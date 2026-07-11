/* =========================================================
   auth/middleware.js — Middlewares de protección (reutilizable).
     requireAuth  -> exige un access token válido de Supabase (Bearer).
     requireAdmin -> además exige rol 'admin' en public.profiles.
   Valida el token contra Supabase (getUser) con una caché corta en memoria
   para no llamar en cada request.
   ========================================================= */
'use strict';
const { anon, getProfile } = require('./supabase');

const cache = new Map();            // token -> { user, exp }
const TTL = 60 * 1000;              // 60s

async function verify(token) {
  const hit = cache.get(token);
  if (hit && hit.exp > Date.now()) return hit.user;
  if (!anon) throw new Error('Supabase no configurado');
  const { data, error } = await anon.auth.getUser(token);
  if (error || !data || !data.user) return null;
  const user = { id: data.user.id, email: data.user.email };
  cache.set(token, { user, exp: Date.now() + TTL });
  return user;
}

function tokenFrom(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return req.headers['x-access-token'] || '';
}

async function requireAuth(req, res, next) {
  try {
    const token = tokenFrom(req);
    if (!token) return res.status(401).json({ error: 'No autenticado' });
    const user = await verify(token);
    if (!user) return res.status(401).json({ error: 'Sesión inválida o expirada' });
    req.user = user;
    next();
  } catch (e) { res.status(500).json({ error: 'auth: ' + e.message }); }
}

async function requireAdmin(req, res, next) {
  try {
    if (!req.user) return res.status(401).json({ error: 'No autenticado' });
    const prof = await getProfile(req.user.id);
    if (!prof || prof.role !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
    req.profile = prof;
    next();
  } catch (e) { res.status(500).json({ error: 'auth: ' + e.message }); }
}

module.exports = { requireAuth, requireAdmin, verify };
