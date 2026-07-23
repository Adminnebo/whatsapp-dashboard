/* =========================================================
   calls.js — Llamadas del agente de voz.
   Fuente de verdad: tabla propia en Postgres. Se alimenta desde n8n
   (webhook con X-Api-Key). Cada llamada guarda: agente, número,
   transcripción, grabación (URL), duración (segundos) y coste.
   Expone lectura paginada + recap agregado del rango. Se monta en /api.
   ========================================================= */
'use strict';
const express = require('express');
const { q } = require('./db');
const { optionalAuth } = require('./analyticsAuth');
const { rangeOf } = require('./range');
const router = express.Router();

const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => { console.error(req.path, e.message); res.status(500).json({ error: e.message }); });
const COST_CCY = process.env.CALL_COST_CURRENCY || 'USD';

// ---------- Esquema (idempotente) ----------
let schemaReady = null;
function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await q(`CREATE TABLE IF NOT EXISTS calls (
      id BIGSERIAL PRIMARY KEY,
      agent TEXT,
      phone TEXT,
      transcript TEXT,
      recording_url TEXT,
      duration_secs INT,
      cost NUMERIC,
      external_id TEXT,
      meta JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS calls_external_id_uq ON calls(external_id) WHERE external_id IS NOT NULL`);
    await q(`CREATE INDEX IF NOT EXISTS calls_created_idx ON calls(created_at)`);
  })().catch(e => { schemaReady = null; throw e; });
  return schemaReady;
}

