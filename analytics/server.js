/* =========================================================
   Analytics WhatsApp — backend (Express + Postgres).
   Lee la MISMA base y calcula métricas: enviados/recibidos,
   por día, horas pico, tiempo de respuesta, último enviado, cotizaciones.
   ========================================================= */
'use strict';
const path = require('path');
const express = require('express');
const { q } = require('./db');
const { quotesStat } = require('./mssql');
const { rangeOf } = require('./range');
const { configured: authCfg, optionalAuth, URL: SB_URL, ANON: SB_ANON } = require('./analyticsAuth');

const app = express();

// ── CORS para la app móvil ───────────────────────────────────────────────────
// La app de Capacitor no se sirve desde este dominio: iOS llega como
// capacitor://localhost y Android como https://localhost. Sin esto el WebView
// bloquea las llamadas. La web propia va por mismo origen y no manda Origin.
const CORS_OK = new Set([
  'capacitor://localhost', 'ionic://localhost', 'http://localhost', 'https://localhost',
  ...String(process.env.CORS_EXTRA || '').split(',').map(s => s.trim()).filter(Boolean)
]);
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && (CORS_OK.has(origin) || /^https?:\/\/localhost(:\d+)?$/.test(origin))) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.set('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '2mb' }));   // necesario para POST/PATCH (crear usuarios)
const PORT = process.env.PORT || 8080;
const TZ = process.env.TZ_DISPLAY || 'America/Santo_Domingo';

// Coste por mensaje. No existe en la base: se aplica una tarifa configurable.
// MSG_COST_OUT = coste por mensaje saliente; MSG_COST_IN = por entrante (normalmente 0).
const MSG_COST_OUT = Number(process.env.MSG_COST_OUT || 0);
const MSG_COST_IN = Number(process.env.MSG_COST_IN || 0);
const COST_CCY = process.env.MSG_COST_CURRENCY || 'USD';

const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => { console.error(req.path, e.message); res.status(500).json({ error: e.message }); });

// El rango de fechas (?days / ?from&to) se parsea en ./range.js (compartido).

// Cotizaciones: los datos viven en una base MSSQL aparte (site4now) y el PDF en
// Supabase Storage. Consultas centralizadas en ./mssql.js; rutas en ./quotes.js.

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/auth/config', (_req, res) => res.json({ supabaseUrl: SB_URL, supabaseAnonKey: SB_ANON, configured: authCfg }));
app.use('/api/auth', require('./authUsers')); // /api/auth/me, /users (solo admin/super_admin)

// Proxy de grabaciones: va ABIERTO (antes del gate) porque el <audio> no puede
// mandar el token de sesión. Se protege con allowlist de hosts (evita SSRF).
// El origen (swordaisolutions.com) no manda CORS/Content-Length, así que sin
// esto el reproductor embebido falla; aquí lo re-servimos desde el mismo origen.
app.get('/api/recordings/proxy', require('./services/recordingProxy').handle);

