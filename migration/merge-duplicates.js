/* =========================================================
   merge-duplicates.js — Une contactos DUPLICADOS de WhatsApp.
   Dos contactos son la misma persona si comparten teléfono o user_id
   (o si el identificador de uno aparece en otra columna del otro).
   Conserva la conversación con MÁS mensajes; mueve los demás mensajes a
   esa (respetando sus fechas/hora), borra convs vacías y contactos sobrantes.
   Recalcula los agregados de la conversación resultante.

   Uso:
     node migration/merge-duplicates.js            (DRY-RUN: solo reporta)
     node migration/merge-duplicates.js --apply    (ejecuta los cambios)

   Seguro: cada grupo va en su propia transacción. Nunca DROP de tablas;
   solo mueve mensajes y borra filas duplicadas.
   ========================================================= */
'use strict';
const { q, pool } = require('../db');
const APPLY = process.argv.includes('--apply');

// Union-Find para agrupar contactos que comparten algún identificador.
function makeUF() {
  const p = new Map();
  const find = x => { while (p.get(x) !== x) { p.set(x, p.get(p.get(x))); x = p.get(x); } return x; };
  return {
    add: x => { if (!p.has(x)) p.set(x, x); },
    union: (a, b) => { p.set(find(a), find(b)); },
    find,
  };
}

const esMeta = v => /^[A-Za-z]{2}\.\d+$/.test(v || '');

