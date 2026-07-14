/* =========================================================
   quotes.js — Cotizaciones detalladas.
   Los DATOS viven en MSSQL (site4now): cabecera iCotizacionesWebIA y
   líneas/productos dCotizacionesWebIA. El DOCUMENTO (PDF) vive en
   Supabase Storage, bucket público, con el nº en el nombre del archivo
   (por defecto: cotizacion_{n}.pdf).
   Se monta en /api.
   ========================================================= */
'use strict';
const express = require('express');
const { quotesList, quoteDetail } = require('./mssql');
const { optionalAuth } = require('./analyticsAuth');
const { rangeOf } = require('./range');
const router = express.Router();

const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => { console.error(req.path, e.message); res.status(500).json({ error: e.message }); });

// ---------- PDF en Supabase Storage (bucket público) ----------
// URL: {SUPABASE_URL}/storage/v1/object/public/{bucket}/{archivo}
// Si los PDFs viven en un proyecto de Supabase distinto al del auth, se
// puede apuntar aparte con SUPABASE_STORAGE_URL.
const SB_URL = String(process.env.SUPABASE_STORAGE_URL || process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const BUCKET = process.env.SUPABASE_QUOTES_BUCKET || 'Lucas';
const PATTERN = process.env.SUPABASE_QUOTES_PATTERN || 'cotizacion_{n}.pdf';

function pdfUrlFor(n) {
  if (!SB_URL || n == null) return null;
  const file = PATTERN.replace('{n}', String(n));
  return `${SB_URL}/storage/v1/object/public/${encodeURIComponent(BUCKET)}/${encodeURIComponent(file)}`;
}

// ---------- Listado (una fila por cotización) ----------
// GET /api/quotes?days=30|all | from&to  &search=&page=&limit=
router.get('/quotes', optionalAuth, wrap(async (req, res) => {
  const { from, to } = rangeOf(req);
  const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 50));
  const page = Math.max(1, Number(req.query.page) || 1);
  const search = String(req.query.search || '').trim();

  const r = await quotesList({ from, to, search, limit, offset: (page - 1) * limit });
  if (!r.available) {
    return res.json({ available: false, page, limit, total: 0, amount: 0, products: 0, units: 0, items: [], error: 'MSSQL no configurado' });
  }
  res.json({
    available: true,
    range: { from, to },
    page, limit,
    total: r.total,
    amount: r.amount,
    products: r.products,
    units: r.units,
    items: r.items.map(x => ({ ...x, pdfUrl: pdfUrlFor(x.number) }))
  });
}));

// ---------- Detalle: productos cotizados (al desplegar la fila) ----------
// GET /api/quotes/:n
router.get('/quotes/:n', optionalAuth, wrap(async (req, res) => {
  const n = Number(req.params.n);
  if (!Number.isFinite(n)) return res.status(400).json({ error: 'Número de cotización inválido' });
  const quote = await quoteDetail(n);
  if (!quote) return res.status(404).json({ error: 'Cotización no encontrada' });
  res.json({ ...quote, pdfUrl: pdfUrlFor(n) });
}));

module.exports = router;
