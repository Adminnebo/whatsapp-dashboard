/* =========================================================
   permcatalog.js — CATÁLOGO ÚNICO de permisos, compartido por las 3
   plataformas (comparten el mismo Supabase / tabla profiles).

   Reglas del modelo:
   - super_admin y admin tienen TODO siempre.
   - a un 'agent' se le concede un subconjunto: profiles.permissions (text[]).
   - Compatibilidad: si permissions es NULL (aún no migrado / usuario viejo),
     se derivan de profiles.platforms — así nadie pierde acceso al desplegar.
   - El acceso a una plataforma = tener al menos 1 permiso con ese prefijo.

   ESTE ARCHIVO SE REPLICA TAL CUAL en:
     dashboard-ws-dinamico/auth/permcatalog.js   (este)
     whatsapp-analytics/permcatalog.js
     cobranzas-dashboard/server/permcatalog.js
   y su gemelo de navegador en cada frontend (public/js/permcatalog.js /
   www/js/permcatalog.js). Si cambias uno, cambia todos.
   ========================================================= */
'use strict';

// Plataformas (coinciden con profiles.platforms y con el prefijo de cada permiso).
const PLATAFORMAS = ['inbox', 'cotizaciones', 'cobranzas'];

// Grupos = una plataforma con sus funcionalidades. `sensible` marca acciones
// peligrosas o de coste (se pintan aparte en el panel).
const GRUPOS = [
  {
    platform: 'inbox', label: 'Inbox — Conversaciones',
    perms: [
      { key: 'inbox.conversations', label: 'Ver conversaciones' },
      { key: 'inbox.send',          label: 'Enviar mensajes' },
      { key: 'inbox.camila',        label: 'Camila on/off + handoff' },
      { key: 'inbox.templates',     label: 'Plantillas de Meta' },
      { key: 'inbox.devices',       label: 'Dispositivos (QR)' },
      { key: 'inbox.tickets',       label: 'Tickets' },
      { key: 'inbox.delete',        label: 'Borrar conversación', sensible: true }
    ]
  },
  {
    platform: 'cotizaciones', label: 'Cotizaciones / Analytics',
    perms: [
      { key: 'cotizaciones.resumen',       label: 'Resumen' },
      { key: 'cotizaciones.mensajes',      label: 'Mensajes' },
      { key: 'cotizaciones.pipeline',      label: 'Pipeline' },
      { key: 'cotizaciones.cotizaciones',  label: 'Cotizaciones' },
      { key: 'cotizaciones.llamadas',      label: 'Llamadas' },
      { key: 'cotizaciones.agentes',       label: 'Ajustes de agente de voz' },
      { key: 'cotizaciones.pipeline_edit', label: 'Mover etapa del pipeline', sensible: true },
      { key: 'cotizaciones.costos',        label: 'Ver costos de IA', sensible: true },
      { key: 'cotizaciones.registros',     label: 'Registros (auditoría)', sensible: true }
    ]
  },
  {
    platform: 'cobranzas', label: 'Cobranzas',
    perms: [
      { key: 'cobranzas.cartera',        label: 'Cartera' },
      { key: 'cobranzas.clientes',       label: 'Clientes y llamadas' },
      { key: 'cobranzas.promesas',       label: 'Promesas' },
      { key: 'cobranzas.asistente',      label: 'Asistente IA' },
      { key: 'cobranzas.cliente_toggle', label: 'Habilitar/deshabilitar cliente', sensible: true },
      { key: 'cobranzas.llamadas',       label: 'Lanzar llamadas / cola', sensible: true },
      { key: 'cobranzas.horario',        label: 'Editar horario de llamadas', sensible: true }
    ]
  }
];

// Todas las claves válidas, en orden.
const ALL_KEYS = GRUPOS.reduce((a, g) => a.concat(g.perms.map(p => p.key)), []);
const platformDeKey = k => String(k || '').split('.')[0];

// Deja solo claves válidas y sin repetir.
function limpiar(v) {
  if (!Array.isArray(v)) return null;
  const set = [...new Set(v.map(String))].filter(k => ALL_KEYS.includes(k));
  return set;
}

// Permisos EFECTIVOS de un perfil (ya resuelve admin y la compatibilidad).
function permisosDe(profile) {
  const role = profile && profile.role;
  if (role === 'super_admin' || role === 'admin') return ALL_KEYS.slice();
  const p = profile && profile.permissions;
  if (Array.isArray(p)) return p.filter(k => ALL_KEYS.includes(k));
  // Sin permisos explícitos: derivar de las plataformas (usuario pre-migración).
  const plats = profile && profile.platforms;
  if (Array.isArray(plats)) return ALL_KEYS.filter(k => plats.includes(platformDeKey(k)));
  return ALL_KEYS.slice();   // sin nada definido: acceso total (no romper)
}

// Plataformas a las que accede (tiene ≥1 permiso de ese prefijo). Mantiene vivo
// el gate por plataforma existente.
function plataformasDe(profile) {
  const role = profile && profile.role;
  if (role === 'super_admin' || role === 'admin') return PLATAFORMAS.slice();
  const perms = permisosDe(profile);
  return PLATAFORMAS.filter(pl => perms.some(k => platformDeKey(k) === pl));
}

const puede = (profile, key) => permisosDe(profile).includes(key);

module.exports = { PLATAFORMAS, GRUPOS, ALL_KEYS, platformDeKey, limpiar, permisosDe, plataformasDe, puede };