(async () => {
  console.log(APPLY ? '=== MODO APLICAR (se harán cambios) ===' : '=== DRY-RUN (no se toca nada) ===');

  // 1) Cargar contactos + sus identificadores.
  const cs = (await q(`SELECT id, ghl_contact_id, phone, user_id, name, handoff FROM contacts`)).rows;
  const uf = makeUF();
  const byVal = new Map();   // valor identificador -> [contactIds]
  for (const c of cs) {
    uf.add(c.id);
    for (const v of [c.ghl_contact_id, c.phone, c.user_id]) {
      const val = v == null ? '' : String(v).trim();
      if (val.length < 6) continue;                 // ignora vacíos/valores raros
      if (!byVal.has(val)) byVal.set(val, []);
      byVal.get(val).push(c.id);
    }
  }
  // 2) Unir contactos que comparten un valor.
  for (const ids of byVal.values()) for (let i = 1; i < ids.length; i++) uf.union(ids[0], ids[i]);

  // 3) Agrupar por raíz; quedarnos con grupos de >1 contacto.
  const groups = new Map();
  for (const c of cs) { const r = uf.find(c.id); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(c); }
  const dupGroups = [...groups.values()].filter(g => g.length > 1);

  console.log(`Contactos: ${cs.length} | Grupos duplicados: ${dupGroups.length} | Contactos a eliminar: ${dupGroups.reduce((a, g) => a + g.length - 1, 0)}`);

  let totMsgsMoved = 0, totConvsDeleted = 0, totContactsDeleted = 0, done = 0;

  for (const g of dupGroups) {
    const cids = g.map(c => c.id);
    // Conversación (1 por contacto) + nº de mensajes de cada una.
    const convs = (await q(
      `SELECT cv.id AS conv_id, cv.contact_id, cv.channel,
              (SELECT count(*)::int FROM messages m WHERE m.conversation_id = cv.id) AS msgs
       FROM conversations cv WHERE cv.contact_id = ANY($1::bigint[])`, [cids])).rows;

    // Canónico = contacto con la conversación de más mensajes; si nadie tiene, el id menor.
    let canonConv = null, canonContact = null, maxMsgs = -1;
    for (const cv of convs) if (cv.msgs > maxMsgs) { maxMsgs = cv.msgs; canonConv = cv.conv_id; canonContact = cv.contact_id; }
    if (canonContact == null) canonContact = cids.slice().sort((a, b) => Number(a) - Number(b))[0];

    const otherConvIds = convs.filter(cv => cv.conv_id !== canonConv).map(cv => cv.conv_id);
    const otherContactIds = cids.filter(id => id !== canonContact);
    const msgsToMove = convs.filter(cv => cv.conv_id !== canonConv).reduce((a, cv) => a + cv.msgs, 0);
    const unreadSum = 0; // se recalcula abajo con lo capturado

    // Campos fusionados del contacto canónico.
    const canon = g.find(c => c.id === canonContact);
    const phone = canon.phone || g.map(c => c.phone).find(Boolean) || null;
    const userId = canon.user_id
      || g.map(c => c.user_id).find(Boolean)
      || g.map(c => c.ghl_contact_id).find(esMeta) || null;
    const handoff = g.some(c => c.handoff);
    const name = canon.name || g.map(c => c.name).find(Boolean) || null;

    console.log(`\n· grupo ${done + 1}: contactos [${cids.join(',')}] tel=${phone || '—'} uid=${userId || '—'}`);
    console.log(`    conserva contacto ${canonContact}, conv ${canonConv ?? '(ninguna)'} (${maxMsgs < 0 ? 0 : maxMsgs} msgs)`);
    console.log(`    mueve ${msgsToMove} msgs desde convs [${otherConvIds.join(',') || '—'}], borra ${otherContactIds.length} contactos, ${otherConvIds.length} convs`);
    console.log(`    contacto final → name="${name}" handoff=${handoff}`);

    if (APPLY) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // capturar unread total del grupo (antes de borrar)
        const ur = await client.query(`SELECT COALESCE(SUM(unread_count),0)::int s FROM conversations WHERE contact_id = ANY($1::bigint[])`, [cids]);
        const unread = ur.rows[0].s;

        if (canonConv && otherConvIds.length) {
          await client.query(`UPDATE messages SET conversation_id = $1 WHERE conversation_id = ANY($2::bigint[])`, [canonConv, otherConvIds]);
          await client.query(`DELETE FROM conversations WHERE id = ANY($1::bigint[])`, [otherConvIds]);
        }
        // fusionar campos en el canónico
        await client.query(
          `UPDATE contacts SET phone=$2, user_id=$3, name=COALESCE($4,name), handoff=$5,
             handoff_stopped = CASE WHEN $5 THEN COALESCE(handoff_stopped,false) ELSE false END,
             handoff_at = CASE WHEN $5 THEN COALESCE(handoff_at, now()) ELSE NULL END,
             updated_at = now()
           WHERE id=$1`, [canonContact, phone, userId, name, handoff]);
        // borrar contactos sobrantes (ya sin conversación → cascade no borra nada)
        if (otherContactIds.length) await client.query(`DELETE FROM contacts WHERE id = ANY($1::bigint[])`, [otherContactIds]);
        // recalcular agregados de la conversación canónica
        if (canonConv) {
          await client.query(
            `WITH last AS (
               SELECT text, COALESCE(sent_at, created_at) AS ts, direction, status
               FROM messages WHERE conversation_id=$1 ORDER BY COALESCE(sent_at, created_at) DESC NULLS LAST, id DESC LIMIT 1),
             li AS (SELECT max(COALESCE(sent_at, created_at)) mi FROM messages WHERE conversation_id=$1 AND direction='in')
             UPDATE conversations SET
               last_message = (SELECT text FROM last),
               last_message_at = (SELECT ts FROM last),
               last_direction = (SELECT direction FROM last),
               last_status = (SELECT status FROM last),
               last_inbound = (SELECT mi FROM li),
               unread_count = $2,
               updated_at = now()
             WHERE id=$1`, [canonConv, unread]);
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK'); console.error('   ✗ error, rollback:', e.message); throw e;
      } finally { client.release(); }
    }

    totMsgsMoved += msgsToMove; totConvsDeleted += otherConvIds.length; totContactsDeleted += otherContactIds.length; done++;
  }

  console.log(`\n=== ${APPLY ? 'APLICADO' : 'RESUMEN (dry-run)'} ===`);
  console.log(`Grupos: ${dupGroups.length} | Mensajes movidos: ${totMsgsMoved} | Convs borradas: ${totConvsDeleted} | Contactos borrados: ${totContactsDeleted}`);
  if (!APPLY) console.log('Para ejecutar: node migration/merge-duplicates.js --apply');
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
