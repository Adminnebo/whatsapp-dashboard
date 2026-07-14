/* =========================================================
   store.js — Estado central + persistencia de ajustes
   ========================================================= */
(function (global) {
  'use strict';

  const SETTINGS_KEY = 'wa_dashboard_settings';

  // Valores por defecto desde config.js (si existe). Las URLs no son secretas.
  const cfg = (typeof window !== 'undefined' && window.WA_CONFIG) || {};

  const defaultSettings = {
    sendUrl: cfg.sendUrl || '',        // POST  -> enviar mensaje (n8n -> WhatsApp Cloud API)
    sendMediaUrl: cfg.sendMediaUrl || '', // POST (multipart) -> enviar adjunto por WhatsApp
    convUrl: cfg.convUrl || '',        // GET   -> lista de conversaciones
    msgUrl: cfg.msgUrl || '',          // GET   -> mensajes de una conversación
    deleteUrl: cfg.deleteUrl || '',    // POST  -> eliminar una conversación
    ghlUrl: cfg.ghlUrl || '',          // GET   -> datos del contacto en GoHighLevel
    ghlFieldUrl: cfg.ghlFieldUrl || '',// POST  -> escribe custom field (bot_status) en GHL
    ghlNameUrl: cfg.ghlNameUrl || '',  // GET   -> nombre del contacto en GHL (liviano)
    botStateUrl: cfg.botStateUrl || '',// GET   -> estado del chatbot (activo/inactivo)
    botSetUrl: cfg.botSetUrl || '',    // POST  -> prender/apagar el chatbot
    handoffUrl: cfg.handoffUrl || '',  // GET   -> contactIds con etiqueta handoff en GHL
    pollInterval: cfg.pollInterval != null ? cfg.pollInterval : 10000, // ms; 0 = desactivado
    token: ''                          // header opcional x-dashboard-token
  };

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      return raw ? Object.assign({}, defaultSettings, JSON.parse(raw)) : Object.assign({}, defaultSettings);
    } catch (_) {
      return Object.assign({}, defaultSettings);
    }
  }
  function saveSettings(s) {
    // En un iframe (GHL) con privacidad estricta, el storage puede estar
    // bloqueado y setItem lanza; lo envolvemos para no romper la app.
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (_) {}
  }

  const Store = {
    settings: loadSettings(),
    conversations: [],
    messagesByConv: {},
    ghlByContact: {},     // cache de datos completos de GHL por contactId (sesión)
    nameByContact: {},    // cache de nombre GHL por contactId (liviano)
    handoffIds: new Set(),// contactIds con etiqueta handoff (GHL)
    templates: [],        // plantillas aprobadas en Meta (se cargan de /api/wa-templates)
    templatesError: null,
    activeId: null,
    filter: 'all',       // all | unread | starred
    search: '',

    // --- mutadores ---
    setData(conversations, messagesByConv, templates) {
      this.conversations = conversations || [];
      this.messagesByConv = messagesByConv || {};
      if (templates) this.templates = templates;
    },
    activeConversation() {
      return this.conversations.find(c => c.id === this.activeId) || null;
    },
    activeMessages() {
      return this.messagesByConv[this.activeId] || [];
    },
    addMessage(convId, msg) {
      (this.messagesByConv[convId] = this.messagesByConv[convId] || []).push(msg);
      const conv = this.conversations.find(c => c.id === convId);
      if (conv) {
        conv.lastMessage = msg.text || (msg.mediaUrl
          ? (msg.type === 'image' ? '📷 Imagen' : msg.type === 'audio' ? '🎵 Audio' : msg.type === 'video' ? '🎬 Video' : '📄 ' + (msg.mediaFilename || 'Documento'))
          : '[adjunto]');
        conv.lastMessageAt = msg.timestamp;
        conv.lastDirection = msg.direction;
        conv.lastStatus = msg.status;
        if (msg.direction === 'in' && convId !== this.activeId) conv.unreadCount = (conv.unreadCount || 0) + 1;
        if (msg.direction === 'in') conv.lastInbound = msg.timestamp;
      }
    },
    markRead(convId) {
      const conv = this.conversations.find(c => c.id === convId);
      if (conv) conv.unreadCount = 0;
    },
    // ¿Está esta conversación en handoff? Vale tanto el flag que manda el servidor
    // (contacts.handoff) como el set que refresca el poll de GHL.
    isHandoff(c) {
      if (!c) return false;
      return !!c.handoff || !!(c.contactId && this.handoffIds.has(c.contactId));
    },
    visibleConversations() {
      let list = this.conversations.slice();
      if (this.filter === 'unread')  list = list.filter(c => c.unreadCount > 0);
      if (this.filter === 'starred') list = list.filter(c => c.starred);
      if (this.filter === 'handoff') list = list.filter(c => this.isHandoff(c));
      if (this.search) {
        const q = this.search.toLowerCase();
        list = list.filter(c =>
          c.name.toLowerCase().includes(q) ||
          (c.phone || '').includes(q) ||
          (c.lastMessage || '').toLowerCase().includes(q)
        );
      }
      // Handoff siempre arriba (fijado); dentro de cada grupo, lo más reciente primero.
      const h = c => (this.isHandoff(c) ? 1 : 0);
      return list.sort((a, b) => (h(b) - h(a)) || (b.lastMessageAt - a.lastMessageAt));
    },
    saveSettings,
    loadSettings
  };

  global.Store = Store;
})(window);
