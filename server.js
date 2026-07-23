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
const { waHash } = require('./wahash');

const app = express();
app.set('trust proxy', true);   // Railway termina el TLS: sin esto req.protocol siempre sería 'http'
const PORT = process.env.PORT || 8080;

// --- config (variables de entorno) ---
const GHL_PIT = process.env.GHL_PIT || '';
const LOCATION_ID = process.env.LOCATION_ID || '';
const WA_TOKEN = process.env.WHATSAPP_TOKEN || '';
const WA_PHONE = process.env.WHATSAPP_PHONE_ID || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const HANDOFF_TAG = process.env.HANDOFF_TAG || 'handoff';
const CLIENT_CHARGE_OUT = Number(process.env.CLIENT_CHARGE_OUT || 0.03); // lo que se cobra por saliente
// Tickets → project-manager. La API key NO va al cliente: se queda aquí.
const TICKETS_URL = process.env.TICKETS_URL || 'https://project-manager-production-1787.up.railway.app/api/ingest/tasks';
const TICKETS_API_KEY = process.env.TICKETS_API_KEY || '';

// ── CORS para la app móvil ───────────────────────────────────────────────────
// La app de Capacitor no se sirve desde este dominio: en Android llega como
// https://localhost y en iOS como capacitor://localhost. Sin esto, el navegador
// embebido bloquea todas las llamadas al API. La web propia va por mismo origen
// y no manda Origin, así que no se ve afectada.
const CORS_OK = new Set([
  'capacitor://localhost',            // iOS
  'ionic://localhost',
  'http://localhost',                 // Android (WebView)
  'https://localhost',
  ...String(process.env.CORS_EXTRA || '').split(',').map(s => s.trim()).filter(Boolean)
]);
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && (CORS_OK.has(origin) || /^https?:\/\/localhost(:\d+)?$/.test(origin))) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-dashboard-token');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.set('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);   // preflight
  next();
});

