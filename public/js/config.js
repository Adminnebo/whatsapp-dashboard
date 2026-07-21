/* =========================================================
   config.js — App dinámica: el backend propio expone /api/* en el
   MISMO origen (Express + Postgres). No hay URLs de n8n.
   Se puede sobreescribir desde Ajustes (localStorage).
   ========================================================= */
window.WA_CONFIG = {
  sendUrl:      '/api/send',
  sendMediaUrl: '/api/send-media',
  convUrl:      '/api/conversations',
  msgUrl:       '/api/messages',
  deleteUrl:    '/api/delete-conversation',
  ghlUrl:       '/api/ghl-contact',
  ghlFieldUrl:  '/api/ghl-set-field',
  ghlNameUrl:   '/api/ghl-name',
  botStateUrl:  '/api/bot-state',
  botSetUrl:    '/api/bot-set',
  handoffUrl:   '/api/handoff',
  handoffConfigUrl: '/api/handoff-config',

  // Servicio de dispositivos por QR (se puede cambiar desde el panel Dispositivos).
  devicesUrl:   '',

  pollInterval: 10000,

  // Las plantillas ya no se definen aquí: se leen de Meta (/api/wa-templates)
};
