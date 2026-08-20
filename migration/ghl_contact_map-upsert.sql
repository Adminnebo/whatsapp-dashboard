-- =========================================================
-- Anti-duplicados + handoff sobre la tabla EXISTENTE public.ghl_contact_map
-- (identidad: wa_id = teléfono/WhatsApp, user_id = id de Meta CO./DO./US.…).
-- Reescribe contact_upsert / contact_set_bot para operar aquí (no en `contacts`).
-- Idempotente: se puede correr varias veces.
-- =========================================================

-- 0) columnas que faltan (no toca las de custom fields existentes)
alter table public.ghl_contact_map add column if not exists user_id      text;
alter table public.ghl_contact_map add column if not exists contact_name text;
alter table public.ghl_contact_map add column if not exists bot_active   boolean default true;
alter table public.ghl_contact_map add column if not exists updated_at   timestamptz default now();

create index if not exists idx_gcm_wa_id   on public.ghl_contact_map(wa_id)   where wa_id   is not null;
create index if not exists idx_gcm_user_id on public.ghl_contact_map(user_id) where user_id is not null;

-- 1) GET-OR-CREATE atómico por wa_id (teléfono) O user_id. Nunca inserta wa_id nulo:
--    si solo viene user_id, ese valor se usa también como wa_id (clave estable).
drop function if exists public.contact_upsert(text, text, text, jsonb);
create or replace function public.contact_upsert(
  p_phone   text  default null,
  p_user_id text  default null,
  p_name    text  default null,
  p_custom  jsonb default null   -- se ignora: la tabla usa columnas propias de custom fields
)
returns table (wa_id text, user_id text, contact_name text, bot_active boolean, created boolean)
language plpgsql
as $$
declare
  v_wa    text := nullif(regexp_replace(coalesce(p_phone,''), '\D', '', 'g'), '');  -- solo dígitos
  v_uid   text := nullif(trim(coalesce(p_user_id,'')), '');
  v_ident text := coalesce(v_wa, v_uid);   -- lo que irá a wa_id si es nuevo
  v_key   text;
  v_created boolean := false;
begin
  if v_ident is null then
    raise exception 'Falta wa_id (teléfono) o user_id';
  end if;
  -- serializa por identidad → sin duplicados bajo concurrencia
  perform pg_advisory_xact_lock(hashtext('contact:' || coalesce(v_uid, v_wa)));

  -- ¿ya existe? (prioriza el match por wa_id)
  select g.wa_id into v_key
  from public.ghl_contact_map g
  where (v_wa  is not null and g.wa_id   = v_wa)
     or (v_uid is not null and g.user_id = v_uid)
  order by case when g.wa_id = v_wa then 0 else 1 end
  limit 1;

  if v_key is not null then
    update public.ghl_contact_map g set
      wa_id        = coalesce(g.wa_id, v_ident),
      user_id      = coalesce(g.user_id, v_uid),
      contact_name = coalesce(g.contact_name, p_name),
      updated_at   = now()
    where g.wa_id = v_key;
  else
    insert into public.ghl_contact_map (wa_id, user_id, contact_name)
    values (v_ident, v_uid, p_name)
    returning ghl_contact_map.wa_id into v_key;
    v_created := true;
  end if;

  return query
    select g.wa_id, g.user_id, g.contact_name, g.bot_active, v_created
    from public.ghl_contact_map g where g.wa_id = v_key;
end;
$$;

-- 2) HAND OFF: prender/apagar el bot por wa_id o user_id.
drop function if exists public.contact_set_bot(boolean, bigint, text, text);
create or replace function public.contact_set_bot(
  p_active  boolean,
  p_id      bigint default null,   -- ignorado (la tabla no usa id numérico)
  p_user_id text   default null,
  p_phone   text   default null
)
returns table (wa_id text, user_id text, contact_name text, bot_active boolean)
language plpgsql
as $$
declare
  v_wa  text := nullif(regexp_replace(coalesce(p_phone,''), '\D', '', 'g'), '');
  v_uid text := nullif(trim(coalesce(p_user_id,'')), '');
begin
  return query
    update public.ghl_contact_map g
       set bot_active = p_active, updated_at = now()
     where (v_wa  is not null and g.wa_id   = v_wa)
        or (v_uid is not null and g.user_id = v_uid)
    returning g.wa_id, g.user_id, g.contact_name, g.bot_active;
end;
$$;

-- 3) MIGRAR las filas que quedaron en la tabla `contacts` (la que creé por error)
--    hacia ghl_contact_map, sin duplicar. No borra `contacts` (eso lo decides tú).
insert into public.ghl_contact_map (wa_id, user_id, contact_name, bot_active)
select coalesce(nullif(c.phone,''), c.user_id) as wa_id, c.user_id, c.name,
       coalesce(c.bot_active, true)
from public.contacts c
where coalesce(nullif(c.phone,''), c.user_id) is not null
  and not exists (
    select 1 from public.ghl_contact_map g
    where g.wa_id = coalesce(nullif(c.phone,''), c.user_id)
       or (c.user_id is not null and g.user_id = c.user_id)
  );

-- Comprobación rápida (opcional):
-- select wa_id, user_id, contact_name, bot_active from public.ghl_contact_map
--   where user_id = 'CO.1471984471401026' or wa_id = '573505903076';
