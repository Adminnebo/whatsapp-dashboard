/* =========================================================
   tickets.js — Sección de tickets (soporte / incidencias).
   El usuario rellena un formulario y se envía por POST al endpoint
   configurado. El endpoint es externo (n8n u otro) y se define en
   config.js (ticketsUrl) o desde Ajustes.
   ========================================================= */
(function (global) {
  'use strict';
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // El ticket va al backend propio (/api/tickets), que lo reenvía al gestor de
  // tareas con la API key. La key NUNCA está en el navegador.
  const ENDPOINT = '/api/tickets';

  const PRIORIDADES = [
    { v: 'baja', t: 'Baja' },
    { v: 'media', t: 'Media' },
    { v: 'alta', t: 'Alta' },
    { v: 'urgente', t: 'Urgente' }
  ];
  const CATEGORIAS = ['Error / falla', 'Solicitud', 'Duda', 'Facturación', 'Otro'];

  const MAX_ARCHIVOS = 5;
  const MAX_BYTES = 10 * 1024 * 1024;
  const peso = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  const iconoDe = m => /^image\//.test(m || '') ? '🖼️' : /pdf/.test(m || '') ? '📕' : /^video\//.test(m || '') ? '🎬' : /^audio\//.test(m || '') ? '🎵' : '📎';

  const Tickets = {
    adjuntos: [],   // archivos elegidos para el ticket que se está redactando

    async quien() {
      // datos del usuario logueado (para adjuntarlos al ticket)
      try {
        if (global.Auth && Auth.currentToken && typeof Auth.me === 'function') {
          const me = await Auth.me();
          if (me) return { email: me.email || null, name: (me.profile && me.profile.full_name) || null, role: me.role || (me.profile && me.profile.role) || null };
        }
      } catch (_) {}
      return { email: null, name: null, role: null };
    },

    abrir() {
      $('#ticketsModal').hidden = false;
      this.verNuevo();
    },
    cerrar() { $('#ticketsModal').hidden = true; },

    verNuevo() {
      document.querySelectorAll('.tk__tab').forEach(t => t.classList.toggle('tk__tab--on', t.dataset.tkview === 'nuevo'));
      $('#ticketList').hidden = true;
      $('#ticketOk').hidden = true;
      $('#ticketForm').hidden = false;
      this.adjuntos = [];              // formulario limpio: también los adjuntos
      this.pintarForm();
    },

    async verLista() {
      document.querySelectorAll('.tk__tab').forEach(t => t.classList.toggle('tk__tab--on', t.dataset.tkview === 'lista'));
      $('#ticketForm').hidden = true;
      $('#ticketOk').hidden = true;
      const box = $('#ticketList');
      box.hidden = false;
      box.innerHTML = '<p class="tk__cargando">Cargando…</p>';
      try {
        const h = {}; if (global.Auth && Auth.currentToken) h['Authorization'] = 'Bearer ' + Auth.currentToken;
        const d = await (await fetch('/api/tickets', { headers: h })).json();
        this.pintarLista(d.tickets || [], d.admin);
      } catch (e) {
        box.innerHTML = `<p class="tk__err">No se pudieron cargar: ${esc(e.message)}</p>`;
      }
    },

    pintarLista(tickets, admin) {
      const box = $('#ticketList');
      if (!tickets.length) { box.innerHTML = '<p class="tk__vacio">No hay tickets todavía.</p>'; return; }
      const EST = { nuevo: ['Nuevo', 'nuevo'], en_progreso: ['En progreso', 'prog'], completado: ['✓ Completado', 'ok'] };
      const PRI = { baja: 'Baja', media: 'Media', alta: 'Alta', urgente: 'Urgente' };
      const fecha = ms => ms ? new Date(ms).toLocaleDateString('es-DO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
      box.innerHTML = tickets.map(t => {
        const [et, cls] = EST[t.status] || ['—', 'nuevo'];
        const adj = (t.files || []).map(f =>
          `<a class="tkitem__adj" href="${esc(f.url)}" target="_blank" rel="noopener" title="${esc(f.name)}">${iconoDe(f.mime)} ${esc(f.name)}</a>`).join('');
        return `<div class="tkitem tkitem--${cls}">
          <div class="tkitem__top">
            <span class="tkitem__title">${esc(t.title)}</span>
            <span class="tkitem__est tkitem__est--${cls}">${et}</span>
          </div>
          <div class="tkitem__meta">${esc(PRI[t.priority] || t.priority || '')}${t.category ? ' · ' + esc(t.category) : ''} · ${fecha(t.createdAt)}${admin && t.userEmail ? ' · ' + esc(t.userEmail) : ''}</div>
          ${adj ? `<div class="tkitem__adjs">${adj}</div>` : ''}
        </div>`;
      }).join('');
    },

    pintarForm() {
      const box = $('#ticketForm');
      box.innerHTML = `
        <label class="tk__lbl">Asunto
          <input id="tkAsunto" class="tk__inp" maxlength="120" placeholder="Resumen breve del problema" />
        </label>
        <div class="tk__row">
          <label class="tk__lbl">Prioridad
            <select id="tkPrioridad" class="tk__inp">
              ${PRIORIDADES.map(p => `<option value="${p.v}" ${p.v === 'media' ? 'selected' : ''}>${p.t}</option>`).join('')}
            </select>
          </label>
          <label class="tk__lbl">Categoría
            <select id="tkCategoria" class="tk__inp">
              ${CATEGORIAS.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
            </select>
          </label>
        </div>
        <label class="tk__lbl">Descripción
          <textarea id="tkDesc" class="tk__inp tk__area" rows="5" placeholder="Cuéntanos qué pasó, con el mayor detalle posible…"></textarea>
        </label>
        <div class="tk__lbl">Adjuntos <span class="tk__hint">— capturas, PDF… máx. ${MAX_ARCHIVOS} archivos de 10 MB</span>
          <input type="file" id="tkFiles" multiple hidden
                 accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.zip" />
          <button type="button" class="tk__adj" id="tkAdjBtn">📎 Añadir archivos</button>
          <div class="tk__chips" id="tkChips"></div>
        </div>
        <p class="tk__err" id="tkErr" hidden></p>
        <button class="tk__enviar" id="tkEnviar">Enviar ticket</button>`;

      $('#tkEnviar').addEventListener('click', () => this.enviar());
      $('#tkAdjBtn').addEventListener('click', () => $('#tkFiles').click());
      $('#tkFiles').addEventListener('change', e => this.añadir(e.target.files));
      $('#tkChips').addEventListener('click', e => {
        const b = e.target.closest('[data-quitar]');
        if (b) { this.adjuntos.splice(Number(b.dataset.quitar), 1); this.pintarChips(); }
      });
      // Arrastrar y soltar sobre la descripción: es lo natural para una captura.
      const area = $('#tkDesc');
      area.addEventListener('dragover', e => { e.preventDefault(); area.classList.add('tk__area--drop'); });
      area.addEventListener('dragleave', () => area.classList.remove('tk__area--drop'));
      area.addEventListener('drop', e => {
        e.preventDefault(); area.classList.remove('tk__area--drop');
        this.añadir(e.dataTransfer.files);
      });
      // Pegar una captura del portapapeles (Win+Shift+S → Ctrl+V).
      area.addEventListener('paste', e => {
        const imgs = [...(e.clipboardData ? e.clipboardData.files : [])].filter(f => f.type.startsWith('image/'));
        if (imgs.length) { e.preventDefault(); this.añadir(imgs); }
      });
      this.pintarChips();
    },

    añadir(lista) {
      const err = $('#tkErr');
      const nuevos = [...(lista || [])];
      let aviso = '';
      for (const f of nuevos) {
        if (this.adjuntos.length >= MAX_ARCHIVOS) { aviso = 'Máximo ' + MAX_ARCHIVOS + ' archivos.'; break; }
        if (f.size > MAX_BYTES) { aviso = `"${f.name}" pesa ${peso(f.size)}: el máximo es 10 MB.`; continue; }
        if (this.adjuntos.some(a => a.name === f.name && a.size === f.size)) continue;   // mismo archivo dos veces
        this.adjuntos.push(f);
      }
      if (err) { err.textContent = aviso; err.hidden = !aviso; }
      $('#tkFiles').value = '';
      this.pintarChips();
    },

    pintarChips() {
      const box = $('#tkChips');
      if (!box) return;
      box.innerHTML = this.adjuntos.map((f, i) =>
        `<span class="tk__chip">${iconoDe(f.type)} <span class="tk__chip-n">${esc(f.name)}</span>
          <span class="tk__chip-p">${peso(f.size)}</span>
          <button type="button" class="tk__chip-x" data-quitar="${i}" title="Quitar">×</button></span>`).join('');
    },

    async enviar() {
      const asunto = $('#tkAsunto').value.trim();
      const desc = $('#tkDesc').value.trim();
      const err = $('#tkErr');
      err.hidden = true;
      if (!asunto || !desc) { err.textContent = 'El asunto y la descripción son obligatorios.'; err.hidden = false; return; }

      const btn = $('#tkEnviar');
      btn.disabled = true; btn.textContent = 'Enviando…';

      const usuario = await this.quien();
      const campos = {
        asunto,
        descripcion: desc,
        prioridad: $('#tkPrioridad').value,
        categoria: $('#tkCategoria').value,
        origen: 'web',
        app: 'inbox',
        usuario
      };

      try {
        const h = {};
        if (global.Auth && Auth.currentToken) h['Authorization'] = 'Bearer ' + Auth.currentToken;
        // Con adjuntos va como multipart; sin ellos, JSON de siempre.
        let body;
        if (this.adjuntos.length) {
          body = new FormData();
          Object.entries(campos).forEach(([k, v]) => body.append(k, typeof v === 'object' ? JSON.stringify(v) : v));
          this.adjuntos.forEach(f => body.append('archivos', f, f.name));
          // OJO: nada de Content-Type a mano — el navegador pone el boundary.
        } else {
          h['Content-Type'] = 'application/json';
          body = JSON.stringify(campos);
        }
        const r = await fetch(ENDPOINT, { method: 'POST', headers: h, body });
        const data = await r.json().catch(() => null);
        if (!r.ok) throw new Error((data && data.error) || 'Error ' + r.status);
        this.adjuntos = [];
        $('#ticketForm').hidden = true;
        $('#ticketOk').hidden = false;
      } catch (e) {
        err.textContent = 'No se pudo enviar: ' + e.message;
        err.hidden = false;
      } finally {
        btn.disabled = false; btn.textContent = 'Enviar ticket';
      }
    },

    init() {
      const btn = $('#btnTickets');
      if (btn) btn.addEventListener('click', () => this.abrir());
      const modal = $('#ticketsModal');
      if (!modal) return;
      modal.addEventListener('click', e => {
        if (e.target.hasAttribute('data-close')) return this.cerrar();
        if (e.target.dataset.tkview === 'nuevo') return this.verNuevo();
        if (e.target.dataset.tkview === 'lista') return this.verLista();
        if (e.target.id === 'tkOtro') return this.verNuevo();
      });
    }
  };

  global.Tickets = Tickets;
})(window);
