-- =========================================================
-- Anti-duplicados de contactos, atómico dentro de Supabase.
-- Reemplaza en n8n: Get many rows + If + Create a row + Edit Fields
-- por UNA sola llamada RPC a esta función.
-- Identifica por user_id (preferente) O por teléfono. Meta manda
-- unos contactos con wa_id (teléfono) y otros solo con user_id.
-- =========================================================

-- 0) la tabla (si el proyecto es nuevo) + columnas que necesita (idempotente)
create table if not exists public.contacts (
  id            bigint generated always as identity primary key,
  phone         text,
  user_id       text,
  name          text,
  bot_active    boolean default true,      -- true = responde el bot; false = handoff a humano
  custom_fields jsonb default '{}'::jsonb,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
alter table public.contacts add column if not exists phone         text;
alter table public.contacts add column if not exists user_id       text;
alter table public.contacts add column if not exists name          text;
alter table public.contacts add column if not exists bot_active    boolean default true;
alter table public.contacts add column if not exists custom_fields jsonb default '{}'::jsonb;
alter table public.contacts add column if not exists updated_at    timestamptz default now();

-- índices (no únicos: un contacto puede tener phone y user_id a la vez;
-- la unicidad real la garantiza el lock de la función, no un constraint)
create index if not exists idx_contacts_phone   on public.contacts(phone)   where phone   is not null;
create index if not exists idx_contacts_user_id on public.contacts(user_id) where user_id is not null;

-- 1) la función get-or-create atómica
-- (drop porque cambió el tipo de retorno: ahora incluye bot_active)
drop function if exists public.contact_upsert(text, text, text, jsonb);
create or replace function public.contact_upsert(
  p_phone   text default null,
  p_user_id text default null,
  p_name    text default null,
  p_custom  jsonb default null
)
returns table (id bigint, phone text, user_id text, name text, bot_active boolean, created boolean)
language plpgsql
as $$
declare
  v_phone text := nullif(regexp_replace(coalesce(p_phone,''), '\D', '', 'g'), '');  -- solo dígitos
  v_uid   text := nullif(trim(coalesce(p_user_id,'')), '');
  v_key   text := coalesce(v_uid, v_phone);
  v_id    bigint;
  v_created boolean := false;
begin
  if v_key is null then
    raise exception 'Falta phone o user_id';
  end if;

  -- Serializa por identidad: dos personas distintas (hash distinto) NO se bloquean.
  -- Las ejecuciones simultáneas de la MISMA persona entran de una en una.
  perform pg_advisory_xact_lock(hashtext('contact:' || v_key));

  -- ¿ya existe? (prioriza user_id)
  select c.id into v_id
  from public.contacts c
  where (v_uid   is not null and c.user_id = v_uid)
     or (v_phone is not null and c.phone   = v_phone)
  order by case when c.user_id = v_uid then 0 else 1 end
  limit 1;

  if v_id is not null then
    -- rellena lo que falte y funde custom_fields
    update public.contacts c set
      user_id       = coalesce(c.user_id, v_uid),
      phone         = coalesce(c.phone, v_phone),
      name          = coalesce(c.name, p_name),
      custom_fields = case when p_custom is not null
                           then coalesce(c.custom_fields,'{}'::jsonb) || p_custom
                           else c.custom_fields end,
      updated_at    = now()
    where c.id = v_id;
  else
    insert into public.contacts (phone, user_id, name, custom_fields)
    values (v_phone, v_uid, p_name, coalesce(p_custom, '{}'::jsonb))
    returning contacts.id into v_id;
    v_created := true;
  end if;

  return query
    select c.id, c.phone, c.user_id, c.name, c.bot_active, v_created
    from public.contacts c where c.id = v_id;
end;
$$;

-- 2) Hand off: prender/apagar el bot de un contacto (reemplaza el tag de GHL).
--    Identifica por id, user_id o teléfono. Devuelve el estado final.
drop function if exists public.contact_set_bot(boolean, bigint, text, text);
create or replace function public.contact_set_bot(
  p_active  boolean,
  p_id      bigint default null,
  p_user_id text   default null,
  p_phone   text   default null
)
returns table (id bigint, phone text, user_id text, name text, bot_active boolean)
language plpgsql
as $$
declare
  v_phone text := nullif(regexp_replace(coalesce(p_phone,''), '\D', '', 'g'), '');
  v_uid   text := nullif(trim(coalesce(p_user_id,'')), '');
begin
  return query
    update public.contacts c
       set bot_active = p_active, updated_at = now()
     where (p_id   is not null and c.id      = p_id)
        or (v_uid  is not null and c.user_id = v_uid)
        or (v_phone is not null and c.phone  = v_phone)
    returning c.id, c.phone, c.user_id, c.name, c.bot_active;
end;
$$;