app.use(express.json({ limit: process.env.JSON_LIMIT || '60mb' }));
app.use(express.urlencoded({ extended: true, limit: '60mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024 } });

// ── Autenticación (Supabase) — módulo reutilizable en auth/ ──────────────────
const authRouter = require('./auth/router');
const { requireAuth, requireAdmin, requirePlatform } = require('./auth/middleware');
const { configured: authConfigured, getProfile } = require('./auth/supabase');
// Nombre del agente logueado (para sent_by). Null si no hay sesión.
async function agentName(req) {
  if (!req.user) return null;
  try { const p = await getProfile(req.user.id); return (p && p.full_name) || req.user.email || null; }
  catch (_) { return req.user.email || null; }
}
// Crea una notificación para la app. El índice único (type, ref_id) evita duplicados
// si el escáner corre varias veces sobre el mismo hecho. Devuelve el id o null si ya existía.
async function notify({ type, contactId, conversationId, title, body, refId, userId }) {
  try {
    const r = await q(
      `INSERT INTO notifications (type, contact_id, conversation_id, title, body, ref_id, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (type, ref_id) DO NOTHING RETURNING id`,
      [type, contactId || null, conversationId || null, title, body || null, refId || null, userId || null]);
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
const OPEN_API = new Set(['/save-in', '/save-out', '/message-cost', '/bot-status', '/health', '/db-setup', '/media', '/tickets/webhook']);
// /tickets es soporte transversal: cualquiera con sesión puede crear uno, aunque
// no tenga acceso a la plataforma del inbox.
const SIN_PLATAFORMA = new Set(['/tickets']);
app.use('/api', (req, res, next) => {
  if (!authConfigured) return next();                    // sin Supabase configurado: modo abierto (no rompe)
  if (req.path.startsWith('/auth/')) return next();      // el router de auth se protege solo
  if (OPEN_API.has(req.path)) return next();             // integraciones máquina-a-máquina
  requireAuth(req, res, () => {                          // exige sesión…
    if (SIN_PLATAFORMA.has(req.path)) return next();
    requirePlatform('inbox')(req, res, next);            // …y acceso a la plataforma inbox
  });
});

// --- helpers ---
const COLORS = ['#2f6df6', '#e2497a', '#1aa179', '#f59e0b', '#7c3aed', '#0ea5e9', '#ef4444', '#10b981'];
function colorFor(n) { n = n || '?'; let h = 0; for (let i = 0; i < n.length; i++) h = n.charCodeAt(i) + ((h << 5) - h); return COLORS[Math.abs(h) % COLORS.length]; }
function initials(n) { return (n || '?').split(' ').slice(0, 2).map(w => w[0] || '').join('').toUpperCase(); }
const asBool = v => (v === true || v === 'true' || v === 1 || v === '1');
// OJO con el esquema: detrás del proxy de Railway, req.protocol es 'http' aunque el
// usuario navegue por https. Si construimos las URLs de los adjuntos con http, Chrome
// las trata como contenido mixto: las imágenes las auto-corrige, pero el <iframe> del
// visor de PDF lo BLOQUEA (se ve un recuadro en blanco). Hacemos caso a x-forwarded-proto.
function originOf(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
  return proto + '://' + req.get('host');
}
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
// Llamada genérica a la Graph API con el token de WhatsApp.
async function graph(pathname) {
  const sep = pathname.includes('?') ? '&' : '?';
  const res = await fetch('https://graph.facebook.com/v21.0' + pathname + sep + 'access_token=' + encodeURIComponent(WA_TOKEN));
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json };
}
// Mensaje de error legible que devuelve Meta (para enseñárselo al agente tal cual).
const metaError = j => (j && j.error && (j.error.error_user_msg || j.error.message)) || 'Error de Meta';
// Ídem para GHL, que devuelve el error de tres formas distintas: texto, array de
// textos, u objeto anidado ({"message":{"error":"Contact ... not found"}}).
const ghlError = (j, status) => {
  let m = j && (j.message || j.error);
  if (Array.isArray(m)) return m.join('; ');
  if (m && typeof m === 'object') m = m.error || m.message || JSON.stringify(m);
  return m || ('GHL respondió ' + status);
};

// ── Envío por GoHighLevel (Instagram, Facebook y live chat de la web) ────────
// WhatsApp sigue saliendo por la Cloud API de Meta; el resto de canales van por la
// API de conversaciones de GHL, que es quien tiene conectadas esas bandejas.
const GHL_MSG_TYPE = { instagram: 'IG', facebook: 'FB', pagina_web: 'Live_Chat', whatsapp: 'WhatsApp' };
async function ghlSendMessage({ channel, contactId, text, attachments }) {
  const type = GHL_MSG_TYPE[channel];
  if (!type) return { ok: false, error: 'Canal no soportado: ' + channel };
  if (!contactId) return { ok: false, error: 'El contacto no tiene ID de GoHighLevel' };
  if (!GHL_PIT) return { ok: false, error: 'Falta el token de GoHighLevel' };

  const body = { type, contactId };
  if (text) body.message = text;
  if (attachments && attachments.length) body.attachments = attachments;

  // La API de conversaciones usa otra versión de cabecera que el resto de GHL.
  const { ok, status, json } = await ghl('/conversations/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Version: '2021-04-15' },
    body: JSON.stringify(body)
  });
  const messageId = json && (json.messageId ||
    (Array.isArray(json.messageIds) && json.messageIds[0]) ||
    (json.msg && json.msg.id));
  if (!ok || !messageId) return { ok: false, error: ghlError(json, status) };
  return { ok: true, messageId: String(messageId), conversationId: json.conversationId || null };
}

// ── Plantillas de Meta ───────────────────────────────────────────────────────
// El id de la cuenta de WhatsApp (WABA) hace falta para listar plantillas. Si no
// está en el entorno lo deducimos del propio token (debug_token nos dice sobre qué
// WABA tiene permisos) y lo cacheamos.
// Cuenta de WhatsApp Business (WABA) de Nebo. No es un secreto (es un id), así que
// va como valor por defecto; se puede sobreescribir con WHATSAPP_WABA_ID.
let _waba = process.env.WHATSAPP_WABA_ID || '403775332809575';
async function wabaId() {
  if (_waba) return _waba;
  if (!WA_TOKEN) return '';
  const { json } = await graph(`/debug_token?input_token=${encodeURIComponent(WA_TOKEN)}`);
  const scopes = (json && json.data && json.data.granular_scopes) || [];
  for (const s of scopes) {
    if (/whatsapp_business/.test(s.scope || '') && Array.isArray(s.target_ids) && s.target_ids.length) {
      _waba = String(s.target_ids[0]);
      console.log('[wa] WABA detectada desde el token:', _waba);
      return _waba;
    }
  }
  return '';
}
// Saca las variables {{1}}, {{2}}… de un texto, ordenadas y sin repetir.
function varsOf(s) {
  const set = new Set();
  String(s || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, n) => { set.add(Number(n)); return _m; });
  return [...set].sort((a, b) => a - b);
}
// Traduce la plantilla de Meta a algo que la interfaz pueda pintar y rellenar.
function parseTemplate(t) {
  const comps = t.components || [];
  const head = comps.find(c => c.type === 'HEADER');
  const body = comps.find(c => c.type === 'BODY');
  const foot = comps.find(c => c.type === 'FOOTER');
  const btns = (comps.find(c => c.type === 'BUTTONS') || {}).buttons || [];
  return {
    name: t.name, language: t.language, category: t.category, status: t.status,
    header: head ? { format: head.format || 'TEXT', text: head.text || '', vars: varsOf(head.text) } : null,
    body: { text: (body && body.text) || '', vars: varsOf(body && body.text) },
    footer: (foot && foot.text) || '',
    buttons: btns.map((b, i) => ({ index: i, type: b.type, text: b.text || '', url: b.url || '', vars: varsOf(b.url) }))
  };
}
// Sustituye {{n}} por los valores dados (para guardar el texto real en el historial).
function fillVars(text, params) {
  return String(text || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, n) => {
    const v = params[Number(n) - 1];
    return v != null && v !== '' ? String(v) : _m;
  });
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
-- Ingesta de replies (contrato n8n): hash estable del wamid para resolver citas,
-- wamid citado y su hash, y la marca de tiempo real del mensaje. Todo NULLABLE:
-- compatible con el código viejo y con payloads que no traigan estos campos.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_hash TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS context_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS context_hash TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_conv_sent ON messages(conversation_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_messages_hash ON messages(message_hash);
CREATE INDEX IF NOT EXISTS idx_messages_context_hash ON messages(context_hash);
-- Backfill idempotente: el histórico ordena por created_at (sent_at queda igual).
-- Reversible (UPDATE messages SET sent_at = NULL). Tras la primera pasada no toca filas.
UPDATE messages SET sent_at = created_at WHERE sent_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_conv_contact ON conversations(contact_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_contacts_ghl ON contacts(ghl_contact_id);
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT now());
INSERT INTO app_settings (key, value) VALUES ('bot_enabled', 'true') ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('handoff_auto_return_mins', '0') ON CONFLICT (key) DO NOTHING;
CREATE TABLE IF NOT EXISTS action_logs (id BIGSERIAL PRIMARY KEY, action TEXT, actor_name TEXT, actor_email TEXT, contact_id TEXT, detail TEXT, created_at TIMESTAMPTZ DEFAULT now());
ALTER TABLE action_logs ADD COLUMN IF NOT EXISTS ref_id TEXT;
CREATE INDEX IF NOT EXISTS idx_action_logs_created ON action_logs(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_action_logs_ref ON action_logs(action, ref_id);
-- Dispositivos extra conectados por QR (WhatsApp Web). El dispositivo NULL es el
-- principal: Camila por la Cloud API oficial, que sigue funcionando igual.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS device_id TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS device_id TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_device ON messages(device_id);
CREATE INDEX IF NOT EXISTS idx_conv_device ON conversations(device_id);
CREATE TABLE IF NOT EXISTS wa_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'nuevo',      -- nuevo | qr | conectado | desconectado
  qr TEXT,                                    -- último QR (mientras se empareja)
  last_seen TIMESTAMPTZ,
  n8n_url TEXT,
  creds JSONB,                                -- estado de sesión (sobrevive a reinicios)
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS handoff BOOLEAN DEFAULT false;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS handoff_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS handoff_stopped BOOLEAN DEFAULT false;
CREATE TABLE IF NOT EXISTS notifications (id BIGSERIAL PRIMARY KEY, type TEXT NOT NULL, contact_id TEXT, conversation_id BIGINT, title TEXT NOT NULL, body TEXT, ref_id TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_ref ON notifications(type, ref_id);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);
CREATE TABLE IF NOT EXISTS notification_reads (notification_id BIGINT REFERENCES notifications(id) ON DELETE CASCADE, user_key TEXT, read_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (notification_id, user_key));
-- Notificaciones dirigidas a un usuario concreto (null = global, la ven todos).
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS user_id TEXT;
-- Tickets de soporte enviados al project-manager (para verlos y saber su estado).
CREATE TABLE IF NOT EXISTS tickets (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  priority TEXT,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'nuevo',      -- nuevo | en_progreso | completado
  origin TEXT, app TEXT,
  user_id TEXT, user_email TEXT, user_name TEXT,
  external_id TEXT,                           -- id de la tarea en el project-manager
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_ext ON tickets(external_id);
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
  // sentAt (ISO-8601 UTC) es la marca real del mensaje que mandan los workflows nuevos.
  // save-in trae el timestamp de Meta (precisión de 1s); save-out el reloj de n8n (ms).
  // Se conserva en segundos (con decimales, para no perder los ms del saliente).
  // OJO: sentAt SOLO alimenta la columna sent_at (que usa /api/messages para ordenar el
  // hilo). NO toca `ts` → created_at y last_message_at siguen siendo hora de escritura
  // (monótona), igual que hoy. Desacoplados a propósito: la lista y scanNoReply no cambian.
  let sentAtEpoch = null;
  if (body.sentAt != null && body.sentAt !== '') {
    const ms = Date.parse(body.sentAt);
    if (Number.isFinite(ms)) sentAtEpoch = ms / 1000;
  }
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
  // Id del mensaje: los workflows nuevos mandan `messageId`; se mantiene `wamid` como
  // alias para no romper nada de lo viejo (ni el send/plantillas que ya lo usan).
  const wamid = body.messageId || body.wamid || null;
  // Wamid citado (reply). El multipart lo manda como "" cuando no es reply: se normaliza a null.
  const rawCtx = body.contextId;
  const contextId = (rawCtx != null && String(rawCtx).trim() !== '') ? String(rawCtx).trim() : null;
  return {
    contactId: body.contactId != null ? String(body.contactId) : null,
    name: body.name || null, text, wamid, ts, type,
    direction, status: body.status || (direction === 'in' ? 'received' : 'sent'),
    phone, channel: ch, mediaUrl, mediaMime, mediaName, preview, mediaData, executionMs: execMs, label, model, costUsd,
    chargedUsd: direction === 'out' ? CLIENT_CHARGE_OUT : null,
    // Quién envió el saliente: nombre del agente logueado o el que mande quien llama (p.ej. "Camila" desde n8n).
    sentBy: body.sentBy != null && String(body.sentBy).trim() !== '' ? String(body.sentBy).trim() : null,
    // Dispositivo QR del que viene/sale el mensaje. null = el principal (Camila, Cloud API).
    deviceId: body.deviceId != null && String(body.deviceId).trim() !== '' ? String(body.deviceId).trim() : null,
    // Resolución de replies: se matchea por hash estable, nunca por id crudo. Ver wahash.js.
    messageHash: waHash(wamid), contextId, contextHash: waHash(contextId),
    // Marca real del mensaje (para ordenar). Null si el payload no la trae → el ORDER BY degrada a created_at.
    sentAt: sentAtEpoch
  };
}

const SAVE_SQL = `
WITH existing AS (SELECT id FROM contacts WHERE ($1::text IS NOT NULL AND ghl_contact_id = $1::text) OR ($9::text IS NOT NULL AND phone = $9::text) ORDER BY CASE WHEN ghl_contact_id = $1::text THEN 0 ELSE 1 END LIMIT 1),
upd AS (UPDATE contacts SET ghl_contact_id = COALESCE(contacts.ghl_contact_id, $1), name = COALESCE($2, contacts.name), phone = COALESCE($9, contacts.phone) WHERE id = (SELECT id FROM existing) RETURNING id),
ins AS (INSERT INTO contacts (ghl_contact_id, name, phone) SELECT $1, $2, $9 WHERE NOT EXISTS (SELECT 1 FROM existing) RETURNING id),
c AS (SELECT id FROM upd UNION ALL SELECT id FROM ins),
conv AS (INSERT INTO conversations (contact_id, channel, device_id, last_message, last_message_at, last_direction, last_status, last_inbound, unread_count, status, updated_at)
  SELECT c.id, $10, $26, $14, to_timestamp($5::double precision), $7, $8, CASE WHEN $7='in' THEN to_timestamp($5::double precision) ELSE NULL END, CASE WHEN $7='in' THEN 1 ELSE 0 END, 'open', now() FROM c
  ON CONFLICT (contact_id) DO UPDATE SET channel=EXCLUDED.channel, device_id=EXCLUDED.device_id, last_message=EXCLUDED.last_message, last_message_at=EXCLUDED.last_message_at, last_direction=EXCLUDED.last_direction, last_status=EXCLUDED.last_status,
    last_inbound=CASE WHEN EXCLUDED.last_direction='in' THEN EXCLUDED.last_message_at ELSE conversations.last_inbound END,
    unread_count=CASE WHEN EXCLUDED.last_direction='in' THEN conversations.unread_count+1 ELSE conversations.unread_count END, status='open', updated_at=now() RETURNING id)
INSERT INTO messages (conversation_id, wamid, direction, type, text, status, channel, media_url, media_mime, media_filename, media_data, created_at, execution_ms, label, model, cost_usd, charged_usd, sent_by, message_hash, context_id, context_hash, sent_at, device_id)
  SELECT conv.id, $4, $7, $6, $3, $8, $10, $11, $12, $13, $15, to_timestamp($5::double precision), $16, $17, $18, $19, $20, $21, $22, $23, $24, to_timestamp($25::double precision), $26 FROM conv
  ON CONFLICT (wamid) DO NOTHING RETURNING id, conversation_id;`;

async function saveMessage(n) {
  const params = [n.contactId, n.name, n.text, n.wamid, n.ts, n.type, n.direction, n.status, n.phone, n.channel, n.mediaUrl, n.mediaMime, n.mediaName, n.preview, n.mediaData || null, n.executionMs ?? null, n.label ?? null, n.model ?? null, n.costUsd ?? null, n.chargedUsd ?? null, n.sentBy ?? null, n.messageHash ?? null, n.contextId ?? null, n.contextHash ?? null, n.sentAt ?? null, n.deviceId ?? null];
  const r = await q(SAVE_SQL, params);
  const row = r.rows[0] || {};
  return { id: row.id != null ? String(row.id) : null, conversationId: row.conversation_id != null ? String(row.conversation_id) : null };
}

// ==================== RUTAS API ====================

app.get('/api/db-setup', wrap(async (_req, res) => { await migrate(); res.json({ ok: true, message: 'Tablas creadas correctamente.' }); }));

// ?device=<id> devuelve solo las de ese dispositivo QR.
// Sin parámetro devuelve las del principal (Camila / Cloud API), que son las que
// tienen device_id NULL: así el inbox de siempre no cambia de comportamiento.
app.get('/api/conversations', wrap(async (req, res) => {
  const device = String(req.query.device || '').trim();
  const todos = asBool(req.query.all);
  let filtro = 'WHERE conv.device_id IS NULL';
  const params = [];
  if (todos) filtro = '';
  else if (device) { params.push(device); filtro = 'WHERE conv.device_id = $1'; }

  const r = await q(`SELECT conv.id, c.ghl_contact_id, c.name, c.phone, c.email, c.company, c.tags, c.source, c.owner, c.handoff,
      conv.channel, conv.status, conv.starred, conv.unread_count, conv.last_message, conv.last_direction, conv.last_status, conv.device_id,
      EXTRACT(EPOCH FROM conv.last_message_at)*1000 AS last_message_at, EXTRACT(EPOCH FROM conv.last_inbound)*1000 AS last_inbound
      FROM conversations conv JOIN contacts c ON c.id = conv.contact_id
      ${filtro}
      ORDER BY conv.last_message_at DESC NULLS LAST`, params);
  const conversations = r.rows.map(row => {
    const nm = row.name || row.phone || '?';
    return {
      id: String(row.id), contactId: row.ghl_contact_id || null, name: nm, phone: row.phone,
      avatar: { initials: initials(nm), color: colorFor(nm) }, channel: row.channel || 'whatsapp',
      lastMessage: row.last_message || '', lastMessageAt: Number(row.last_message_at) || 0,
      lastDirection: row.last_direction || 'in', lastStatus: row.last_status || 'received',
      unreadCount: Number(row.unread_count) || 0, starred: !!row.starred, status: row.status || 'open',
      lastInbound: Number(row.last_inbound) || 0, handoff: !!row.handoff,
      deviceId: row.device_id || null,
      contact: { email: row.email || '', company: row.company || '', tags: row.tags || [], source: row.source || '', owner: row.owner || '' }
    };
  });
  res.json({ conversations });
}));

app.get('/api/messages', wrap(async (req, res) => {
  const id = String(req.query.conversationId || '');
  if (!id) return res.json({ messages: [] });
  // El UPDATE solo si de verdad hay no leídos: así abrir un chat ya leído no escribe
  // (ni espera bloqueos) en cada carga.
  // Cita (reply): por cada mensaje con context_hash, se busca el mensaje citado dentro
  // de la MISMA conversación cuyo message_hash coincide (match por hash estable, nunca por
  // id crudo — ver wahash.js). Si no resuelve, qt.* queda NULL y se renderiza sin cita.
  // Orden: coalesce(sent_at, created_at) — degrada a created_at si el payload no trajo
  // sent_at — con desempate created_at, id (Meta da segundos: dos entrantes empatan).
  const r = await q(`WITH upd AS (UPDATE conversations SET unread_count=0 WHERE id=$1::bigint AND unread_count > 0 RETURNING id)
    SELECT m.id, m.conversation_id, m.direction, m.type, m.text, m.template, m.media_url, m.media_mime, m.media_filename,
      (m.media_data IS NOT NULL) AS has_blob, m.status, m.channel, m.sent_by, m.context_id,
      EXTRACT(EPOCH FROM COALESCE(m.sent_at, m.created_at))*1000 AS timestamp,
      qt.id AS q_id, qt.direction AS q_direction, qt.type AS q_type, qt.text AS q_text,
      qt.media_mime AS q_media_mime, qt.media_filename AS q_media_filename,
      (qt.media_data IS NOT NULL) AS q_has_blob, qt.media_url AS q_media_url, qt.sent_by AS q_sent_by
    FROM messages m
    LEFT JOIN LATERAL (
      SELECT c.id, c.direction, c.type, c.text, c.media_mime, c.media_filename, c.media_data, c.media_url, c.sent_by
      FROM messages c
      WHERE m.context_hash IS NOT NULL AND c.message_hash = m.context_hash
        AND c.conversation_id = m.conversation_id AND c.id <> m.id
      ORDER BY c.created_at DESC LIMIT 1
    ) qt ON true
    WHERE m.conversation_id=$1::bigint
    ORDER BY COALESCE(m.sent_at, m.created_at) ASC, m.created_at ASC, m.id ASC`, [id]);
  const messages = r.rows.map(m => {
    let mediaUrl = m.media_url || null;
    if (!mediaUrl && m.has_blob) mediaUrl = mediaUrlFor(req, m.id);
    // Mensaje citado (si resolvió). El frontend lo pinta como la barra de reply de WhatsApp.
    let quoted = null;
    if (m.q_id != null) {
      let qUrl = m.q_media_url || null;
      if (!qUrl && m.q_has_blob) qUrl = mediaUrlFor(req, m.q_id);
      quoted = {
        id: String(m.q_id), direction: m.q_direction, type: m.q_type || 'text',
        text: m.q_text || '', mediaUrl: qUrl, mediaMime: m.q_media_mime || null,
        mediaFilename: m.q_media_filename || null, sentBy: m.q_sent_by || null
      };
    }
    return {
      id: String(m.id), conversationId: String(m.conversation_id), direction: m.direction, type: m.type || 'text',
      text: m.text || '', template: m.template || null, mediaUrl, mediaMime: m.media_mime || null,
      mediaFilename: m.media_filename || null, timestamp: Number(m.timestamp) || 0, status: m.status || 'received', channel: m.channel || 'whatsapp',
      sentBy: m.sent_by || null,
      // Presente solo si es un reply que resolvió; el frontend degrada a nada si es null.
      quoted, quotedMissing: !!m.context_id && m.q_id == null
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
  // inline (no attachment): así el visor del navegador lo muestra en vez de descargarlo,
  // y el nombre del archivo sale en la pestaña del visor de PDF.
  if (row.media_filename) {
    const seguro = String(row.media_filename).replace(/["\\\r\n]/g, '');
    res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(seguro)}`);
  }
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
  if (row) {
    // Sin conversación no hay nada que atender: el contacto deja de contar como handoff
    // (si no, se quedaría marcado para siempre e inflaría el contador de la pestaña).
    if (cid) await q(`UPDATE contacts SET handoff = false, handoff_stopped = false, handoff_at = NULL
                      WHERE ghl_contact_id = $1`, [cid]);
    await logAction(req, 'conv_delete', cid, 'Eliminó la conversación');
  }
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

// Minutos tras los cuales un chat en handoff vuelve a encender a Camila.
// 0 (o vacío) = desactivado. Se guarda en app_settings.
async function getHandoffReturnMins() {
  const r = await q(`SELECT value FROM app_settings WHERE key='handoff_auto_return_mins'`);
  const n = Math.floor(Number(r.rows[0] && r.rows[0].value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}
app.get('/api/handoff-config', wrap(async (_req, res) => res.json({ minutes: await getHandoffReturnMins() })));
app.post('/api/handoff-config', wrap(async (req, res) => {
  let mins = Math.floor(Number(req.body && req.body.minutes));
  if (!Number.isFinite(mins) || mins < 0) mins = 0;
  await q(`INSERT INTO app_settings (key,value,updated_at) VALUES ('handoff_auto_return_mins',$1,now())
           ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [String(mins)]);
  await logAction(req, 'handoff_config', null,
    mins ? `Auto-return de handoff: ${mins} min` : 'Auto-return de handoff: desactivado');
  res.json({ ok: true, minutes: mins });
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
// Quita la etiqueta handoff en GHL (al volver a encender a Camila). Si no la quitáramos,
// el escáner volvería a apagarla en la siguiente pasada.
async function quitarTagHandoff(contactId) {
  const r = await ghl('/contacts/' + encodeURIComponent(contactId) + '/tags', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags: [HANDOFF_TAG] })
  });
  return r.ok;
}

// Enciende / apaga a Camila PARA ESE CONTACTO (bot_status = '' | 'STOP' en GHL).
// Apagar = handoff: el chat se marca en rojo y avisa. Encender lo limpia todo,
// incluida la etiqueta handoff en GHL.
app.post('/api/ghl-set-field', wrap(async (req, res) => {
  const contactId = String((req.body && req.body.contactId) || '').trim();
  const value = String((req.body && req.body.value) != null ? req.body.value : '');
  if (!contactId) return res.json({ ok: false });
  const closed = String(value).toUpperCase() === 'STOP';   // closed = Camila OFF

  const { json } = await ghl('/contacts/' + encodeURIComponent(contactId), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customFields: [{ id: BOT_STATUS_FIELD, value }] }) });
  const ok = !!(json && json.contact && json.contact.id);

  if (ok) {
    if (closed) {
      // Camila OFF → marca handoff (rojo + notificación), venga del botón o de la etiqueta.
      const upd = await q(
        `UPDATE contacts SET handoff = true, handoff_stopped = true,
                handoff_at = COALESCE(handoff_at, now())
         WHERE ghl_contact_id = $1 AND handoff IS NOT TRUE
         RETURNING id, name, phone`, [contactId]);
      const c = upd.rows[0];
      if (c) {
        const cv = await q(`SELECT id FROM conversations WHERE contact_id = $1 LIMIT 1`, [c.id]);
        await notify({
          type: 'handoff', contactId, conversationId: cv.rows[0] ? cv.rows[0].id : null,
          title: 'Camila OFF: ' + (c.name || c.phone || 'contacto'),
          body: 'Conversación en manual — el bot no responderá',
          refId: contactId + ':' + Date.now()
        });
      }
    } else {
      // Camila ON → fuera handoff: etiqueta en GHL incluida.
      await quitarTagHandoff(contactId).catch(e => console.error('quitarTagHandoff', e.message));
      await q(`UPDATE contacts SET handoff = false, handoff_stopped = false, handoff_at = NULL
               WHERE ghl_contact_id = $1`, [contactId]);
    }
  }

  await logAction(req, closed ? 'conv_close' : 'conv_open', contactId,
    closed ? 'Apagó a Camila (conversación manual)' : 'Encendió a Camila (quitó el handoff)');
  res.json({ ok, contactId: ok ? json.contact.id : null, handoff: ok ? closed : null });
}));

// Contactos con la etiqueta handoff. Sirve del cache en DB (lo mantiene scanHandoff);
// con ?refresh=1 fuerza una consulta a GHL antes de responder.
app.get('/api/handoff', wrap(async (req, res) => {
  if (asBool(req.query.refresh)) await scanHandoff();
  // Solo los que siguen teniendo conversación: un contacto marcado cuya conversación
  // se borró no debe aparecer ni sumar en el contador.
  const r = await q(`SELECT c.ghl_contact_id FROM contacts c
                     JOIN conversations cv ON cv.contact_id = c.id
                     WHERE c.handoff = true AND c.ghl_contact_id IS NOT NULL`);
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
       AND (n.user_id IS NULL OR n.user_id = $3)     -- globales + las dirigidas a mí
     ORDER BY n.created_at DESC LIMIT $2`, [userKey(req), limit, (req.user && req.user.id) || '']);
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
  const n = normalize({ ...b, type: 'text' }, null, 'out');   // ya trae el canal normalizado
  let msgId = null, sent = false, error = null;

  if (n.channel === 'whatsapp') {
    const to = b.to ? String(b.to).replace(/[^\d]/g, '') : (n.phone || null);
    if (!to) error = 'El contacto no tiene teléfono';
    else if (!WA_TOKEN || !WA_PHONE) error = 'WhatsApp no está configurado';
    else {
      const r = await waSend({ messaging_product: 'whatsapp', to, type: 'text', text: { body: b.text || '' } });
      msgId = r.json && r.json.messages && r.json.messages[0] ? r.json.messages[0].id : null;
      sent = !!msgId;
      if (!sent) error = metaError(r.json);
    }
  } else {
    // Instagram / Facebook / página web → salen por GoHighLevel
    const r = await ghlSendMessage({ channel: n.channel, contactId: n.contactId, text: b.text || '' });
    sent = r.ok; msgId = r.messageId || null; error = r.error || null;
  }

  n.wamid = msgId;
  n.status = sent ? 'sent' : 'failed';
  n.sentBy = await agentName(req);   // quién lo envió (agente logueado)
  const saved = await saveMessage(n);
  res.json({ id: saved.id, conversationId: saved.conversationId, status: n.status, wamid: msgId, sent, error });
}));

// ---- plantillas de Meta ----
// Lista las plantillas de la WABA (cacheadas 5 min). Solo las APROBADAS por defecto;
// con ?all=1 devuelve también las pendientes/rechazadas, marcadas con su estado.
let _tplCache = { at: 0, items: [] };
app.get('/api/wa-templates', wrap(async (req, res) => {
  if (!WA_TOKEN) return res.json({ ok: false, error: 'Falta WHATSAPP_TOKEN', templates: [] });
  const waba = await wabaId();
  if (!waba) return res.json({ ok: false, error: 'No se pudo determinar la WABA (define WHATSAPP_WABA_ID)', templates: [] });

  const fresco = Date.now() - _tplCache.at < 5 * 60 * 1000;
  if (!fresco || asBool(req.query.refresh)) {
    const { ok, json } = await graph(`/${waba}/message_templates?limit=200&fields=name,status,category,language,components`);
    if (!ok) return res.status(400).json({ ok: false, error: metaError(json), templates: [] });
    _tplCache = { at: Date.now(), items: ((json && json.data) || []).map(parseTemplate) };
  }
  const todas = asBool(req.query.all);
  const templates = _tplCache.items.filter(t => todas || t.status === 'APPROVED');
  res.json({ ok: true, waba, templates, cachedAt: _tplCache.at });
}));

// ── Tickets → project-manager ────────────────────────────────────────────────
// El cliente (web/app) manda aquí; nosotros reenviamos con la API key (que nunca
// sale al navegador). Mapea nuestros campos al formato del project-manager.
const PRIORIDAD_PM = { baja: 'LOW', media: 'MEDIUM', alta: 'HIGH', urgente: 'URGENT' };
app.post('/api/tickets', wrap(async (req, res) => {
  const b = req.body || {};
  const asunto = String(b.asunto || '').trim();
  const desc = String(b.descripcion || '').trim();
  if (!asunto || !desc) return res.status(400).json({ error: 'Asunto y descripción son obligatorios' });
  if (!TICKETS_API_KEY) return res.status(500).json({ error: 'Falta TICKETS_API_KEY en el servidor' });

  // Quién lo reporta (de la sesión) para dar contexto en la tarea.
  const u = b.usuario || {};
  const quien = u.name || u.email || (req.user && req.user.email) || 'desconocido';
  const meta = [
    'Reportado por: ' + quien,
    b.categoria ? 'Categoría: ' + b.categoria : '',
    'Origen: ' + (b.origen || '?') + (b.app ? ' (' + b.app + ')' : '')
  ].filter(Boolean).join('\n');

  const payload = {
    title: asunto,
    description: desc + '\n\n— — —\n' + meta,
    priority: PRIORIDAD_PM[String(b.prioridad || '').toLowerCase()] || 'MEDIUM',
    stage: 'Nuevo'
  };

  try {
    const r = await fetch(TICKETS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': TICKETS_API_KEY },
      body: JSON.stringify(payload)
    });
    const txt = await r.text();
    if (!r.ok) {
      console.error('[tickets]', r.status, txt.slice(0, 200));
      return res.status(502).json({ error: 'El gestor de tareas respondió ' + r.status });
    }
    let data = null; try { data = txt ? JSON.parse(txt) : null; } catch (_) {}
    // el project-manager devuelve { task: { id, … } } (a veces anidado). Buscamos el
    // id en profundidad; si no aparece, lo registramos para poder ajustarlo.
    const task = (data && data.task && data.task.task) || (data && data.task) || data || {};
    const idBruto = task.id || task.taskId || task._id || task.uuid
      || (data && (data.id || data.taskId))
      || (data && data.data && data.data.id);
    const externalId = idBruto ? String(idBruto) : null;
    if (!externalId) console.warn('[tickets] el project-manager no devolvió id de tarea; respuesta:', txt.slice(0, 200));

    // Guardamos el ticket para poder listarlo y saber su estado.
    let saved = null;
    try {
      const r2 = await q(
        `INSERT INTO tickets (title, description, priority, category, status, origin, app, user_id, user_email, user_name, external_id)
         VALUES ($1,$2,$3,$4,'nuevo',$5,$6,$7,$8,$9,$10) RETURNING id`,
        [asunto, desc, String(b.prioridad || 'media'), b.categoria || null, b.origen || null, b.app || null,
         (req.user && req.user.id) || null, u.email || (req.user && req.user.email) || null, u.name || null, externalId]);
      saved = r2.rows[0] ? String(r2.rows[0].id) : null;
    } catch (e) { console.error('[tickets] guardar', e.message); }

    await logAction(req, 'ticket', null, 'Creó un ticket: ' + asunto).catch(() => {});
    res.json({ ok: true, id: saved, externalId, task });
  } catch (e) {
    console.error('[tickets]', e.message);
    res.status(502).json({ error: 'No se pudo contactar con el gestor de tareas' });
  }
}));

// Lista de tickets. Un agente ve los suyos; admin/super_admin ven todos.
app.get('/api/tickets', wrap(async (req, res) => {
  const prof = req.user ? await getProfile(req.user.id).catch(() => null) : null;
  // Sin sesión (auth desactivada) o admin/super_admin → ve todos; agente → solo los suyos.
  const esAdmin = !req.user || (prof && ['admin', 'super_admin'].includes(prof.role));
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
  const params = [limit];
  let filtro = '';
  if (!esAdmin) { params.push((req.user && req.user.id) || ''); filtro = 'WHERE user_id = $2'; }
  const r = await q(
    `SELECT id, title, description, priority, category, status, origin, user_email, user_name, external_id,
            EXTRACT(EPOCH FROM created_at)*1000 AS created_at, EXTRACT(EPOCH FROM completed_at)*1000 AS completed_at
     FROM tickets ${filtro} ORDER BY created_at DESC LIMIT $1`, params);
  res.json({ ok: true, admin: !!esAdmin, tickets: r.rows.map(t => ({
    id: String(t.id), title: t.title, description: t.description, priority: t.priority, category: t.category,
    status: t.status, origin: t.origin, userEmail: t.user_email, userName: t.user_name,
    createdAt: Number(t.created_at) || 0, completedAt: t.completed_at ? Number(t.completed_at) : null
  })) });
}));

// ── Webhook: el project-manager avisa cuando cambia el estado de un ticket ───
// Lo protege un secreto compartido (TICKETS_WEBHOOK_SECRET), NO la sesión de usuario.
// Diseñado para integrarse con CUALQUIER emisor de webhooks: acepta el secreto por
// varios sitios y busca el id de la tarea y el estado en muchos nombres de campo,
// incluso anidados. Es idempotente: completar dos veces no duplica la notificación.
const TICKETS_WEBHOOK_SECRET = process.env.TICKETS_WEBHOOK_SECRET || '';

// Busca la primera clave presente dentro de un objeto (superficial + un nivel).
function buscarCampo(obj, claves) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of claves) if (obj[k] != null && obj[k] !== '') return obj[k];
  for (const sub of ['task', 'data', 'record', 'ticket', 'payload', 'body']) {
    const o = obj[sub];
    if (o && typeof o === 'object') for (const k of claves) if (o[k] != null && o[k] !== '') return o[k];
  }
  return null;
}
// ¿este texto/estado significa "completado"?
const esCompletado = v => {
  if (v === true) return true;
  const s = String(v || '').toLowerCase();
  return /complet|done|finaliz|cerr|resuelt|closed|resolved/.test(s);
};

// Ayuda si alguien abre la URL en el navegador (GET): confirma que está viva.
app.get('/api/tickets/webhook', (_req, res) => res.json({
  ok: true, hint: 'Usa POST con el header x-webhook-secret y { taskId, status }.'
}));

app.post('/api/tickets/webhook', wrap(async (req, res) => {
  const b = req.body || {};
  // Secreto: header, Bearer, query ?secret= o campo en el body — lo que soporte el emisor.
  const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const secret = req.get('x-webhook-secret') || bearer || req.query.secret || b.secret || '';
  if (!TICKETS_WEBHOOK_SECRET) return res.status(503).json({ error: 'Webhook sin configurar (falta TICKETS_WEBHOOK_SECRET)' });
  if (secret !== TICKETS_WEBHOOK_SECRET) return res.status(401).json({ error: 'Secreto inválido' });

  // Id de la tarea del project-manager (lo guardamos como external_id al crear el ticket).
  const externalId = String(buscarCampo(b, ['taskId', 'external_id', 'externalId', 'id', 'task_id']) || '').trim();
  // También permitimos apuntar por NUESTRO id de ticket, por si lo tienen.
  const ticketId = String(buscarCampo(b, ['ticketId', 'nebo_ticket_id']) || '').trim();
  if (!externalId && !ticketId) return res.status(400).json({ error: 'Falta el id de la tarea (taskId)' });

  const estadoRaw = buscarCampo(b, ['status', 'stage', 'state', 'estado']) ?? (b.completed === true ? 'completado' : 'completado');
  const completado = esCompletado(estadoRaw) || b.completed === true;
  const nuevoEstado = completado ? 'completado' : (String(estadoRaw || 'en_progreso').toLowerCase().slice(0, 40));

  const r = await q(
    `UPDATE tickets SET status = $2, completed_at = CASE WHEN $3 AND completed_at IS NULL THEN now() ELSE completed_at END, updated_at = now()
     WHERE ($1 <> '' AND external_id = $1) OR ($4 <> '' AND id::text = $4)
     RETURNING id, title, user_id, status`,
    [externalId, nuevoEstado, completado, ticketId]);
  const t = r.rows[0];
  if (!t) return res.status(404).json({ error: 'No encontramos un ticket con ese id', taskId: externalId || ticketId });

  // Notifica al autor (idempotente: el índice único evita repetir el aviso).
  if (completado && t.user_id) {
    await notify({
      type: 'ticket', userId: t.user_id,
      title: '✅ Tu ticket fue resuelto',
      body: t.title,
      refId: 'ticket-done-' + t.id
    });
  }
  res.json({ ok: true, id: String(t.id), status: t.status, completado });
}));

// Envía una plantilla aprobada. Es lo ÚNICO que Meta deja mandar fuera de la
// ventana de 24 h. Guarda en el historial el texto ya rellenado.
app.post('/api/send-template', wrap(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const lang = String(b.language || '').trim() || 'es';
  const to = b.to ? String(b.to).replace(/[^\d]/g, '') : null;
  if (!name) return res.status(400).json({ ok: false, error: 'Falta el nombre de la plantilla' });
  if (!to) return res.status(400).json({ ok: false, error: 'El contacto no tiene teléfono' });
  if (!WA_TOKEN || !WA_PHONE) return res.status(400).json({ ok: false, error: 'WhatsApp no está configurado' });

  const txt = v => ({ type: 'text', text: String(v == null ? '' : v) });
  const headerParams = Array.isArray(b.headerParams) ? b.headerParams : [];
  const bodyParams = Array.isArray(b.bodyParams) ? b.bodyParams : [];
  const buttonParams = Array.isArray(b.buttonParams) ? b.buttonParams : [];   // [{index, text}]
  const headerMedia = b.headerMedia || null;                                   // {type, link, filename}

  const components = [];
  if (headerMedia && headerMedia.link) {
    const t = String(headerMedia.type || 'image').toLowerCase();
    const media = { link: headerMedia.link };
    if (t === 'document' && headerMedia.filename) media.filename = headerMedia.filename;
    components.push({ type: 'header', parameters: [{ type: t, [t]: media }] });
  } else if (headerParams.length) {
    components.push({ type: 'header', parameters: headerParams.map(txt) });
  }
  if (bodyParams.length) components.push({ type: 'body', parameters: bodyParams.map(txt) });
  buttonParams.forEach(bp => components.push({
    type: 'button', sub_type: 'url', index: String(bp.index),
    parameters: [txt(bp.text)]
  }));

  const payload = {
    messaging_product: 'whatsapp', to, type: 'template',
    template: { name, language: { code: lang }, ...(components.length ? { components } : {}) }
  };
  const r = await waSend(payload);
  const wamid = r.json && r.json.messages && r.json.messages[0] ? r.json.messages[0].id : null;
  if (!r.ok || !wamid) return res.status(400).json({ ok: false, error: metaError(r.json) });

  // Guardamos el texto YA rellenado, para que en el hilo se lea el mensaje real.
  // OJO: no expandimos `b` aquí — su `name` es el de la PLANTILLA, y para normalize
  // `name` es el nombre del CONTACTO (lo pisaría en la base).
  const texto = fillVars(b.preview || '', bodyParams) || ('[plantilla] ' + name);
  const n = normalize({
    contactId: b.contactId || null, name: b.contactName || null, phone: to,
    text: texto, wamid, type: 'text', channel: 'whatsapp', status: 'sent'
  }, null, 'out');
  n.sentBy = await agentName(req);
  const saved = await saveMessage(n);
  if (saved.id) await q(`UPDATE messages SET template = $1 WHERE id = $2::bigint`, [name, saved.id]);
  res.json({ ok: true, id: saved.id, conversationId: saved.conversationId, wamid, sent: true });
}));

app.post('/api/send-media', upload.single('file'), wrap(async (req, res) => {
  const b = req.body || {};
  const n = normalize(b, req.file, 'out');
  n.sentBy = await agentName(req);   // quién lo envió (agente logueado)
  const saved = await saveMessage(n);

  // URL firmada del adjunto: la descargan sin cabeceras tanto Meta como GHL.
  const mediaUrl = n.mediaUrl || (saved.id ? mediaUrlFor(req, saved.id) : null);
  let msgId = null, sent = false, error = null;

  if (!mediaUrl) {
    error = 'No se pudo preparar el adjunto';
  } else if (n.channel === 'whatsapp') {
    const to = b.to ? String(b.to).replace(/[^\d]/g, '') : (n.phone || null);
    if (!to) error = 'El contacto no tiene teléfono';
    else if (!WA_TOKEN || !WA_PHONE) error = 'WhatsApp no está configurado';
    else {
      const media = { link: mediaUrl };
      if (n.type === 'document') media.filename = n.mediaName || 'documento';
      if (n.text && n.type !== 'audio') media.caption = n.text;
      const waBody = { messaging_product: 'whatsapp', to, type: n.type }; waBody[n.type] = media;
      const r = await waSend(waBody);
      msgId = r.json && r.json.messages && r.json.messages[0] ? r.json.messages[0].id : null;
      sent = !!msgId;
      if (!sent) error = metaError(r.json);
    }
  } else {
    // Instagram / Facebook / página web → GoHighLevel, con el adjunto por URL
    const r = await ghlSendMessage({ channel: n.channel, contactId: n.contactId, text: n.text || '', attachments: [mediaUrl] });
    sent = r.ok; msgId = r.messageId || null; error = r.error || null;
  }

  // Guardamos el id del proveedor: si luego llega el mismo mensaje por webhook,
  // el índice único de wamid lo deduplica en vez de duplicar la burbuja.
  if (saved.id) {
    try {
      await q(`UPDATE messages SET wamid = COALESCE($1, wamid), status = $2 WHERE id = $3::bigint`,
        [msgId, sent ? 'sent' : 'failed', saved.id]);
    } catch (e) { console.error('send-media update', e.message); }
  }
  res.json({ ok: true, id: saved.id, conversationId: saved.conversationId, wamid: msgId, sent, error });
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
// Admite decimales (1.5 = minuto y medio); internamente trabajamos en segundos.
const NO_REPLY_MIN = Number(process.env.NO_REPLY_MINUTES || 1.5);
const NO_REPLY_SECS = Math.max(15, Math.round(NO_REPLY_MIN * 60));
const NO_REPLY_LABEL = NO_REPLY_SECS % 60 === 0
  ? (NO_REPLY_SECS / 60) + ' min'
  : Math.floor(NO_REPLY_SECS / 60) + ' min ' + (NO_REPLY_SECS % 60) + ' s';
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
        WHERE li.created_at < now() - make_interval(secs => $1::int)
          AND NOT EXISTS (
            SELECT 1 FROM messages o
            WHERE o.conversation_id = li.conversation_id AND o.direction = 'out' AND o.created_at > li.created_at)
      )
      INSERT INTO action_logs (action, contact_id, detail, ref_id)
      SELECT 'no_reply', p.ghl_contact_id,
             'Entrante sin respuesta tras ' || $2,
             p.id::text
      FROM pending p
      ON CONFLICT (action, ref_id) DO NOTHING
      RETURNING contact_id, ref_id`, [NO_REPLY_SECS, NO_REPLY_LABEL]);
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
        body: `Lleva más de ${NO_REPLY_LABEL} sin recibir respuesta`, refId: row.ref_id
      });
    }
  } catch (e) { console.error('scanNoReply', e.message); }
}
// El escaneo debe ser bastante más frecuente que el umbral, si no la alerta llega tarde.
const NO_REPLY_EVERY = Math.min(30, Math.max(10, Math.round(NO_REPLY_SECS / 3))) * 1000;
setInterval(scanNoReply, NO_REPLY_EVERY);
setTimeout(scanNoReply, 15 * 1000);        // primera pasada al arrancar
console.log(`[no-reply] umbral ${NO_REPLY_LABEL} (${NO_REPLY_SECS}s), escaneo cada ${NO_REPLY_EVERY / 1000}s`);

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
    const candidatos = json.contacts.map(c => c.id).filter(Boolean);

    // El índice de búsqueda de GHL va con retraso: sigue devolviendo el contacto un rato
    // después de quitarle la etiqueta. Si nos fiáramos de él, volveríamos a apagar a Camila
    // justo después de que alguien la encendiera. Por eso confirmamos contra el contacto real.
    const ids = [];
    for (const id of candidatos) {
      try {
        const { json: c } = await ghl('/contacts/' + encodeURIComponent(id));
        const tags = ((c && c.contact && c.contact.tags) || []).map(t => String(t).toLowerCase());
        if (tags.includes(String(HANDOFF_TAG).toLowerCase())) ids.push(id);
        else console.log('[handoff] la búsqueda devolvió', id, 'pero ya no tiene la etiqueta (índice desfasado): se ignora');
      } catch (e) { console.error('handoff verificar', id, e.message); }
    }
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

    // NO desmarcamos a los que no tienen la etiqueta: un chat puesto en manual desde el
    // botón (Camila OFF) no lleva etiqueta y debe seguir en rojo. El handoff solo se
    // levanta encendiendo a Camila (POST /api/ghl-set-field con valor vacío), que además
    // borra la etiqueta en GHL.
  } catch (e) { console.error('scanHandoff', e.message); }
}
setInterval(scanHandoff, 60 * 1000);       // cada minuto
setTimeout(scanHandoff, 5 * 1000);         // primera pasada al arrancar

