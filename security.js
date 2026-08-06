/* =========================================================
   security.js — Endurecimiento sin dependencias externas:
   cabeceras de seguridad + rate limit en memoria (por IP real).
   Pensado para un solo proceso por servicio (Railway). Se replica igual
   en los 3 backends (inbox, cotizaciones, cobranzas).
   ========================================================= */
'use strict';
const crypto = require('crypto');

// Compara tokens/API keys en tiempo constante (evita timing attacks). La longitud
// no es secreta, así que un desajuste de largo devuelve false directo.
function safeEqual(a, b) {
  a = String(a == null ? '' : a);
  b = String(b == null ? '' : b);
  if (a.length !== b.length || a.length === 0) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch (_) { return false; }
}

// Framers permitidos: el propio panel + GoHighLevel (los paneles se embeben como
// iframe dentro de la subcuenta de GHL). Configurable por env FRAME_ANCESTORS.
const FRAME_ANCESTORS = process.env.FRAME_ANCESTORS ||
  "'self' https://app.gohighlevel.com https://*.gohighlevel.com https://*.leadconnectorhq.com";

// Cabeceras de seguridad. La única CSP que ponemos es frame-ancestors (controla
// quién puede embeber); no tocamos scripts/estilos inline que usan los paneles.
function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');                       // no adivinar el MIME
  // OJO: NO usar X-Frame-Options: SAMEORIGIN → bloquea el iframe de GHL. El
  // control de embebido se hace SOLO con frame-ancestors (permite allowlist).
  res.setHeader('Content-Security-Policy', 'frame-ancestors ' + FRAME_ANCESTORS);
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0');                                   // desactiva el filtro legacy (recomendado)
  res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains'); // 180 días HTTPS
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
}

function hardening(app) {
  app.set('trust proxy', 1);        // detrás del proxy de Railway → req.ip = IP real del cliente
  app.disable('x-powered-by');      // no revelar que es Express
  app.use(securityHeaders);
}

// Rate limit en memoria, ventana fija por IP.
// opts: { windowMs, max, skip(req)->bool, message }
function rateLimit(opts = {}) {
  const windowMs = opts.windowMs || 60000;
  const max = opts.max || 300;
  const skip = opts.skip || (() => false);
  const message = opts.message || 'Demasiadas solicitudes. Espera un momento e intenta de nuevo.';
  const hits = new Map();            // ip -> { count, reset }

  const limpieza = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs);
  if (limpieza.unref) limpieza.unref();

  return function (req, res, next) {
    if (skip(req)) return next();
    const now = Date.now();
    const ip = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
    let e = hits.get(ip);
    if (!e || e.reset <= now) { e = { count: 0, reset: now + windowMs }; hits.set(ip, e); }
    e.count++;
    const restante = Math.max(0, max - e.count);
    const resetSecs = Math.ceil((e.reset - now) / 1000);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(restante));
    res.setHeader('RateLimit-Reset', String(resetSecs));
    if (e.count > max) {
      res.setHeader('Retry-After', String(resetSecs));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

module.exports = { hardening, securityHeaders, rateLimit, safeEqual };
