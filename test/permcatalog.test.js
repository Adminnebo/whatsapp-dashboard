/* Test del catalogo de permisos. Correr: node test/permcatalog.test.js

   Lo que protege: a Jarvis se entra solo si alguien lo concedio a proposito.
   permisosDe() tiene respaldos para no romper usuarios viejos, y ninguno de
   ellos puede regalar acceso al asistente. */
'use strict';
const assert = require('assert');
const PERMS = require('../auth/permcatalog');

const jarvis = k => String(k).startsWith('jarvis.');

let fallos = 0;
function prueba(nombre, fn) {
  try { fn(); console.log(`ok   ${nombre}`); }
  catch (e) { fallos++; console.error(`MAL  ${nombre}\n     ${e.message}`); }
}

prueba('el grupo jarvis existe con sus dos permisos', () => {
  assert.ok(PERMS.PLATAFORMAS.includes('jarvis'));
  assert.ok(PERMS.ALL_KEYS.includes('jarvis.usar'));
  assert.ok(PERMS.ALL_KEYS.includes('jarvis.admin'));
});

prueba('un perfil sin nada definido NO recibe jarvis', () => {
  // Este es el respaldo "no romper": da acceso total a los demas, pero
  // regalar el asistente seria una fuga.
  const perms = PERMS.permisosDe({ role: 'agent' });
  assert.strictEqual(perms.filter(jarvis).length, 0);
  assert.ok(perms.includes('inbox.conversations'));
});

prueba('un perfil viejo con platforms NO recibe jarvis', () => {
  const perms = PERMS.permisosDe({
    role: 'agent', permissions: null,
    platforms: ['inbox', 'cotizaciones', 'cobranzas'],
  });
  assert.strictEqual(perms.filter(jarvis).length, 0);
});

prueba('super_admin y admin si reciben jarvis', () => {
  for (const role of ['super_admin', 'admin']) {
    assert.ok(PERMS.permisosDe({ role }).includes('jarvis.usar'), role);
    assert.ok(PERMS.permisosDe({ role }).includes('jarvis.admin'), role);
  }
});

prueba('un agente con el permiso explicito lo conserva', () => {
  const perms = PERMS.permisosDe({ role: 'agent', permissions: ['jarvis.usar'] });
  assert.deepStrictEqual(perms, ['jarvis.usar']);
});

prueba('tener jarvis.usar da acceso a la plataforma jarvis', () => {
  const plats = PERMS.plataformasDe({ role: 'agent', permissions: ['jarvis.usar'] });
  assert.ok(plats.includes('jarvis'));
});

// A "Pagos" se entra igual que a Jarvis: solo si el super admin lo marco.
const pagos = k => String(k).startsWith('pagos.');

prueba('el grupo pagos existe con su permiso', () => {
  assert.ok(PERMS.PLATAFORMAS.includes('pagos'));
  assert.ok(PERMS.ALL_KEYS.includes('pagos.ver'));
});

prueba('ningun respaldo regala pagos', () => {
  assert.strictEqual(PERMS.permisosDe({ role: 'agent' }).filter(pagos).length, 0);
  const viejo = PERMS.permisosDe({
    role: 'agent', permissions: null,
    platforms: ['inbox', 'cotizaciones', 'cobranzas'],
  });
  assert.strictEqual(viejo.filter(pagos).length, 0);
});

prueba('pagos.ver explicito se conserva y super_admin lo tiene', () => {
  assert.deepStrictEqual(PERMS.permisosDe({ role: 'agent', permissions: ['pagos.ver'] }), ['pagos.ver']);
  assert.ok(PERMS.permisosDe({ role: 'super_admin' }).includes('pagos.ver'));
});

if (fallos) { console.error(`\n${fallos} fallaron`); process.exit(1); }
console.log('\nTodo correcto.');
