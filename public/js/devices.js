/* =========================================================
   devices.js — Dispositivos de WhatsApp conectados por QR.

   El dispositivo "principal" es Camila por la Cloud API oficial y NO se toca:
   se representa con deviceId = null y es lo que se ve al entrar.
   Cada dispositivo extra tiene sus propias conversaciones (device_id en la BD).
   ========================================================= */
(function (global) {
  'use strict';
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // URL del servicio de dispositivos (se puede sobreescribir desde Ajustes).
  function base() {
    try { const g = localStorage.getItem('nebo_devices_url'); if (g) return g.replace(/\/+$/, ''); } catch (_) {}
    return (global.WA_CONFIG && WA_CONFIG.devicesUrl) || '';
  }

  function headers() {
    const h = { 'Content-Type': 'application/json' };
    if (global.Auth && Auth.currentToken) h['Authorization'] = 'Bearer ' + Auth.currentToken;
    return h;
  }

  async function api(ruta, opts) {
    if (!base()) throw new Error('Falta configurar la URL del servicio de dispositivos');
    const r = await fetch(base() + ruta, opts || { headers: headers() });
    const t = await r.text();
    const j = t ? JSON.parse(t) : null;
    if (!r.ok) throw new Error((j && j.error) || 'HTTP ' + r.status);
    return j;
  }

  const ESTADOS = {
    conectado:    ['Conectado', 'ok'],
    qr:           ['Escanea el QR', 'medio'],
    conectando:   ['Conectando…', 'medio'],
    desconectado: ['Desconectado', 'mal'],
    desvinculado: ['Desvinculado', 'mal'],
    nuevo:        ['Sin emparejar', 'medio']
  };

  let lista = [], sondeo = null;

  const Devices = {
    // null = principal (Camila). Un id = ese dispositivo QR.
    actual: null,

    async cargar() {
      try {
        const d = await api('/api/devices');
        lista = d.devices || [];
      } catch (e) {
        lista = [];
        this.error = e.message;
      }
      this.pintar();
      return lista;
    },

    nombreActual() {
      if (!this.actual) return 'Principal · Camila';
      const d = lista.find(x => x.id === this.actual);
      return d ? d.name : 'Dispositivo';
    },

    pintar() {
      const box = $('#devList');
      if (!box) return;
      const fila = (id, nombre, sub, estado, acciones) => {
        const [txt, tono] = ESTADOS[estado] || ['—', 'medio'];
        const activo = (id || null) === this.actual;
        return `<div class="dev ${activo ? 'dev--activo' : ''}" data-dev="${esc(id || '')}">
          <div class="dev__main">
            <div class="dev__nombre">${esc(nombre)}${activo ? ' <span class="dev__aqui">viendo</span>' : ''}</div>
            <div class="dev__sub">${esc(sub)}</div>
          </div>
          <span class="dev__estado dev__estado--${tono}">${txt}</span>
          ${acciones || ''}
        </div>`;
      };

      let html = fila(null, 'Principal · Camila', 'API oficial de WhatsApp (Meta)', 'conectado', '');

      if (this.error) {
        html += `<p class="dev__err">${esc(this.error)}
          <button class="dev__cfg" id="devCfg">Configurar servidor</button></p>`;
      } else if (!lista.length) {
        html += '<p class="dev__vacio">No hay dispositivos adicionales.</p>';
      } else {
        html += lista.map(d => fila(
          d.id, d.name,
          d.phone ? '+' + d.phone : (d.emparejado ? 'emparejado' : 'sin emparejar'),
          d.status,
          `<div class="dev__acc">
             ${d.status !== 'conectado' ? `<button class="dev__btn" data-qr="${esc(d.id)}">QR</button>` : ''}
             <button class="dev__btn dev__btn--x" data-del="${esc(d.id)}">✕</button>
           </div>`
        )).join('');
      }
      box.innerHTML = html;
    },

    abrir() {
      $('#devicesModal').hidden = false;
      this.cargar();
      // mientras el panel está abierto, refresca para ver cambios de estado
      clearInterval(sondeo);
      sondeo = setInterval(() => { if (!$('#devicesModal').hidden) this.cargar(); else clearInterval(sondeo); }, 4000);
    },
    cerrar() { $('#devicesModal').hidden = true; clearInterval(sondeo); $('#qrBox').hidden = true; },

    // Cambia de "sesión": recarga las conversaciones de ese dispositivo.
    async cambiarA(id) {
      this.actual = id || null;
      this.pintar();
      this.cerrar();
      UI.renderDeviceBadge(this.nombreActual(), this.actual);
      Store.activeId = null;
      Store.conversations = [];
      Store.messagesByConv = {};
      UI.renderList(); UI.renderThread();
      await global.App.refreshData();
      UI.toast('Viendo: ' + this.nombreActual());
    },

    async crear() {
      const name = prompt('Nombre del dispositivo (por ejemplo: Ventas Juan)');
      if (!name || !name.trim()) return;
      try {
        const d = await api('/api/devices', { method: 'POST', headers: headers(), body: JSON.stringify({ name: name.trim() }) });
        await this.cargar();
        this.mostrarQr(d.device.id);
      } catch (e) { UI.toast('No se pudo crear: ' + e.message); }
    },

    // Muestra el QR y espera a que el teléfono lo escanee.
    async mostrarQr(id) {
      const caja = $('#qrBox'), img = $('#qrImg'), txt = $('#qrTexto');
      caja.hidden = false;
      img.removeAttribute('src');
      txt.textContent = 'Generando código…';

      clearInterval(this._qrTimer);
      const tick = async () => {
        try {
          const d = await api('/api/devices/' + encodeURIComponent(id));
          if (d.device.status === 'conectado') {
            clearInterval(this._qrTimer);
            img.removeAttribute('src');
            txt.innerHTML = '<b>¡Conectado!</b> Ya puedes usar este dispositivo.';
            this.cargar();
            setTimeout(() => { caja.hidden = true; }, 2500);
            return;
          }
          if (d.qr) {
            img.src = d.qr;
            txt.innerHTML = 'Abre <b>WhatsApp</b> en el teléfono → <b>Dispositivos vinculados</b> → <b>Vincular dispositivo</b> y escanea este código.';
          }
        } catch (e) {
          clearInterval(this._qrTimer);
          txt.textContent = 'Error: ' + e.message;
        }
      };
      await tick();
      this._qrTimer = setInterval(tick, 3000);
    },

    async borrar(id) {
      const d = lista.find(x => x.id === id);
      if (!confirm(`¿Quitar el dispositivo "${d ? d.name : id}"?\nSe cerrará su sesión de WhatsApp.`)) return;
      try {
        await api('/api/devices/' + encodeURIComponent(id), { method: 'DELETE', headers: headers() });
        if (this.actual === id) await this.cambiarA(null);
        this.cargar();
      } catch (e) { UI.toast('No se pudo quitar: ' + e.message); }
    },

    // Envío: el principal usa /api/send del inbox; un dispositivo QR, su servicio.
    async enviar(conv, texto) {
      if (!this.actual) return null;      // null → que lo maneje el flujo normal
      return await api('/api/devices/' + encodeURIComponent(this.actual) + '/send', {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ to: (conv.phone || '').replace(/[^\d]/g, ''), text: texto })
      });
    },

    init() {
      const btn = $('#btnDevices');
      if (btn) btn.addEventListener('click', () => this.abrir());
      const modal = $('#devicesModal');
      if (!modal) return;
      modal.addEventListener('click', e => {
        if (e.target.hasAttribute('data-close')) return this.cerrar();
        if (e.target.id === 'devCfg') {
          const u = prompt('URL del servicio de dispositivos', base());
          if (u) { try { localStorage.setItem('nebo_devices_url', u.replace(/\/+$/, '')); } catch (_) {} this.error = null; this.cargar(); }
          return;
        }
        if (e.target.id === 'devNuevo') return this.crear();
        const qr = e.target.closest('[data-qr]');
        if (qr) return this.mostrarQr(qr.dataset.qr);
        const del = e.target.closest('[data-del]');
        if (del) return this.borrar(del.dataset.del);
        const row = e.target.closest('[data-dev]');
        if (row) return this.cambiarA(row.dataset.dev || null);
      });
    }
  };

  global.Devices = Devices;
})(window);
