/* =========================================================
   pipeline.js — Tablero de oportunidades (estilo GHL).
   Fuente de verdad: tablas propias en Postgres. Se alimenta desde
   n8n (webhook con X-Api-Key) y también se puede mover a mano (arrastrar)
   desde la interfaz. Cada oportunidad puede tener una cotización (MSSQL)
   y un canal (whatsapp/instagram/facebook/pagina_web) distinguible/filtrable.
   Se monta en /api.
   ========================================================= */
'use strict';
const express = require('express');
const { q } = require('./db');
const { configured, roleForToken } = require('./analyticsAuth');
const { quoteDetail } = require('./mssql');
const router = express.Router();

const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => { console.error(req.path, e.message); res.status(500).json({ error: e.message }); });
const CHANNELS = ['whatsapp', 'instagram', 'facebook', 'pagina_web'];
const normChannel = c => { const k = String(c || '').trim().toLowerCase(); return CHANNELS.includes(k) ? k : null; };
// Normaliza para comparar nombres de etapa: minúsculas, sin acentos ni espacios extra.
const normName = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

// ---------- Esquema (idempotente) ----------
const DEFAULT_STAGES = [
  { name: 'Llamada entrante', color: '#64748b' },
  { name: 'Llamada inconclusa', color: '#f59e0b' },
  { name: 'Enviado de Agente de voz a WhatsApp', color: '#6366f1' },
  { name: 'Cotización Enviada Agente de WhatsApp', color: '#10b981' },
  { name: 'Cotización Enviada vía Instagram', color: '#d62976' },
  { name: 'Cotización Enviada vía Facebook', color: '#1877f2' },
  { name: 'Derivar a humano', color: '#ef4444' }
];

