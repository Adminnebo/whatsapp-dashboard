/* =========================================================
   authUsers.js — Gestión de usuarios para la analítica (sin supabase-js).
   Usa la Admin API de Supabase (GoTrue) + REST de profiles vía fetch.
   Solo admin / super_admin. El rol super_admin NO se asigna por el panel.
   Se monta en /api/auth.
   ========================================================= */
'use strict';
const express = require('express');
const { URL, SERVICE, configured, roleForToken } = require('./analyticsAuth');
const router = express.Router();
const ROLES = ['admin', 'agent'];

const svc = (extra) => Object.assign({ apikey: SERVICE, Authorization: 'Bearer ' + SERVICE, 'Content-Type': 'application/json' }, extra || {});
async function tokenRole(req) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  return roleForToken(t);
}
async function requireAdmin(req, res, next) {
  if (!configured) return res.status(503).json({ error: 'Auth no configurado' });
  const role = await tokenRole(req);
  if (!['admin', 'super_admin'].includes(role)) return res.status(403).json({ error: 'Solo administradores' });
  req.role = role;
  next();
}

// Rol del usuario actual (para que el frontend muestre/oculte la sección).
router.get('/me', async (req, res) => {
  res.json({ role: (await tokenRole(req)) || null });
});

router.get('/users', requireAdmin, async (_req, res) => {
  const ures = await fetch(URL + '/auth/v1/admin/users?page=1&per_page=500', { headers: svc() });
  if (!ures.ok) return res.status(500).json({ error: 'listUsers ' + ures.status });
  const uj = await ures.json();
  const pres = await fetch(URL + '/rest/v1/profiles?select=id,role,full_name', { headers: svc() });
  const profs = pres.ok ? await pres.json() : [];
  const pmap = {}; profs.forEach(p => { pmap[p.id] = p; });
  const users = (uj.users || []).map(u => {
    const p = pmap[u.id] || {};
    return { id: u.id, email: u.email, createdAt: u.created_at, lastSignInAt: u.last_sign_in_at, role: p.role || 'agent', fullName: p.full_name || null };
  });
  res.json({ users });
});

router.post('/users', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  if (!email || password.length < 6) return res.status(400).json({ error: 'Email y contraseña (mínimo 6) requeridos' });
  const role = ROLES.includes(b.role) ? b.role : 'agent';   // super_admin no asignable por panel
  const cres = await fetch(URL + '/auth/v1/admin/users', { method: 'POST', headers: svc(), body: JSON.stringify({ email, password, email_confirm: true }) });
  const cj = await cres.json().catch(() => ({}));
  if (!cres.ok) return res.status(400).json({ error: cj.msg || cj.error_description || ('createUser ' + cres.status) });
  await fetch(URL + '/rest/v1/profiles', { method: 'POST', headers: svc({ Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify({ id: cj.id, email, role, full_name: b.fullName || null }) });
  res.status(201).json({ ok: true, id: cj.id });
});

router.patch('/users/:id', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.role && ROLES.includes(b.role)) patch.role = b.role;
  if ('fullName' in b) patch.full_name = b.fullName || null;
  if (Object.keys(patch).length) {
    await fetch(URL + '/rest/v1/profiles?id=eq.' + req.params.id, { method: 'PATCH', headers: svc({ Prefer: 'return=minimal' }), body: JSON.stringify(patch) });
  }
  if (b.password) {
    await fetch(URL + '/auth/v1/admin/users/' + req.params.id, { method: 'PUT', headers: svc(), body: JSON.stringify({ password: String(b.password) }) });
  }
  res.json({ ok: true });
});

router.delete('/users/:id', requireAdmin, async (req, res) => {
  await fetch(URL + '/auth/v1/admin/users/' + req.params.id, { method: 'DELETE', headers: svc() });
  await fetch(URL + '/rest/v1/profiles?id=eq.' + req.params.id, { method: 'DELETE', headers: svc({ Prefer: 'return=minimal' }) });
  res.json({ ok: true });
});

module.exports = router;
