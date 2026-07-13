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
const CLIENT_CHARGE_OUT = Number(process.env.CLIENT_CHARGE_OUT || 0.03); // lo que se cobra por saliente

app.use(express.json({ limit: process.env.JSON_LIMIT || '60mb' }));
app.use(express.urlencoded({ extended: true, limit: '60mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024 } });

// ── Autenticación (Supabase) — módulo reutilizable en auth/ ──────────────────
const authRouter = require('./auth/router');
const { requireAuth, requireAdmin } = require('./auth/middleware');
const { configured: authConfigured, getProfile } = require('./auth/supabase');
// Nombre del agente logueado (para sent_by). Null si no hay sesión.
async function agentName(req) {
  if (!req.user) return null;
  try { const p = await getProfile(req.user.id); return (p && p.full_name) || req.user.email || null; }
  catch (_) { return req.user.email || null; }
}
// Crea una notificación para la app. El índice único (type, ref_id) evita duplicados
// si el escáner corre varias veces sobre el mismo hecho. Devuelve el id o null si ya existía.
async function notify({ type, contactId, conversationId, title, body, refId }) {
  try {
    const r = await q(
      `INSERT INTO notifications (type, contact_id, conversation_id, title, body, ref_id)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (type, ref_id) DO NOTHING RETURNING id`,
      [type, contactId || null, conversationId || null, title, body || null, refId || null]);
    return r.rows[0] ? r.rows[0].id : null;
  } catch (e) { console.error('notify', e.message); return null; }
}
// Clave de lectura por usuario (para saber qué notificaciones ya vio cada uno).
const userKey = req => (req.user && (req.user.id || req.user.email)) || 'anon';

// Registra una acción de la interfaz (apagar bot, cerrar conversación, eliminar).
async function logAction(req, action, contactId, detail) {
  try {
    const name = await agentName(req);
    await q(`INSERT INTO action_logs (action, actor_name, actor_email, contact_id, detail) VALUES ($1,$2,$3,$4,$5)`,
      [action, name, req.user ? req.user.email : null, contactId || null, detail || null]);
  } catch (e) { console.error('logAction', e.message); }
}
app.use('/api/auth', authRouter);
// Endpoints de máquina (n8n / bot) que NO requieren sesión de usuario:
// (/media va abierta: la protege la firma HMAC — <img>/<audio> y Meta no mandan headers)
const OPEN_API = new Set(['/save-in', '/save-out', '/message-cost', '/bot-status', '/health', '/db-setup', '/media']);
app.use('/api', (req, res, next) => {
  if (!authConfigured) return next();                    // sin Supabase configurado: modo abierto (no rompe)
  if (req.path.startsWith('/auth/')) return next();      // el router de auth se protege solo
  if (OPEN_API.has(req.path)) return next();             // integraciones máquina-a-máquina
  return requireAuth(req, res, next);                    // todo lo demás exige sesión
});

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
ALTER TABLE messages ADD COLUMN IF NOT EXISTS execution_ms BIGINT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS label TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(12,6);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS charged_usd NUMERIC(12,6);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sent_by TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conv_contact ON conversations(contact_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_contacts_ghl ON contacts(ghl_contact_id);
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT now());
INSERT INTO app_settings (key, value) VALUES ('bot_enabled', 'true') ON CONFLICT (key) DO NOTHING;
CREATE TABLE IF NOT EXISTS action_logs (id BIGSERIAL PRIMARY KEY, action TEXT, actor_name TEXT, actor_email TEXT, contact_id TEXT, detail TEXT, created_at TIMESTAMPTZ DEFAULT now());
ALTER TABLE action_logs ADD COLUMN IF NOT EXISTS ref_id TEXT;
CREATE INDEX IF NOT EXISTS idx_action_logs_created ON action_logs(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_action_logs_ref ON action_logs(action, ref_id);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS handoff BOOLEAN DEFAULT false;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS handoff_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS handoff_stopped BOOLEAN DEFAULT false;
CREATE TABLE IF NOT EXISTS notifications (id BIGSERIAL PRIMARY KEY, type TEXT NOT NULL, contact_id TEXT, conversation_id BIGINT, title TEXT NOT NULL, body TEXT, ref_id TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_ref ON notifications(type, ref_id);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);
CREATE TABLE IF NOT EXISTS notification_reads (notification_id BIGINT REFERENCES notifications(id) ON DELETE CASCADE, user_key TEXT, read_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (notification_id, user_key));
`;
async function migrate() { await q(MIGRATIONS); }

// --- media pública pero firmada ---
// /api/media NO puede exigir Authorization: las etiquetas <img>/<audio> y la
// Cloud API de Meta (que descarga el adjunto al enviarlo) no mandan headers.
// Se protege con una firma HMAC por id, así la URL no es adivinable.
const crypto = require('crypto');
const MEDIA_SECRET = process.env.MEDIA_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || 'nebo-media-fallback';
const mediaSig = id => crypto.createHmac('sha256', MEDIA_SECRET).update(String(id)).digest('hex').slice(0, 24);
const mediaUrlFor = (req, id) => originOf(req) + '/api/media?id=' + id + '&sig=' + mediaSig(id);

// --- canales soportados (save-in / save-out) ---
const CHANNELS_OK = ['whatsapp', 'instagram', 'facebook', 'pagina_web'];
const CH_ALIAS = {
  wa: 'whatsapp', ig: 'instagram', fb: 'facebook', messenger: 'facebook',
  web: 'pagina_web', website: 'pagina_web', paginaweb: 'pagina_web',
  'pagina-web': 'pagina_web', 'página_web': 'pagina_web', 'página web': 'pagina_web', 'pagina web': 'pagina_web'
};

// --- normalizar + guardar un mensaje (save-in/out y send-media) ---
// Instagram manda las notas de voz como .mp4 (video/mp4). Un mp4 solo-audio no
// tiene pista de vídeo: en el contenedor no aparece el handler 'vide' (sí 'soun').
// Miramos la cabecera del archivo para no pintar un reproductor de vídeo negro.
function esAudioEnMp4(buf, mime) {
  if (!Buffer.isBuffer(buf) || !buf.length) return false;
  const m = String(mime || '').toLowerCase();
  if (!m.includes('mp4') && !m.includes('m4a') && !m.includes('quicktime')) return false;
  const head = buf.subarray(0, Math.min(buf.length, 256 * 1024));   // el moov suele ir al principio o al final
  const tail = buf.subarray(Math.max(0, buf.length - 256 * 1024));
  const tieneVideo = head.includes('vide', 0, 'latin1') || tail.includes('vide', 0, 'latin1');
  const tieneAudio = head.includes('soun', 0, 'latin1') || tail.includes('soun', 0, 'latin1');
  return tieneAudio && !tieneVideo;
}

function normalize(body, file, direction) {
  let ts = body.timestamp;
  if (ts == null || ts === '') ts = Math.floor(Date.now() / 1000);
  else { ts = Number(ts); if (ts > 1e12) ts = Math.floor(ts / 1000); }
  const phone = body.phone ? String(body.phone).replace(/[^\d]/g, '') : null;
  let chRaw = String(body.channel || '').trim().toLowerCase();
  chRaw = CH_ALIAS[chRaw] || chRaw;
  const ch = CHANNELS_OK.includes(chRaw) ? chRaw : 'whatsapp';
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
  // Nota de voz de Instagram: viene marcada como vídeo, pero el mp4 es solo audio.
  if ((type === 'video' || type === 'document') && esAudioEnMp4(mediaData, mediaMime || mediaName)) {
    type = 'audio';
    mediaMime = 'audio/mp4';
  }
  const text = body.text || body.caption || '';
  const LBL = { image: '📷 Imagen', audio: '🎵 Audio', video: '🎬 Video', sticker: '🎯 Sticker', document: '📄 ' + (mediaName || 'Documento') };
  const preview = text || LBL[type] || (hasMedia ? '📎 Adjunto' : '');
  // Tiempo de ejecución (ms) — lo calcula quien llama (n8n) y lo manda en el body.
  let execMs = body.executionMs ?? body.execution_ms ?? body.execMs ?? body.executionTime ?? body.exec_ms;
  execMs = (execMs === '' || execMs == null) ? null : Math.round(Number(execMs));
  if (!Number.isFinite(execMs)) execMs = null;
  // Etiqueta del mensaje: 'primary' (respuesta principal) / 'secondary' (adjuntos
  // como imágenes/PDF enviados en la misma ejecución). La manda quien llama.
  const rawLabel = body.label ?? body.tag ?? body.msgLabel ?? body.priority;
  const label = rawLabel != null && String(rawLabel).trim() !== '' ? String(rawLabel).trim().toLowerCase() : null;
  // Modelo usado (deepseek/haiku) y coste del run en USD — los manda quien llama.
  const model = body.model != null && String(body.model).trim() !== '' ? String(body.model).trim() : null;
  let costUsd = body.costUsd ?? body.cost_usd ?? body.costUSD;
  costUsd = (costUsd === '' || costUsd == null) ? null : Number(costUsd);
  if (!Number.isFinite(costUsd)) costUsd = null;
  return {
    contactId: body.contactId != null ? String(body.contactId) : null,
    name: body.name || null, text, wamid: body.wamid || null, ts, type,
    direction, status: body.status || (direction === 'in' ? 'received' : 'sent'),
    phone, channel: ch, mediaUrl, mediaMime, mediaName, preview, mediaData, executionMs: execMs, label, model, costUsd,
    chargedUsd: direction === 'out' ? CLIENT_CHARGE_OUT : null,
    // Quién envió el saliente: nombre del agente logueado o el que mande quien llama (p.ej. "Camila" desde n8n).
    sentBy: body.sentBy != null && String(body.sentBy).trim() !== '' ? String(body.sentBy).trim() : null
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
INSERT INTO messages (conversation_id, wamid, direction, type, text, status, channel, media_url, media_mime, media_filename, media_data, created_at, execution_ms, label, model, cost_usd, charged_usd, sent_by)
  SELECT conv.id, $4, $7, $6, $3, $8, $10, $11, $12, $13, $15, to_timestamp($5::double precision), $16, $17, $18, $19, $20, $21 FROM conv
  ON CONFLICT (wamid) DO NOTHING RETURNING id, conversation_id;`;

async function saveMessage(n) {
  const params = [n.contactId, n.name, n.text, n.wamid, n.ts, n.type, n.direction, n.status, n.phone, n.channel, n.mediaUrl, n.mediaMime, n.mediaName, n.preview, n.mediaData || null, n.executionMs ?? null, n.label ?? null, n.model ?? null, n.costUsd ?? null, n.chargedUsd ?? null, n.sentBy ?? null];
  const r = await q(SAVE_SQL, params);
  const row = r.rows[0] || {};
  return { id: row.id != null ? String(row.id) : null, conversationId: row.conversation_id != null ? String(row.conversation_id) : null };
}

// ==================== RUTAS API ====================

app.get('/api/db-setup', wrap(async (_req, res) => { await migrate(); res.json({ ok: true, message: 'Tablas creadas correctamente.' }); }));

app.get('/api/conversations', wrap(async (_req, res) => {
  const r = await q(`SELECT conv.id, c.ghl_contact_id, c.name, c.phone, c.email, c.company, c.tags, c.source, c.owner, c.handoff,
      conv.channel, conv.status, conv.starred, conv.unread_count, conv.last_message, conv.last_direction, conv.last_status,
      EXTRACT(EPOCH FROM conv.last_message_at)*1000 AS last_message_at, EXTRACT(EPOCH FROM conv.last_inbound)*1000 AS last_inbound
      FROM conversations conv JOIN contacts c ON c.id = conv.contact_id
      ORDER BY c.handoff DESC NULLS LAST, conv.last_message_at DESC NULLS LAST`);
  const conversations = r.rows.map(row => {
    const nm = row.name || row.phone || '?';
    return {
      id: String(row.id), contactId: row.ghl_contact_id || null, name: nm, phone: row.phone,
      avatar: { initials: initials(nm), color: colorFor(nm) }, channel: row.channel || 'whatsapp',
      lastMessage: row.last_message || '', lastMessageAt: Number(row.last_message_at) || 0,
      lastDirection: row.last_direction || 'in', lastStatus: row.last_status || 'received',
      unreadCount: Number(row.unread_count) || 0, starred: !!row.starred, status: row.status || 'open',
      lastInbound: Number(row.last_inbound) || 0, handoff: !!row.handoff,
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
      (media_data IS NOT NULL) AS has_blob, status, channel, sent_by, EXTRACT(EPOCH FROM created_at)*1000 AS timestamp
      FROM messages WHERE conversation_id=$1::bigint ORDER BY created_at ASC`, [id]);
  const base = originOf(req);
  const messages = r.rows.map(m => {
    let mediaUrl = m.media_url || null;
    if (!mediaUrl && m.has_blob) mediaUrl = mediaUrlFor(req, m.id);
    return {
      id: String(m.id), conversationId: String(m.conversation_id), direction: m.direction, type: m.type || 'text',
      text: m.text || '', template: m.template || null, mediaUrl, mediaMime: m.media_mime || null,
      mediaFilename: m.media_filename || null, timestamp: Number(m.timestamp) || 0, status: m.status || 'received', channel: m.channel || 'whatsapp',
      sentBy: m.sent_by || null
    };
  });
  res.json({ messages });
}));

app.get('/api/media', wrap(async (req, res) => {
  const id = String(req.query.id || '');
  if (!id) return res.status(400).end();
  if (String(req.query.sig || '') !== mediaSig(id)) return res.status(403).end();  // URL firmada
  const r = await q(`SELECT media_data, media_mime, media_filename FROM messages WHERE id=$1::bigint AND media_data IS NOT NULL`, [id]);
  const row = r.rows[0];
  if (!row || !row.media_data) return res.status(404).end();
  res.set('Content-Type', row.media_mime || 'application/octet-stream');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(row.media_data);
}));

app.post('/api/save-in', upload.single('file'), wrap(async (req, res) => {
  const n = normalize(req.body || {}, req.file, 'in');
  const saved = await saveMessage(n);
  res.json({ ok: true, ...saved });
  // Si nadie automático va a contestar (handoff o bot apagado), avisamos en la app.
  try {
    if (!n.contactId) return;
    const c = await q(`SELECT name, phone, handoff FROM contacts WHERE ghl_contact_id = $1 LIMIT 1`, [n.contactId]);
    const row = c.rows[0]; if (!row) return;
    const botOn = await getFlag();
    if (!row.handoff && botOn) return;
    await notify({
      type: 'inbound', contactId: n.contactId, conversationId: saved.conversationId,
      title: 'Mensaje de ' + (row.name || row.phone || 'contacto'),
      body: (n.text || '[adjunto]').slice(0, 120) + (row.handoff ? ' — en handoff' : ' — bot apagado'),
      refId: n.wamid || String(saved.id)
    });
  } catch (e) { console.error('save-in notify', e.message); }
}));
app.post('/api/save-out', upload.single('file'), wrap(async (req, res) => {
  const n = normalize(req.body || {}, req.file, 'out');
  if (!n.sentBy) n.sentBy = process.env.BOT_NAME || 'Camila';   // por defecto, el bot es Camila
  res.json({ ok: true, ...(await saveMessage(n)) });
}));

// Actualiza modelo/coste/tiempo de un mensaje YA guardado, por wamid. Lo usa el
// workflow de "costo IA" que corre DESPUÉS de terminar la ejecución (cuando el
// runData de n8n ya está completo y se pueden leer los tokens). Solo escribe los
// campos que llegan (COALESCE), así no borra lo ya guardado.
app.post('/api/message-cost', wrap(async (req, res) => {
  const b = req.body || {};
  const wamid = b.wamid ? String(b.wamid) : null;
  if (!wamid) return res.status(400).json({ ok: false, error: 'wamid requerido' });
  const model = b.model != null && String(b.model).trim() !== '' ? String(b.model).trim() : null;
  let costUsd = b.costUsd ?? b.cost_usd; costUsd = (costUsd === '' || costUsd == null) ? null : Number(costUsd);
  if (!Number.isFinite(costUsd)) costUsd = null;
  let execMs = b.executionMs ?? b.execution_ms; execMs = (execMs === '' || execMs == null) ? null : Math.round(Number(execMs));
  if (!Number.isFinite(execMs)) execMs = null;
  const r = await q(
    `UPDATE messages SET model = COALESCE($2, model), cost_usd = COALESCE($3, cost_usd),
        execution_ms = COALESCE($4, execution_ms)
     WHERE wamid = $1 RETURNING id`, [wamid, model, costUsd, execMs]);
  res.json({ ok: true, updated: r.rowCount });
}));

app.post('/api/delete-conversation', wrap(async (req, res) => {
  const id = String((req.body && req.body.conversationId) || '').replace(/[^0-9]/g, '');
  const cr = await q(`SELECT c.ghl_contact_id FROM conversations cv JOIN contacts c ON c.id=cv.contact_id WHERE cv.id=(NULLIF($1,''))::bigint`, [id]);
  const cid = cr.rows[0] ? cr.rows[0].ghl_contact_id : null;
  const r = await q(`DELETE FROM conversations WHERE id=(NULLIF($1,''))::bigint RETURNING id`, [id]);
  const row = r.rows[0];
  if (row) await logAction(req, 'conv_delete', cid, 'Eliminó la conversación');
  res.json({ ok: true, deleted: !!row, id: row ? String(row.id) : null });
}));

// ---- bot flag ----
async function getFlag() { const r = await q(`SELECT value FROM app_settings WHERE key='bot_enabled'`); const v = r.rows[0] && r.rows[0].value; return v == null ? true : String(v) === 'true'; }
app.get('/api/bot-state', wrap(async (_req, res) => res.json({ ok: true, active: await getFlag() })));
app.get('/api/bot-enabled', wrap(async (_req, res) => res.json({ enabled: await getFlag() })));
app.post('/api/bot-set', wrap(async (req, res) => {
  const val = asBool(req.body && req.body.active) ? 'true' : 'false';
  await q(`INSERT INTO app_settings (key,value,updated_at) VALUES ('bot_enabled',$1,now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [val]);
  await logAction(req, val === 'true' ? 'bot_on' : 'bot_off', null, val === 'true' ? 'Encendió el bot' : 'Apagó el bot');
  res.json({ ok: true, active: val === 'true' });
}));

// Estado combinado por contacto: ¿debe responder el bot a esta persona?
// Junta el flag global, el handoff (tag en GHL), si su conversación está abierta
// y si está dentro de la ventana de 24h de WhatsApp. `shouldReply` ya viene listo
// para un IF en n8n.
app.get('/api/bot-status', wrap(async (req, res) => {
  const contactId = String(req.query.contactId || '').trim();
  const botActive = await getFlag();

  let handoff = false, conversationOpen = true, botStatus = '', lastInboundAt = null;
  if (contactId) {
    // ventana 24h de WhatsApp (desde el último entrante en la DB)
    const r = await q(
      `SELECT EXTRACT(EPOCH FROM conv.last_inbound)*1000 AS last_inbound
       FROM conversations conv JOIN contacts c ON c.id = conv.contact_id
       WHERE c.ghl_contact_id = $1 LIMIT 1`, [contactId]);
    if (r.rows.length && r.rows[0].last_inbound != null) lastInboundAt = Number(r.rows[0].last_inbound);

    // GHL: tags (handoff) + custom field bot_status (botón Abierta/Cerrada a mano).
    // bot_status = 'STOP' => conversación cerrada (bot detenido); vacío => abierta.
    try {
      const { json } = await ghl('/contacts/' + encodeURIComponent(contactId));
      const contact = (json && json.contact) || {};
      const tags = contact.tags || [];
      handoff = tags.map(t => String(t).toLowerCase()).includes(String(HANDOFF_TAG).toLowerCase());
      const cf = (contact.customFields || []).find(f => f && f.id === BOT_STATUS_FIELD);
      botStatus = cf && cf.value != null ? String(cf.value) : '';
      conversationOpen = botStatus.toUpperCase() !== 'STOP';
    } catch (_) { /* si GHL falla, no bloquea al bot */ }
  }

  const withinWindow = lastInboundAt != null ? (Date.now() - lastInboundAt) < 24 * 3600 * 1000 : true;
  const shouldReply = botActive && !handoff && conversationOpen;
  res.json({ ok: true, contactId: contactId || null, botActive, handoff, conversationOpen, botStatus, lastInboundAt, withinWindow, shouldReply });
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
// Escribe el custom field bot_status en GHL. 'STOP' = conversación cerrada (el bot
// no responde a ESE contacto). Es el mismo campo que mueve el botón de la interfaz.
async function setBotStatus(contactId, value) {
  const { json } = await ghl('/contacts/' + encodeURIComponent(contactId), {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customFields: [{ id: BOT_STATUS_FIELD, value }] })
  });
  return !!(json && json.contact && json.contact.id);
}
app.post('/api/ghl-set-field', wrap(async (req, res) => {
  const contactId = String((req.body && req.body.contactId) || '').trim();
  const value = String((req.body && req.body.value) != null ? req.body.value : '');
  if (!contactId) return res.json({ ok: false });
  const { json } = await ghl('/contacts/' + encodeURIComponent(contactId), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customFields: [{ id: BOT_STATUS_FIELD, value }] }) });
  const closed = String(value).toUpperCase() === 'STOP';
  await logAction(req, closed ? 'conv_close' : 'conv_open', contactId, closed ? 'Cerró la conversación' : 'Abrió la conversación');
  res.json({ ok: !!(json && json.contact && json.contact.id), contactId: json && json.contact ? json.contact.id : null });
}));

// Contactos con la etiqueta handoff. Sirve del cache en DB (lo mantiene scanHandoff);
// con ?refresh=1 fuerza una consulta a GHL antes de responder.
app.get('/api/handoff', wrap(async (req, res) => {
  if (asBool(req.query.refresh)) await scanHandoff();
  const r = await q(`SELECT ghl_contact_id FROM contacts WHERE handoff = true AND ghl_contact_id IS NOT NULL`);
  res.json({ ok: true, contactIds: r.rows.map(x => x.ghl_contact_id) });
}));

// ---- notificaciones ----
app.get('/api/notifications', wrap(async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 40));
  const r = await q(
    `SELECT n.id, n.type, n.contact_id, n.conversation_id, n.title, n.body,
            EXTRACT(EPOCH FROM n.created_at)*1000 AS created_at,
            (nr.notification_id IS NOT NULL) AS read
     FROM notifications n
     LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_key = $1
     WHERE n.created_at > now() - interval '7 days'
     ORDER BY n.created_at DESC LIMIT $2`, [userKey(req), limit]);
  const items = r.rows.map(n => ({
    id: String(n.id), type: n.type, contactId: n.contact_id || null,
    conversationId: n.conversation_id != null ? String(n.conversation_id) : null,
    title: n.title, body: n.body || '', createdAt: Number(n.created_at) || 0, read: !!n.read
  }));
  res.json({ ok: true, items, unread: items.filter(i => !i.read).length });
}));

app.post('/api/notifications/read', wrap(async (req, res) => {
  const uk = userKey(req);
  const b = req.body || {};
  if (asBool(b.all)) {
    await q(`INSERT INTO notification_reads (notification_id, user_key)
             SELECT id, $1 FROM notifications WHERE created_at > now() - interval '7 days'
             ON CONFLICT DO NOTHING`, [uk]);
  } else {
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(n => Number.isFinite(n) && n > 0);
    if (ids.length) {
      await q(`INSERT INTO notification_reads (notification_id, user_key)
               SELECT unnest($2::bigint[]), $1 ON CONFLICT DO NOTHING`, [uk, ids]);
    }
  }
  res.json({ ok: true });
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
  const n = normalize({ ...b, wamid, type: 'text' }, null, 'out');
  n.sentBy = await agentName(req);   // quién lo envió (agente logueado)
  const saved = await saveMessage(n);
  res.json({ id: saved.id, conversationId: saved.conversationId, status: sent ? 'sent' : 'failed', wamid, sent });
}));

app.post('/api/send-media', upload.single('file'), wrap(async (req, res) => {
  const b = req.body || {};
  const n = normalize(b, req.file, 'out');
  n.sentBy = await agentName(req);   // quién lo envió (agente logueado)
  const saved = await saveMessage(n);
  const to = b.to ? String(b.to).replace(/[^\d]/g, '') : (n.phone || null);
  let wamid = null, sent = false;
  const mediaUrl = n.mediaUrl || (saved.id ? mediaUrlFor(req, saved.id) : null);   // firmada: Meta la descarga sin auth
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
// Usuarios de GHL (para vincularlos a un login desde el panel admin). Solo admin.
app.get('/api/ghl-users', requireAdmin, wrap(async (_req, res) => {
  const { json } = await ghl(`/users/?locationId=${encodeURIComponent(LOCATION_ID)}`);
  const users = ((json && json.users) || []).map(u => ({
    id: u.id,
    name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.name || u.email || u.id,
    email: u.email || ''
  }));
  res.json({ users });
}));

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---- arranque ----
migrate().then(() => console.log('[db] migraciones OK')).catch(e => console.error('[db] migración falló:', e.message));
// ── Alerta: entrante sin respuesta tras N minutos ─────────────────────────────
// Revisa el ÚLTIMO entrante de cada conversación; si lleva más de NO_REPLY_MINUTES
// sin ningún saliente posterior, deja un registro. El índice único (action, ref_id)
// garantiza una sola alerta por mensaje, aunque el escáner corra muchas veces.
const NO_REPLY_MIN = Number(process.env.NO_REPLY_MINUTES || 10);
async function scanNoReply() {
  try {
    const r = await q(`
      WITH last_in AS (
        SELECT DISTINCT ON (conversation_id) id, conversation_id, created_at
        FROM messages
        WHERE direction='in' AND created_at > now() - interval '24 hours'
        ORDER BY conversation_id, created_at DESC
      ),
      pending AS (
        SELECT li.id, li.created_at, c.ghl_contact_id
        FROM last_in li
        JOIN conversations cv ON cv.id = li.conversation_id
        JOIN contacts c ON c.id = cv.contact_id
        WHERE li.created_at < now() - make_interval(mins => $1::int)
          AND NOT EXISTS (
            SELECT 1 FROM messages o
            WHERE o.conversation_id = li.conversation_id AND o.direction = 'out' AND o.created_at > li.created_at)
      )
      INSERT INTO action_logs (action, contact_id, detail, ref_id)
      SELECT 'no_reply', p.ghl_contact_id,
             'Entrante sin respuesta tras ' || $1 || ' min',
             p.id::text
      FROM pending p
      ON CONFLICT (action, ref_id) DO NOTHING
      RETURNING contact_id, ref_id`, [NO_REPLY_MIN]);
    if (r.rowCount) console.log('[no-reply] nuevas alertas:', r.rowCount);
    // Cada alerta nueva genera además una notificación en la app.
    for (const row of r.rows) {
      const who = await q(
        `SELECT cv.id AS conv_id, ct.name, ct.phone FROM contacts ct
         LEFT JOIN conversations cv ON cv.contact_id = ct.id WHERE ct.ghl_contact_id = $1 LIMIT 1`, [row.contact_id]);
      const c = who.rows[0] || {};
      await notify({
        type: 'no_reply', contactId: row.contact_id, conversationId: c.conv_id || null,
        title: 'Sin respuesta: ' + (c.name || c.phone || 'contacto'),
        body: `Lleva más de ${NO_REPLY_MIN} min sin recibir respuesta`, refId: row.ref_id
      });
    }
  } catch (e) { console.error('scanNoReply', e.message); }
}
setInterval(scanNoReply, 2 * 60 * 1000);   // cada 2 minutos
setTimeout(scanNoReply, 15 * 1000);        // primera pasada al arrancar

// ── Handoff: sincroniza la etiqueta de GHL con la DB y notifica los nuevos ────
// Guarda el estado en contacts.handoff para que la lista pueda fijar y pintar de
// rojo esas conversaciones sin depender de GHL en cada carga.
async function scanHandoff() {
  if (!GHL_PIT || !LOCATION_ID) return;
  try {
    const { json } = await ghl('/contacts/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locationId: LOCATION_ID, pageLimit: 100, filters: [{ field: 'tags', operator: 'contains', value: HANDOFF_TAG }] })
    });
    if (!json || !Array.isArray(json.contacts)) return;   // GHL falló: no tocamos el estado
    const ids = json.contacts.map(c => c.id).filter(Boolean);

    // 1) Nuevos: los que tienen la etiqueta y aún no estaban marcados → notificación.
    const nuevos = await q(
      `UPDATE contacts SET handoff = true, handoff_at = now()
       WHERE ghl_contact_id = ANY($1::text[]) AND handoff IS NOT TRUE
       RETURNING id, ghl_contact_id, name, phone`, [ids]);
    for (const c of nuevos.rows) {
      const cv = await q(`SELECT id FROM conversations WHERE contact_id = $1 LIMIT 1`, [c.id]);
      await notify({
        type: 'handoff', contactId: c.ghl_contact_id, conversationId: cv.rows[0] ? cv.rows[0].id : null,
        title: 'Handoff: ' + (c.name || c.phone || 'contacto'),
        body: 'Requiere atención humana — se apaga el bot para este contacto',
        refId: c.ghl_contact_id + ':' + Date.now()
      });
    }
    if (nuevos.rowCount) console.log('[handoff] nuevos:', nuevos.rowCount);

    // 2) Apaga el bot PARA ESE CONTACTO (bot_status = STOP en GHL), igual que el botón
    //    "Conversación cerrada" de la interfaz. NO toca el bot global. Si GHL falla,
    //    handoff_stopped sigue en false y se reintenta en la siguiente pasada.
    const pendientes = await q(
      `SELECT ghl_contact_id, EXTRACT(EPOCH FROM handoff_at)::bigint AS since FROM contacts
       WHERE handoff = true AND handoff_stopped IS NOT TRUE AND ghl_contact_id IS NOT NULL`);
    for (const c of pendientes.rows) {
      try {
        if (!await setBotStatus(c.ghl_contact_id, 'STOP')) continue;   // reintenta al siguiente ciclo
        await q(`UPDATE contacts SET handoff_stopped = true WHERE ghl_contact_id = $1`, [c.ghl_contact_id]);
        await q(`INSERT INTO action_logs (action, actor_name, contact_id, detail, ref_id)
                 VALUES ('conv_close', 'Sistema (handoff)', $1,
                         'Bot apagado automáticamente al recibir la etiqueta handoff', $2)
                 ON CONFLICT (action, ref_id) DO NOTHING`,
          [c.ghl_contact_id, 'handoff:' + c.ghl_contact_id + ':' + (c.since || 0)]);
        console.log('[handoff] bot apagado para', c.ghl_contact_id);
      } catch (e) { console.error('handoff setBotStatus', c.ghl_contact_id, e.message); }
    }

    // 3) Los que ya no tienen la etiqueta vuelven a la normalidad. La conversación se
    //    queda cerrada a propósito: reabrirla es decisión del agente (botón de la app).
    await q(`UPDATE contacts SET handoff = false, handoff_at = NULL, handoff_stopped = false
             WHERE handoff = true AND NOT (ghl_contact_id = ANY($1::text[]))`, [ids]);
  } catch (e) { console.error('scanHandoff', e.message); }
}
setInterval(scanHandoff, 60 * 1000);       // cada minuto
setTimeout(scanHandoff, 5 * 1000);         // primera pasada al arrancar

app.listen(PORT, () => console.log(`Dashboard escuchando en :${PORT}`));
