/* =========================================================
   ui.js — Renderizado del DOM
   ========================================================= */
(function (global) {
  'use strict';

  const $ = sel => document.querySelector(sel);

  // ---------- canales (plataformas) ----------
  const CHANNELS = {
    whatsapp: {
      label: 'WhatsApp', color: '#25d366', bg: '#25d366',
      icon: '<svg viewBox="0 0 24 24"><path d="M12 2C6.5 2 2 6.5 2 12c0 1.8.5 3.5 1.3 5L2 22l5.2-1.3c1.4.8 3.1 1.2 4.8 1.2 5.5 0 10-4.5 10-10S17.5 2 12 2z"/></svg>'
    },
    instagram: {
      label: 'Instagram', color: '#e1306c',
      bg: 'radial-gradient(circle at 30% 107%, #fdf497 0%, #fd5949 45%, #d6249f 70%, #285AEB 100%)',
      icon: '<svg viewBox="0 0 24 24"><path d="M12 2.2c3.2 0 3.6 0 4.9.1 1.2.1 1.8.3 2.2.4.6.2 1 .5 1.4.9.4.4.7.8.9 1.4.2.4.4 1 .4 2.2.1 1.3.1 1.7.1 4.9s0 3.6-.1 4.9c-.1 1.2-.3 1.8-.4 2.2-.2.6-.5 1-.9 1.4-.4.4-.8.7-1.4.9-.4.2-1 .4-2.2.4-1.3.1-1.7.1-4.9.1s-3.6 0-4.9-.1c-1.2-.1-1.8-.3-2.2-.4-.6-.2-1-.5-1.4-.9-.4-.4-.7-.8-.9-1.4-.2-.4-.4-1-.4-2.2C2.2 15.6 2.2 15.2 2.2 12s0-3.6.1-4.9c.1-1.2.3-1.8.4-2.2.2-.6.5-1 .9-1.4.4-.4.8-.7 1.4-.9.4-.2 1-.4 2.2-.4C8.4 2.2 8.8 2.2 12 2.2zm0 3.2A6.4 6.4 0 1018.4 12 6.4 6.4 0 0012 5.4zm0 2.2A4.2 4.2 0 117.8 12 4.2 4.2 0 0112 7.6zm6.6-2.3a1.5 1.5 0 10-1.5 1.5 1.5 1.5 0 001.5-1.5z"/></svg>'
    },
    facebook: {
      label: 'Facebook', color: '#0084ff', bg: '#0084ff',
      icon: '<svg viewBox="0 0 24 24"><path d="M12 2C6.3 2 2 6.2 2 11.6c0 2.9 1.3 5.4 3.4 7.1V22l3.1-1.7c.8.2 1.7.3 2.5.3 5.7 0 10-4.2 10-9.6S17.7 2 12 2zm1 12.9-2.6-2.7-4.9 2.7 5.4-5.7 2.6 2.7 4.8-2.7-5.3 5.7z"/></svg>'
    },
    pagina_web: {
      label: 'Página web', color: '#6b7cff', bg: '#6b7cff',
      icon: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.9 6h-2.9a15.7 15.7 0 0 0-1.3-3.4A8 8 0 0 1 18.9 8zM12 4c.8 1.2 1.4 2.5 1.8 4h-3.6c.4-1.5 1-2.8 1.8-4zM4.3 14A8 8 0 0 1 4 12c0-.7.1-1.4.3-2h3.4a16.6 16.6 0 0 0 0 4H4.3zm.8 2h2.9c.3 1.2.8 2.4 1.3 3.4A8 8 0 0 1 5.1 16zm2.9-8H5.1a8 8 0 0 1 4.2-3.4C8.8 5.6 8.3 6.8 8 8zM12 20c-.8-1.2-1.4-2.5-1.8-4h3.6c-.4 1.5-1 2.8-1.8 4zm2.2-6H9.8a14.7 14.7 0 0 1 0-4h4.4a14.7 14.7 0 0 1 0 4zm.3 5.4c.5-1 1-2.2 1.3-3.4h2.9a8 8 0 0 1-4.2 3.4zm1.8-5.4a16.6 16.6 0 0 0 0-4h3.4c.2.6.3 1.3.3 2s-.1 1.4-.3 2h-3.4z"/></svg>'
    }
  };
  const chMeta = ch => CHANNELS[ch] || CHANNELS.whatsapp;
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- helpers de fecha ----------
  function timeShort(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  }
  function relList(ts) {
    const d = new Date(ts), now = new Date();
    const diff = (now - d) / 1000;
    if (diff < 60) return 'ahora';
    if (diff < 3600) return Math.floor(diff / 60) + ' min';
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return timeShort(ts);
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    if (d.toDateString() === yest.toDateString()) return 'Ayer';
    return d.toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit' });
  }
  function dateLabel(ts) {
    const d = new Date(ts), now = new Date();
    if (d.toDateString() === now.toDateString()) return 'Hoy';
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    if (d.toDateString() === yest.toDateString()) return 'Ayer';
    return d.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  // ticks de estado de mensaje
  const TICK = {
    sent:      '<svg viewBox="0 0 16 11"><path d="M11.07.65 5.4 6.32 3.5 4.43l-.7.7 2.6 2.6L11.77 1.35z" fill="currentColor"/></svg>',
    delivered: '<svg viewBox="0 0 16 11"><path d="M11.07.65 5.4 6.32 3.5 4.43l-.7.7 2.6 2.6L11.77 1.35zM15 .65 9.33 6.32l-.92-.92-.7.7 1.62 1.62L15.7 1.35z" fill="currentColor"/></svg>',
    read:      '<svg viewBox="0 0 16 11"><path d="M11.07.65 5.4 6.32 3.5 4.43l-.7.7 2.6 2.6L11.77 1.35zM15 .65 9.33 6.32l-.92-.92-.7.7 1.62 1.62L15.7 1.35z" fill="currentColor"/></svg>',
    failed:    '<svg viewBox="0 0 16 16"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zm.8 10.5H7.2V10h1.6v1.5zm0-2.7H7.2V4.5h1.6v4.3z" fill="currentColor"/></svg>'
  };

  // icono genérico de documento (para adjuntos no reproducibles)
  const DOC_ICON = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm0 2 4 4h-4V4zM8 13h8v1.5H8V13zm0 3h8v1.5H8V16zm0-6h4v1.5H8V10z" fill="currentColor"/></svg>';

  const UI = {
    // ---------- badge de conexión ----------
    renderConnBadge() {
      const b = $('#connBadge');
      b.className = 'conn conn--live';
      b.textContent = 'LIVE';
    },

    // ---------- contador de la pestaña Handoff ----------
    // Cuenta CONVERSACIONES en handoff, no contactos marcados: si se borra una
    // conversación, su contacto ya no debe sumar aquí.
    renderHandoffCount() {
      const n = (Store.conversations || []).filter(c => Store.isHandoff(c)).length;
      const el2 = $('#handoffCount');
      if (el2) el2.textContent = n > 0 ? ' ' + n : '';
      const tab = document.querySelector('.tab[data-filter="handoff"]');
      if (tab) tab.classList.toggle('tab--has', n > 0);
    },

    // ---------- botón prender/apagar chatbot ----------
    renderBotToggle(active, loading) {
      const btn = $('#botToggle');
      if (!btn) return;
      btn.hidden = false;
      btn.classList.toggle('bot-toggle--on', !!active);
      btn.classList.toggle('bot-toggle--off', !active);
      btn.classList.toggle('is-loading', !!loading);
      const label = $('#botToggleLabel');
      if (label) label.textContent = active ? 'Bot ON' : 'Bot OFF';
    },

    // ---------- lista de conversaciones ----------
    renderList() {
      const box = $('#convList');
      const list = Store.visibleConversations();
      this.renderHandoffCount();          // siempre en sintonía con lo que hay en la lista
      if (!list.length) {
        box.innerHTML = '<div class="list__body-empty"><p style="padding:30px;text-align:center;color:#9aa3b2">Sin conversaciones</p></div>';
        return;
      }
      const frag = document.createDocumentFragment();
      list.forEach(c => {
        const active = c.id === Store.activeId;
        const cm = chMeta(c.channel);
        const handoff = Store.isHandoff(c);
        const node = el('div', 'conv' + (active ? ' conv--active' : '') + (c.unreadCount > 0 ? ' conv--unread' : '') + (handoff ? ' conv--handoff' : ''));
        const tick = c.lastDirection === 'out' ? `<span class="tick ${c.lastStatus === 'read' ? 'read' : ''}">${TICK[c.lastStatus] || TICK.sent}</span> ` : '';
        node.innerHTML = `
          <div class="conv__avatar">
            <div class="avatar" style="background:${c.avatar.color}">${esc(c.avatar.initials)}</div>
            <span class="conv__chan" style="background:${cm.bg}">${cm.icon}</span>
          </div>
          <div class="conv__main">
            <div class="conv__top">
              <span class="conv__name">${esc(c.name)}</span>
              <span class="conv__time">${relList(c.lastMessageAt)}</span>
            </div>
            <div class="conv__bottom">
              ${handoff ? '<span class="conv__handoff">Handoff</span>' : ''}
              <span class="conv__preview">${tick}${esc(c.lastMessage)}</span>
              ${c.unreadCount > 0 ? `<span class="conv__badge">${c.unreadCount}</span>` : ''}
            </div>
          </div>`;
        node.addEventListener('click', () => global.App.openConversation(c.id));
        frag.appendChild(node);
      });
      box.replaceChildren(frag);
    },

    // ---------- hilo de mensajes ----------
    renderThread() {
      const conv = Store.activeConversation();
      const empty = $('#threadEmpty'), inner = $('#threadInner'), details = $('#details');
      if (!conv) { empty.hidden = false; inner.hidden = true; details.hidden = true; return; }
      empty.hidden = true; inner.hidden = false; details.hidden = false;

      // cabecera
      $('#threadAvatar').textContent = conv.avatar.initials;
      $('#threadAvatar').style.background = conv.avatar.color;
      $('#threadName').textContent = conv.name;
      $('#threadPhone').textContent = conv.phone || (conv.contactId ? 'ID ' + conv.contactId : '');
      const hcm = chMeta(conv.channel);
      const chanEl = $('#threadChan');
      if (chanEl) { chanEl.innerHTML = hcm.icon + ' ' + hcm.label; chanEl.style.color = hcm.color; }
      // aviso rojo cuando la conversación está en handoff
      const thread = $('#thread');
      if (thread) thread.classList.toggle('thread--handoff', Store.isHandoff(conv));

      // mensajes con separadores de fecha
      const box = $('#messages');
      // ¿conviene saltar al fondo? Solo al abrir otra conversación o si el
      // usuario ya estaba abajo (para no interrumpir su lectura en cada poll).
      const convChanged = this._threadConvId !== conv.id;
      const nearBottom = (box.scrollHeight - box.scrollTop - box.clientHeight) < 90;
      const prevScroll = box.scrollTop;
      const frag = document.createDocumentFragment();
      let lastDay = null;
      Store.activeMessages().forEach(m => {
        const day = new Date(m.timestamp).toDateString();
        if (day !== lastDay) {
          frag.appendChild(el('div', 'date-sep', dateLabel(m.timestamp)));
          lastDay = day;
        }
        frag.appendChild(this.messageNode(m));
      });
      box.replaceChildren(frag);
      if (convChanged || nearBottom) box.scrollTop = box.scrollHeight;
      else box.scrollTop = prevScroll;
      this._threadConvId = conv.id;

      // aviso ventana 24h: es una regla de WhatsApp (plantillas de Meta), no de los demás canales
      const outOfWindow = conv.channel === 'whatsapp' && conv.lastInbound && (Date.now() - conv.lastInbound) > 24 * 3600 * 1000;
      $('#windowWarn').hidden = !outOfWindow;

      this.renderDetails(conv);
    },

    // Placeholder mientras llegan los mensajes (evita el hilo en negro).
    showThreadLoading(on) {
      const box = $('#messages');
      if (!box) return;
      const prev = box.querySelector('.thread__loading');
      if (!on) { if (prev) prev.remove(); return; }
      if (prev || box.children.length) return;      // ya hay contenido: no molestamos
      box.appendChild(el('div', 'thread__loading', '<span class="spinner"></span> Cargando mensajes…'));
    },

    // ¿la url o el mime corresponden a un PDF?
    isPdf(url, mime) { return mime === 'application/pdf' || /\.pdf($|\?)/i.test(url || ''); },

    // Renderiza el adjunto según su tipo (imagen, audio, video, documento).
    // Imagen, video y documento abren el visor (lightbox) al hacer clic.
    mediaNode(m) {
      const url = m.mediaUrl;
      if (!url) return '';
      const u = esc(url);
      const mime = (m.mediaMime || '').toLowerCase();
      const type = m.type === 'sticker' ? 'image' : m.type;
      const name = esc(m.mediaFilename || '');
      const data = `data-url="${u}" data-mime="${esc(mime)}" data-name="${name}"`;
      if (type === 'image' || mime.startsWith('image/')) {
        return `<div class="msg__media js-media-open" data-mtype="image" ${data}><img src="${u}" alt="" loading="lazy" decoding="async"></div>`;
      }
      if (type === 'audio' || mime.startsWith('audio/')) {
        return `<div class="msg__media msg__media--audio"><audio controls preload="none" src="${u}"></audio></div>`;
      }
      if (type === 'video' || mime.startsWith('video/')) {
        return `<div class="msg__media js-media-open msg__media--video" data-mtype="video" ${data}><video preload="metadata" src="${u}#t=0.1"></video><span class="msg__play">▶</span></div>`;
      }
      // documento → tarjeta que abre el visor (PDF embebido / descarga)
      const label = name || (this.isPdf(url, mime) ? 'PDF' : 'Documento');
      const hint = this.isPdf(url, mime) ? 'Ver' : 'Abrir';
      return `<div class="msg__doc js-media-open" data-mtype="document" ${data}>${DOC_ICON}<span class="msg__doc-name">${label}</span><span class="msg__doc-hint">${hint}</span></div>`;
    },

    messageNode(m) {
      const out = m.direction === 'out';
      const cm = chMeta(m.channel);
      const hasMedia = !!m.mediaUrl;
      const node = el('div', 'msg ' + (out ? 'msg--out' : 'msg--in') + (m.type === 'template' ? ' msg--template' : '') + (hasMedia ? ' msg--media' : '') + (m.status === 'failed' ? ' msg--failed' : ''));
      let inner = '';
      if (out && m.sentBy) inner += `<div class="msg__sender">${esc(m.sentBy)}</div>`;
      if (m.type === 'template') inner += `<div class="msg__tplflag">Plantilla · ${esc(m.template || '')}</div>`;
      if (hasMedia) inner += this.mediaNode(m);
      if (m.text) inner += `<div class="msg__text">${esc(m.text)}</div>`;
      inner += `<div class="msg__meta"><span class="msg__chan" style="color:${cm.color}" title="${cm.label}">${cm.icon}</span><span class="msg__time">${timeShort(m.timestamp)}</span>`;
      if (out) inner += `<span class="msg__tick ${m.status === 'read' ? 'read' : ''}">${TICK[m.status] || TICK.sent}</span>`;
      inner += `</div>`;
      node.innerHTML = inner;
      // abrir el visor al hacer clic en el adjunto
      const opener = node.querySelector('.js-media-open');
      if (opener) opener.addEventListener('click', () => this.openMedia({
        url: opener.dataset.url, mtype: opener.dataset.mtype,
        mime: opener.dataset.mime, name: opener.dataset.name
      }));
      return node;
    },

    // ---------- visor de media (lightbox) ----------
    openMedia(o) {
      const url = o.url, mime = (o.mime || '').toLowerCase(), name = o.name || '';
      const body = $('#mediaModalBody');
      $('#mediaModalName').textContent = name;
      const openA = $('#mediaModalOpen'), dlA = $('#mediaModalDl');
      openA.href = url; dlA.href = url;
      if (name) dlA.setAttribute('download', name); else dlA.removeAttribute('download');
      let html;
      if (o.mtype === 'image' || mime.startsWith('image/')) {
        html = `<img class="media-modal__img" src="${esc(url)}" alt="">`;
      } else if (o.mtype === 'video' || mime.startsWith('video/')) {
        html = `<video class="media-modal__media" src="${esc(url)}" controls autoplay></video>`;
      } else if (o.mtype === 'audio' || mime.startsWith('audio/')) {
        html = `<audio class="media-modal__media" src="${esc(url)}" controls autoplay></audio>`;
      } else if (this.isPdf(url, mime)) {
        html = `<iframe class="media-modal__frame" src="${esc(url)}" title="${esc(name)}"></iframe>`;
      } else {
        html = `<div class="media-modal__noprev">${DOC_ICON}<p>No hay vista previa para este tipo de archivo${name ? ` (${esc(name)})` : ''}.</p><a class="btn-primary" href="${esc(url)}" target="_blank" rel="noopener" download>Descargar</a></div>`;
      }
      body.innerHTML = html;
      $('#mediaModal').hidden = false;
    },
    closeMedia() {
      $('#mediaModalBody').innerHTML = ''; // detiene video/audio
      $('#mediaModal').hidden = true;
    },

    // ---------- panel de detalles ----------
    renderDetails(conv) {
      $('#detAvatar').textContent = conv.avatar.initials;
      $('#detAvatar').style.background = conv.avatar.color;
      $('#detName').textContent = conv.name;

      const dbc = conv.contact || {};
      const entry = conv.contactId && Store.ghlByContact ? Store.ghlByContact[conv.contactId] : undefined;
      const g = (entry && entry.contact) ? entry.contact : null;

      const phone = (g && g.phone) || conv.phone || '';
      const email = (g && g.email) || dbc.email || '';
      $('#detPhone').textContent = phone || (conv.contactId ? 'ID ' + conv.contactId : '');
      $('#detTel').href = 'tel:' + String(phone).replace(/\s/g, '');
      $('#detMail').href = 'mailto:' + email;

      // nota de carga de GHL
      const note = $('#detGhlNote');
      if (note) {
        if (conv.contactId && entry === undefined) { note.hidden = false; note.textContent = 'Cargando datos de GoHighLevel…'; }
        else if (conv.contactId && entry === null) { note.hidden = false; note.textContent = 'No se pudieron cargar los datos de GHL.'; }
        else { note.hidden = true; note.textContent = ''; }
      }

      // etiquetas (GHL si hay; si no, las de la BD)
      const tags = (g && g.tags && g.tags.length) ? g.tags : (dbc.tags || []);
      $('#detTags').innerHTML = tags.length
        ? tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')
        : '<span style="color:#9aa3b2;font-size:13px">Sin etiquetas</span>';

      // información
      const fmtDate = (d) => { if (!d) return '—'; try { return new Date(d).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' }); } catch (_) { return '—'; } };
      const fields = [
        ['Teléfono', phone || '—'],
        ['Email', email || '—'],
        ['Empresa', (g && g.companyName) || dbc.company || '—'],
        ['Origen', (g && g.source) || dbc.source || '—']
      ];
      if (g) {
        if (g.type) fields.push(['Tipo', g.type]);
        if (g.country) fields.push(['País', g.country]);
        if (g.timezone) fields.push(['Zona horaria', g.timezone]);
        fields.push(['Alta', fmtDate(g.dateAdded)]);
        fields.push(['DND', g.dnd ? 'Sí' : 'No']);
      } else if (dbc.owner) {
        fields.push(['Propietario', dbc.owner]);
      }
      $('#detFields').innerHTML = fields.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');

      // oportunidades
      const oppsSec = $('#detOppsSection'), oppsBox = $('#detOpps');
      const opps = (entry && entry.opportunities) || [];
      if (oppsSec && oppsBox) {
        if (opps.length) {
          oppsSec.hidden = false;
          oppsBox.innerHTML = opps.map(o => {
            const st = (o.status || '').toLowerCase();
            let money = '';
            if (o.monetaryValue != null) { try { money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(o.monetaryValue); } catch (_) { money = '$' + o.monetaryValue; } }
            const path = [o.pipeline, o.stage].filter(Boolean).join(' ▸ ');
            return `<div class="opp">
              <div class="opp__top"><span class="opp__name">${esc(o.name || 'Oportunidad')}</span><span class="opp__status opp__status--${esc(st)}">${esc(o.status || '')}</span></div>
              ${path ? `<div class="opp__path">${esc(path)}</div>` : ''}
              ${money ? `<div class="opp__value">${esc(money)}</div>` : ''}
            </div>`;
          }).join('');
        } else { oppsSec.hidden = true; oppsBox.innerHTML = ''; }
      }

      // campos personalizados
      const cfSec = $('#detCustomSection'), cfBox = $('#detCustom');
      const cf = (g && g.customFields) || [];
      if (cfSec && cfBox) {
        if (cf.length) {
          cfSec.hidden = false;
          cfBox.innerHTML = cf.map(f => `<div><dt>${esc(f.name)}</dt><dd>${esc(f.value)}</dd></div>`).join('');
        } else { cfSec.hidden = true; cfBox.innerHTML = ''; }
      }

      // Camila OFF = handoff. Sale del flag que ya trae la conversación (instantáneo),
      // no de la respuesta de GHL: así el botón nunca contradice al aviso rojo.
      const ct = $('#convToggle'), ctl = $('#convToggleLabel');
      if (ct) {
        const closed = Store.isHandoff(conv);
        ct.classList.toggle('pill-toggle--off', closed);
        ct.classList.toggle('pill-toggle--on', !closed);
        if (ctl) ctl.textContent = closed ? 'CAMILA OFF' : 'CAMILA ON';
      }
    },

    // ---------- plantillas de Meta ----------
    // Pinta {{1}} resaltado para que se vea dónde van las variables.
    tplHtml(text, vals) {
      return esc(String(text || '')).replace(/\{\{\s*(\d+)\s*\}\}/g, (m, n) => {
        const v = vals && vals[Number(n) - 1];
        return v ? `<b class="tpl__fill">${esc(v)}</b>` : `<span class="tpl__var">{{${n}}}</span>`;
      });
    },

    renderTemplates() {
      const box = $('#templateList');
      const form = $('#templateForm');
      if (form) form.hidden = true;
      box.hidden = false;
      $('#tplTitle').textContent = 'Plantillas de Meta';

      if (Store.templatesError) {
        box.innerHTML = `<p class="tpl__empty">No se pudieron leer las plantillas: ${esc(Store.templatesError)}</p>`;
        return;
      }
      const list = Store.templates || [];
      if (!list.length) {
        box.innerHTML = '<p class="tpl__empty">No hay plantillas aprobadas en tu cuenta de WhatsApp.</p>';
        return;
      }
      box.innerHTML = '';
      list.forEach(t => {
        const nvars = (t.body && t.body.vars ? t.body.vars.length : 0) + (t.header && t.header.vars ? t.header.vars.length : 0);
        const node = el('div', 'tpl');
        node.innerHTML = `
          <div class="tpl__name">${esc(t.name)}
            <span class="tpl__cat">${esc(t.category || '')}</span>
            <span class="tpl__lang">${esc(t.language || '')}</span>
          </div>
          <div class="tpl__body">${this.tplHtml(t.body && t.body.text)}</div>
          ${nvars ? `<div class="tpl__meta">${nvars} variable${nvars > 1 ? 's' : ''} por rellenar</div>` : ''}`;
        node.addEventListener('click', () => global.App.useTemplate(t));
        box.appendChild(node);
      });
    },

    // Formulario para rellenar las variables de una plantilla, con vista previa viva.
    renderTemplateForm(t) {
      const box = $('#templateList'), form = $('#templateForm');
      box.hidden = true; form.hidden = false;
      $('#tplTitle').textContent = t.name;

      const campo = (id, label, ph) =>
        `<label class="tpl__field"><span>${esc(label)}</span><input id="${id}" type="text" placeholder="${esc(ph || '')}" /></label>`;

      let campos = '';
      if (t.header && t.header.format === 'TEXT') {
        (t.header.vars || []).forEach(n => { campos += campo('tplH' + n, `Encabezado · variable {{${n}}}`); });
      } else if (t.header && t.header.format !== 'TEXT') {
        campos += campo('tplMedia', `Encabezado · URL del ${t.header.format.toLowerCase()}`, 'https://…');
      }
      (t.body.vars || []).forEach(n => { campos += campo('tplB' + n, `Variable {{${n}}}`); });
      (t.buttons || []).forEach(b => {
        (b.vars || []).forEach(n => { campos += campo('tplBt' + b.index, `Botón "${b.text}" · variable {{${n}}}`); });
      });

      form.innerHTML = `
        <button class="tpl__back" id="tplBack">← Volver a la lista</button>
        <div class="tpl__card">
          ${t.header && t.header.format === 'TEXT' && t.header.text ? `<div class="tpl__head-txt" id="tplPrevH">${this.tplHtml(t.header.text)}</div>` : ''}
          ${t.header && t.header.format !== 'TEXT' ? `<div class="tpl__media">📎 ${esc(t.header.format)}</div>` : ''}
          <div class="tpl__prev" id="tplPrev">${this.tplHtml(t.body.text)}</div>
          ${t.footer ? `<div class="tpl__foot">${esc(t.footer)}</div>` : ''}
          ${(t.buttons || []).length ? `<div class="tpl__btns">${t.buttons.map(b => `<span>${esc(b.text)}</span>`).join('')}</div>` : ''}
        </div>
        ${campos || '<p class="tpl__meta">Esta plantilla no tiene variables.</p>'}
        <button class="tpl__send" id="tplSend">Enviar plantilla</button>`;

      // vista previa viva
      const repinta = () => {
        const vals = (t.body.vars || []).map(n => (document.getElementById('tplB' + n) || {}).value || '');
        // los índices de las variables no tienen por qué ser 1..n consecutivos
        const arr = [];
        (t.body.vars || []).forEach((n, i) => { arr[n - 1] = vals[i]; });
        $('#tplPrev').innerHTML = this.tplHtml(t.body.text, arr);
        if (t.header && t.header.format === 'TEXT' && $('#tplPrevH')) {
          const h = [];
          (t.header.vars || []).forEach(n => { h[n - 1] = (document.getElementById('tplH' + n) || {}).value || ''; });
          $('#tplPrevH').innerHTML = this.tplHtml(t.header.text, h);
        }
      };
      form.querySelectorAll('input').forEach(i => i.addEventListener('input', repinta));
      $('#tplBack').addEventListener('click', () => this.renderTemplates());
      $('#tplSend').addEventListener('click', () => global.App.sendTemplate(t));

      // atajo: la primera variable del cuerpo suele ser el nombre del contacto
      const conv = Store.activeConversation();
      const first = t.body.vars && t.body.vars[0];
      const inp = first && document.getElementById('tplB' + first);
      if (inp && conv && conv.name) { inp.value = String(conv.name).split(' ')[0]; repinta(); }
    },

    toast(msg) {
      const t = $('#toast');
      t.textContent = msg;
      t.hidden = false;
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
    },

    // ---------- barra de grabación de voz ----------
    showRecording(on) {
      const bar = $('#recBar'), row = document.querySelector('.composer__row');
      if (bar) bar.hidden = !on;
      if (row) row.style.display = on ? 'none' : '';
      if (on) this.updateRecTime(0);
    },
    updateRecTime(ms) {
      const el = $('#recTime');
      if (!el) return;
      const s = Math.floor(ms / 1000);
      el.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    },

    scrollMessages() {
      const box = $('#messages');
      box.scrollTop = box.scrollHeight;
    }
  };

  global.UI = UI;
})(window);
