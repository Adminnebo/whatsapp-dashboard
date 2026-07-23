/**
 * Proxy de grabaciones. El origen (app.swordaisolutions.com) sirve el WAV sin
 * Accept-Ranges, sin Content-Length y sin CORS, por lo que el <audio> embebido
 * no puede reproducirlo (muestra 0:00 y no suena). Aquí lo descargamos del lado
 * del server y lo re-servimos con Content-Length + soporte de Range, mismo
 * origen que el dashboard -> el reproductor inline funciona y permite avanzar.
 *
 * Allowlist de hosts para evitar SSRF (solo dominios de grabaciones conocidos).
 */

const ALLOWED = (process.env.RECORDING_ALLOWED_HOSTS || 'swordaisolutions.com,neboaiconsulting.com,supabase.co')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

function hostAllowed(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:') return false;
    const h = url.hostname.toLowerCase();
    return ALLOWED.some((a) => h === a || h.endsWith('.' + a));
  } catch { return false; }
}

// Caché corto en memoria: el <audio> hace varias peticiones Range del mismo
// archivo; así no lo re-descargamos cada vez.
const cache = new Map(); // url -> { buf, type, at }
const TTL = 120000;
const MAX = 12;

function getCached(u) {
  const e = cache.get(u);
  if (e && Date.now() - e.at < TTL) return e;
  if (e) cache.delete(u);
  return null;
}
function setCached(u, buf, type) {
  cache.set(u, { buf, type, at: Date.now() });
  if (cache.size > MAX) cache.delete(cache.keys().next().value);
}

async function fetchFull(u) {
  const cached = getCached(u);
  if (cached) return cached;
  const res = await fetch(u);
  if (!res.ok) { const e = new Error(`origen ${res.status}`); e.status = res.status; throw e; }
  const type = res.headers.get('content-type') || 'audio/wav';
  const buf = Buffer.from(await res.arrayBuffer());
  setCached(u, buf, type);
  return { buf, type };
}

async function handle(req, res) {
  const u = req.query.url;
  if (!u) return res.status(400).send('falta url');
  if (!hostAllowed(u)) return res.status(403).send('host no permitido');

  try {
    const { buf, type } = await fetchFull(u);
    const total = buf.length;
    res.setHeader('Content-Type', type);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=120');

    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
      if (isNaN(start)) start = 0;
      if (isNaN(end) || end >= total) end = total - 1;
      if (start > end || start >= total) {
        res.status(416).setHeader('Content-Range', `bytes */${total}`);
        return res.end();
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', end - start + 1);
      return res.end(buf.subarray(start, end + 1));
    }

    res.setHeader('Content-Length', total);
    return res.end(buf);
  } catch (err) {
    console.error('[recordings/proxy]', err.message);
    res.status(err.status || 502).send('no se pudo obtener la grabación');
  }
}

module.exports = { handle };
