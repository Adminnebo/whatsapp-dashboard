/* =========================================================
   Dashboard WhatsApp — backend full-stack (Express + Postgres).
   Sirve el frontend (public/) y expone /api/* consultando Postgres
   directamente, y haciendo de proxy a GoHighLevel y WhatsApp Cloud API.
   Reemplaza los webhooks de n8n para todo lo que es BD/GHL/envío.
   ========================================================= */
'use strict';
const path = require('path');
const express = require('express');
const multer = require('multer');
const { q } = require('./db');

const app = express();
const PORT = process.env.PORT || 8080;

// --- config (variables de entorno) ---
const GHL_PIT = process.env.GHL_PIT || '';
const LOCATION_ID = process.env.LOCATION_ID || '';
const WA_TOKEN = process.env.WHATSAPP_TOKEN || '';
const WA_PHONE = process.env.WHATSAPP_PHONE_ID || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const HANDOFF_TAG = process.env.HANDOFF_TAG || 'handoff';

app.use(express.json({ limit: process.env.JSON_LIMIT || '60mb' }));
app.use(express.urlencoded({ extended: true, limit: '60mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024 } });

// --- helpers ---
const COLORS = ['#2f6df6', '#e2497a', '#1aa179', '#f59e0b', '#7c3aed', '#0ea5e9', '#ef4444', '#10b981'];
function colorFor(n) { n = n || '?'; let h = 0; for (let i = 0; i < n.length; i++) h = n.charCodeAt(i) + ((h << 5) - h); return COLORS[Math.abs(h) % COLORS.length]; }
function initials(n) { return (n || '?').split(' ').slice(0, 2).map(w => w[0] || '').join('').toUpperCase(); }
const asBool = v => (v === true || v === 'true' || v === 1 || v === '1');
function originOf(req) { return PUBLIC_URL || (req.protocol + '://' + req.get('host')); }
const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => { console.error(req.path, e); res.status(500).json({ error: e.message }); });

async function ghl(pathname, opts = {}) {
  const res = await fetch('https://services.leadconnectorhq.com' + pathname, {
    ...opts,
    headers: { Authorization: 'Bearer ' + GHL_PIT, Version: '2021-07-28', Accept: 'application/json', ...(opts.headers || {}) }
  });
  let json = null; const text = await res.text(); try { json = text ? JSON.parse(text) : null; } catch (_) {}
  return { ok: res.ok, status: res.status, json };
}
async function waSend(payload) {
  const res = await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE}/messages`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json };
}

// --- migraciones (tablas) ---
const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS contacts (id BIGSERIAL PRIMARY KEY, phone TEXT, name TEXT, email TEXT, company TEXT, tags TEXT[] DEFAULT '{}', source TEXT, owner TEXT, ghl_contact_id TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS conversations (id BIGSERIAL PRIMARY KEY, contact_id BIGINT UNIQUE REFERENCES contacts(id) ON DELETE CASCADE, channel TEXT DEFAULT 'whatsapp', status TEXT DEFAULT 'open', starred BOOLEAN DEFAULT false, unread_count INT DEFAULT 0, last_message TEXT, last_message_at TIMESTAMPTZ, last_direction TEXT, last_status TEXT, last_inbound TIMESTAMPTZ, updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS messages (id BIGSERIAL PRIMARY KEY, conversation_id BIGINT REFERENCES conversations(id) ON DELETE CASCADE, wamid TEXT UNIQUE, direction TEXT, type TEXT DEFAULT 'text', text TEXT, template TEXT, media_url TEXT, media_mime TEXT, media_filename TEXT, media_data BYTEA, status TEXT, channel TEXT DEFAULT 'whatsapp', created_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conv_contact ON conversations(contact_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_contacts_ghl ON contacts(ghl_contact_id);
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT now());
INSERT INTO app_settings (key, value) VALUES ('bot_enabled', 'true') ON CONFLICT (key) DO NOTHING;
`;
async function migrate() { await q(MIGRATIONS); }

// --- normalizar + guardar un mensaje (save-in/out y send-media) ---
function normalize(body, file, direction) {
  let ts = body.timestamp;
  if (ts == null || ts === '') ts = Math.floor(Date.now() / 1000);
  else { ts = Number(ts); if (ts > 1e12) ts = Math.floor(ts / 1000); }
  const phone = body.phone ? String(body.phone).replace(/[^\d]/g, '') : null;
  const ch = ['whatsapp', 'instagram', 'facebook'].includes(String(body.channel || '').toLowerCase()) ? String(body.channel).toLowerCase() : 'whatsapp';
  const mediaUrl = body.mediaUrl || body.media_url || null;
  let mediaMime = body.mediaMime || body.mimeType || body.mime || null;
  let mediaName = body.filename || body.mediaFilename || body.fileName || null;
  let mediaData = null;
  let b64 = body.mediaBase64 || body.mediaData || body.media_base64 || null;
  if (b64) { b64 = String(b64).replace(/^data:[^;]+;base64,/, '').replace(/\s/g, ''); mediaData = Buffer.from(b64, 'base64'); }
  if (!mediaData && !mediaUrl && file) { mediaData = file.buffer; if (!mediaMime) mediaMime = file.mimetype || null; if (!mediaName) mediaName = file.originalname || null; }
  const hasMedia = !!(mediaUrl || mediaData);
  const VALID = ['text', 'image', 'audio', 'video', 'document', 'sticker'];
  let type = String(body.type || '').toLowerCase();
  if (!VALID.includes(type)) {
    const m = (mediaMime || '').toLowerCase();
    if (hasMedia && m.startsWith('image/')) type = 'image';
    else if (hasMedia && m.startsWith('audio/')) type = 'audio';
    else if (hasMedia && m.startsWith('video/')) type = 'video';
    else type = hasMedia ? 'document' : 'text';
  }
  const text = body.text || body.caption || '';
  const LBL = { image: '📷 Imagen', audio: '🎵 Audio', video: '🎬 Video', sticker: '🎯 Sticker', document: '📄 ' + (mediaName || 'Documento') };
  const preview = text || LBL[type] || (hasMedia ? '📎 Adjunto' : '');
  return {
    contactId: body.contactId != null ? String(body.contactId) : null,
    name: body.name || null, text, wamid: body.wamid || null, ts, type,
    direction, status: body.status || (direction === 'in' ? 'received' : 'sent'),
    phone, channel: ch, mediaUrl, mediaMime, mediaName, preview, mediaData
  };
}

const SAVE_SQL = `
WITH existing AS (SELECT id FROM contacts WHERE ($1::text IS NOT NULL AND ghl_contact_id = $1::text) OR ($9::text IS NOT NULL AND phone = $9::text) ORDER BY CASE WHEN ghl_contact_id = $1::text THEN 0 ELSE 1 END LIMIT 1),
upd AS (UPDATE contacts SET ghl_contact_id = COALESCE(contacts.ghl_contact_id, $1), name = COALESCE($2, contacts.name), phone = COALESCE($9, contacts.phone) WHERE id = (SELECT id FROM existing) RETURNING id),
ins AS (INSERT INTO contacts (ghl_contact_id, name, phone) SELECT $1, $2, $9 WHERE NOT EXISTS (SELECT 1 FROM existing) RETURNING id),
c AS (SELECT id FROM upd UNION ALL SELECT id FROM ins),
conv AS (INSERT INTO conversations (contact_id, channel, last_message, last_message_at, last_direction, last_status, last_inbound, unread_count, status, updated_at)
  SELECT c.id, $10, $14, to_timestamp($5::double precision), $7, $8, CASE WHEN $7='in' THEN to_timestamp($5::double precision) ELSE NULL END, CASE WHEN $7='in' THEN 1 ELSE 0 END, 'open', now() FROM c
  ON CONFLICT (contact_id) DO UPDATE SET channel=EXCLUDED.channel, last_message=EXCLUDED.last_message, last_message_at=EXCLUDED.last_message_at, last_direction=EXCLUDED.last_direction, last_status=EXCLUDED.last_status,
    last_inbound=CASE WHEN EXCLUDED.last_direction='in' THEN EXCLUDED.last_message_at ELSE conversations.last_inbound END,
    unread_count=CASE WHEN EXCLUDED.last_direction='in' THEN conversations.unread_count+1 ELSE conversations.unread_count END, status='open', updated_at=now() RETURNING id)
INSERT INTO messages (conversation_id, wamid, direction, type, text, status, channel, media_url, media_mime, media_filename, media_data, created_at)
  SELECT conv.id, $4, $7, $6, $3, $8, $10, $11, $12, $13, $15, to_timestamp($5::double precision) FROM conv
  ON CONFLICT (wamid) DO NOTHING RETURNING id, conversation_id;`;

async function saveMessage(n) {
  const params = [n.contactId, n.name, n.text, n.wamid, n.ts, n.type, n.direction, n.status, n.phone, n.channel, n.mediaUrl, n.mediaMime, n.mediaName, n.preview, n.mediaData || null];
  const r = await q(SAVE_SQL, params);
  const row = r.rows[0] || {};
  return { id: row.id != null ? String(row.id) : null, conversationId: row.conversation_id != null ? String(row.conversation_id) : null };
}

// ==================== RUTAS API ====================

app.get('/api/db-setup', wrap(async (_req, res) => { await migrate(); res.json({ ok: true, message: 'Tablas creadas correctamente.' }); }));

app.get('/api/conversations', wrap(async (_req, res) => {
  const r = await q(`SELECT conv.id, c.ghl_contact_id, c.name, c.phone, c.email, c.company, c.tags, c.source, c.owner,
      conv.channel, conv.status, conv.starred, conv.unread_count, conv.last_message, conv.last_direction, conv.last_status,
      EXTRACT(EPOCH FROM conv.last_message_at)*1000 AS last_message_at, EXTRACT(EPOCH FROM conv.last_inbound)*1000 AS last_inbound
      FROM conversations conv JOIN contacts c ON c.id = conv.contact_id ORDER BY conv.last_message_at DESC NULLS LAST`);
  const conversations = r.rows.map(row => {
    const nm = row.name || row.phone || '?';
    return {
      id: String(row.id), contactId: row.ghl_contact_id || null, name: nm, phone: row.phone,
      avatar: { initials: initials(nm), color: colorFor(nm) }, channel: row.channel || 'whatsapp',
      lastMessage: row.last_message || '', lastMessageAt: Number(row.last_message_at) || 0,
      lastDirection: row.last_direction || 'in', lastStatus: row.last_status || 'received',
      unreadCount: Number(row.unread_count) || 0, starred: !!row.starred, status: row.status || 'open',
      lastInbound: Number(row.last_inbound) || 0,
      contact: { email: row.email || '', company: row.company || '', tags: row.tags || [], source: row.source || '', owner: row.owner || '' }
    };
  });
  res.json({ conversations });
}));

app.get('/api/messages', wrap(async (req, res) => {
  const id = String(req.query.conversationId || '');
  if (!id) return res.json({ messages: [] });
  const r = await q(`WITH r AS (UPDATE conversations SET unread_count=0 WHERE id=$1::bigint RETURNING id)
    SELECT id, conversation_id, direction, type, text, template, media_url, media_mime, media_filename,
      (media_data IS NOT NULL) AS has_blob, status, channel, EXTRACT(EPOCH FROM created_at)*1000 AS timestamp
      FROM messages WHERE conversation_id=$1::bigint ORDER BY created_at ASC`, [id]);
  const base = originOf(req);
  const messages = r.rows.map(m => {
    let mediaUrl = m.media_url || null;
    if (!mediaUrl && m.has_blob) mediaUrl = base + '/api/media?id=' + m.id;
    return {
      id: String(m.id), conversationId: String(m.conversation_id), direction: m.direction, type: m.type || 'text',
      text: m.text || '', template: m.template || null, mediaUrl, mediaMime: m.media_mime || null,
      mediaFilename: m.media_filename || null, timestamp: Number(m.timestamp) || 0, status: m.status || 'received', channel: m.channel || 'whatsapp'
    };
  });
  res.json({ messages });
}));

app.get('/api/media', wrap(async (req, res) => {
  const id = String(req.query.id || '');
  if (!id) return res.status(400).end();
  const r = await q(`SELECT media_data, media_mime, media_filename FROM messages WHERE id=$1::bigint AND media_data IS NOT NULL`, [id]);
  const row = r.rows[0];
  if (!row || !row.media_data) return res.status(404).end();
  res.set('Content-Type', row.media_mime || 'application/octet-stream');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(row.media_data);
}));

app.post('/api/save-in', upload.single('file'), wrap(async (req, res) => { res.json({ ok: true, ...(await saveMessage(normalize(req.body || {}, req.file, 'in'))) }); }));
app.post('/api/save-out', upload.single('file'), wrap(async (req, res) => { res.json({ ok: true, ...(await saveMessage(normalize(req.body || {}, req.file, 'out'))) }); }));

app.post('/api/delete-conversation', wrap(async (req, res) => {
  const id = String((req.body && req.body.conversationId) || '').replace(/[^0-9]/g, '');
  const r = await q(`DELETE FROM conversations WHERE id=(NULLIF($1,''))::bigint RETURNING id`, [id]);
  const row = r.rows[0];
  res.json({ ok: true, deleted: !!row, id: row ? String(row.id) : null });
}));

// ---- bot flag ----
async function getFlag() { const r = await q(`SELECT value FROM app_settings WHERE key='bot_enabled'`); const v = r.rows[0] && r.rows[0].value; return v == null ? true : String(v) === 'true'; }
app.get('/api/bot-state', wrap(async (_req, res) => res.json({ ok: true, active: await getFlag() })));
app.get('/api/bot-enabled', wrap(async (_req, res) => res.json({ enabled: await getFlag() })));
app.post('/api/bot-set', wrap(async (req, res) => {
  const val = asBool(req.body && req.body.active) ? 'true' : 'false';
  await q(`INSERT INTO app_settings (key,value,updated_at) VALUES ('bot_enabled',$1,now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [val]);
  res.json({ ok: true, active: val === 'true' });
}));

// ---- GHL ----
app.get('/api/ghl-name', wrap(async (req, res) => {
  const id = String(req.query.contactId || '').trim();
  if (!id) return res.json({ ok: false, name: '' });
  const { json } = await ghl('/contacts/' + encodeURIComponent(id));
  const c = (json && json.contact) || {};
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || c.contactName || c.name || '';
  res.json({ ok: !!c.id, name, phone: c.phone || null });
}));

app.get('/api/ghl-contact', wrap(async (req, res) => {
  const id = String(req.query.contactId || '').trim();
  if (!id) return res.json({ ok: false, contact: null, opportunities: [] });
  const [rc, ro, rcf, rp] = await Promise.all([
    ghl('/contacts/' + encodeURIComponent(id)),
    ghl(`/opportunities/search?location_id=${LOCATION_ID}&contact_id=${encodeURIComponent(id)}`),
    ghl(`/locations/${LOCATION_ID}/customFields`),
    ghl(`/opportunities/pipelines?locationId=${LOCATION_ID}`)
  ]);
  const contact = (rc.json && rc.json.contact) || {};
  if (!contact.id) return res.json({ ok: false, contact: null, opportunities: [] });
  const opps = (ro.json && ro.json.opportunities) || [];
  const cfDefs = (rcf.json && rcf.json.customFields) || [];
  const pipes = (rp.json && rp.json.pipelines) || [];
  const cfName = {}; cfDefs.forEach(d => { cfName[d.id] = d.name; });
  const pipeName = {}, stageName = {};
  pipes.forEach(p => { pipeName[p.id] = p.name; (p.stages || []).forEach(s => { stageName[s.id] = s.name; }); });
  const trunc = v => { let s = typeof v === 'string' ? v : JSON.stringify(v); if (s == null) return ''; return s.length > 1000 ? s.slice(0, 1000) + '…' : s; };
  const customFields = (contact.customFields || []).filter(f => f && f.value != null && f.value !== '' && !(Array.isArray(f.value) && !f.value.length)).map(f => ({ name: cfName[f.id] || f.id, value: trunc(f.value) }));
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() || contact.contactName || contact.name || '';
  const opportunities = opps.map(o => ({ id: o.id, name: o.name || '', status: o.status || '', monetaryValue: o.monetaryValue != null ? o.monetaryValue : null, pipeline: pipeName[o.pipelineId] || '', stage: stageName[o.pipelineStageId] || '', source: o.source || '', createdAt: o.createdAt || null }));
  res.json({ ok: true, contact: { id: contact.id, name, firstName: contact.firstName || '', lastName: contact.lastName || '', email: contact.email || '', phone: contact.phone || '', companyName: contact.companyName || '', source: contact.source || '', type: contact.type || '', country: contact.country || '', timezone: contact.timezone || '', dnd: !!contact.dnd, dateAdded: contact.dateAdded || null, dateUpdated: contact.dateUpdated || null, tags: contact.tags || [], customFields }, opportunities });
}));

const BOT_STATUS_FIELD = process.env.BOT_STATUS_FIELD_ID || 'M2ONiagYfBbAJrC9jhgO';
app.post('/api/ghl-set-field', wrap(async (req, res) => {
  const contactId = String((req.body && req.body.contactId) || '').trim();
  const value = String((req.body && req.body.value) != null ? req.body.value : '');
  if (!contactId) return res.json({ ok: false });
  const { json } = await ghl('/contacts/' + encodeURIComponent(contactId), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customFields: [{ id: BOT_STATUS_FIELD, value }] }) });
  res.json({ ok: !!(json && json.contact && json.contact.id), contactId: json && json.contact ? json.contact.id : null });
}));

app.get('/api/handoff', wrap(async (req, res) => {
  const tag = String(req.query.tag || HANDOFF_TAG).trim();
  const { json } = await ghl('/contacts/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locationId: LOCATION_ID, pageLimit: 100, filters: [{ field: 'tags', operator: 'contains', value: tag }] }) });
  const contactIds = ((json && json.contacts) || []).map(c => c.id).filter(Boolean);
  res.json({ ok: true, contactIds });
}));

// ---- envío por WhatsApp ----
app.post('/api/send', wrap(async (req, res) => {
  const b = req.body || {};
  const to = b.to ? String(b.to).replace(/[^\d]/g, '') : null;
  let wamid = null, sent = false;
  if (to && WA_TOKEN && WA_PHONE) {
    const r = await waSend({ messaging_product: 'whatsapp', to, type: 'text', text: { body: b.text || '' } });
    wamid = r.json && r.json.messages && r.json.messages[0] ? r.json.messages[0].id : null; sent = !!wamid;
  }
  const saved = await saveMessage(normalize({ ...b, wamid, type: 'text' }, null, 'out'));
  res.json({ id: saved.id, conversationId: saved.conversationId, status: sent ? 'sent' : 'failed', wamid, sent });
}));

app.post('/api/send-media', upload.single('file'), wrap(async (req, res) => {
  const b = req.body || {};
  const n = normalize(b, req.file, 'out');
  const saved = await saveMessage(n);
  const to = b.to ? String(b.to).replace(/[^\d]/g, '') : (n.phone || null);
  let wamid = null, sent = false;
  const mediaUrl = n.mediaUrl || (saved.id ? originOf(req) + '/api/media?id=' + saved.id : null);
  if (to && WA_TOKEN && WA_PHONE && mediaUrl) {
    const media = { link: mediaUrl };
    if (n.type === 'document') media.filename = n.mediaName || 'documento';
    if (n.text && n.type !== 'audio') media.caption = n.text;
    const waBody = { messaging_product: 'whatsapp', to, type: n.type }; waBody[n.type] = media;
    const r = await waSend(waBody);
    wamid = r.json && r.json.messages && r.json.messages[0] ? r.json.messages[0].id : null; sent = !!wamid;
  }
  res.json({ ok: true, id: saved.id, conversationId: saved.conversationId, wamid, sent });
}));

// ---- estáticos (frontend) ----
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---- arranque ----
migrate().then(() => console.log('[db] migraciones OK')).catch(e => console.error('[db] migración falló:', e.message));
app.listen(PORT, () => console.log(`Dashboard escuchando en :${PORT}`));
