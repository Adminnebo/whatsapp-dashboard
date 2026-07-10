/* Pool de Postgres + helpers. Conecta a la MISMA base (Railway) vía DATABASE_URL. */
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('[db] Falta DATABASE_URL — configúrala en las variables de entorno.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway (proxy público) funciona sin SSL; ponible con PGSSL=true si hiciera falta.
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PG_MAX || 10),
  idleTimeoutMillis: 30000
});

pool.on('error', (err) => console.error('[db] error inesperado en cliente idle', err.message));

const q = (text, params) => pool.query(text, params);

module.exports = { pool, q };
