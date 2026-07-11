-- =========================================================
-- auth/schema.sql — Corre esto en Supabase (SQL Editor).
-- Tabla de perfiles: rol (admin/agent) + vínculo con un usuario de GHL.
-- =========================================================

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  role text not null default 'agent' check (role in ('super_admin','admin','agent')),
  ghl_user_id text,
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;

-- Cada usuario puede leer su propio perfil (el backend usa la service_role key,
-- que salta RLS, para administrar todos).
drop policy if exists "own profile read" on public.profiles;
create policy "own profile read" on public.profiles
  for select using (auth.uid() = id);

-- Crea el perfil automáticamente al dar de alta un usuario en auth.users.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---- Sembrar el primer admin ----
-- 1) Crea tu usuario admin en Supabase Studio → Authentication → Add user
--    (o luego desde el panel /users.html, pero el primero hazlo aquí).
-- 2) Márcalo como admin:
--    update public.profiles set role = 'admin' where email = 'TU_ADMIN@empresa.com';
