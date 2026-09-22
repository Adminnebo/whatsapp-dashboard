-- Botón "Ocultar usuario" (super_admin) de la sección Usuarios.
-- Ejecutar UNA vez en el SQL Editor de Supabase (proyecto de auth del panel).
-- No borra nada: solo saca al usuario del listado. Idempotente.
alter table public.profiles
  add column if not exists hidden boolean not null default false;
