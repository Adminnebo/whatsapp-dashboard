/* =========================================================
   analyticsAuth.js — Auth OPCIONAL para la analítica (ligero, sin supabase-js).
   Verifica el token de Supabase con fetch directo y lee el rol de public.profiles.
   No bloquea: solo detecta el rol (para mostrar costes solo a super_admin).
   Config por env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
   ========================================================= */
'use strict';
const URL = process.env.SUPABASE_URL || '';
const ANON = process.env.SUPABASE_ANON_KEY || '';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const configured = !!(URL && ANON && SERVICE);

const cache = new Map();            // token -> { role, exp }
const TTL = 60 * 1000;

async function roleForToken(token) {
  if (!token || !configured) return null;
  const hit = cache.get(token);
  if (hit && hit.exp > Date.now()) return hit.role;
  try {
    const ures = await fetch(URL + '/auth/v1/user', { headers: { apikey: ANON, Authorization: 'Bearer ' + token } });
    if (!ures.ok) return null;
    const u = await ures.json();
    const id = u && u.id;
    if (!id) return null;
    const pres = await fetch(URL + '/rest/v1/profiles?id=eq.' + id + '&select=role', { headers: { apikey: SERVICE, Authorization: 'Bearer ' + SERVICE } });
    const rows = pres.ok ? await pres.json() : [];
    const role = rows[0] ? rows[0].role : null;
    cache.set(token, { role, exp: Date.now() + TTL });
    return role;
  } catch (_) { return null; }
}

// Middleware: adjunta req.role (o null). Nunca bloquea.
async function optionalAuth(req, _res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  req.role = await roleForToken(token);
  next();
}

module.exports = { configured, optionalAuth, URL, ANON };
