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

  pollInterval: 10000,

  templates: [
    { name: 'recordatorio_cita', category: 'UTILITY',   body: 'Hola {{1}}, te recordamos tu cita el {{2}} a las {{3}}. Responde CONFIRMAR para confirmarla.' },
    { name: 'bienvenida',        category: 'MARKETING',  body: '¡Hola {{1}}! Gracias por contactarnos. ¿En qué podemos ayudarte hoy?' },
    { name: 'seguimiento_pago',  category: 'UTILITY',    body: 'Hola {{1}}, tu pago de {{2}} está pendiente. Puedes completarlo aquí: {{3}}' },
    { name: 'reactivacion',      category: 'MARKETING',  body: '¡Te extrañamos {{1}}! Tenemos una oferta especial para ti este mes.' }
  ]
};