// ── Gate de plataforma: todo lo demás exige acceso a 'cotizaciones' ──────────
// Se eximen los webhooks de n8n (llevan su propia API key) y health.
const { requirePlatform } = require('./analyticsAuth');
const ABIERTAS = [/^\/hooks\//, /^\/calls\/hook$/, /^\/health$/];
app.use('/api', (req, res, next) => {
  if (ABIERTAS.some(re => re.test(req.path))) return next();
  requirePlatform('cotizaciones')(req, res, next);
});

app.use('/api', require('./pipeline'));       // pipeline/oportunidades + webhook n8n
app.use('/api', require('./quotes'));         // cotizaciones (MSSQL) + PDF (Supabase)
app.use('/api', require('./calls'));          // llamadas del agente de voz + webhook n8n

// Vigilancia de la secuencia de cotizaciones: avisa a un webhook si hay huecos.
const quoteGaps = require('./quoteGaps');
app.get('/api/quotes/gaps', optionalAuth, wrap(async (_req, res) => {
  res.json(await quoteGaps.revisar());        // revisión bajo demanda
}));

app.get('/api/stats', optionalAuth, wrap(async (req, res) => {
  const { from, to } = rangeOf(req);
  const canSeeCost = !authCfg || req.role === 'super_admin'; // costes reales solo super_admin

  const [kpi, rt, byDay, byHour, byType, execT, aiRows, quotes] = await Promise.all([
    q(`SELECT count(*) FILTER (WHERE direction='out') AS sent,
              count(*) FILTER (WHERE direction='in')  AS received,
              COALESCE(SUM(charged_usd),0) AS charged,
              max(created_at) FILTER (WHERE direction='out') AS last_sent_at,
              count(DISTINCT conversation_id) AS active_convs
       FROM messages WHERE created_at >= $1 AND created_at < $2`, [from, to]),
    q(`WITH seq AS (
         SELECT conversation_id, direction, created_at,
                LAG(direction)  OVER w AS pd,
                LAG(created_at) OVER w AS pa
         FROM messages WHERE created_at >= $1 AND created_at < $2
         WINDOW w AS (PARTITION BY conversation_id ORDER BY created_at))
       SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (created_at - pa))) AS median_secs,
              avg(EXTRACT(EPOCH FROM (created_at - pa))) AS avg_secs,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (created_at - pa))) AS p90_secs,
              count(*) AS n
       FROM seq WHERE direction='out' AND pd='in' AND (created_at - pa) < interval '6 hours'`, [from, to]),
    q(`SELECT to_char(date_trunc('day', created_at AT TIME ZONE $3), 'YYYY-MM-DD') AS day,
              count(*) FILTER (WHERE direction='out') AS sent,
              count(*) FILTER (WHERE direction='in')  AS received
       FROM messages WHERE created_at >= $1 AND created_at < $2 GROUP BY 1 ORDER BY 1`, [from, to, TZ]),
    q(`SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE $3)::int AS hour,
              count(*) FILTER (WHERE direction='out') AS sent,
              count(*) FILTER (WHERE direction='in')  AS received
       FROM messages WHERE created_at >= $1 AND created_at < $2 GROUP BY 1 ORDER BY 1`, [from, to, TZ]),
    q(`SELECT COALESCE(type,'text') AS type, count(*)::int AS n
       FROM messages WHERE created_at >= $1 AND created_at < $2 AND direction='out' GROUP BY 1 ORDER BY 2 DESC`, [from, to]),
    q(`SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY execution_ms) AS median_secs,
              avg(execution_ms) AS avg_secs,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY execution_ms) AS p90_secs,
              count(*) AS n
       FROM messages WHERE created_at >= $1 AND created_at < $2 AND execution_ms IS NOT NULL`, [from, to]),
    q(`SELECT COALESCE(NULLIF(TRIM(model),''),'(desconocido)') AS model,
              count(*)::int AS runs, COALESCE(SUM(cost_usd),0) AS usd
       FROM messages
       WHERE created_at >= $1 AND created_at < $2 AND (cost_usd IS NOT NULL OR model IS NOT NULL)
       GROUP BY 1 ORDER BY 3 DESC`, [from, to]),
    quotesStat(from, to)
  ]);

  const k = kpi.rows[0] || {};
  const r = rt.rows[0] || {};
  const e = execT.rows[0] || {};
  const byModel = aiRows.rows.map(x => ({ model: x.model, runs: Number(x.runs) || 0, usd: Number(x.usd) || 0 }));
  const aiCost = {
    totalUsd: byModel.reduce((a, m) => a + m.usd, 0),
    runs: byModel.reduce((a, m) => a + m.runs, 0),
    byModel
  };
  const sentOut = Number(k.sent) || 0;
  const chargedTotal = Number(k.charged) || 0;
  const hourMap = {}; byHour.rows.forEach(x => { hourMap[x.hour] = x; });
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, sent: Number((hourMap[h] || {}).sent) || 0, received: Number((hourMap[h] || {}).received) || 0 }));

  res.json({
    range: { from, to, tz: TZ },
    kpi: {
      sent: Number(k.sent) || 0,
      received: Number(k.received) || 0,
      lastSentAt: k.last_sent_at || null,
      activeConversations: Number(k.active_convs) || 0
    },
    responseTime: {
      medianSecs: r.median_secs != null ? Number(r.median_secs) : null,
      avgSecs: r.avg_secs != null ? Number(r.avg_secs) : null,
      p90Secs: r.p90_secs != null ? Number(r.p90_secs) : null,
      samples: Number(r.n) || 0
    },
    execTime: {
      medianSecs: e.median_secs != null ? Number(e.median_secs) : null,
      avgSecs: e.avg_secs != null ? Number(e.avg_secs) : null,
      p90Secs: e.p90_secs != null ? Number(e.p90_secs) : null,
      samples: Number(e.n) || 0
    },
    aiCost: canSeeCost ? aiCost : null,
    canSeeCost,
    billing: { perOut: sentOut ? chargedTotal / sentOut : MSG_COST_OUT, currency: COST_CCY, total: chargedTotal },
    byDay: byDay.rows.map(x => ({ day: x.day, sent: Number(x.sent) || 0, received: Number(x.received) || 0 })),
    byHour: hours,
    byType: byType.rows.map(x => ({ type: x.type, n: x.n })),
    quotes
  });
}));