let schemaReady = null;
function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await q(`CREATE TABLE IF NOT EXISTS pipelines (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await q(`CREATE TABLE IF NOT EXISTS pipeline_stages (
      id BIGSERIAL PRIMARY KEY,
      pipeline_id BIGINT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      position INT NOT NULL DEFAULT 0,
      color TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await q(`CREATE TABLE IF NOT EXISTS opportunities (
      id BIGSERIAL PRIMARY KEY,
      pipeline_id BIGINT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
      stage_id BIGINT REFERENCES pipeline_stages(id) ON DELETE SET NULL,
      title TEXT,
      contact_id BIGINT,
      ghl_contact_id TEXT,
      phone TEXT,
      channel TEXT,
      quote_number NUMERIC,
      quote_amount NUMERIC,
      quote_pdf_url TEXT,
      value NUMERIC,
      status TEXT NOT NULL DEFAULT 'open',
      position DOUBLE PRECISION NOT NULL DEFAULT 0,
      external_id TEXT,
      meta JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await q(`CREATE TABLE IF NOT EXISTS opportunity_events (
      id BIGSERIAL PRIMARY KEY,
      opportunity_id BIGINT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
      from_stage_id BIGINT,
      to_stage_id BIGINT,
      actor TEXT,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS opp_external_id_uq ON opportunities(external_id) WHERE external_id IS NOT NULL`);
    await q(`CREATE INDEX IF NOT EXISTS opp_stage_idx ON opportunities(stage_id)`);
    await q(`CREATE INDEX IF NOT EXISTS opp_quote_idx ON opportunities(quote_number)`);
    // 'position' admite valores fraccionados (reordenar sin renumerar todo). Si la
    // tabla ya existía como INT, se migra a DOUBLE PRECISION.
    const posType = await q(`SELECT data_type FROM information_schema.columns WHERE table_name='opportunities' AND column_name='position'`);
    if (posType.rows[0] && posType.rows[0].data_type === 'integer') {
      await q(`ALTER TABLE opportunities ALTER COLUMN position TYPE DOUBLE PRECISION`);
    }

    // Semilla: un pipeline "Cotizaciones" con las 5 etapas por defecto.
    const p = await q(`SELECT id FROM pipelines ORDER BY id LIMIT 1`);
    if (!p.rows.length) {
      const ins = await q(`INSERT INTO pipelines(name) VALUES ($1) RETURNING id`, ['Cotizaciones']);
      const pid = ins.rows[0].id;
      for (let i = 0; i < DEFAULT_STAGES.length; i++) {
        await q(`INSERT INTO pipeline_stages(pipeline_id, name, position, color) VALUES ($1,$2,$3,$4)`,
          [pid, DEFAULT_STAGES[i].name, i + 1, DEFAULT_STAGES[i].color]);
      }
    }
  })().catch(e => { schemaReady = null; throw e; });
  return schemaReady;
}

async function defaultPipelineId() {
  const p = await q(`SELECT id FROM pipelines ORDER BY id LIMIT 1`);
  return p.rows[0] ? p.rows[0].id : null;
}

// ---------- Auth ----------
// Escrituras de la interfaz: requieren sesión cuando la auth está configurada.
// En local (sin Supabase) no bloquea, para poder desarrollar y probar.
async function requireUser(req, res, next) {
  if (!configured) { req.role = 'local'; return next(); }
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  const role = await roleForToken(t);
  if (!role) return res.status(401).json({ error: 'Requiere sesión' });
  req.role = role;
  next();
}
// Webhook de n8n: se protege con una API key propia (header X-Api-Key).
function requireApiKey(req, res, next) {
  const key = process.env.N8N_API_KEY || '';
  if (!key) return res.status(503).json({ error: 'N8N_API_KEY no configurado en el servidor' });
  const got = req.headers['x-api-key'] || req.query.api_key || '';
  if (got !== key) return res.status(401).json({ error: 'API key inválida' });
  next();
}

// Resuelve el contacto (contacts) por ghl_contact_id o teléfono; devuelve {contactId, channel}.
async function resolveContact({ ghlContactId, phone }) {
  let row = null;
  if (ghlContactId) {
    const r = await q(`SELECT id FROM contacts WHERE ghl_contact_id=$1 LIMIT 1`, [String(ghlContactId)]);
    row = r.rows[0];
  }
  if (!row && phone) {
    const r = await q(`SELECT id FROM contacts WHERE phone=$1 LIMIT 1`, [String(phone)]);
    row = r.rows[0];
  }
  if (!row) return { contactId: null, channel: null };
  // canal: el de la conversación más reciente de ese contacto
  const ch = await q(`SELECT channel FROM conversations WHERE contact_id=$1 AND channel IS NOT NULL ORDER BY updated_at DESC NULLS LAST LIMIT 1`, [row.id]);
  return { contactId: row.id, channel: ch.rows[0] ? normChannel(ch.rows[0].channel) : null };
}

// Serializa una oportunidad para el frontend.
const shapeOpp = o => ({
  id: String(o.id),
  pipelineId: String(o.pipeline_id),
  stageId: o.stage_id != null ? String(o.stage_id) : null,
  title: o.title || null,
  contactId: o.contact_id != null ? String(o.contact_id) : null,
  ghlContactId: o.ghl_contact_id || null,
  phone: o.phone || null,
  channel: o.channel || null,
  quoteNumber: o.quote_number != null ? Number(o.quote_number) : null,
  quoteAmount: o.quote_amount != null ? Number(o.quote_amount) : null,
  quotePdfUrl: o.quote_pdf_url || null,
  value: o.value != null ? Number(o.value) : null,
  status: o.status || 'open',
  position: o.position != null ? Number(o.position) : 0,
  externalId: o.external_id || null,
  createdAt: o.created_at,
  updatedAt: o.updated_at
});

// ---------- Lectura: pipeline + etapas ----------
router.get('/pipelines', wrap(async (_req, res) => {
  await ensureSchema();
  const pl = await q(`SELECT id, name FROM pipelines ORDER BY id`);
  const st = await q(`SELECT id, pipeline_id, name, position, color FROM pipeline_stages ORDER BY pipeline_id, position, id`);
  res.json({
    pipelines: pl.rows.map(p => ({
      id: String(p.id), name: p.name,
      stages: st.rows.filter(s => String(s.pipeline_id) === String(p.id))
        .map(s => ({ id: String(s.id), name: s.name, position: Number(s.position), color: s.color || null }))
    }))
  });
}));

// ---------- Lectura: oportunidades (filtro por canal / búsqueda) ----------
router.get('/opportunities', wrap(async (req, res) => {
  await ensureSchema();
  const pid = req.query.pipelineId ? Number(req.query.pipelineId) : await defaultPipelineId();
  const params = [pid];
  let where = `pipeline_id = $1 AND status <> 'archived'`;
  const channel = normChannel(req.query.channel);
  if (channel) { params.push(channel); where += ` AND channel = $${params.length}`; }
  const search = String(req.query.search || '').trim();
  if (search) {
    params.push('%' + search + '%');
    where += ` AND (title ILIKE $${params.length} OR phone ILIKE $${params.length} OR CAST(quote_number AS TEXT) ILIKE $${params.length})`;
  }
  const r = await q(`SELECT * FROM opportunities WHERE ${where} ORDER BY stage_id, position DESC, id DESC`, params);
  res.json({ pipelineId: pid != null ? String(pid) : null, items: r.rows.map(shapeOpp) });
}));

// ---------- Cotización de una oportunidad (MSSQL cabecera+líneas + PDF) ----------
router.get('/opportunities/:id/quote', requireUser, wrap(async (req, res) => {
  await ensureSchema();
  const r = await q(`SELECT id, quote_number, quote_pdf_url FROM opportunities WHERE id=$1`, [Number(req.params.id)]);
  const opp = r.rows[0];
  if (!opp) return res.status(404).json({ error: 'Oportunidad no encontrada' });
  let quote = null;
  if (opp.quote_number != null) {
    try { quote = await quoteDetail(opp.quote_number); }
    catch (e) { return res.json({ quoteNumber: Number(opp.quote_number), pdfUrl: opp.quote_pdf_url || null, quote: null, error: e.message }); }
  }
  res.json({ quoteNumber: opp.quote_number != null ? Number(opp.quote_number) : null, pdfUrl: opp.quote_pdf_url || null, quote });
}));

// ---------- Mover / editar una oportunidad (arrastrar desde la interfaz) ----------
router.patch('/opportunities/:id', requireUser, wrap(async (req, res) => {
  await ensureSchema();
  const id = Number(req.params.id);
  const cur = await q(`SELECT * FROM opportunities WHERE id=$1`, [id]);
  const opp = cur.rows[0];
  if (!opp) return res.status(404).json({ error: 'Oportunidad no encontrada' });
  const b = req.body || {};
  const sets = [], vals = [];
  const put = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };

  let movedTo = null;
  if (b.stageId != null) { const sid = Number(b.stageId); put('stage_id', sid); if (String(sid) !== String(opp.stage_id)) movedTo = sid; }
  if (b.position != null) put('position', Number(b.position));
  if (b.title != null) put('title', String(b.title));
  if (b.status != null) put('status', String(b.status));
  if (b.value !== undefined) put('value', b.value === null ? null : Number(b.value));
  if (b.channel !== undefined) put('channel', normChannel(b.channel));
  if (!sets.length) return res.json({ ok: true, opportunity: shapeOpp(opp) });
  sets.push('updated_at = now()');
  vals.push(id);
  const upd = await q(`UPDATE opportunities SET ${sets.join(', ')} WHERE id=$${vals.length} RETURNING *`, vals);

  if (movedTo != null) {
    const actor = (req.role && req.role !== 'local') ? req.role : 'usuario';
    await q(`INSERT INTO opportunity_events(opportunity_id, from_stage_id, to_stage_id, actor, note) VALUES ($1,$2,$3,$4,$5)`,
      [id, opp.stage_id, movedTo, actor, 'Movida desde la interfaz']);
  }
  res.json({ ok: true, opportunity: shapeOpp(upd.rows[0]) });
}));

// ---------- Webhook n8n: crear/actualizar oportunidad (upsert) ----------
// Body: { externalId?, title?, phone?, ghlContactId?, channel?, stage? | stageId?,
//         quoteNumber?, quoteAmount?, quotePdfUrl?, value?, status?, meta? }
// Idempotente por externalId; si no hay, intenta emparejar por quoteNumber.
router.post('/hooks/opportunities', requireApiKey, wrap(async (req, res) => {
  await ensureSchema();
  const b = req.body || {};
  const pid = await defaultPipelineId();
  if (!pid) return res.status(500).json({ error: 'Sin pipeline configurado' });

  // Etapa: por id, o por nombre (insensible a mayúsculas y acentos), o la primera.
  const stagesR = await q(`SELECT id, name, position FROM pipeline_stages WHERE pipeline_id=$1 ORDER BY position, id`, [pid]);
  let stageId = b.stageId != null ? Number(b.stageId) : null;
  if (!stageId && b.stage) {
    const want = normName(b.stage);
    const hit = stagesR.rows.find(s => normName(s.name) === want);
    stageId = hit ? Number(hit.id) : null;
  }
  if (!stageId) stageId = stagesR.rows[0] ? Number(stagesR.rows[0].id) : null;

  const { contactId, channel: derivedChannel } = await resolveContact({ ghlContactId: b.ghlContactId, phone: b.phone });
  const channel = normChannel(b.channel) || derivedChannel;
  const ext = b.externalId != null ? String(b.externalId) : null;
  const quoteNumber = b.quoteNumber != null && b.quoteNumber !== '' ? Number(b.quoteNumber) : null;

  // ¿existe ya? por externalId, si no por quoteNumber.
  let existing = null;
  if (ext) existing = (await q(`SELECT * FROM opportunities WHERE external_id=$1`, [ext])).rows[0] || null;
  if (!existing && quoteNumber != null) existing = (await q(`SELECT * FROM opportunities WHERE quote_number=$1 ORDER BY id LIMIT 1`, [quoteNumber])).rows[0] || null;

  if (existing) {
    const sets = [], vals = [];
    const put = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (b.title != null) put('title', String(b.title));
    if (stageId != null) put('stage_id', stageId);
    if (b.phone != null) put('phone', String(b.phone));
    if (b.ghlContactId != null) put('ghl_contact_id', String(b.ghlContactId));
    if (contactId != null) put('contact_id', contactId);
    if (channel != null) put('channel', channel);
    if (quoteNumber != null) put('quote_number', quoteNumber);
    if (b.quoteAmount != null) put('quote_amount', Number(b.quoteAmount));
    if (b.quotePdfUrl != null) put('quote_pdf_url', String(b.quotePdfUrl));
    if (b.value != null) put('value', Number(b.value));
    if (b.status != null) put('status', String(b.status));
    if (b.meta != null) put('meta', JSON.stringify(b.meta));
    if (ext) put('external_id', ext);
    sets.push('updated_at = now()');
    vals.push(existing.id);
    const upd = await q(`UPDATE opportunities SET ${sets.join(', ')} WHERE id=$${vals.length} RETURNING *`, vals);
    if (stageId != null && String(stageId) !== String(existing.stage_id)) {
      await q(`INSERT INTO opportunity_events(opportunity_id, from_stage_id, to_stage_id, actor, note) VALUES ($1,$2,$3,'n8n',$4)`,
        [existing.id, existing.stage_id, stageId, 'Actualizada por n8n']);
    }
    return res.json({ ok: true, created: false, opportunity: shapeOpp(upd.rows[0]) });
  }

  // nueva: posición = final de la etapa
  const posR = await q(`SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM opportunities WHERE stage_id=$1`, [stageId]);
  const pos = posR.rows[0] ? Number(posR.rows[0].pos) : 1;
  const ins = await q(
    `INSERT INTO opportunities
       (pipeline_id, stage_id, title, contact_id, ghl_contact_id, phone, channel,
        quote_number, quote_amount, quote_pdf_url, value, status, position, external_id, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [pid, stageId, b.title != null ? String(b.title) : null, contactId,
     b.ghlContactId != null ? String(b.ghlContactId) : null, b.phone != null ? String(b.phone) : null, channel,
     quoteNumber, b.quoteAmount != null ? Number(b.quoteAmount) : null, b.quotePdfUrl != null ? String(b.quotePdfUrl) : null,
     b.value != null ? Number(b.value) : null, b.status != null ? String(b.status) : 'open', pos, ext,
     b.meta != null ? JSON.stringify(b.meta) : null]
  );
  await q(`INSERT INTO opportunity_events(opportunity_id, to_stage_id, actor, note) VALUES ($1,$2,'n8n',$3)`,
    [ins.rows[0].id, stageId, 'Creada por n8n']);
  res.status(201).json({ ok: true, created: true, opportunity: shapeOpp(ins.rows[0]) });
}));

// ---------- Gestión de etapas (editables) ----------
router.post('/stages', requireUser, wrap(async (req, res) => {
  await ensureSchema();
  const b = req.body || {};
  const pid = b.pipelineId ? Number(b.pipelineId) : await defaultPipelineId();
  if (!b.name) return res.status(400).json({ error: 'Falta el nombre' });
  const posR = await q(`SELECT COALESCE(MAX(position),0)+1 AS pos FROM pipeline_stages WHERE pipeline_id=$1`, [pid]);
  const r = await q(`INSERT INTO pipeline_stages(pipeline_id, name, position, color) VALUES ($1,$2,$3,$4) RETURNING id, name, position, color`,
    [pid, String(b.name), Number(posR.rows[0].pos), b.color || null]);
  res.status(201).json({ ok: true, stage: { id: String(r.rows[0].id), name: r.rows[0].name, position: Number(r.rows[0].position), color: r.rows[0].color } });
}));

router.patch('/stages/:id', requireUser, wrap(async (req, res) => {
  await ensureSchema();
  const b = req.body || {};
  const sets = [], vals = [];
  const put = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (b.name != null) put('name', String(b.name));
  if (b.color != null) put('color', String(b.color));
  if (b.position != null) put('position', Number(b.position));
  if (!sets.length) return res.json({ ok: true });
  vals.push(Number(req.params.id));
  await q(`UPDATE pipeline_stages SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
  res.json({ ok: true });
}));

module.exports = router;
