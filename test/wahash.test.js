/* Test de waHash con los 6 vectores reales del contrato de ingesta.
   Correr:  node test/wahash.test.js
   Si algún hash no cuadra, la feature de replies no anda: falla ruidoso. */
'use strict';
const assert = require('assert');
const { waHash } = require('../wahash');

const VECTORES = [
  ['wamid.HBgLMTgwOTc1MjA1MTgVAgARGBIyRDgxNUMzQjlCNENGNDA4Q0QA', '2D815C3B9B4CF408CD'],
  ['wamid.HBgLMTMzOTU2NTg0MjUVAgASGCBBNTBBQjcxQUY1MkUxNzk2RTBCOEI2MTA1RkU4OUQ4QgA=', 'A50AB71AF52E1796E0B8B6105FE89D8B'],
  ['wamid.HBgTVVMuMTAxMjI1Njc5NDczNTQ3MBUUABIYIEE1MEFCNzFBRjUyRTE3OTZFMEI4QjYxMDVGRTg5RDhCAA==', 'A50AB71AF52E1796E0B8B6105FE89D8B'],
  ['wamid.HBgLMTgyOTk2MjUxNDQVAgASGBQyQUMwNjY1RThGOTU5NDZDNTUyQgA=', '2AC0665E8F95946C552B'],
  ['wamid.HBgLMTgwOTc1MjA1MTgVAgASGBQzQUFGNTA0QURDRTZFNEZEQUFDNAA=', '3AAF504ADCE6E4FDAAC4'],
  ['wamid.HBgLMTgwOTM5MDYyNDYVAgASGBQzQTk4OTkxQ0VBNkNCRDIyNUJCNQA=', '3A98991CEA6CBD225BB5'],
];

let ok = 0;
for (const [wamid, esperado] of VECTORES) {
  const got = waHash(wamid);
  try {
    assert.strictEqual(got, esperado);
    console.log(`  OK  ${esperado}`);
    ok++;
  } catch (_) {
    console.error(`  FALLA  esperado=${esperado}  got=${got}\n         wamid=${wamid}`);
  }
}

// Las filas 2 y 3 son el mismo mensaje (messageId vs contextId): sus hashes deben coincidir.
assert.strictEqual(waHash(VECTORES[1][0]), waHash(VECTORES[2][0]), 'fila 2 y 3 deben dar el mismo hash');
console.log('  OK  fila 2 == fila 3 (mismo mensaje, id distinto)');

// Casos borde: nunca deben tirar error, degradan a null.
for (const bad of [null, undefined, '', 'no-base64-###', 'wamid.', 'wamid.YWJj']) {
  const r = waHash(bad);
  assert.ok(r === null, `borde debe ser null: ${JSON.stringify(bad)} -> ${JSON.stringify(r)}`);
}
console.log('  OK  casos borde -> null (sin error)');

if (ok !== VECTORES.length) { console.error(`\nFALLARON ${VECTORES.length - ok} vectores`); process.exit(1); }
console.log(`\n${ok}/${VECTORES.length} vectores OK + bordes. waHash correcto.`);
