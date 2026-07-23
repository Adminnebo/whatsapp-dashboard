/* =========================================================
   quoteGaps.js — Vigila la secuencia de números de cotización.

   Los nfactura de las cotizaciones deben ser consecutivos. Si aparece un hueco
   (un número que falta entre dos que existen), se avisa UNA sola vez a un webhook.
   El registro de huecos ya avisados vive en Postgres (sobrevive a reinicios), así
   que no se repite la alerta.

   Config:
     QUOTE_GAP_WEBHOOK_URL   webhook al que avisar (n8n, Slack, etc.)
     QUOTE_GAP_WINDOW        cuántos números recientes revisar (def. 3000)
     QUOTE_GAP_SCAN_MINUTES  cada cuánto revisar (def. 10)
   ========================================================= */
'use strict';
const { q } = require('./db');
const { quoteNumbers } = require('./mssql');

const WEBHOOK = process.env.QUOTE_GAP_WEBHOOK_URL || '';
const WINDOW = Number(process.env.QUOTE_GAP_WINDOW || 3000);

let ready = null;
function ensureSchema() {
  if (ready) return ready;
  ready = q(`CREATE TABLE IF NOT EXISTS quote_gap_alerts (
    gap_number BIGINT PRIMARY KEY,
    before_number BIGINT,
    after_number BIGINT,
    notified BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now()
  )`).catch(e => { ready = null; throw e; });
  return ready;
}

// Dada la lista de números presentes, devuelve los que faltan entre el mínimo
// y el máximo (los huecos), con el número anterior y siguiente de cada uno.
function huecos(numbers) {
  const set = new Set(numbers);
  const min = Math.min(...numbers), max = Math.max(...numbers);
  const gaps = [];
  for (let n = min + 1; n < max; n++) {
    if (!set.has(n)) {
      // anterior/siguiente presentes (para dar contexto en la alerta)
      let before = n - 1; while (before >= min && !set.has(before)) before--;
      let after = n + 1;  while (after <= max && !set.has(after)) after++;
      gaps.push({ gap: n, before, after });
    }
  }
  return gaps;
}

async function avisar(gap, total) {
  if (!WEBHOOK) return false;
  try {
    const res = await fetch(WEBHOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tipo: 'hueco_cotizacion',
        mensaje: `Se rompió la secuencia de cotizaciones: falta el número ${gap.gap}`,
        numero_faltante: gap.gap,
        numero_anterior: gap.before,
        numero_siguiente: gap.after,
        huecos_totales: total,
        detectado: new Date().toISOString()
      })
    });
    return res.ok;
  } catch (e) {
    console.error('[quote-gaps] webhook', e.message);
    return false;
  }
}

// Revisa la secuencia y avisa de los huecos NUEVOS (no avisados antes).
// `numerosPrueba` permite inyectar la lista (tests); en producción va a MSSQL.
async function revisar(numerosPrueba) {
  const r = numerosPrueba ? { available: true, numbers: numerosPrueba } : await quoteNumbers(WINDOW);
  if (!r.available || r.numbers.length < 2) return { available: r.available, nuevos: 0 };
  await ensureSchema();

  const gaps = huecos(r.numbers);
  if (!gaps.length) return { available: true, huecos: 0, nuevos: 0 };

  // ¿cuáles ya estaban registrados?
  const ya = new Set((await q(
    `SELECT gap_number FROM quote_gap_alerts WHERE gap_number = ANY($1::bigint[])`,
    [gaps.map(g => g.gap)]
  )).rows.map(x => Number(x.gap_number)));

  const nuevos = gaps.filter(g => !ya.has(g.gap));
  for (const g of nuevos) {
    const ok = await avisar(g, gaps.length);
    await q(
      `INSERT INTO quote_gap_alerts (gap_number, before_number, after_number, notified)
       VALUES ($1,$2,$3,$4) ON CONFLICT (gap_number) DO NOTHING`,
      [g.gap, g.before, g.after, ok]
    );
    console.log('[quote-gaps] hueco', g.gap, '(entre', g.before, 'y', g.after, ')', ok ? '→ avisado' : '→ sin webhook');
  }
  return { available: true, huecos: gaps.length, nuevos: nuevos.length };
}

// Arranca el escaneo periódico.
function start() {
  const mins = Math.max(1, Number(process.env.QUOTE_GAP_SCAN_MINUTES || 10));
  const tick = () => revisar().catch(e => console.error('[quote-gaps]', e.message));
  setTimeout(tick, 20 * 1000);              // primera pasada a los 20s
  setInterval(tick, mins * 60 * 1000);
  console.log(`[quote-gaps] vigilando secuencia cada ${mins} min` + (WEBHOOK ? '' : ' (sin QUOTE_GAP_WEBHOOK_URL: solo registra)'));
}

module.exports = { start, revisar, huecos };