// Mensajes emparejados: cada mensaje entrante junto a su respuesta saliente,
// con el tiempo que tardó la respuesta y el coste del saliente. Un par = un
// saliente cuyo mensaje inmediatamente anterior en la conversación fue entrante.
const trunc = (t, n) => (t && t.length > n ? t.slice(0, n) + '…' : (t || ''));
app.get('/api/messages', optionalAuth, wrap(async (req, res) => {
  const { from, to } = rangeOf(req);
  const canSeeCost = !authCfg || req.role === 'super_admin';

  const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 50));
  const page = Math.max(1, Number(req.query.page) || 1);
  const offset = (page - 1) * limit;
  const search = String(req.query.search || '').trim();

  const params = [from, to];
  let searchClause = '';
  if (search) {
    params.push('%' + search + '%');
    searchClause = ` AND (c.phone ILIKE $${params.length} OR c.name ILIKE $${params.length} OR s.text ILIKE $${params.length} OR s.prev_text ILIKE $${params.length})`;
  }
  const sender = String(req.query.sender || 'all');   // all | bot (Camila) | human (usuarios)
  let senderClause = '';
  if (sender === 'bot') senderClause = ` AND lower(s.sent_by) = 'camila'`;
  else if (sender === 'human') senderClause = ` AND s.sent_by IS NOT NULL AND lower(s.sent_by) <> 'camila'`;

  const CHANNELS = ['whatsapp', 'instagram', 'facebook', 'pagina_web'];
  const channel = String(req.query.channel || '').trim().toLowerCase();
  let channelClause = '';
  if (CHANNELS.includes(channel)) {
    params.push(channel);
    channelClause = ` AND s.channel = $${params.length}`;
  }

  const [rows, totalR] = await Promise.all([
    q(`WITH seq AS (
         SELECT id, conversation_id, direction, type, text, status, created_at, execution_ms, model, cost_usd, charged_usd, sent_by, channel,
                LAG(direction)  OVER w AS prev_dir,
                LAG(text)       OVER w AS prev_text,
                LAG(type)       OVER w AS prev_type,
                LAG(created_at) OVER w AS prev_at
         FROM messages WHERE created_at >= $1 AND created_at < $2
         WINDOW w AS (PARTITION BY conversation_id ORDER BY created_at, id))
       SELECT s.id, s.conversation_id, s.created_at AS out_at, s.status, s.execution_ms, s.model, s.cost_usd, s.charged_usd, s.sent_by, s.channel,
              s.text AS out_text, s.type AS out_type,
              s.prev_text AS in_text, s.prev_type AS in_type, s.prev_at AS in_at,
              EXTRACT(EPOCH FROM (s.created_at - s.prev_at)) AS response_secs,
              c.phone, c.name
       FROM seq s
       JOIN conversations cv ON cv.id = s.conversation_id
       JOIN contacts c ON c.id = cv.contact_id
       WHERE s.direction='out' AND s.prev_dir='in'${searchClause}${senderClause}${channelClause}
       ORDER BY s.created_at DESC, s.id DESC
       LIMIT ${limit} OFFSET ${offset}`, params),
    q(`WITH seq AS (
         SELECT conversation_id, direction, text, sent_by, channel,
                LAG(direction) OVER w AS prev_dir,
                LAG(text)      OVER w AS prev_text
         FROM messages WHERE created_at >= $1 AND created_at < $2
         WINDOW w AS (PARTITION BY conversation_id ORDER BY created_at, id))
       SELECT count(*)::int AS n
       FROM seq s
       JOIN conversations cv ON cv.id = s.conversation_id
       JOIN contacts c ON c.id = cv.contact_id
       WHERE s.direction='out' AND s.prev_dir='in'${searchClause}${senderClause}${channelClause}`, params)
  ]);

  const total = totalR.rows[0] ? totalR.rows[0].n : 0;
  res.json({
    page, limit, total, canSeeCost,
    cost: { out: MSG_COST_OUT, in: MSG_COST_IN, currency: COST_CCY },
    items: rows.rows.map(m => ({
      id: String(m.id),
      conversationId: String(m.conversation_id),
      phone: m.phone || null,
      name: m.name || null,
      inText: trunc(m.in_text, 240),
      inType: m.in_type || 'text',
      inAt: m.in_at,
      outText: trunc(m.out_text, 240),
      outType: m.out_type || 'text',
      outAt: m.out_at,
      status: m.status || '',
      responseSecs: m.response_secs != null ? Number(m.response_secs) : null,
      execSecs: m.execution_ms != null ? Number(m.execution_ms) : null,
      model: m.model || null,
      sentBy: m.sent_by || null,
      channel: m.channel || 'whatsapp',
      costUsd: (canSeeCost && m.cost_usd != null) ? Number(m.cost_usd) : null,
      cost: m.charged_usd != null ? Number(m.charged_usd) : MSG_COST_OUT
    }))
  });
}));

