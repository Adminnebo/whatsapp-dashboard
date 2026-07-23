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

// ── Acceso por plataforma ────────────────────────────────────────────────────
// Las tres plataformas comparten login. super_admin y admin ven TODAS siempre;
// a un 'agent' se le limita con profiles.platforms (array). Si la columna aún no
// existe (antes de correr la migración en Supabase) o es null, ve todas: así el
// despliegue no deja a nadie fuera.
const PLATAFORMAS = ['inbox', 'cotizaciones', 'cobranzas'];

function plataformasDe(profile) {
  const role = profile && profile.role;
  if (role === 'super_admin' || role === 'admin') return PLATAFORMAS.slice();
  const p = profile && profile.platforms;
  return Array.isArray(p) ? p : PLATAFORMAS.slice();
}

// Middleware que exige acceso a una plataforma concreta.
function requirePlatform(key) {
  return async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'No autenticado' });
      const prof = req.profile || await getProfile(req.user.id);
      req.profile = prof;
      if (!plataformasDe(prof).includes(key)) {
        return res.status(403).json({ error: 'Sin acceso a esta plataforma', platform: key });
      }
      next();
    } catch (e) { res.status(500).json({ error: 'auth: ' + e.message }); }
  };
}

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
    if (!prof || !['admin', 'super_admin'].includes(prof.role)) return res.status(403).json({ error: 'Solo administradores' });
    req.profile = prof;
    next();
  } catch (e) { res.status(500).json({ error: 'auth: ' + e.message }); }
}

// No bloquea: si viene un token válido, adjunta req.user + req.role; si no, sigue.
// Útil para contenido opcional según el rol (p.ej. mostrar costes solo a super_admin).
async function optionalAuth(req, _res, next) {
  try {
    const token = tokenFrom(req);
    if (token) {
      const user = await verify(token);
      if (user) { req.user = user; const prof = await getProfile(user.id); req.role = prof ? prof.role : null; }
    }
  } catch (_) { /* nunca bloquea */ }
  next();
}

// Solo super_admin (p.ej. para ver costes reales de IA). Se asigna solo por API.
async function requireSuperAdmin(req, res, next) {
  try {
    if (!req.user) return res.status(401).json({ error: 'No autenticado' });
    const prof = await getProfile(req.user.id);
    if (!prof || prof.role !== 'super_admin') return res.status(403).json({ error: 'Solo super admin' });
    req.profile = prof;
    next();
  } catch (e) { res.status(500).json({ error: 'auth: ' + e.message }); }
}

module.exports = { requireAuth, requireAdmin, requireSuperAdmin, optionalAuth, verify, requirePlatform, plataformasDe, PLATAFORMAS };
