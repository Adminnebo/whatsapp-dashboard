/* =========================================================
   permcatalog.js (navegador) — Catálogo de permisos + helpers para el
   frontend. Gemelo de auth/permcatalog.js del servidor: MISMAS claves.
   Expone window.PERMS. Sirve para:
     - pintar las casillas en el panel de usuarios (PERMS.GRUPOS)
     - ocultar secciones/botones según lo que puede el usuario (PERMS.puede)
   La seguridad REAL la impone el backend; esto es solo UX.
   ========================================================= */
(function (global) {
  'use strict';

  const PLATAFORMAS = ['inbox', 'cotizaciones', 'cobranzas'];

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

  const ALL_KEYS = GRUPOS.reduce((a, g) => a.concat(g.perms.map(p => p.key)), []);
  const platformDeKey = k => String(k || '').split('.')[0];

  // Estado del usuario actual (lo setea la app tras /me). null = aún no sabemos.
  let _mias = null;   // Set de claves, o null = todavía sin cargar (no ocultar nada)

  const PERMS = {
    PLATAFORMAS, GRUPOS, ALL_KEYS, platformDeKey,

    // Guarda los permisos del usuario logueado (array que devuelve /me).
    set(lista) { _mias = new Set(Array.isArray(lista) ? lista : ALL_KEYS); return this; },

    // ¿el usuario actual puede X? Antes de cargar (=null) devuelve true para no
    // parpadear ocultando cosas que sí puede.
    puede(key) { return _mias === null ? true : _mias.has(key); },

    // ¿tiene algo de esta plataforma? (para mostrar/ocultar la plataforma entera)
    tienePlataforma(pl) { return _mias === null ? true : [..._mias].some(k => platformDeKey(k) === pl); },

    // Oculta (hidden=true) todo elemento [data-perm="key"] que el usuario no tenga.
    // Un elemento con varias claves separadas por coma se muestra si tiene ALGUNA.
    aplicar(root) {
      (root || document).querySelectorAll('[data-perm]').forEach(el => {
        const claves = el.getAttribute('data-perm').split(',').map(s => s.trim()).filter(Boolean);
        el.hidden = !claves.some(k => this.puede(k));
      });
    }
  };

  global.PERMS = PERMS;
})(window);
