/* =========================================================
   api.js — Adaptador de datos (modo LIVE, backend n8n).
   Una sola interfaz que el resto de la app consume.

   >>> PUNTOS DE INTEGRACIÓN CON n8n / META <<<
   n8n es el backend:
     · sendUrl   -> Webhook que llama a la WhatsApp Cloud API
     · convUrl   -> Webhook que devuelve las conversaciones
     · msgUrl    -> Webhook que devuelve los mensajes de una conversación
     · deleteUrl -> Webhook que elimina una conversación (y sus mensajes)
   ========================================================= */
(function (global) {
  'use strict';

  const S = () => Store.settings;
  const CFG = () => (global.WA_CONFIG || {});

  function headers() {
    const h = { 'Content-Type': 'application/json' };
    if (S().token) h['x-dashboard-token'] = S().token;
    if (window.Auth && window.Auth.currentToken) h['Authorization'] = 'Bearer ' + window.Auth.currentToken;
    return h;
  }

  async function http(url, opts) {
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  const Api = {
    // ---------------------------------------------------------------
    // Cargar conversaciones. GET al webhook -> { conversations: [...] }
    // ---------------------------------------------------------------
    async loadConversations() {
      // El dispositivo activo decide qué conversaciones se ven (null = principal).
      const dev = (global.Devices && Devices.actual) || null;
      const url = S().convUrl + (dev ? (S().convUrl.includes('?') ? '&' : '?') + 'device=' + encodeURIComponent(dev) : '');
      const data = await http(url, { method: 'GET', headers: headers() });
      return {
        conversations: data.conversations || data || [],
        messagesByConv: data.messagesByConv || {}
        // las plantillas ya no vienen de aquí: se leen de Meta (getWaTemplates)
      };
    },

    // ---------------------------------------------------------------
    // Plantillas aprobadas en Meta (WABA) -> { templates: [...] }
    // ---------------------------------------------------------------
    async getWaTemplates(refresh) {
      return await http('/api/wa-templates' + (refresh ? '?refresh=1' : ''), { method: 'GET', headers: headers() });
    },

    // Envía una plantilla aprobada (único envío permitido fuera de las 24 h).
    async sendTemplate(payload) {
      const res = await fetch('/api/send-template', { method: 'POST', headers: headers(), body: JSON.stringify(payload) });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || 'No se pudo enviar la plantilla');
      return data;
    },

    // ---------------------------------------------------------------
    // Mensajes de una conversación (lazy load)
    // ---------------------------------------------------------------
    async loadMessages(conversationId) {
      const url = S().msgUrl + (S().msgUrl.includes('?') ? '&' : '?') + 'conversationId=' + encodeURIComponent(conversationId);
      const data = await http(url, { method: 'GET', headers: headers() });
      return data.messages || data || [];
    },

    // ---------------------------------------------------------------
    // Enviar mensaje. POST a n8n -> WhatsApp Cloud API.
    //   { conversationId, to, type:'text'|'template', text, template, params }
    // Se espera { id, status, wamid } de vuelta.
    // ---------------------------------------------------------------
    async sendMessage(payload) {
      const data = await http(S().sendUrl, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(payload)
      });
      return data || { id: 'm' + Date.now(), status: 'sent' };
    },

    // ---------------------------------------------------------------
    // Eliminar una conversación (y sus mensajes, vía CASCADE en Postgres).
    // POST { conversationId } -> { ok: true }
    // ---------------------------------------------------------------
    async deleteConversation(conversationId) {
      const data = await http(S().deleteUrl, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ conversationId })
      });
      return data || { ok: true };
    },

    // ---------------------------------------------------------------
    // Datos del contacto en GoHighLevel (tags, email, tel, custom fields,
    // opportunities). GET ?contactId= -> { ok, contact, opportunities }
    // ---------------------------------------------------------------
    async getGhlContact(contactId) {
      if (!S().ghlUrl) return null;
      const url = S().ghlUrl + (S().ghlUrl.includes('?') ? '&' : '?') + 'contactId=' + encodeURIComponent(contactId);
      return await http(url, { method: 'GET', headers: headers() });
    },

    // ---------------------------------------------------------------
    // Contactos con etiqueta "handoff" en GHL. GET -> { contactIds: [...] }
    // ---------------------------------------------------------------
    async getHandoffIds() {
      if (!S().handoffUrl) return null;
      return await http(S().handoffUrl, { method: 'GET', headers: headers() });
    },

    // ---------------------------------------------------------------
    // Chatbot on/off (activar/desactivar su workflow en n8n)
    // ---------------------------------------------------------------
    async getBotState() {
      if (!S().botStateUrl) return null;
      return await http(S().botStateUrl, { method: 'GET', headers: headers() });
    },
    async setBotState(active) {
      if (!S().botSetUrl) throw new Error('Toggle del bot no configurado');
      return await http(S().botSetUrl, { method: 'POST', headers: headers(), body: JSON.stringify({ active: !!active }) });
    },

    // ---------------------------------------------------------------
    // Auto-return de handoff: minutos tras los cuales Camila se reactiva
    // sola en un chat en handoff. 0 = desactivado. Se guarda en el servidor.
    // ---------------------------------------------------------------
    async getHandoffConfig() {
      const url = S().handoffConfigUrl || (global.WA_CONFIG || {}).handoffConfigUrl;
      if (!url) return null;
      return await http(url, { method: 'GET', headers: headers() });
    },
    async setHandoffConfig(minutes) {
      const url = S().handoffConfigUrl || (global.WA_CONFIG || {}).handoffConfigUrl;
      if (!url) return null;
      return await http(url, { method: 'POST', headers: headers(), body: JSON.stringify({ minutes: Number(minutes) || 0 }) });
    },

    // ---------------------------------------------------------------
    // Enviar un adjunto por WhatsApp (multipart). Sube el archivo, se guarda
    // en la DB (aparece en el hilo) y se envía por la Cloud API.
    // Devuelve { ok, id, conversationId, wamid, sent }.
    // ---------------------------------------------------------------
    async sendMedia(file, meta) {
      if (!S().sendMediaUrl) throw new Error('Envío de adjuntos no configurado');
      const fd = new FormData();
      fd.append('file', file, file.name);
      fd.append('conversationId', meta.conversationId || '');
      fd.append('contactId', meta.contactId || '');
      fd.append('to', meta.to || '');
      fd.append('channel', meta.channel || 'whatsapp');
      fd.append('type', meta.type || 'document');
      fd.append('filename', file.name);
      if (meta.text) fd.append('text', meta.text);
      const h = {};
      if (S().token) h['x-dashboard-token'] = S().token;
      if (window.Auth && window.Auth.currentToken) h['Authorization'] = 'Bearer ' + window.Auth.currentToken;
      const res = await fetch(S().sendMediaUrl, { method: 'POST', headers: h, body: fd });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const t = await res.text();
      return t ? JSON.parse(t) : null;
    },

    // ---------------------------------------------------------------
    // Nombre del contacto en GHL (liviano, 1 sola llamada). GET ?contactId=
    // ---------------------------------------------------------------
    async getGhlName(contactId) {
      if (!S().ghlNameUrl) return null;
      const url = S().ghlNameUrl + (S().ghlNameUrl.includes('?') ? '&' : '?') + 'contactId=' + encodeURIComponent(contactId);
      return await http(url, { method: 'GET', headers: headers() });
    },

    // ---------------------------------------------------------------
    // Escribe el custom field bot_status del contacto en GHL.
    // value: 'STOP' (cerrar → detener bot) o '' (abrir → reactivar).
    // ---------------------------------------------------------------
    async setGhlField(contactId, value) {
      if (!S().ghlFieldUrl) return null;
      return await http(S().ghlFieldUrl, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ contactId, value })
      });
    },

    // ---------------------------------------------------------------
    // Sondeo de novedades (polling). n8n expone en convUrl las
    // conversaciones con su último mensaje y unreadCount actualizados.
    // ---------------------------------------------------------------
    async poll() {
      try {
        const data = await http(S().convUrl, { method: 'GET', headers: headers() });
        return { conversations: data.conversations || data || [] };
      } catch (e) {
        return { error: e.message };
      }
    }
  };

  global.Api = Api;
})(window);
