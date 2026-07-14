/* =========================================================
   mssql.js — conexión ÚNICA a la base MSSQL (site4now) donde viven
   las cotizaciones. Centraliza el pool para no abrir conexiones de más.
   Expone: getMssql (pool), quotesStat (conteo/monto por rango) y
   quoteDetail (cabecera + líneas de una cotización por nfactura).
   Config por env MSSQL_*.
   ========================================================= */
'use strict';
const sql = require('mssql');

let pool = null;
async function getMssql() {
  if (!process.env.MSSQL_SERVER) return null;
  if (pool && pool.connected) return pool;
  try {
    const p = new sql.ConnectionPool({
      server: process.env.MSSQL_SERVER,
      database: process.env.MSSQL_DATABASE,
      user: process.env.MSSQL_USER,
      password: process.env.MSSQL_PASSWORD,
      port: Number(process.env.MSSQL_PORT || 1433),
      options: { encrypt: process.env.MSSQL_ENCRYPT === 'true', trustServerCertificate: true },
      pool: { max: 4, idleTimeoutMillis: 30000 },
      connectionTimeout: 15000, requestTimeout: 15000
    });
    pool = await p.connect();
    pool.on('error', () => { pool = null; });
    return pool;
  } catch (e) { pool = null; throw e; }
}

// Conteo y monto de cotizaciones en un rango de fechas.
async function quotesStat(from, to) {
  if (!process.env.MSSQL_SERVER) return { available: false };
  const table = process.env.MSSQL_QUOTES_TABLE || 'iCotizacionesWebIA';
  const dateCol = process.env.MSSQL_QUOTES_DATE || 'FechaRegistro';
  const amountCol = process.env.MSSQL_QUOTES_AMOUNT || 'total';
  try {
    const p = await getMssql();
    const r = await p.request()
      .input('from', sql.DateTime, new Date(from))
      .input('to', sql.DateTime, new Date(to || Date.now()))
      .query(`SELECT COUNT(*) AS n, COALESCE(SUM([${amountCol}]),0) AS monto FROM [${table}] WHERE [${dateCol}] >= @from AND [${dateCol}] < @to`);
    const row = r.recordset[0] || {};
    return { available: true, count: Number(row.n) || 0, amount: Number(row.monto) || 0 };
  } catch (e) {
    pool = null;
    return { available: false, error: e.message };
  }
}

// Lista paginada de cotizaciones (cabeceras) en un rango, con búsqueda por
// cliente / RNC / nº de cotización / teléfono. Devuelve items + total + monto.
async function quotesList({ from, to, search, limit = 50, offset = 0 }) {
  if (!process.env.MSSQL_SERVER) return { available: false, items: [], total: 0, amount: 0 };
  const p = await getMssql();
  if (!p) return { available: false, items: [], total: 0, amount: 0 };

  const s = String(search || '').trim();
  const where = `WHERE FechaRegistro >= @from AND FechaRegistro < @to` +
    (s ? ` AND (clientenombre LIKE @s OR RNC LIKE @s OR Telefono LIKE @s OR CAST(nfactura AS VARCHAR(32)) LIKE @s)` : '');
  const bind = () => {
    const r = p.request()
      .input('from', sql.DateTime, new Date(from))
      .input('to', sql.DateTime, new Date(to));
    if (s) r.input('s', sql.NVarChar, '%' + s + '%');
    return r;
  };

  const [rows, cnt, prod] = await Promise.all([
    bind().query(`SELECT nfactura, clientenombre, RNC, Telefono, Correo, Ciudad,
                         total, itbis, FechaRegistro, vencimiento, Estatus, Enviado
                  FROM iCotizacionesWebIA ${where}
                  ORDER BY FechaRegistro DESC, nfactura DESC
                  OFFSET ${Number(offset)} ROWS FETCH NEXT ${Number(limit)} ROWS ONLY`),
    bind().query(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS monto FROM iCotizacionesWebIA ${where}`),
    // productos cotizados (líneas) de las cotizaciones que caen en el mismo rango/búsqueda
    bind().query(`SELECT COUNT(*) AS lineas, COALESCE(SUM(d.cantidad),0) AS unidades
                  FROM dCotizacionesWebIA d
                  WHERE d.nfactura IN (SELECT nfactura FROM iCotizacionesWebIA ${where})`)
  ]);

  const c = cnt.recordset[0] || {};
  const pr = prod.recordset[0] || {};
  return {
    available: true,
    total: Number(c.n) || 0,
    amount: Number(c.monto) || 0,
    products: Number(pr.lineas) || 0,      // nº de productos/líneas cotizados
    units: Number(pr.unidades) || 0,       // suma de cantidades
    items: rows.recordset.map(h => ({
      number: Number(h.nfactura),
      client: (h.clientenombre || '').trim(),
      rnc: (h.RNC || '').trim(),
      phone: (h.Telefono || '').trim(),
      email: (h.Correo || '').trim(),
      city: (h.Ciudad || '').trim(),
      total: Number(h.total) || 0,
      itbis: Number(h.itbis) || 0,
      date: h.FechaRegistro || null,
      dueDate: h.vencimiento || null,
      status: h.Estatus,
      sent: !!h.Enviado
    }))
  };
}

// Reconstruye una cotización: cabecera (iCotizacionesWebIA) + líneas (dCotizacionesWebIA),
// unidas por nfactura. Devuelve null si no hay MSSQL o no existe la cotización.
async function quoteDetail(nfactura) {
  if (!process.env.MSSQL_SERVER) return null;
  const n = Number(nfactura);
  if (!Number.isFinite(n)) return null;
  const p = await getMssql();
  if (!p) return null;
  const head = await p.request()
    .input('n', sql.Numeric(18, 0), n)
    .query(`SELECT TOP 1 nfactura, clientenombre, RNC, Direccion, Telefono, Correo, Ciudad, Sector,
                   total, itbis, FechaRegistro, fecha, vencimiento, Estatus, Enviado, comentarios
            FROM iCotizacionesWebIA WHERE nfactura=@n`);
  const header = head.recordset[0];
  if (!header) return null;
  const det = await p.request()
    .input('n', sql.Numeric(18, 0), n)
    .query(`SELECT codigo, Descripcion, Und, cantidad, precio, MontoITBIS
            FROM dCotizacionesWebIA WHERE nfactura=@n ORDER BY sec`);
  const lines = det.recordset.map(l => ({
    codigo: l.codigo || '',
    descripcion: l.Descripcion || '',
    unidad: (l.Und || '').trim(),
    cantidad: Number(l.cantidad) || 0,
    precio: Number(l.precio) || 0,
    itbis: Number(l.MontoITBIS) || 0,
    importe: (Number(l.cantidad) || 0) * (Number(l.precio) || 0)
  }));
  return {
    number: Number(header.nfactura),
    client: (header.clientenombre || '').trim(),
    rnc: (header.RNC || '').trim(),
    address: (header.Direccion || '').trim(),
    phone: (header.Telefono || '').trim(),
    email: (header.Correo || '').trim(),
    city: (header.Ciudad || '').trim(),
    total: Number(header.total) || 0,
    itbis: Number(header.itbis) || 0,
    date: header.FechaRegistro || header.fecha || null,
    dueDate: header.vencimiento || null,
    status: header.Estatus,
    sent: !!header.Enviado,
    notes: (header.comentarios || '').trim(),
    lines
  };
}

module.exports = { sql, getMssql, quotesStat, quotesList, quoteDetail };
