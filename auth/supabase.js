/* =========================================================
   auth/supabase.js — Clientes Supabase para el sistema de login reutilizable.
   Config por variables de entorno:
     SUPABASE_URL                (público)
     SUPABASE_ANON_KEY           (público — valida tokens y va al frontend)
     SUPABASE_SERVICE_ROLE_KEY   (secreto — crear/administrar usuarios)
   ========================================================= */
'use strict';
const { createClient } = require('@supabase/supabase-js');

const URL = process.env.SUPABASE_URL || '';
const ANON = process.env.SUPABASE_ANON_KEY || '';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!URL || !ANON) console.warn('[auth] Falta SUPABASE_URL / SUPABASE_ANON_KEY');
if (!SERVICE) console.warn('[auth] Falta SUPABASE_SERVICE_ROLE_KEY (necesario para el panel admin)');

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const anon = (URL && ANON) ? createClient(URL, ANON, opts) : null;        // valida access tokens
const admin = (URL && SERVICE) ? createClient(URL, SERVICE, opts) : null; // operaciones de admin (service role)

// Perfil de public.profiles (rol, vínculo con GHL, etc.)
async function getProfile(userId) {
  if (!admin || !userId) return null;
  const { data } = await admin.from('profiles').select('*').eq('id', userId).maybeSingle();
  return data || null;
}

module.exports = { URL, ANON, SERVICE, anon, admin, getProfile, configured: !!(anon && admin) };
