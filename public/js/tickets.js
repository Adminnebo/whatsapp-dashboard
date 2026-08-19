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
  const CATEGORIAS = ['Error / falla', 'Solicitud', 'Nuevo desarrollo', 'Duda', 'Facturación', 'Otro'];

  const MAX_ARCHIVOS = 5;
  const MAX_BYTES = 10 * 1024 * 1024;
  const peso = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  const iconoDe = m => /^image\//.test(m || '') ? '🖼️' : /pdf/.test(m || '') ? '📕' : /^video\//.test(m || '') ? '🎬' : /^audio\//.test(m || '') ? '🎵' : '📎';
  const esImagen = m => /^image\//.test(m || '');

  // Estado (etiqueta + clase), prioridad (etiqueta) y fechas — compartidos por lista y detalle.
  const EST = { nuevo: ['Nuevo', 'nuevo'], en_progreso: ['En progreso', 'prog'], completado: ['✓ Completado', 'ok'] };
  const PRI = { baja: 'Baja', media: 'Media', alta: 'Alta', urgente: 'Urgente' };
  const FILTROS = [['todos', 'Todos'], ['nuevo', 'Nuevos'], ['en_progreso', 'En progreso'], ['completado', 'Completados']];
  const fechaCorta = ms => ms ? new Date(ms).toLocaleDateString('es-DO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  const fechaLarga = ms => ms ? new Date(ms).toLocaleString('es-DO', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

  const Tickets = {
    adjuntos: [],       // archivos elegidos para el ticket que se está redactando
    _tickets: [],       // últimos tickets cargados
    _admin: false,
    _scope: 'mios',     // 'mios' | 'todos' (solo admin puede ver todos)
    _filtro: 'todos',   // filtro de estado
    _prio: 'todas',     // filtro de prioridad
    _cat: 'todas',      // filtro de categoría
    _dias: 'todo',      // filtro de fecha
    _orden: 'recientes',// orden
    _busca: '',         // texto de búsqueda

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
        // Por defecto el backend devuelve solo los míos; un admin puede pedir todos.
        const url = '/api/tickets' + (this._scope === 'todos' ? '?scope=all' : '');
        const d = await (await fetch(url, { headers: h })).json();
        this._tickets = d.tickets || [];
        this._admin = !!d.admin;
        this._super = !!d.super;
        this.pintarLista();
      } catch (e) {
        box.innerHTML = `<p class="tk__err">No se pudieron cargar: ${esc(e.message)}</p>`;
      }
    },

    // Barra (toggle admin + filtros de estado + buscador + selects) y filas.
    pintarLista() {
      const box = $('#ticketList');
      const cont = { todos: this._tickets.length, nuevo: 0, en_progreso: 0, completado: 0 };
      this._tickets.forEach(t => { if (cont[t.status] != null) cont[t.status]++; });
      const chips = FILTROS.map(([k, lbl]) =>
        `<button class="tkfil ${this._filtro === k ? 'tkfil--on' : ''}" data-tkfiltro="${k}">${lbl}<span class="tkfil__n">${cont[k]}</span></button>`).join('');
      // Interruptor Míos / Todos, solo para admin/super_admin.
      const scope = this._admin ? `
        <div class="tkscope">
          <button class="tkscope__b ${this._scope === 'mios' ? 'tkscope__b--on' : ''}" data-tkscope="mios">Míos</button>
          <button class="tkscope__b ${this._scope === 'todos' ? 'tkscope__b--on' : ''}" data-tkscope="todos">Todos</button>
        </div>` : '';
      const opt = (v, l, sel) => `<option value="${esc(v)}" ${sel === v ? 'selected' : ''}>${esc(l)}</option>`;
      const selPrio = `<select id="tkPrio" class="tksel">${opt('todas', 'Prioridad: todas', this._prio)}${PRIORIDADES.map(p => opt(p.v, p.t, this._prio)).join('')}</select>`;
      const selCat = `<select id="tkCat" class="tksel">${opt('todas', 'Categoría: todas', this._cat)}${CATEGORIAS.map(c => opt(c, c, this._cat)).join('')}</select>`;
      const selDias = `<select id="tkDias" class="tksel">${[['todo', 'Fecha: todo'], ['hoy', 'Hoy'], ['7', 'Últimos 7 días'], ['30', 'Últimos 30 días']].map(([v, l]) => opt(v, l, this._dias)).join('')}</select>`;
      const selOrden = `<select id="tkOrden" class="tksel">${[['recientes', 'Orden: recientes'], ['antiguos', 'Orden: antiguos'], ['prioridad', 'Orden: prioridad']].map(([v, l]) => opt(v, l, this._orden)).join('')}</select>`;
      box.innerHTML = `
        <div class="tklist__bar">
          ${scope}
          <div class="tkfils">${chips}</div>
          <div class="tksearch">
            <svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/></svg>
            <input id="tkBuscar" class="tksearch__inp" type="text" placeholder="Buscar por asunto o descripción…" value="${esc(this._busca)}" />
          </div>
          <div class="tkfilters">${selPrio}${selCat}${selDias}${selOrden}</div>
        </div>
        <div class="tklist" id="tkItems"></div>`;
      this.pintarItems();
    },

    pintarItems() {
      const cont = $('#tkItems');
      if (!cont) return;
      const q = this._busca.trim().toLowerCase();
      const ahora = Date.now();
      const corte = this._dias === 'hoy' ? new Date().setHours(0, 0, 0, 0)
        : this._dias === '7' ? ahora - 7 * 864e5
        : this._dias === '30' ? ahora - 30 * 864e5 : 0;
      const ORD = { urgente: 0, alta: 1, media: 2, baja: 3 };
      let items = this._tickets.filter(t =>
        (this._filtro === 'todos' || t.status === this._filtro) &&
        (this._prio === 'todas' || (t.priority || 'media') === this._prio) &&
        (this._cat === 'todas' || t.category === this._cat) &&
        (!corte || (t.createdAt || 0) >= corte));
      if (q) items = items.filter(t =>
        (t.title || '').toLowerCase().includes(q) ||
        (t.description || '').toLowerCase().includes(q) ||
        (t.userEmail || '').toLowerCase().includes(q));
      items = items.slice().sort((a, b) => {
        if (this._orden === 'antiguos') return (a.createdAt || 0) - (b.createdAt || 0);
        if (this._orden === 'prioridad') {
          const d = (ORD[a.priority] ?? 2) - (ORD[b.priority] ?? 2);
          return d || (b.createdAt || 0) - (a.createdAt || 0);
        }
        return (b.createdAt || 0) - (a.createdAt || 0);
      });
      if (!items.length) {
        cont.innerHTML = `<div class="tk__vacio">${this._tickets.length ? 'Ningún ticket coincide con el filtro.' : 'No hay tickets todavía.'}</div>`;
        return;
      }
      cont.innerHTML = items.map(t => {
        const [et, cls] = EST[t.status] || ['—', 'nuevo'];
        const pr = t.priority || 'media';
        const nAdj = (t.files || []).length;
        const nCom = (t.comments || []).length;
        return `<button class="tkrow" data-tkid="${esc(t.id)}">
          <span class="tkrow__pri tkrow__pri--${pr}" title="${PRI[pr] || pr}"></span>
          <span class="tkrow__main">
            <span class="tkrow__top">
              <span class="tkrow__title">${esc(t.title)}</span>
              <span class="tkitem__est tkitem__est--${cls}">${et}</span>
            </span>
            <span class="tkrow__meta">${esc(PRI[pr] || pr)}${t.category ? ' · ' + esc(t.category) : ''} · ${fechaCorta(t.createdAt)}${this._admin && t.userEmail ? ' · ' + esc(t.userEmail) : ''}${nAdj ? ' · 📎 ' + nAdj : ''}${nCom ? ' · 💬 ' + nCom : ''}</span>
          </span>
          <span class="tkrow__go">›</span>
        </button>`;
      }).join('');
    },

    aplicarFiltro(k) {
      this._filtro = k;
      document.querySelectorAll('.tkfil').forEach(c => c.classList.toggle('tkfil--on', c.dataset.tkfiltro === k));
      this.pintarItems();
    },

    // Cambiar la categoría de un ticket ya creado (solo super_admin; el backend
    // lo valida). Actualiza en memoria para no recargar todo.
    async cambiarCategoria(id, category) {
      const h = { 'Content-Type': 'application/json' };
      if (global.Auth && Auth.currentToken) h['Authorization'] = 'Bearer ' + Auth.currentToken;
      try {
        const r = await fetch('/api/tickets/' + encodeURIComponent(id), { method: 'PATCH', headers: h, body: JSON.stringify({ category }) });
        const d = await r.json().catch(() => null);
        if (!r.ok || !d || d.error) throw new Error((d && d.error) || 'Error ' + r.status);
        const t = this._tickets.find(x => String(x.id) === String(id));
        if (t) t.category = d.category;
        if (global.UI && UI.toast) UI.toast('Categoría actualizada');
      } catch (e) {
        if (global.UI && UI.toast) UI.toast('No se pudo cambiar la categoría: ' + e.message);
      }
    },

    // Ficha de un ticket: descripción completa, badges, adjuntos con miniatura.
    abrirDetalle(id) {
      const t = this._tickets.find(x => String(x.id) === String(id));
      if (!t) return;
      const [et, cls] = EST[t.status] || ['—', 'nuevo'];
      const pr = t.priority || 'media';
      const imgs = (t.files || []).filter(f => esImagen(f.mime));
      const otros = (t.files || []).filter(f => !esImagen(f.mime));
      $('#ticketList').innerHTML = `
        <div class="tkdet">
          <button class="tkdet__back" data-tkback>‹ Volver a la lista</button>
          <h3 class="tkdet__title">${esc(t.title)}</h3>
          <div class="tkdet__badges">
            <span class="tkitem__est tkitem__est--${cls}">${et}</span>
            <span class="tkbadge tkbadge--${pr}">${esc(PRI[pr] || pr)}</span>
            ${this._super
              ? `<select class="tkbadge tkcat-sel" data-tkcat="${esc(t.id)}" title="Cambiar categoría (super admin)">${CATEGORIAS.map(c => `<option value="${esc(c)}"${c === t.category ? ' selected' : ''}>${esc(c)}</option>`).join('')}${(t.category && !CATEGORIAS.includes(t.category)) ? `<option value="${esc(t.category)}" selected>${esc(t.category)}</option>` : ''}</select>`
              : (t.category ? `<span class="tkbadge">${esc(t.category)}</span>` : '')}
          </div>
          <div class="tkdet__meta">Creado ${fechaLarga(t.createdAt)}${this._admin && t.userEmail ? ' · por ' + esc(t.userEmail) : ''}${t.completedAt ? ' · Resuelto ' + fechaLarga(t.completedAt) : ''}</div>
          ${(t.affectedConversation || t.affectedPhone) ? `<div class="tkdet__meta">💬 Conversación afectada: ${esc(t.affectedConversation || '—')}${t.affectedPhone ? ' · 📞 ' + esc(t.affectedPhone) : ''}</div>` : ''}
          <div class="tkdet__desc">${esc(t.description || '—').replace(/\n/g, '<br>')}</div>
          ${imgs.length ? `<div class="tkdet__sec">Capturas</div><div class="tkdet__imgs">${imgs.map(f => `<a class="tkdet__img" href="${esc(f.url)}" target="_blank" rel="noopener" title="${esc(f.name)}"><img src="${esc(f.url)}" alt="${esc(f.name)}" loading="lazy" /></a>`).join('')}</div>` : ''}
          ${otros.length ? `<div class="tkdet__sec">Adjuntos</div><div class="tkitem__adjs">${otros.map(f => `<a class="tkitem__adj" href="${esc(f.url)}" target="_blank" rel="noopener">${iconoDe(f.mime)} ${esc(f.name)}</a>`).join('')}</div>` : ''}
          ${(t.comments && t.comments.length) ? `<div class="tkdet__sec">Respuestas (${t.comments.length})</div>
            <div class="tkcoms">${t.comments.map(cm => `
              <div class="tkcom">
                <div class="tkcom__h">💬 ${esc(cm.author || 'Soporte')} · ${fechaCorta(cm.createdAt)}</div>
                <div class="tkcom__b">${esc(cm.body || '').replace(/\n/g, '<br>')}</div>
              </div>`).join('')}</div>` : ''}
        </div>`;
    },

    pintarForm() {
      const box = $('#ticketForm');
      // Si hay una conversación abierta, pre-llenamos la conversación afectada.
      const activa = (global.Store && Store.activeConversation && Store.activeConversation()) || null;
      const preTel = activa && activa.phone ? activa.phone : '';
      const preConv = activa && activa.name && activa.name !== '?' ? activa.name : '';
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
        <div class="tk__row">
          <label class="tk__lbl">Conversación afectada <span class="tk__hint">(opcional)</span>
            <input id="tkConv" class="tk__inp" maxlength="120" placeholder="Nombre del contacto" value="${esc(preConv)}" />
          </label>
          <label class="tk__lbl">Teléfono afectado <span class="tk__hint">(opcional)</span>
            <input id="tkTel" class="tk__inp" maxlength="30" placeholder="Ej. 18091234567" value="${esc(preTel)}" />
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
        telefono: ($('#tkTel') && $('#tkTel').value.trim()) || '',
        conversacion: ($('#tkConv') && $('#tkConv').value.trim()) || '',
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
        const chip = e.target.closest('[data-tkfiltro]');
        if (chip) return this.aplicarFiltro(chip.dataset.tkfiltro);
        const sc = e.target.closest('[data-tkscope]');
        if (sc) { if (this._scope !== sc.dataset.tkscope) { this._scope = sc.dataset.tkscope; this.verLista(); } return; }
        if (e.target.closest('[data-tkback]')) return this.pintarLista();
        const row = e.target.closest('[data-tkid]');
        if (row) return this.abrirDetalle(row.dataset.tkid);
      });
      // Buscador (solo re-pinta las filas, así no pierde el foco al escribir).
      modal.addEventListener('input', e => {
        if (e.target.id === 'tkBuscar') { this._busca = e.target.value; this.pintarItems(); }
      });
      // Selects de filtro (prioridad / categoría / fecha / orden).
      modal.addEventListener('change', e => {
        const catSel = e.target.closest('[data-tkcat]');
        if (catSel) return this.cambiarCategoria(catSel.dataset.tkcat, catSel.value);
        const map = { tkPrio: '_prio', tkCat: '_cat', tkDias: '_dias', tkOrden: '_orden' };
        const k = map[e.target.id];
        if (k) { this[k] = e.target.value; this.pintarItems(); }
      });
    }
  };

  global.Tickets = Tickets;
})(window);
