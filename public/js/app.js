/* =========================================================
   app.js — Orquestación: init, eventos y flujo de envío/recepción
   ========================================================= */
(function (global) {
  'use strict';

  const $ = sel => document.querySelector(sel);
  let pollTimer = null;

  const App = {
    async init() {
      let savedTheme = 'light';
      try { savedTheme = localStorage.getItem('wa_dashboard_theme') || 'light'; } catch (_) {}
      this.applyTheme(savedTheme);
      UI.renderConnBadge();
      await this.refreshData();
      this.bindEvents();
      this.startPolling();
      this.loadBotState();
      this.loadHandoff();
    },

    // ---------- tema claro / oscuro ----------
    applyTheme(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      const dark = theme === 'dark';
      const moon = document.querySelector('#btnTheme .icon-moon');
      const sun = document.querySelector('#btnTheme .icon-sun');
      if (moon && sun) { moon.style.display = dark ? 'none' : ''; sun.style.display = dark ? '' : 'none'; }
    },
    toggleTheme() {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      this.applyTheme(next);
      try { localStorage.setItem('wa_dashboard_theme', next); } catch (_) {}
    },

    // ---------- chatbot on/off ----------
    async loadBotState() {
      if (!Store.settings.botStateUrl) { const b = document.querySelector('#botToggle'); if (b) b.hidden = true; return; }
      try { const s = await Api.getBotState(); this._botActive = !!(s && s.active); UI.renderBotToggle(this._botActive); }
      catch (_) {}
    },
    async toggleBot() {
      if (!Store.settings.botSetUrl) return;
      const next = !this._botActive;
      UI.renderBotToggle(next, true);
      try {
        const s = await Api.setBotState(next);
        this._botActive = (s && typeof s.active === 'boolean') ? s.active : next;
        UI.renderBotToggle(this._botActive);
        UI.toast(this._botActive ? 'Chatbot encendido' : 'Chatbot apagado');
      } catch (e) {
        UI.renderBotToggle(this._botActive);
        UI.toast('No se pudo cambiar el chatbot');
      }
    },

    // ---------- handoff (contactos con etiqueta handoff en GHL) ----------
    async loadHandoff(force) {
      if (!Store.settings.handoffUrl) return;
      const now = Date.now();
      if (!force && this._handoffAt && now - this._handoffAt < 25000) return; // throttle ~25s
      this._handoffAt = now;
      try {
        const d = await Api.getHandoffIds();
        const ids = new Set((d && d.contactIds) || []);
        const changed = ids.size !== Store.handoffIds.size || [...ids].some(x => !Store.handoffIds.has(x));
        Store.handoffIds = ids;
        UI.renderHandoffCount(ids.size);
        if (changed) UI.renderList();
      } catch (_) {}
    },

    // ---------- carga / recarga de datos ----------
    async refreshData() {
      try {
        const data = await Api.loadConversations();
        Store.setData(data.conversations, data.messagesByConv, data.templates);
        this._listSig = this.convSig(Store.conversations);
        UI.renderList();
        UI.renderTemplates();
        if (Store.activeId) UI.renderThread();
        this.enrichNames();
      } catch (e) {
        UI.toast('Error al cargar: ' + e.message);
        $('#connBadge').className = 'conn conn--error';
        $('#connBadge').textContent = 'ERROR';
      }
    },

    // ---------- abrir conversación ----------
    async openConversation(id) {
      Store.activeId = id;
      Store.markRead(id);
      // Carga mensajes bajo demanda si aún no están
      if (!(Store.messagesByConv[id] || []).length) {
        try { Store.messagesByConv[id] = await Api.loadMessages(id); }
        catch (e) { UI.toast('No se pudieron cargar los mensajes'); }
      }
      const c = Store.activeConversation();
      this._activeStatus = c ? c.lastStatus : null;
      UI.renderList();
      UI.renderThread();
      this.loadGhl(c);
    },

    // ¿el texto parece un nombre real? (tiene al menos una letra)
    isValidName(s) { try { return /\p{L}/u.test(String(s || '')); } catch (_) { return /[a-zA-Z]/.test(String(s || '')); } },

    // Rellena nombres faltantes ("?", teléfonos, ". .") con el nombre de GHL.
    // Solo consulta las que no tienen nombre válido; reusa la caché (sin repetir llamadas).
    async enrichNames() {
      if (!Store.settings.ghlNameUrl) return;
      // primero aplica lo ya cacheado (tras un poll, sin llamadas nuevas)
      this.applyResolvedNames();
      const need = Store.conversations.filter(c => c.contactId && !this.isValidName(c.name) && !(c.contactId in Store.nameByContact));
      if (!need.length) return;
      const CAP = 5; // llamadas concurrentes máximas
      for (let i = 0; i < need.length; i += CAP) {
        const batch = need.slice(i, i + CAP);
        await Promise.all(batch.map(async c => {
          try { const d = await Api.getGhlName(c.contactId); Store.nameByContact[c.contactId] = (d && d.ok && this.isValidName(d.name)) ? String(d.name).trim() : null; }
          catch (_) { Store.nameByContact[c.contactId] = null; }
        }));
        this.applyResolvedNames();
      }
    },

    // Aplica los nombres ya resueltos (desde caché) a la lista, sin llamadas.
    applyResolvedNames() {
      let changed = false;
      for (const c of Store.conversations) {
        if (this.isValidName(c.name)) continue;
        const nm = c.contactId ? Store.nameByContact[c.contactId] : null;
        if (nm && this.isValidName(nm)) {
          c.name = nm;
          c.avatar = { initials: (nm.split(' ').slice(0, 2).map(w => w[0] || '').join('').toUpperCase()) || '?', color: c.avatar.color };
          changed = true;
        }
      }
      if (changed) { UI.renderList(); if (Store.activeId) UI.renderThread(); }
    },

    // ---------- datos del contacto en GoHighLevel ----------
    async loadGhl(conv) {
      if (!conv || !conv.contactId || !Store.settings.ghlUrl) return;
      const cid = conv.contactId;
      if (Object.prototype.hasOwnProperty.call(Store.ghlByContact, cid)) {
        UI.renderDetails(conv); // ya cacheado (ok o null)
        return;
      }
      UI.renderDetails(conv); // muestra "Cargando datos de GoHighLevel…"
      let data = null;
      try { data = await Api.getGhlContact(cid); } catch (_) {}
      Store.ghlByContact[cid] = (data && data.ok) ? data : null;
      this.applyBotStatus(conv);
      if (Store.activeId === conv.id) UI.renderDetails(conv);
    },

    // Lee el custom field "Bot Status" de GHL y refleja el estado abierta/cerrada.
    applyBotStatus(conv) {
      const entry = conv && conv.contactId ? Store.ghlByContact[conv.contactId] : null;
      const cf = entry && entry.contact ? (entry.contact.customFields || []) : [];
      const bs = cf.find(f => f.name === 'Bot Status');
      if (bs) conv.status = (String(bs.value).trim().toUpperCase() === 'STOP') ? 'closed' : 'open';
    },

    // Cambia estado abierta/cerrada y escribe bot_status en GHL (STOP / vacío).
    async setStatus(status) {
      const c = Store.activeConversation(); if (!c) return;
      c.status = status;
      UI.renderDetails(c);
      if (!c.contactId || !Store.settings.ghlFieldUrl) return;
      const value = status === 'closed' ? 'STOP' : '';
      try {
        await Api.setGhlField(c.contactId, value);
        // refleja en la caché para que un re-render no lo revierta
        const entry = Store.ghlByContact[c.contactId];
        if (entry && entry.contact) {
          entry.contact.customFields = entry.contact.customFields || [];
          const bs = entry.contact.customFields.find(f => f.name === 'Bot Status');
          if (bs) bs.value = value; else entry.contact.customFields.push({ name: 'Bot Status', value });
        }
        UI.toast(status === 'closed' ? 'Cerrada · bot detenido (STOP)' : 'Abierta · bot reactivado');
      } catch (e) {
        UI.toast('No se pudo actualizar GHL: ' + e.message);
      }
    },

    // ---------- eliminar conversación ----------
    async deleteConversation() {
      const conv = Store.activeConversation();
      if (!conv) return;
      if (!confirm(`¿Eliminar la conversación con ${conv.name}?\nSe borrarán todos sus mensajes. Esta acción no se puede deshacer.`)) return;
      try {
        await Api.deleteConversation(conv.id);
        Store.conversations = Store.conversations.filter(c => c.id !== conv.id);
        delete Store.messagesByConv[conv.id];
        Store.activeId = null;
        UI.renderList();
        UI.renderThread();
        UI.toast('Conversación eliminada');
      } catch (e) {
        UI.toast('Error al eliminar: ' + e.message);
      }
    },

    // ---------- enviar mensaje ----------
    async send(text, opts) {
      opts = opts || {};
      const conv = Store.activeConversation();
      if (!conv || (!text.trim() && !opts.template)) return;

      const optimistic = {
        id: 'tmp' + Date.now(),
        conversationId: conv.id,
        direction: 'out',
        type: opts.template ? 'template' : 'text',
        text: text,
        template: opts.template || null,
        channel: conv.channel,
        timestamp: Date.now(),
        status: 'sent'
      };
      Store.addMessage(conv.id, optimistic);
      UI.renderThread();
      UI.renderList();

      // Payload que recibe n8n -> WhatsApp Cloud API
      const payload = {
        conversationId: conv.id,
        contactId: conv.contactId || null,
        channel: conv.channel,
        to: conv.phone ? conv.phone.replace(/[^\d]/g, '') : null,
        type: optimistic.type,
        text: text,
        template: opts.template ? { name: opts.template, params: opts.params || [] } : null
      };

      try {
        const res = await Api.sendMessage(payload);
        optimistic.id = res.id || optimistic.id;
        optimistic.status = res.status || 'delivered';
      } catch (e) {
        optimistic.status = 'failed';
        UI.toast('Error al enviar: ' + e.message);
      }
      UI.renderThread();
      UI.renderList();
    },

    // ---------- enviar adjunto (documento / imagen / audio / video) ----------
    async sendFile(file) {
      const conv = Store.activeConversation();
      if (!conv) { UI.toast('Selecciona una conversación primero'); return; }
      if (!Store.settings.sendMediaUrl) { UI.toast('Envío de adjuntos no configurado'); return; }
      const mime = file.type || 'application/octet-stream';
      let type = 'document';
      if (mime.startsWith('image/')) type = 'image';
      else if (mime.startsWith('audio/')) type = 'audio';
      else if (mime.startsWith('video/')) type = 'video';

      const tmpUrl = URL.createObjectURL(file); // vista previa inmediata
      const optimistic = {
        id: 'tmp' + Date.now(), conversationId: conv.id, direction: 'out', type,
        text: '', mediaUrl: tmpUrl, mediaMime: mime, mediaFilename: file.name,
        channel: conv.channel, timestamp: Date.now(), status: 'sent'
      };
      Store.addMessage(conv.id, optimistic);
      UI.renderThread(); UI.renderList();

      try {
        const res = await Api.sendMedia(file, {
          conversationId: conv.id,
          contactId: conv.contactId || '',
          to: conv.phone ? conv.phone.replace(/[^\d]/g, '') : '',
          channel: conv.channel, type
        });
        if (res && res.id) optimistic.id = res.id;
        if (res && res.sent === false) {
          optimistic.status = 'failed';
          UI.toast('Guardado, pero WhatsApp no lo entregó (¿fuera de la ventana de 24 h?)');
        } else {
          optimistic.status = 'delivered';
          UI.toast('Adjunto enviado');
        }
      } catch (e) {
        optimistic.status = 'failed';
        UI.toast('Error al enviar: ' + e.message);
      }
      UI.renderThread(); UI.renderList();
    },

    // ---------- grabar nota de voz ----------
    async startRecording() {
      if (this._rec) return;
      const conv = Store.activeConversation();
      if (!conv) { UI.toast('Selecciona una conversación primero'); return; }
      if (!navigator.mediaDevices || !window.MediaRecorder) { UI.toast('Tu navegador no soporta grabación de audio'); return; }
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
      catch (e) { UI.toast('No se pudo acceder al micrófono (permiso denegado)'); return; }
      const prefer = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
      let mimeType = '';
      for (const m of prefer) { try { if (window.MediaRecorder.isTypeSupported(m)) { mimeType = m; break; } } catch (_) {} }
      let rec;
      try { rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream); }
      catch (e) { rec = new MediaRecorder(stream); }
      this._rec = { rec, stream, chunks: [], mimeType: rec.mimeType || mimeType || 'audio/webm', start: Date.now(), send: false };
      rec.ondataavailable = e => { if (e.data && e.data.size) this._rec.chunks.push(e.data); };
      rec.onstop = () => this._onRecStop();
      rec.start();
      UI.showRecording(true);
      this._recTimer = setInterval(() => { if (this._rec) UI.updateRecTime(Date.now() - this._rec.start); }, 200);
    },
    stopRecording(send) {
      if (!this._rec) return;
      this._rec.send = !!send;
      clearInterval(this._recTimer);
      try { this._rec.rec.stop(); } catch (_) {}
      UI.showRecording(false);
    },
    async _onRecStop() {
      const r = this._rec; this._rec = null;
      if (r && r.stream) { try { r.stream.getTracks().forEach(t => t.stop()); } catch (_) {} }
      if (!r || !r.send || !r.chunks.length) return;
      const baseMime = (r.mimeType || 'audio/webm').split(';')[0];
      const blob = new Blob(r.chunks, { type: baseMime });
      // formatos que WhatsApp acepta directo
      if (/(ogg|mpeg|mp4|aac|amr)/.test(baseMime)) {
        const ext = baseMime.includes('ogg') ? 'ogg' : baseMime.includes('mp4') ? 'm4a' : 'mp3';
        this.sendFile(new File([blob], 'nota-de-voz.' + ext, { type: baseMime }));
        return;
      }
      // Chrome graba webm -> WhatsApp no lo acepta -> convertir a MP3 en el navegador
      UI.toast('Procesando audio…');
      try {
        const mp3 = await this.blobToMp3(blob);
        this.sendFile(new File([mp3], 'nota-de-voz.mp3', { type: 'audio/mpeg' }));
      } catch (e) {
        this.sendFile(new File([blob], 'nota-de-voz.webm', { type: baseMime }));
        UI.toast('No se pudo convertir a MP3; enviado como está');
      }
    },

    // carga perezosa del encoder MP3 (lamejs), solo la 1ª vez que se graba
    ensureLame() {
      if (window.lamejs && window.lamejs.Mp3Encoder) return Promise.resolve();
      if (this._lamePromise) return this._lamePromise;
      this._lamePromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'js/vendor/lame.all.js?v=16';
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('encoder MP3 no disponible'));
        document.head.appendChild(s);
      });
      return this._lamePromise;
    },

    async blobToMp3(blob) {
      await this.ensureLame();
      if (!window.lamejs || !window.lamejs.Mp3Encoder) throw new Error('encoder no disponible');
      const arrayBuf = await blob.arrayBuffer();
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      const audioBuf = await ctx.decodeAudioData(arrayBuf);
      try { ctx.close(); } catch (_) {}
      const sampleRate = audioBuf.sampleRate;
      const channels = audioBuf.numberOfChannels > 1 ? 2 : 1;
      const left = this._f32ToI16(audioBuf.getChannelData(0));
      const right = channels === 2 ? this._f32ToI16(audioBuf.getChannelData(1)) : null;
      const enc = new window.lamejs.Mp3Encoder(channels, sampleRate, 128);
      const block = 1152, out = [];
      for (let i = 0; i < left.length; i += block) {
        const l = left.subarray(i, i + block);
        const chunk = channels === 2 ? enc.encodeBuffer(l, right.subarray(i, i + block)) : enc.encodeBuffer(l);
        if (chunk.length) out.push(new Int8Array(chunk));
      }
      const end = enc.flush();
      if (end.length) out.push(new Int8Array(end));
      return new Blob(out, { type: 'audio/mpeg' });
    },
    _f32ToI16(f32) {
      const out = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++) {
        const s = Math.max(-1, Math.min(1, f32[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      return out;
    },

    useTemplate(tpl) {
      $('#templateModal').hidden = true;
      const conv = Store.activeConversation();
      if (!conv) { UI.toast('Selecciona una conversación primero'); return; }
      // sustituye {{1}} por el nombre como demostración
      const filled = tpl.body.replace('{{1}}', conv.name.split(' ')[0]);
      this.send(filled, { template: tpl.name });
    },

    // ---------- polling (incremental: re-renderiza solo si hay cambios) ----------
    startPolling() {
      clearInterval(pollTimer);
      const ms = Number(Store.settings.pollInterval) || 0;
      if (ms <= 0) return;
      pollTimer = setInterval(() => { this.pollOnce(); }, ms);
    },

    // firma compacta de la lista para detectar cambios reales
    convSig(list) {
      let s = '';
      for (const c of list) s += c.id + ':' + (c.lastMessageAt || 0) + ':' + (c.unreadCount || 0) + ':' + (c.lastStatus || '') + '|';
      return s;
    },

    async pollOnce() {
      this.loadHandoff(); // se auto-throttlea (~25s)
      const res = await Api.poll();
      if (!res || !res.conversations) return;
      const convs = res.conversations;

      // 1) Lista: re-renderiza solo si algo cambió de verdad
      const sig = this.convSig(convs);
      if (sig !== this._listSig) {
        Store.conversations = convs;
        this._listSig = sig;
        UI.renderList();
        this.enrichNames();
      }

      // 2) Hilo activo: recarga mensajes solo si esa conversación tiene novedades
      if (Store.activeId) {
        const active = convs.find(c => c.id === Store.activeId);
        if (active) {
          const msgs = Store.messagesByConv[Store.activeId] || [];
          const localLast = msgs.length ? msgs[msgs.length - 1].timestamp : 0;
          const hasNew = (active.lastMessageAt || 0) > localLast;
          const statusChanged = active.lastStatus !== this._activeStatus;
          if (hasNew || statusChanged) {
            try {
              Store.messagesByConv[Store.activeId] = await Api.loadMessages(Store.activeId);
              this._activeStatus = active.lastStatus;
              UI.renderThread();
            } catch (_) {}
          }
        }
      }
    },

    // ---------- ajustes ----------
    openSettings() {
      const s = Store.settings;
      $('#cfgSendUrl').value = s.sendUrl;
      $('#cfgConvUrl').value = s.convUrl;
      $('#cfgMsgUrl').value = s.msgUrl;
      $('#cfgDeleteUrl').value = s.deleteUrl;
      $('#cfgGhlUrl').value = s.ghlUrl;
      $('#cfgGhlFieldUrl').value = s.ghlFieldUrl;
      $('#cfgPoll').value = String(s.pollInterval);
      $('#cfgToken').value = s.token;
      $('#settingsModal').hidden = false;
    },
    async saveSettings() {
      Object.assign(Store.settings, {
        sendUrl: $('#cfgSendUrl').value.trim(),
        convUrl: $('#cfgConvUrl').value.trim(),
        msgUrl: $('#cfgMsgUrl').value.trim(),
        deleteUrl: $('#cfgDeleteUrl').value.trim(),
        ghlUrl: $('#cfgGhlUrl').value.trim(),
        ghlFieldUrl: $('#cfgGhlFieldUrl').value.trim(),
        pollInterval: Number($('#cfgPoll').value),
        token: $('#cfgToken').value.trim()
      });
      if (!Store.settings.convUrl) {
        UI.toast('Falta la URL de conversaciones');
      }
      Store.saveSettings(Store.settings);
      $('#settingsModal').hidden = true;
      UI.renderConnBadge();
      UI.toast('Ajustes guardados');
      await this.refreshData();
      this.startPolling();
    },

    // ---------- eventos ----------
    bindEvents() {
      // búsqueda
      $('#searchInput').addEventListener('input', e => { Store.search = e.target.value; UI.renderList(); });
      // tabs
      document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(x => x.classList.remove('tab--active'));
        t.classList.add('tab--active');
        Store.filter = t.dataset.filter;
        UI.renderList();
        if (Store.filter === 'handoff') this.loadHandoff(true); // refresca al entrar
      }));
      // composer: autoexpandir
      const input = $('#msgInput');
      input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; });
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.handleSend(); }
      });
      $('#btnSend').addEventListener('click', () => this.handleSend());
      // adjuntar archivo (documento / imagen / etc.)
      $('#btnAttach').addEventListener('click', () => $('#fileInput').click());
      $('#fileInput').addEventListener('change', e => {
        const f = e.target.files && e.target.files[0];
        e.target.value = '';
        if (f) this.sendFile(f);
      });
      // grabar nota de voz
      $('#btnMic').addEventListener('click', () => this.startRecording());
      $('#recCancel').addEventListener('click', () => this.stopRecording(false));
      $('#recSend').addEventListener('click', () => this.stopRecording(true));
      // destacar
      $('#btnStar').addEventListener('click', () => {
        const c = Store.activeConversation(); if (!c) return;
        c.starred = !c.starred; UI.renderList(); UI.toast(c.starred ? 'Destacada' : 'Sin destacar');
      });
      // eliminar conversación
      $('#btnDelete').addEventListener('click', () => this.deleteConversation());
      // prender/apagar chatbot
      $('#botToggle').addEventListener('click', () => this.toggleBot());
      // abierta/cerrada (toggle; cerrar escribe STOP en GHL)
      $('#convToggle').addEventListener('click', () => {
        const c = Store.activeConversation(); if (!c) return;
        this.setStatus(c.status === 'closed' ? 'open' : 'closed');
      });
      // plantillas
      $('#btnTemplate').addEventListener('click', () => { $('#templateModal').hidden = false; });
      // tema claro/oscuro
      $('#btnTheme').addEventListener('click', () => this.toggleTheme());
      // ajustes
      $('#btnSettings').addEventListener('click', () => this.openSettings());
      $('#btnSaveSettings').addEventListener('click', () => this.saveSettings());
      // cerrar modales
      document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => {
        $('#settingsModal').hidden = true; $('#templateModal').hidden = true;
      }));
      // cerrar visor de media
      document.querySelectorAll('[data-mclose]').forEach(b => b.addEventListener('click', () => UI.closeMedia()));
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
          $('#settingsModal').hidden = true; $('#templateModal').hidden = true;
          UI.closeMedia();
        }
      });
    },

    handleSend() {
      const input = $('#msgInput');
      const text = input.value;
      if (!text.trim()) return;
      input.value = ''; input.style.height = 'auto';
      this.send(text);
    }
  };

  global.App = App;
  document.addEventListener('DOMContentLoaded', () => App.init());
})(window);