// Registro de acciones de la interfaz (apagar bot, cerrar/eliminar conversación).
app.get('/api/logs', optionalAuth, wrap(async (req, res) => {
  const { from, to } = rangeOf(req);
  const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 50));
  const page = Math.max(1, Number(req.query.page) || 1);
  const offset = (page - 1) * limit;
  const [rows, totalR] = await Promise.all([
    q(`SELECT l.id, l.action, l.actor_name, l.actor_email, l.contact_id, l.detail, l.created_at,
              c.name AS contact_name, c.phone
       FROM action_logs l LEFT JOIN contacts c ON c.ghl_contact_id = l.contact_id
       WHERE l.created_at >= $1 AND l.created_at < $2
       ORDER BY l.created_at DESC LIMIT ${limit} OFFSET ${offset}`, [from, to]),
    q(`SELECT count(*)::int AS n FROM action_logs WHERE created_at >= $1 AND created_at < $2`, [from, to])
  ]);
  const total = totalR.rows[0] ? totalR.rows[0].n : 0;
  res.json({
    page, limit, total,
    items: rows.rows.map(l => ({
      id: String(l.id), action: l.action || '',
      actor: l.actor_name || l.actor_email || null,
      contact: l.contact_name || l.phone || l.contact_id || null,
      detail: l.detail || null, at: l.created_at
    }))
  });
}));

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`Analytics escuchando en :${PORT} (TZ ${TZ})`);
  quoteGaps.start();                          // vigila la secuencia de cotizaciones
});
