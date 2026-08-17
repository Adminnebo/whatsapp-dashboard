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
      this.loadTemplates();
      if (global.Devices) global.Devices.init();
      if (global.Tickets) global.Tickets.init();
      if (global.Notifs) global.Notifs.init();
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
      if (this._botEditable === false) { UI.toast('Solo un administrador puede prender o apagar el bot'); return; }
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
        Store.handoffIds = ids;
        UI.renderList();                  // renderList ya recalcula el contador
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
      const c = Store.activeConversation();
      this._activeStatus = c ? c.lastStatus : null;

      // Pinta YA la cabecera y lo que haya en caché: si esperamos a la red, el hilo
      // se queda en negro todo lo que tarde /api/messages (en producción, segundos).
      UI.renderList();
      UI.renderThread();
      this.loadGhl(c);

      if (!(Store.messagesByConv[id] || []).length) {
        UI.showThreadLoading(true);
        try {
          const { messages, hasMore } = await Api.loadMessages(id, { limit: 50 });   // solo los últimos 50 → abre al instante
          if (Store.activeId !== id) return;        // el usuario ya se fue a otro chat
          Store.messagesByConv[id] = messages;
          Store.hasMoreByConv[id] = hasMore;
          UI.renderThread();
        } catch (e) {
          if (Store.activeId === id) UI.toast('No se pudieron cargar los mensajes');
        } finally {
          if (Store.activeId === id) UI.showThreadLoading(false);
        }
      }
    },

    // Carga los mensajes ANTERIORES (scroll hacia arriba). Antepone respetando el orden
    // y mantiene la posición de lectura (el chat no salta).
    async loadOlderMessages() {
      const id = Store.activeId;
      if (!id || this._loadingOlder || !Store.hasMoreByConv[id]) return;
      const msgs = Store.messagesByConv[id] || [];
      if (!msgs.length) return;
      this._loadingOlder = true;
      const box = document.getElementById('messages');
      const prevH = box ? box.scrollHeight : 0, prevTop = box ? box.scrollTop : 0;
      try {
        const { messages, hasMore } = await Api.loadMessages(id, { before: msgs[0].id, limit: 50 });
        if (Store.activeId !== id) return;
        if (messages.length) {
          const vistos = new Set(msgs.map(m => m.id));
          const nuevos = messages.filter(m => !vistos.has(m.id));
          Store.messagesByConv[id] = nuevos.concat(Store.messagesByConv[id] || []);
        }
        Store.hasMoreByConv[id] = hasMore;
        UI.renderThread();
        if (box) box.scrollTop = box.scrollHeight - prevH + prevTop;   // ancla la vista
      } catch (_) {
      } finally { this._loadingOlder = false; }
    },

    // Recarga los mensajes del chat activo conservando los ya cargados (para el poll
    // y tras enviar): trae los últimos y los funde con lo que hubiera arriba.
    async reloadActive() {
      const id = Store.activeId; if (!id) return;
      const cur = Store.messagesByConv[id] || [];
      const { messages } = await Api.loadMessages(id, { limit: Math.max(50, cur.length) });
      const map = new Map(cur.map(m => [m.id, m]));
      for (const m of messages) map.set(m.id, m);
      Store.messagesByConv[id] = [...map.values()].sort((a, b) => (a.timestamp - b.timestamp) || (Number(a.id) - Number(b.id)));
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

    // El estado del botón (CAMILA ON/OFF) NO espera a GHL: sale del flag handoff que
    // ya viene con la lista de conversaciones, así se ve al instante al abrir el chat.
    // Esto solo reconcilia: si GHL dice STOP y nosotros no lo sabíamos (alguien lo cambió
    // en el CRM), lo marcamos y lo guardamos. No hacemos lo contrario: apagar a Camila
    // solo se levanta con el botón CAMILA ON, para no pisar un handoff recién puesto.
    applyBotStatus(conv) {
      const entry = conv && conv.contactId ? Store.ghlByContact[conv.contactId] : null;
      if (!entry || !entry.contact) return;                      // GHL no respondió: no tocamos nada
      const cf = entry.contact.customFields || [];
      const bs = cf.find(f => f.name === 'Bot Status');          // los vacíos no llegan: ausencia = encendida
      const closed = !!(bs && String(bs.value).trim().toUpperCase() === 'STOP');
      if (!closed || Store.isHandoff(conv)) return;              // ya coincide
      conv.handoff = true;
      Store.handoffIds.add(conv.contactId);
      UI.renderList(); UI.renderThread();
      Api.setGhlField(conv.contactId, 'STOP').catch(() => {});   // persiste el estado en la base
    },

    // Enciende / apaga a Camila para este contacto (escribe bot_status en GHL).
    // Apagar = handoff: el chat se pinta en rojo. Encender lo limpia (y quita la etiqueta).
    async setStatus(status) {
      const c = Store.activeConversation(); if (!c) return;
      const closed = status === 'closed';
      c.status = status;
      c.handoff = closed;                                   // rojo inmediato, sin esperar al poll
      if (c.contactId) {
        if (closed) Store.handoffIds.add(c.contactId);
        else Store.handoffIds.delete(c.contactId);
      }
      UI.renderDetails(c);
      UI.renderList();
      UI.renderThread();
      if (!Store.settings.ghlFieldUrl) return;
      const value = closed ? 'STOP' : '';
      try {
        // Mandamos también el conversationId: si el contacto no tiene ghl_contact_id
        // (contacto Meta), el servidor lo resuelve igual por la conversación.
        await Api.setGhlField(c.contactId, value, c.id);
        // refleja en la caché para que un re-render no lo revierta
        const entry = Store.ghlByContact[c.contactId];
        if (entry && entry.contact) {
          entry.contact.customFields = entry.contact.customFields || [];
          const bs = entry.contact.customFields.find(f => f.name === 'Bot Status');
          if (bs) bs.value = value; else entry.contact.customFields.push({ name: 'Bot Status', value });
        }
        UI.toast(closed ? 'Camila OFF · conversación en manual (handoff)' : 'Camila ON · handoff retirado');
        if (window.Notifs) Notifs.load();            // refresca el aviso al instante
      } catch (e) {
        UI.toast('No se pudo actualizar GHL: ' + e.message);
      }
    },

    // ---------- sección Bloqueados ----------
    async loadBlocked() {
      try { const d = await Api.listBlocked(); Store.blockedList = (d && d.blocked) || []; }
      catch (e) { Store.blockedList = Store.blockedList || []; UI.toast('No se pudo cargar bloqueados: ' + e.message); }
      if (Store.filter === 'blocked') UI.renderList();
    },
    // Alta manual: bloquear un número aunque no exista como contacto (proactivo).
    async blockNumber() {
      const input = document.querySelector('#blkNumber'); if (!input) return;
      const digits = (input.value || '').replace(/[^\d]/g, '');
      if (digits.length < 7) { UI.toast('Escribe un número válido'); return; }
      try {
        const r = await Api.blockSet({ phone: digits }, true);
        input.value = '';
        UI.toast(r && r.created === false ? 'Ese número ya estaba; queda bloqueado' : 'Número bloqueado: ' + ((r && r.phone) || digits));
        await this.loadBlocked();
      } catch (e) { UI.toast('No se pudo bloquear: ' + e.message); }
    },
    async unblockContact(b) {
      const target = b.conversationId ? { conversationId: b.conversationId }
        : (b.phone ? { phone: b.phone } : { userId: b.userId });
      try {
        await Api.blockSet(target, false);
        UI.toast('Desbloqueado: ' + (b.name || b.phone || ''));
        Store.blockedList = (Store.blockedList || []).filter(x => x.contactId !== b.contactId);
        const c = Store.conversations.find(cv => String(cv.id) === String(b.conversationId));
        if (c) c.blocked = false;
        UI.renderList();
      } catch (e) { UI.toast('No se pudo desbloquear: ' + e.message); }
    },

    // ---------- bloquear / desbloquear contacto ----------
    // Bloqueado = Camila nunca le responde (todos los canales). El servidor espeja
    // el estado a Supabase (WhatsApp) y GHL (IG/FB/web).
    async toggleBlock() {
      const c = Store.activeConversation(); if (!c) return;
      const willBlock = !c.blocked;
      if (willBlock && !confirm(`¿Bloquear a ${c.name}?\nCamila dejará de responderle en todos los canales. Podrás desbloquearlo cuando quieras.`)) return;
      c.blocked = willBlock;                                  // optimista
      UI.renderDetails(c); UI.renderList();
      try {
        await Api.blockSet(c.id, willBlock);
        UI.toast(willBlock ? 'Contacto bloqueado · Camila no responderá' : 'Contacto desbloqueado');
        if (window.Notifs) Notifs.load();
      } catch (e) {
        c.blocked = !willBlock;                              // revertir si falla
        UI.renderDetails(c); UI.renderList();
        UI.toast('No se pudo actualizar el bloqueo: ' + e.message);
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
        // Si estamos viendo un dispositivo QR, sale por su servicio, no por Meta.
        const res = (global.Devices && Devices.actual)
          ? await Devices.enviar(conv, text).then(r => ({ id: optimistic.id, status: r && r.ok ? 'delivered' : 'failed', sent: !!(r && r.ok) }))
          : await Api.sendMessage(payload);
        optimistic.id = res.id || optimistic.id;
        optimistic.status = res.status || 'delivered';
        // el proveedor (Meta o GHL) puede rechazar el mensaje aunque el HTTP sea 200
        if (res.sent === false) UI.toast('No se pudo enviar: ' + (res.error || 'lo rechazó el proveedor'));
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
          UI.toast('Guardado, pero no se entregó: ' + (res.error || 'lo rechazó el proveedor'));
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

    // ---------- plantillas de Meta ----------
    async loadTemplates(force) {
      try {
        const d = await Api.getWaTemplates(force);
        Store.templates = (d && d.templates) || [];
        Store.templatesError = d && d.ok === false ? (d.error || 'error') : null;
      } catch (e) {
        Store.templates = [];
        Store.templatesError = e.message;
      }
      UI.renderTemplates();
    },

    useTemplate(tpl) {
      const conv = Store.activeConversation();
      if (!conv) { UI.toast('Selecciona una conversación primero'); return; }
      UI.renderTemplateForm(tpl);
    },

    async sendTemplate(tpl) {
      const conv = Store.activeConversation();
      if (!conv) { UI.toast('Selecciona una conversación primero'); return; }
      const val = id => { const e = document.getElementById(id); return e ? e.value.trim() : ''; };

      // Meta exige TODAS las variables: si falta alguna, rechaza el envío.
      const bodyParams = [], headerParams = [], buttonParams = [];
      (tpl.body.vars || []).forEach(n => { bodyParams[n - 1] = val('tplB' + n); });
      if (tpl.header && tpl.header.format === 'TEXT') {
        (tpl.header.vars || []).forEach(n => { headerParams[n - 1] = val('tplH' + n); });
      }
      (tpl.buttons || []).forEach(b => { if ((b.vars || []).length) buttonParams.push({ index: b.index, text: val('tplBt' + b.index) }); });
      const faltan = [...bodyParams, ...headerParams, ...buttonParams.map(b => b.text)].some(v => !v);
      if (faltan) { UI.toast('Rellena todas las variables'); return; }

      const payload = {
        name: tpl.name, language: tpl.language,
        to: conv.phone, contactId: conv.contactId, contactName: conv.name,
        bodyParams, headerParams, buttonParams,
        preview: tpl.body.text
      };
      if (tpl.header && tpl.header.format !== 'TEXT') {
        const link = val('tplMedia');
        if (!link) { UI.toast('Falta la URL del ' + tpl.header.format.toLowerCase()); return; }
        payload.headerMedia = { type: tpl.header.format.toLowerCase(), link };
      }

      const btn = document.getElementById('tplSend');
      if (btn) { btn.disabled = true; btn.textContent = 'Enviando…'; }
      try {
        await Api.sendTemplate(payload);
        $('#templateModal').hidden = true;
        UI.toast('Plantilla enviada');
        await this.reloadActive();
        UI.renderThread();
        this.refreshData();
      } catch (e) {
        UI.toast(e.message);                       // el error viene tal cual de Meta
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Enviar plantilla'; }
      }
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
      for (const c of list) s += c.id + ':' + (c.lastMessageAt || 0) + ':' + (c.unreadCount || 0) + ':' + (c.lastStatus || '') + ':' + (c.handoff ? 'H' : '') + '|';
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
              await this.reloadActive();
              this._activeStatus = active.lastStatus;
              UI.renderThread();
            } catch (_) {}
          }
        }
      }
    },

    // ---------- ajustes ----------
    // Solo se expone el auto-return de handoff. Las URLs/polling/token quedan
    // fijos por config.js (mismo origen) y ya no se editan desde la interfaz.
    openSettings() {
      $('#settingsModal').hidden = false;
      // Auto-return de handoff: valor real del servidor (minutos).
      const rIn = $('#cfgHandoffReturn'), rUnit = $('#cfgHandoffUnit');
      if (rIn) {
        rIn.value = ''; if (rUnit) rUnit.value = '1';
        Api.getHandoffConfig().then(cfg => {
          const m = (cfg && Number(cfg.minutes)) || 0;
          if (m && m % 60 === 0) { rIn.value = String(m / 60); if (rUnit) rUnit.value = '60'; }
          else { rIn.value = String(m); if (rUnit) rUnit.value = '1'; }
        }).catch(() => {});
      }
    },
    async saveSettings() {
      // Auto-return de handoff (setting del servidor, no localStorage).
      const rIn = $('#cfgHandoffReturn'), rUnit = $('#cfgHandoffUnit');
      if (rIn) {
        const mins = Math.max(0, Math.floor((Number(rIn.value) || 0) * (Number(rUnit && rUnit.value) || 1)));
        try { await Api.setHandoffConfig(mins); } catch (e) { UI.toast('No se pudo guardar el auto-return'); }
      }
      $('#settingsModal').hidden = true;
      UI.toast('Ajustes guardados');
    },

    // ---------- eventos ----------
    bindEvents() {
      // búsqueda (al filtrar, volvemos a empezar por las primeras 25)
      $('#searchInput').addEventListener('input', e => { Store.search = e.target.value; Store.renderLimit = 25; UI.renderList(); });
      // tabs
      document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(x => x.classList.remove('tab--active'));
        t.classList.add('tab--active');
        Store.filter = t.dataset.filter;
        Store.renderLimit = 25;                 // reset de la paginación al cambiar de filtro
        UI.renderList();
        if (Store.filter === 'handoff') this.loadHandoff(true); // refresca al entrar
        if (Store.filter === 'blocked') this.loadBlocked();      // trae la lista (incluye sin conversación)
      }));
      // auto-cargar más al llegar cerca del fondo de la lista (además del botón)
      const convBox = $('#convList');
      if (convBox) convBox.addEventListener('scroll', () => {
        if (convBox.scrollTop + convBox.clientHeight >= convBox.scrollHeight - 120) {
          const total = Store.visibleConversations().length;
          if ((Store.renderLimit || 25) < total) { Store.renderLimit = (Store.renderLimit || 25) + 25; UI.renderList(); }
        }
      });
      // cargar mensajes anteriores al llegar arriba del hilo
      const msgBox = $('#messages');
      if (msgBox) msgBox.addEventListener('scroll', () => {
        if (msgBox.scrollTop <= 60) this.loadOlderMessages();
      });
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
        // Decide con el MISMO dato que pinta la etiqueta (handoff). Si usáramos c.status
        // podría estar desfasado y el botón mandaría OFF cuando ya dice OFF.
        this.setStatus(Store.isHandoff(c) ? 'open' : 'closed');
      });
      // bloquear / desbloquear contacto
      const cb = $('#convBlock');
      if (cb) cb.addEventListener('click', () => this.toggleBlock());
      // plantillas
      $('#btnTemplate').addEventListener('click', () => {
        $('#templateModal').hidden = false;
        UI.renderTemplates();                       // vuelve siempre a la lista
        if (!Store.templates.length) this.loadTemplates();
      });
      $('#tplRefresh').addEventListener('click', () => this.loadTemplates(true));
      // tema claro/oscuro
      $('#btnTheme').addEventListener('click', () => this.toggleTheme());
      // ajustes
      $('#btnSettings').addEventListener('click', () => this.openSettings());
      $('#btnSaveSettings').addEventListener('click', () => this.saveSettings());
      // nuevo chat
      const nc = $('#newChatBtn');
      if (nc) nc.addEventListener('click', () => this.openNewChat());
      const ncS = $('#ncSend');
      if (ncS) ncS.addEventListener('click', () => this.sendNewChat());
      const ncMode = $('#ncMode');
      if (ncMode) ncMode.addEventListener('change', () => this.ncModeChange());
      const ncTpl = $('#ncTemplate');
      if (ncTpl) ncTpl.addEventListener('change', () => this.ncTemplateChange());
      // cerrar modales
      document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => {
        $('#settingsModal').hidden = true; $('#templateModal').hidden = true; $('#newChatModal').hidden = true;
      }));
      // cerrar visor de media
      document.querySelectorAll('[data-mclose]').forEach(b => b.addEventListener('click', () => UI.closeMedia()));
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
          $('#settingsModal').hidden = true; $('#templateModal').hidden = true; $('#newChatModal').hidden = true;
          UI.closeMedia();
        }
      });
    },

    // ---------- nuevo chat: crear número + primer mensaje ----------
    openNewChat() {
      $('#ncErr').hidden = true;
      $('#ncMode').value = 'free';
      this.ncModeChange();
      $('#newChatModal').hidden = false;
      if (!Store.templates.length) this.loadTemplates().then(() => this.ncFillTemplates());
      else this.ncFillTemplates();
      setTimeout(() => { const p = $('#ncPhone'); if (p) p.focus(); }, 50);
    },
    ncModeChange() {
      const tpl = $('#ncMode').value === 'tpl';
      $('#ncFreeGroup').hidden = tpl;
      $('#ncTplGroup').hidden = !tpl;
    },
    ncFillTemplates() {
      const sel = $('#ncTemplate'); if (!sel) return;
      const aprob = (Store.templates || []).filter(t => t.status === 'APPROVED');
      sel.innerHTML = '';
      if (!aprob.length) { sel.innerHTML = '<option value="">No hay plantillas aprobadas</option>'; }
      else aprob.forEach((t, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = t.name; sel.appendChild(o); });
      this.ncTemplateChange();
    },
    ncTemplateChange() {
      const aprob = (Store.templates || []).filter(t => t.status === 'APPROVED');
      const tpl = aprob[Number($('#ncTemplate').value)] || null;
      const form = $('#ncTplForm'), prev = $('#ncTplPreview');
      if (!tpl) { form.innerHTML = ''; prev.textContent = ''; return; }
      let html = '';
      (tpl.header && tpl.header.format === 'TEXT' ? tpl.header.vars : []).forEach(n => {
        html += `<input class="nc-var" id="ncH${n}" placeholder="Encabezado {{${n}}}" />`;
      });
      (tpl.body.vars || []).forEach(n => { html += `<input class="nc-var" id="ncB${n}" placeholder="Variable {{${n}}}" />`; });
      if (tpl.header && tpl.header.format !== 'TEXT') {
        html += `<input class="nc-var" id="ncMedia" placeholder="URL del ${tpl.header.format.toLowerCase()}" />`;
      }
      form.innerHTML = html;
      prev.textContent = tpl.body.text || '';
    },
    async sendNewChat() {
      const phone = ($('#ncPhone').value || '').replace(/[^\d]/g, '');
      const name = ($('#ncName').value || '').trim();
      const err = $('#ncErr'); err.hidden = true;
      if (phone.length < 8) { err.textContent = 'Pon el número con código de país (solo dígitos).'; err.hidden = false; return; }
      const esTpl = $('#ncMode').value === 'tpl';
      const btn = $('#ncSend'); btn.disabled = true; btn.textContent = 'Enviando…';
      const val = id => { const e = document.getElementById(id); return e ? e.value.trim() : ''; };
      try {
        let res;
        if (esTpl) {
          const aprob = (Store.templates || []).filter(t => t.status === 'APPROVED');
          const tpl = aprob[Number($('#ncTemplate').value)];
          if (!tpl) throw new Error('Elige una plantilla');
          const bodyParams = [], headerParams = [], buttonParams = [];
          (tpl.body.vars || []).forEach(n => { bodyParams[n - 1] = val('ncB' + n); });
          if (tpl.header && tpl.header.format === 'TEXT') (tpl.header.vars || []).forEach(n => { headerParams[n - 1] = val('ncH' + n); });
          if ([...bodyParams, ...headerParams].some(v => !v)) throw new Error('Rellena todas las variables de la plantilla');
          const payload = { name: tpl.name, language: tpl.language, to: phone, contactName: name || null, bodyParams, headerParams, buttonParams, preview: tpl.body.text };
          if (tpl.header && tpl.header.format !== 'TEXT') {
            const link = val('ncMedia'); if (!link) throw new Error('Falta la URL del ' + tpl.header.format.toLowerCase());
            payload.headerMedia = { type: tpl.header.format.toLowerCase(), link };
          }
          res = await Api.sendTemplate(payload);
        } else {
          const text = ($('#ncText').value || '').trim();
          if (!text) throw new Error('Escribe el mensaje.');
          res = await Api.sendMessage({ channel: 'whatsapp', to: phone, phone: phone, name: name || null, type: 'text', text: text });
          if (res && res.sent === false) throw new Error(res.error || 'El proveedor rechazó el mensaje');
        }
        $('#newChatModal').hidden = true;
        $('#ncPhone').value = ''; $('#ncName').value = ''; $('#ncText').value = '';
        await this.refreshData();
        if (res && res.conversationId) this.openConversation(String(res.conversationId));
        UI.toast('Mensaje enviado');
      } catch (e) {
        err.textContent = 'No se pudo enviar: ' + e.message;
        err.hidden = false;
      } finally { btn.disabled = false; btn.textContent = 'Enviar'; }
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
  document.addEventListener('DOMContentLoaded', async () => {
    if (window.Auth) {
      const s = await Auth.requireSession(); if (!s) return; // exige sesión
      if (Auth.configured) {
        const av = document.querySelector('.rail__avatar');
        if (av) { av.title = 'Cerrar sesión'; av.style.cursor = 'pointer'; av.addEventListener('click', () => Auth.signOut()); }
        try {
          const me = await Auth.me();
          const role = me && me.profile ? me.profile.role : null;
          // Puerta de acceso: si el usuario no tiene la plataforma 'inbox', no entra.
          const plats = (me && me.platforms) || [];
          if (Array.isArray(plats) && plats.length && !plats.includes('inbox')) {
            return mostrarSinAcceso(plats);
          }
          // Permisos granulares: oculta secciones/botones que el usuario no tiene.
          if (global.PERMS) { PERMS.set(me && me.permissions); PERMS.aplicar(); }
          // Accesos a las otras plataformas según el acceso del usuario.
          const tienePlat = k => !Array.isArray(plats) || !plats.length || plats.includes(k);
          const gc = document.querySelector('#goCotiz'); if (gc && tienePlat('cotizaciones')) gc.hidden = false;
          const gb = document.querySelector('#goCobranzas'); if (gb && tienePlat('cobranzas')) gb.hidden = false;
          const esAdmin = ['admin', 'super_admin'].includes(role);
          if (esAdmin) { const ub = document.querySelector('#btnUsers'); if (ub) ub.hidden = false; }
          // El toggle global del bot SOLO lo cambia admin/super_admin. Los demás lo
          // ven (para saber el estado) pero no pueden tocarlo.
          App._botEditable = esAdmin;
          if (!esAdmin) {
            const bt = document.querySelector('#botToggle');
            if (bt) { bt.classList.add('bot-toggle--readonly'); bt.title = 'Solo un administrador puede prender/apagar el bot'; }
          }
        } catch (_) {}
      }
    }
    App.init();
  });

  // Pantalla de "sin acceso" con enlaces a las plataformas que SÍ tiene.
  function mostrarSinAcceso(plats) {
    const destinos = {
      cotizaciones: ['Panel de cotizaciones', 'https://panelcotizaciones.neboaiconsulting.com'],
      cobranzas: ['Panel de cobranzas', 'https://panelcobranzas.neboaiconsulting.com']
    };
    const links = (plats || []).filter(p => destinos[p])
      .map(p => `<a class="noacc__link" href="${destinos[p][1]}">${destinos[p][0]} →</a>`).join('');
    document.body.innerHTML = `<div class="noacc">
      <div class="noacc__ic">🔒</div>
      <h1>Sin acceso a Conversaciones</h1>
      <p>Tu usuario no tiene permiso para esta plataforma. Pídeselo a un administrador.</p>
      ${links ? '<div class="noacc__links">' + links + '</div>' : ''}
      <button class="noacc__out" onclick="window.Auth && Auth.signOut()">Cerrar sesión</button>
    </div>`;
  }
})(window);