// ---------- Helpers ----------
// Duración a segundos: acepta número (segundos), "90", "1:30", "01:02:03".
function parseDuration(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.max(0, Math.round(v)) : null;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.max(0, Math.round(Number(s)));
  const parts = s.split(':').map(x => Number(x));
  if (!parts.length || parts.some(x => !Number.isFinite(x))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}
// Coste a número: quita símbolos de moneda ("$1.50", "USD 1.5" -> 1.5).
function parseCost(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}
const num = (v, d = 0) => (Number(v) || d);

// Webhook de n8n: misma API key que el pipeline (header X-Api-Key).
function requireApiKey(req, res, next) {
  const key = process.env.N8N_API_KEY || '';
  if (!key) return res.status(503).json({ error: 'N8N_API_KEY no configurado en el servidor' });
  const got = req.headers['x-api-key'] || req.query.api_key || '';
  if (got !== key) return res.status(401).json({ error: 'API key inválida' });
  next();
}

const shapeCall = (c, { full = false } = {}) => ({
  id: String(c.id),
  agent: c.agent || null,
  phone: c.phone || null,
  transcript: full ? (c.transcript || '') : undefined,
  transcriptPreview: c.transcript ? (c.transcript.length > 160 ? c.transcript.slice(0, 160) + '…' : c.transcript) : null,
  hasTranscript: !!c.transcript,
  recordingUrl: c.recording_url || null,
  durationSecs: c.duration_secs != null ? Number(c.duration_secs) : null,
  cost: c.cost != null ? Number(c.cost) : null,
  externalId: c.external_id || null,
  at: c.created_at
});

// ---------- Ingesta (n8n) ----------
// POST /api/calls/hook
// body: { agent, phone, transcript, recordingUrl|recording, duration|durationSecs, cost, externalId?, at?, meta? }
// Idempotente por externalId (si viene): re-postear actualiza en vez de duplicar.
router.post('/calls/hook', requireApiKey, wrap(async (req, res) => {
  await ensureSchema();
  const b = req.body || {};
  const agent = b.agent != null ? String(b.agent) : null;
  const phone = b.phone != null ? String(b.phone) : (b.numero != null ? String(b.numero) : null);
  const transcript = b.transcript != null ? String(b.transcript) : (b.transcripcion != null ? String(b.transcripcion) : null);
  const recordingUrl = b.recordingUrl || b.recording || b.grabacion || null;
  const durationSecs = parseDuration(b.durationSecs != null ? b.durationSecs : (b.duration != null ? b.duration : b.duracion));
  const cost = parseCost(b.cost != null ? b.cost : b.coste);
  const ext = b.externalId != null ? String(b.externalId) : null;
  const at = b.at ? new Date(b.at) : null;
  const meta = b.meta != null ? JSON.stringify(b.meta) : null;

  if (ext) {
    const upd = await q(
      `INSERT INTO calls (agent, phone, transcript, recording_url, duration_secs, cost, external_id, meta, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9, now()))
       ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO UPDATE SET
         agent = COALESCE(EXCLUDED.agent, calls.agent),
         phone = COALESCE(EXCLUDED.phone, calls.phone),
         transcript = COALESCE(EXCLUDED.transcript, calls.transcript),
         recording_url = COALESCE(EXCLUDED.recording_url, calls.recording_url),
         duration_secs = COALESCE(EXCLUDED.duration_secs, calls.duration_secs),
         cost = COALESCE(EXCLUDED.cost, calls.cost),
         meta = COALESCE(EXCLUDED.meta, calls.meta)
       RETURNING *`,
      [agent, phone, transcript, recordingUrl ? String(recordingUrl) : null, durationSecs, cost, ext, meta, at]
    );
    return res.json({ ok: true, call: shapeCall(upd.rows[0], { full: true }) });
  }

  const ins = await q(
    `INSERT INTO calls (agent, phone, transcript, recording_url, duration_secs, cost, meta, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8, now())) RETURNING *`,
    [agent, phone, transcript, recordingUrl ? String(recordingUrl) : null, durationSecs, cost, meta, at]
  );
  res.status(201).json({ ok: true, call: shapeCall(ins.rows[0], { full: true }) });
}));

// ---------- Lectura: listado + recap del rango ----------
// GET /api/calls?days=30|all | from&to  &search=&agent=&page=&limit=
router.get('/calls', optionalAuth, wrap(async (req, res) => {
  await ensureSchema();
  const { from, to } = rangeOf(req);
  const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 50));
  const page = Math.max(1, Number(req.query.page) || 1);
  const offset = (page - 1) * limit;

  const params = [from, to];
  let where = `created_at >= $1 AND created_at < $2`;
  const search = String(req.query.search || '').trim();
  if (search) { params.push('%' + search + '%'); where += ` AND (phone ILIKE $${params.length} OR agent ILIKE $${params.length} OR transcript ILIKE $${params.length})`; }
  const agent = String(req.query.agent || '').trim();
  if (agent) { params.push(agent); where += ` AND agent = $${params.length}`; }

  const [rows, agg, byAgent] = await Promise.all([
    q(`SELECT id, agent, phone, transcript, recording_url, duration_secs, cost, external_id, created_at
       FROM calls WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`, params),
    q(`SELECT count(*)::int AS calls, COALESCE(SUM(cost),0) AS cost,
              COALESCE(SUM(duration_secs),0)::bigint AS dur
       FROM calls WHERE ${where}`, params),
    q(`SELECT COALESCE(NULLIF(TRIM(agent),''),'(sin agente)') AS agent,
              count(*)::int AS calls, COALESCE(SUM(cost),0) AS cost,
              COALESCE(SUM(duration_secs),0)::bigint AS dur
       FROM calls WHERE ${where} GROUP BY 1 ORDER BY calls DESC, cost DESC`, params)
  ]);

  const a = agg.rows[0] || {};
  const calls = num(a.calls);
  const totalCost = num(a.cost);
  const totalDur = num(a.dur);

  res.json({
    range: { from, to },
    page, limit, total: calls, currency: COST_CCY,
    recap: {
      calls,
      totalCost,
      totalDurationSecs: totalDur,
      avgDurationSecs: calls ? totalDur / calls : 0,
      avgCost: calls ? totalCost / calls : 0,
      agents: byAgent.rows.map(r => ({ agent: r.agent, calls: num(r.calls), cost: num(r.cost), durationSecs: num(r.dur) }))
    },
    items: rows.rows.map(c => shapeCall(c))
  });
}));

// ---------- Detalle (transcripción completa) ----------
// GET /api/calls/:id
router.get('/calls/:id', optionalAuth, wrap(async (req, res) => {
  await ensureSchema();
  const r = await q(`SELECT * FROM calls WHERE id=$1`, [Number(req.params.id)]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Llamada no encontrada' });
  res.json({ call: shapeCall(r.rows[0], { full: true }) });
}));

module.exports = router;
