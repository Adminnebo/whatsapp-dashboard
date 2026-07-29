/* =========================================================
   auth/router.js — Rutas de autenticación y administración de usuarios.
   Se monta en /api/auth. El login (email+contraseña) ocurre en el frontend
   contra Supabase; aquí exponemos config pública, el usuario actual, y el
   CRUD de usuarios (solo admin, vía service role).
   ========================================================= */
'use strict';
const express = require('express');
const { URL, ANON, admin, getProfile } = require('./supabase');
const { requireAuth, requireAdmin, plataformasDe, permisosDe, PLATAFORMAS } = require('./middleware');
const { limpiar: limpiarPermisos } = require('./permcatalog');

const router = express.Router();
const ROLES = ['admin', 'agent'];

// Normaliza la lista de plataformas que llega del cliente (solo válidas, sin repes).
function limpiarPlataformas(v) {
  if (!Array.isArray(v)) return null;
  const set = [...new Set(v.map(String))].filter(x => PLATAFORMAS.includes(x));
  return set;
}

// Escribe en profiles TOLERANDO esquemas viejos: si Supabase todavía no tiene la
// columna 'permissions' (o 'platforms') —la migración aún no corrió—, reintenta
// sin ella en vez de fallar. Así cambiar la contraseña o el rol nunca se rompe
// por una columna que falta; los permisos se persistirán al correr el ALTER.
async function escribirPerfil(op, payload, id) {
  const run = obj => op === 'upsert'
    ? admin.from('profiles').upsert(obj)
    : admin.from('profiles').update(obj).eq('id', id);
  let { error } = await run(payload);
  for (const col of ['permissions', 'platforms']) {
    if (error && (col in payload) && String(error.message || '').includes(`'${col}'`)) {
      delete payload[col];
      ({ error } = await run(payload));
    }
  }
  return error;
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
    platforms: plataformasDe(prof),         // ya resuelve super_admin/admin = todas
    permissions: permisosDe(prof)           // permisos efectivos (para ocultar en el frontend)
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
      // plataformas y permisos concedidos; admin/super_admin siempre todo
      platforms: plataformasDe(p),
      permissions: permisosDe(p)
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
  const perms = limpiarPermisos(b.permissions);
  if (perms) {
    perfil.permissions = perms;
    // Mantener 'platforms' en sinc con los permisos (una plataforma = tener ≥1
    // permiso suyo), para que el gate por plataforma no se contradiga.
    perfil.platforms = [...new Set(perms.map(k => k.split('.')[0]))];
  } else {
    const plats = limpiarPlataformas(b.platforms);
    if (plats) perfil.platforms = plats;    // compat: si mandan solo plataformas
  }
  const perr = await escribirPerfil('upsert', perfil);
  if (perr) return res.status(500).json({ error: 'usuario creado pero falló el perfil: ' + perr.message });
  res.status(201).json({ ok: true, id });
});

// Un super_admin aparece en la lista pero NO se puede editar ni eliminar desde el
// panel. Devuelve true si bloqueó (ya respondió 403).
async function protegidoSuper(id, res) {
  const prof = await getProfile(id);
  if (prof && prof.role === 'super_admin') {
    res.status(403).json({ error: 'Un super admin no se puede editar ni eliminar' });
    return true;
  }
  return false;
}

router.patch('/users/:id', requireAuth, requireAdmin, async (req, res) => {
  if (await protegidoSuper(req.params.id, res)) return;
  const b = req.body || {};
  const patch = {};
  if (b.role && ROLES.includes(b.role)) patch.role = b.role;
  if ('fullName' in b) patch.full_name = b.fullName || null;
  if ('ghlUserId' in b) patch.ghl_user_id = b.ghlUserId || null;
  if ('permissions' in b) {
    const p = limpiarPermisos(b.permissions);
    if (p) { patch.permissions = p; patch.platforms = [...new Set(p.map(k => k.split('.')[0]))]; }
  } else if ('platforms' in b) {
    const p = limpiarPlataformas(b.platforms); if (p) patch.platforms = p;
  }
  const authUpd = {};
  if (b.password) authUpd.password = String(b.password);
  if (b.email) { authUpd.email = String(b.email).trim().toLowerCase(); patch.email = authUpd.email; }
  if (Object.keys(authUpd).length) {
    const { error } = await admin.auth.admin.updateUserById(req.params.id, authUpd);
    if (error) return res.status(400).json({ error: error.message });
  }
  if (Object.keys(patch).length) {
    const error = await escribirPerfil('update', patch, req.params.id);
    if (error) return res.status(400).json({ error: error.message });
  }
  res.json({ ok: true });
});

router.delete('/users/:id', requireAuth, requireAdmin, async (req, res) => {
  if (await protegidoSuper(req.params.id, res)) return;
  const { error } = await admin.auth.admin.deleteUser(req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  await admin.from('profiles').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

module.exports = router;