// ── Auto-return: chats que llevan X minutos en handoff → reactivar Camila ─────
// El tiempo se configura desde la interfaz (Ajustes). 0 = desactivado.
// Reactivar = lo mismo que el botón "Camila ON": bot_status='' en GHL, se quita
// la etiqueta handoff y se limpia el estado en la DB.
async function scanHandoffAutoReturn() {
  if (!GHL_PIT || !LOCATION_ID) return;
  try {
    const mins = await getHandoffReturnMins();
    if (!mins) return;   // desactivado
    const vencidos = await q(
      `SELECT ghl_contact_id, EXTRACT(EPOCH FROM (now() - handoff_at))::bigint AS secs
         FROM contacts
        WHERE handoff = true AND handoff_at IS NOT NULL AND ghl_contact_id IS NOT NULL
          AND handoff_at < now() - make_interval(mins => $1::int)`, [mins]);
    for (const c of vencidos.rows) {
      try {
        // Si GHL falla, no tocamos la DB: se reintenta en el próximo ciclo.
        if (!await setBotStatus(c.ghl_contact_id, '')) continue;
        await quitarTagHandoff(c.ghl_contact_id).catch(e => console.error('auto-return quitarTag', e.message));
        await q(`UPDATE contacts SET handoff = false, handoff_stopped = false, handoff_at = NULL
                 WHERE ghl_contact_id = $1`, [c.ghl_contact_id]);
        await q(`INSERT INTO action_logs (action, actor_name, contact_id, detail)
                 VALUES ('conv_open', 'Sistema (auto-return)', $1, $2)`,
          [c.ghl_contact_id, `Camila reactivada automáticamente tras ${mins} min en handoff`]);
        console.log('[handoff] auto-return: Camila ON para', c.ghl_contact_id, `(${Math.round((c.secs||0)/60)} min)`);
      } catch (e) { console.error('auto-return', c.ghl_contact_id, e.message); }
    }
  } catch (e) { console.error('scanHandoffAutoReturn', e.message); }
}
setInterval(scanHandoffAutoReturn, 60 * 1000);   // cada minuto
setTimeout(scanHandoffAutoReturn, 20 * 1000);    // primera pasada al arrancar

app.listen(PORT, () => console.log(`Dashboard escuchando en :${PORT}`));
