/* =========================================================
   fix-orphan-contacts.js — Arregla contactos "?" (sin nombre/teléfono/id)
   creados por envíos manuales que no pasaron el destinatario. Recupera el
   teléfono/user_id decodificando el wamid del mensaje y:
     - si el contacto real ya existe → mueve el mensaje ahí y borra el huérfano;
     - si no existe → etiqueta al huérfano con el identificador recuperado.
   Uso: node migration/fix-orphan-contacts.js [--apply]
   ========================================================= */
'use strict';
const { q, pool } = require('../db');
const APPLY = process.argv.includes('--apply');

function decodeWamid(wamid) {
  if (!wamid) return {};
  try {
    const dec = Buffer.from(String(wamid).replace(/^wamid\./, ''), 'base64').toString('latin1');
    const mMeta = dec.match(/[A-Z]{2}\.\d{6,}/);
    if (mMeta) return { userId: mMeta[0] };
    const mPhone = dec.match(/\d{10,15}/);
    if (mPhone) return { phone: mPhone[0] };
  } catch (_) {}
  return {};
}

(async () => {
  console.log(APPLY ? '=== APLICAR ===' : '=== DRY-RUN ===');
  const orphans = (await q(
    `SELECT c.id, cv.id AS conv
     FROM contacts c JOIN conversations cv ON cv.contact_id = c.id
     WHERE (c.name IS NULL OR trim(c.name)='') AND c.phone IS NULL AND c.user_id IS NULL`)).rows;
  console.log('huérfanos:', orphans.length);
  let merged = 0, labeled = 0, skipped = 0;

  for (const o of orphans) {
    const w = (await q(`SELECT wamid FROM messages WHERE conversation_id=$1 AND wamid IS NOT NULL ORDER BY id ASC LIMIT 1`, [o.conv])).rows[0];
    const rec = decodeWamid(w && w.wamid);
    if (!rec.phone && !rec.userId) { skipped++; console.log('  · contacto', o.id, '→ sin wamid útil, se omite'); continue; }

    const real = (await q(
      `SELECT id, (SELECT id FROM conversations WHERE contact_id=contacts.id) conv
       FROM contacts WHERE id <> $1 AND (
         ($2::text IS NOT NULL AND (phone=$2 OR ghl_contact_id=$2 OR user_id=$2)) OR
         ($3::text IS NOT NULL AND (user_id=$3 OR ghl_contact_id=$3 OR phone=$3)))
       ORDER BY id LIMIT 1`, [o.id, rec.phone || null, rec.userId || null])).rows[0];

    if (real) {
      console.log('  · contacto', o.id, '→ FUNDIR en', real.id, '('+(rec.phone||rec.userId)+')');
      if (APPLY) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          if (real.conv) {
            await client.query(`UPDATE messages SET conversation_id=$1 WHERE conversation_id=$2`, [real.conv, o.conv]);
            await client.query(`DELETE FROM contacts WHERE id=$1`, [o.id]);  // cascade borra la conv vacía
          } else {
            await client.query(`UPDATE conversations SET contact_id=$1 WHERE id=$2`, [real.id, o.conv]);
            await client.query(`DELETE FROM contacts WHERE id=$1`, [o.id]);
          }
          // recalcular agregados de la conv del real
          const rc = real.conv || o.conv;
          await client.query(
            `WITH last AS (SELECT text, COALESCE(sent_at,created_at) ts, direction, status FROM messages WHERE conversation_id=$1 ORDER BY COALESCE(sent_at,created_at) DESC NULLS LAST, id DESC LIMIT 1)
             UPDATE conversations SET last_message=(SELECT text FROM last), last_message_at=(SELECT ts FROM last),
               last_direction=(SELECT direction FROM last), last_status=(SELECT status FROM last), updated_at=now() WHERE id=$1`, [rc]);
          await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK'); console.error('    error:', e.message); }
        finally { client.release(); }
      }
      merged++;
    } else {
      console.log('  · contacto', o.id, '→ etiquetar', rec.phone ? 'phone='+rec.phone : 'user_id='+rec.userId, '(no hay contacto real)');
      if (APPLY) await q(`UPDATE contacts SET phone=COALESCE(phone,$2), user_id=COALESCE(user_id,$3), updated_at=now() WHERE id=$1`,
        [o.id, rec.phone || null, rec.userId || null]);
      labeled++;
    }
  }
  console.log(`\n${APPLY ? 'APLICADO' : 'RESUMEN'}: fundidos=${merged} etiquetados=${labeled} omitidos=${skipped}`);
  if (!APPLY) console.log('Ejecutar: node migration/fix-orphan-contacts.js --apply');
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
