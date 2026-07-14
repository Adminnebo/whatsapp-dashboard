/* =========================================================
   quotes.js — Pestaña "Cotizaciones".
   Una fila por cotización (datos de MSSQL). Al hacer clic la fila se
   despliega y muestra los productos cotizados. El PDF vive en Supabase
   y se abre en el visor interno (#pdfViewer, ya montado por pipeline.js).
   Expone window.Quotes = { init, load, refreshIfVisible }.
   ========================================================= */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);

  let deps = null;              // { rangeParams, authHeaders } — los pasa app.js
  let page = 1;
  let search = '';
  let data = null;
  const open = new Set();       // nº de cotizaciones desplegadas
  const details = new Map();    // nº -> detalle (cacheado)

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtNum = n => (Number(n) || 0).toLocaleString('es-DO');
  const fmtRD = v => v == null ? '—' : 'RD$ ' + (Number(v) || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function fmtDate(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch (_) { return '—'; }
  }

  // Abre el PDF en el visor interno. Los listeners de cierre ya los monta pipeline.js.
  function openPdf(url, name) {
    if (!url) return;
    $('#pdfFrame').src = url;
    $('#pdfViewerName').textContent = name || 'Cotización';
    $('#pdfViewerOpen').href = url;
    $('#pdfViewer').hidden = false;
  }

  // Fila desplegada: tabla de productos cotizados.
  function detailRow(n) {
    const d = details.get(n);
    if (!d) return `<tr class="quo__detail"><td colspan="8"><div class="quo__loading">Cargando productos…</div></td></tr>`;
    if (d.error) return `<tr class="quo__detail"><td colspan="8"><div class="quo__err">Error: ${esc(d.error)}</div></td></tr>`;

    const lines = d.lines || [];
    const rows = lines.length
      ? lines.map(l => `<tr>
          <td class="nowrap dim">${esc(l.codigo)}</td>
          <td>${esc(l.descripcion)}</td>
          <td class="nowrap dim">${esc(l.unidad)}</td>
          <td class="num">${fmtNum(l.cantidad)}</td>
          <td class="num">${fmtRD(l.precio)}</td>
          <td class="num">${fmtRD(l.itbis)}</td>
          <td class="num"><b>${fmtRD(l.importe)}</b></td>
        </tr>`).join('')
      : `<tr><td colspan="7" class="msgs__empty">Esta cotización no tiene líneas.</td></tr>`;

    const meta = [
      d.rnc ? `RNC: <b>${esc(d.rnc)}</b>` : '',
      d.phone ? `Tel: <b>${esc(d.phone)}</b>` : '',
      d.email ? `Correo: <b>${esc(d.email)}</b>` : '',
      d.city ? `Ciudad: <b>${esc(d.city)}</b>` : '',
      d.dueDate ? `Vence: <b>${fmtDate(d.dueDate)}</b>` : ''
    ].filter(Boolean).join(' · ');

    return `<tr class="quo__detail"><td colspan="8">
      <div class="quo__panel">
        ${meta ? `<div class="quo__meta">${meta}</div>` : ''}
        ${d.notes ? `<div class="quo__notes">📝 ${esc(d.notes)}</div>` : ''}
        <table class="quo__lines">
          <thead>
            <tr>
              <th>Código</th><th>Descripción</th><th>Und</th>
              <th class="num">Cant.</th><th class="num">Precio</th><th class="num">ITBIS</th><th class="num">Importe</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
          <tfoot>
            <tr>
              <td colspan="5"></td>
              <td class="num dim">ITBIS ${fmtRD(d.itbis)}</td>
              <td class="num"><b>${fmtRD(d.total)}</b></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </td></tr>`;
  }

  // Recap del rango completo (no solo de la página): monto, cotizaciones y productos.
  function renderRecap() {
    const box = $('#quoRecap');
    if (!box) return;
    const d = data;
    if (!d || !d.available) { box.innerHTML = ''; box.hidden = true; return; }
    box.hidden = false;
    const tile = (label, value, sub) =>
      `<div class="quo__stat"><div class="quo__stat-val">${value}</div><div class="quo__stat-lbl">${label}</div>${sub ? `<div class="quo__stat-sub">${sub}</div>` : ''}</div>`;
    box.innerHTML =
      tile('Monto total cotizado', fmtRD(d.amount)) +
      tile('Cotizaciones', fmtNum(d.total)) +
      tile('Productos cotizados', fmtNum(d.products), d.units ? fmtNum(d.units) + ' unidades' : '');
  }

  function render() {
    const d = data;
    const body = $('#quotesBody');
    if (!d) return;
    renderRecap();

    if (!d.available) {
      body.innerHTML = `<tr><td colspan="8" class="msgs__empty">Base de cotizaciones (MSSQL) no configurada.</td></tr>`;
      $('#quotesPager').innerHTML = '';
      return;
    }
    if (!d.items.length) {
      body.innerHTML = `<tr><td colspan="8" class="msgs__empty">Sin cotizaciones en el rango.</td></tr>`;
      $('#quotesPager').innerHTML = '';
      return;
    }

    body.innerHTML = d.items.map(x => {
      const isOpen = open.has(x.number);
      const head = `<tr class="quo__row ${isOpen ? 'quo__row--open' : ''}" data-n="${x.number}">
        <td class="quo__exp"><span class="quo__caret">${isOpen ? '▾' : '▸'}</span></td>
        <td class="nowrap"><b>${esc(x.number)}</b></td>
        <td>${x.client ? esc(x.client) : '<span class="dim">—</span>'}${x.rnc ? `<div class="msgs__name">RNC ${esc(x.rnc)}</div>` : ''}</td>
        <td class="nowrap">${fmtDate(x.date)}</td>
        <td class="num dim">${fmtRD(x.itbis)}</td>
        <td class="num"><b>${fmtRD(x.total)}</b></td>
        <td class="nowrap">${x.sent ? '<span class="quo__sent">✔ Enviada</span>' : `<span class="dim cap">${esc(x.status || '—')}</span>`}</td>
        <td class="nowrap">${x.pdfUrl ? `<button class="q__btn quo__pdf" data-url="${esc(x.pdfUrl)}" data-n="${x.number}">📄 Ver</button>` : '<span class="dim">—</span>'}</td>
      </tr>`;
      return head + (isOpen ? detailRow(x.number) : '');
    }).join('');

    const pages = Math.max(1, Math.ceil(d.total / d.limit));
    const first = d.total ? (d.page - 1) * d.limit + 1 : 0;
    const last = Math.min(d.page * d.limit, d.total);
    $('#quotesPager').innerHTML = `
      <span>${fmtNum(first)}–${fmtNum(last)} de ${fmtNum(d.total)} cotizaciones · ${fmtRD(d.amount)} en total</span>
      <div class="pager__btns">
        <button class="pgbtn" data-pg="prev" ${d.page <= 1 ? 'disabled' : ''}>← Anterior</button>
        <span class="pager__n">Pág. ${d.page} / ${pages}</span>
        <button class="pgbtn" data-pg="next" ${d.page >= pages ? 'disabled' : ''}>Siguiente →</button>
      </div>`;
  }

  async function load() {
    try {
      const params = deps.rangeParams();
      params.set('page', String(page));
      params.set('limit', '50');
      if (search) params.set('search', search);
      const res = await fetch('/api/quotes?' + params.toString(), { headers: deps.authHeaders() });
      data = await res.json();
      render();
    } catch (e) {
      $('#quotesBody').innerHTML = `<tr><td colspan="8" class="msgs__empty">Error: ${esc(e.message)}</td></tr>`;
    }
  }

  // Despliega/repliega una fila; trae el detalle la primera vez.
  async function toggle(n) {
    if (open.has(n)) { open.delete(n); render(); return; }
    open.add(n);
    render();                                   // pinta "Cargando productos…"
    if (details.has(n)) { render(); return; }   // ya cacheado
    try {
      const res = await fetch('/api/quotes/' + n, { headers: deps.authHeaders() });
      const d = await res.json();
      details.set(n, res.ok ? d : { error: d.error || 'No se pudo cargar' });
    } catch (e) {
      details.set(n, { error: e.message });
    }
    if (open.has(n)) render();
  }

  function refreshIfVisible() {
    page = 1;
    open.clear();
    details.clear();
    if (!$('#tabCotizaciones').hidden) load();
  }

  function init(ctx) {
    deps = ctx;

    $('#quotesBody').addEventListener('click', e => {
      const pdf = e.target.closest('.quo__pdf');
      if (pdf) {                                // el botón de PDF no despliega la fila
        e.stopPropagation();
        openPdf(pdf.dataset.url, 'Cotización ' + pdf.dataset.n);
        return;
      }
      const row = e.target.closest('.quo__row');
      if (row) toggle(Number(row.dataset.n));
    });

    $('#quotesPager').addEventListener('click', e => {
      const b = e.target.closest('.pgbtn');
      if (!b || b.disabled) return;
      page += b.dataset.pg === 'next' ? 1 : -1;
      if (page < 1) page = 1;
      open.clear();
      load();
    });

    let t = null;
    $('#quoSearch').addEventListener('input', e => {
      clearTimeout(t);
      const v = e.target.value.trim();
      t = setTimeout(() => { search = v; page = 1; open.clear(); load(); }, 350);
    });

    $('#quoRefresh').addEventListener('click', () => { details.clear(); load(); });
  }

  window.Quotes = { init, load, refreshIfVisible };
})();
