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

  const Tickets = {
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
      $('#ticketOk').hidden = true;
      $('#ticketForm').hidden = false;
      this.pintarForm();
    },
    cerrar() { $('#ticketsModal').hidden = true; },

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
        <p class="tk__err" id="tkErr" hidden></p>
        <button class="tk__enviar" id="tkEnviar">Enviar ticket</button>`;

      $('#tkEnviar').addEventListener('click', () => this.enviar());
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
      const payload = {
        asunto,
        descripcion: desc,
        prioridad: $('#tkPrioridad').value,
        categoria: $('#tkCategoria').value,
        origen: 'web',
        app: 'inbox',
        usuario
      };

      try {
        const h = { 'Content-Type': 'application/json' };
        if (global.Auth && Auth.currentToken) h['Authorization'] = 'Bearer ' + Auth.currentToken;
        const r = await fetch(ENDPOINT, { method: 'POST', headers: h, body: JSON.stringify(payload) });
        const data = await r.json().catch(() => null);
        if (!r.ok) throw new Error((data && data.error) || 'Error ' + r.status);
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
        if (e.target.id === 'tkOtro') { $('#ticketOk').hidden = true; $('#ticketForm').hidden = false; this.pintarForm(); }
      });
    }
  };

  global.Tickets = Tickets;
})(window);
