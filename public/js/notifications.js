/* =========================================================
   notifications.js — Centro de notificaciones de la app.

   Origen de las notificaciones (las genera el servidor):
     · handoff   -> a alguien le pusieron la etiqueta handoff en GHL
     · no_reply  -> un entrante lleva más de N minutos sin respuesta
     · inbound   -> entró un mensaje y nadie automático va a contestar
                    (contacto en handoff o bot apagado)

   Estado de leído: por usuario, en el servidor (tabla notification_reads),
   así que se respeta aunque cambies de navegador.
   ========================================================= */
(function (global) {
  'use strict';

  const $ = s => document.querySelector(s);
  const POLL_MS = 20000;
  const ICON = { handoff: '🚨', no_reply: '⏰', inbound: '💬' };

  function headers() {
    const h = { 'Content-Type': 'application/json' };
    const s = (global.Store && Store.settings) || {};
    if (s.token) h['x-dashboard-token'] = s.token;
    if (global.Auth && global.Auth.currentToken) h['Authorization'] = 'Bearer ' + global.Auth.currentToken;
    return h;
  }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function rel(ts) {
    const m = Math.floor((Date.now() - ts) / 60000);
    if (m < 1) return 'ahora';
    if (m < 60) return 'hace ' + m + ' min';
    const h = Math.floor(m / 60);
    if (h < 24) return 'hace ' + h + ' h';
    return 'hace ' + Math.floor(h / 24) + ' d';
  }

  // Pitido corto con WebAudio (sin depender de ningún archivo de sonido).
  function beep() {
    try {
      const Ctx = global.AudioContext || global.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(); osc.stop(ctx.currentTime + 0.36);
      osc.onended = () => ctx.close();
    } catch (_) {}
  }

  const Notifs = {
    items: [],
    unread: 0,
    open: false,
    _known: null,      // ids ya vistos por esta pestaña (para no repetir avisos)
    _timer: null,

    async init() {
      if (!$('#notifBtn')) return;
      $('#notifBtn').addEventListener('click', e => { e.stopPropagation(); this.toggle(); });
      $('#notifReadAll').addEventListener('click', e => { e.stopPropagation(); this.readAll(); });
      $('#notifPerm').addEventListener('click', e => { e.stopPropagation(); this.askPermission(); });
      document.addEventListener('click', e => { if (this.open && !e.target.closest('#notifWrap')) this.close(); });
      document.addEventListener('keydown', e => { if (e.key === 'Escape' && this.open) this.close(); });
      global.addEventListener('resize', () => { if (this.open) this.place(); });
      this.renderFoot();
      await this.load();
      this._timer = setInterval(() => this.load(), POLL_MS);
    },

    async load() {
      try {
        const res = await fetch('/api/notifications?limit=40', { headers: headers() });
        if (!res.ok) return;
        const d = await res.json();
        this.items = d.items || [];
        this.unread = d.unread || 0;

        // Avisa (sonido + notificación del navegador) solo de lo NUEVO sin leer.
        const nuevos = this.items.filter(n => !n.read && this._known && !this._known.has(n.id));
        if (nuevos.length) {
          beep();
          nuevos.slice(0, 3).forEach(n => this.desktop(n));
        }
        this._known = new Set(this.items.map(n => n.id));   // 1ª pasada: solo memoriza

        this.renderBadge();
        if (this.open) this.renderList();
      } catch (_) {}
    },

    desktop(n) {
      try {
        if (!('Notification' in global) || Notification.permission !== 'granted') return;
        const nt = new Notification(n.title, { body: n.body || '', tag: 'wa-' + n.id });
        nt.onclick = () => { global.focus(); this.openItem(n); nt.close(); };
      } catch (_) {}
    },

    async askPermission() {
      try { await Notification.requestPermission(); } catch (_) {}
      this.renderFoot();
    },

    renderFoot() {
      const foot = $('#notifFoot');
      if (!foot) return;
      const puede = ('Notification' in global) && Notification.permission === 'default';
      foot.hidden = !puede;
    },

    renderBadge() {
      const c = $('#notifCount'), btn = $('#notifBtn');
      if (!c || !btn) return;
      c.textContent = this.unread > 99 ? '99+' : String(this.unread);
      c.hidden = this.unread === 0;
      btn.classList.toggle('notif__btn--has', this.unread > 0);
    },

    renderList() {
      const box = $('#notifList');
      if (!box) return;
      if (!this.items.length) {
        box.innerHTML = '<div class="notif__empty">Sin notificaciones</div>';
        return;
      }
      box.innerHTML = this.items.map(n => `
        <div class="notif__item ${n.read ? '' : 'notif__item--unread'} notif__item--${esc(n.type)}" data-id="${esc(n.id)}">
          <span class="notif__icon">${ICON[n.type] || '🔔'}</span>
          <div class="notif__body">
            <div class="notif__title">${esc(n.title)}</div>
            ${n.body ? `<div class="notif__text">${esc(n.body)}</div>` : ''}
            <div class="notif__time">${rel(n.createdAt)}</div>
          </div>
        </div>`).join('');
      box.querySelectorAll('.notif__item').forEach(el => {
        el.addEventListener('click', () => {
          const n = this.items.find(x => x.id === el.dataset.id);
          if (n) this.openItem(n);
        });
      });
    },

    // Abre la conversación de la notificación y la marca leída.
    openItem(n) {
      this.markRead([n.id]);
      this.close();
      if (n.conversationId && global.App && global.App.openConversation) {
        global.App.openConversation(String(n.conversationId));
      }
    },

    async markRead(ids) {
      const nuevos = ids.filter(id => { const n = this.items.find(x => x.id === id); return n && !n.read; });
      if (!nuevos.length) return;
      nuevos.forEach(id => { const n = this.items.find(x => x.id === id); if (n) n.read = true; });
      this.unread = this.items.filter(n => !n.read).length;
      this.renderBadge(); this.renderList();
      try { await fetch('/api/notifications/read', { method: 'POST', headers: headers(), body: JSON.stringify({ ids: nuevos.map(Number) }) }); } catch (_) {}
    },

    async readAll() {
      this.items.forEach(n => { n.read = true; });
      this.unread = 0;
      this.renderBadge(); this.renderList();
      try { await fetch('/api/notifications/read', { method: 'POST', headers: headers(), body: JSON.stringify({ all: true }) }); } catch (_) {}
    },

    // El panel va en position:fixed, así que lo colocamos a mano bajo la campana.
    // Preferimos alinearlo por la derecha; si no cabe, por la izquierda; y siempre
    // dentro de la pantalla (con la lista en overflow:hidden, si no se recortaría).
    place() {
      const btn = $('#notifBtn'), panel = $('#notifPanel');
      if (!btn || !panel) return;
      const r = btn.getBoundingClientRect();
      const w = panel.offsetWidth || 340;
      const M = 10;                                   // margen mínimo con el borde
      let left = r.right - w;                         // alineado a la derecha del botón
      if (left < M) left = r.left;                    // no cabe: lo abrimos hacia la derecha
      left = Math.max(M, Math.min(left, window.innerWidth - w - M));
      panel.style.left = Math.round(left) + 'px';
      panel.style.top = Math.round(r.bottom + 8) + 'px';
    },

    toggle() { this.open ? this.close() : this.show(); },
    show() {
      this.open = true;
      const panel = $('#notifPanel');
      panel.hidden = false;
      this.renderList();
      this.renderFoot();
      this.place();
      this.load();
    },
    close() { this.open = false; $('#notifPanel').hidden = true; }
  };

  global.Notifs = Notifs;
})(window);
