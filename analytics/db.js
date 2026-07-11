const { Pool } = require('pg');
if (!process.env.DATABASE_URL) console.warn('[db] Falta DATABASE_URL');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PG_MAX || 8),
  idleTimeoutMillis: 30000
});
pool.on('error', e => console.error('[db] idle client error', e.message));
module.exports = { pool, q: (t, p) => pool.query(t, p) };
