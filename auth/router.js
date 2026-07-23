/* =========================================================
   auth/router.js — Rutas de autenticación y administración de usuarios.
   Se monta en /api/auth. El login (email+contraseña) ocurre en el frontend
   contra Supabase; aquí exponemos config pública, el usuario actual, y el
   CRUD de usuarios (solo admin, vía service role).
   ========================================================= */
'use strict';
const express = require('express');
const { URL, ANON, admin, getProfile } = require('./supabase');
const { requireAuth, requireAdmin, plataformasDe, PLATAFORMAS } = require('./middleware');

const router = express.Router();
const ROLES = ['admin', 'agent'];

// Normaliza la lista de plataformas que llega del cliente (solo válidas, sin repes).
function limpiarPlataformas(v) {
  if (!Array.isArray(v)) return null;
  const set = [...new Set(v.map(String))].filter(x => PLATAFORMAS.includes(x));
  return set;
}

// Config pública para el frontend (URL + anon key). No expone secretos.
router.get('/config', (_req, res) => {
  res.json({ supabaseUrl: URL, supabaseAnonKey: ANON, configured: !!(URL && ANON) });
});

// Usuario autenticado + su perfil (rol, vínculo GHL) + plataformas a las que accede.
router.get('/me', requireAuth, async (req, res) => {
  const prof = await getProfile(req.user.id);
  res.json({
    id: req.user.id, email: req.user.email, profile: prof || null,
    role: prof ? prof.role : null,
    platforms: plataformasDe(prof)          // ya resuelve super_admin/admin = todas
  });
});

// ---- Administración de usuarios (solo admin) ----
router.get('/users', requireAuth, requireAdmin, async (_req, res) => {
  const { data: list, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 500 });
  if (error) return res.status(500).json({ error: error.message });
  const { data: profs } = await admin.from('profiles').select('*');
  const pmap = {}; (profs || []).forEach(p => { pmap[p.id] = p; });
  const users = (list.users || []).map(u => {
    const p = pmap[u.id] || {};
    return {
      id: u.id, email: u.email, createdAt: u.created_at, lastSignInAt: u.last_sign_in_at,
      role: p.role || 'agent', fullName: p.full_name || null, ghlUserId: p.ghl_user_id || null,
      // plataformas concedidas al agente; admin/super_admin siempre todas
      platforms: plataformasDe(p)
    };
  });
  res.json({ users });
});

router.post('/users', requireAuth, requireAdmin, async (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  if (!email || password.length < 6) return res.status(400).json({ error: 'Email y contraseña (mínimo 6) son requeridos' });
  const role = ROLES.includes(b.role) ? b.role : 'agent';
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) return res.status(400).json({ error: error.message });
  const id = data.user.id;
  const perfil = { id, email, role, full_name: b.fullName || null, ghl_user_id: b.ghlUserId || null };
  const plats = limpiarPlataformas(b.platforms);
  if (plats) perfil.platforms = plats;      // si no manda, la BD pone el default (las 3)
  const { error: perr } = await admin.from('profiles').upsert(perfil);
  if (perr) return res.status(500).json({ error: 'usuario creado pero falló el perfil: ' + perr.message });
  res.status(201).json({ ok: true, id });
});

router.patch('/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.role && ROLES.includes(b.role)) patch.role = b.role;
  if ('fullName' in b) patch.full_name = b.fullName || null;
  if ('ghlUserId' in b) patch.ghl_user_id = b.ghlUserId || null;
  if ('platforms' in b) { const p = limpiarPlataformas(b.platforms); if (p) patch.platforms = p; }
  const authUpd = {};
  if (b.password) authUpd.password = String(b.password);
  if (b.email) { authUpd.email = String(b.email).trim().toLowerCase(); patch.email = authUpd.email; }
  if (Object.keys(authUpd).length) {
    const { error } = await admin.auth.admin.updateUserById(req.params.id, authUpd);
    if (error) return res.status(400).json({ error: error.message });
  }
  if (Object.keys(patch).length) {
    const { error } = await admin.from('profiles').update(patch).eq('id', req.params.id);
    if (error) return res.status(400).json({ error: error.message });
  }
  res.json({ ok: true });
});

router.delete('/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const { error } = await admin.auth.admin.deleteUser(req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  await admin.from('profiles').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

module.exports = router;
