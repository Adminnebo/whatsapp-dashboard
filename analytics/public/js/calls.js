/* =========================================================
   calls.js — Pestaña "Llamadas".
   Recap del rango arriba (total llamadas, coste, duración) + desglose
   por agente. Tabla con una fila por llamada; al hacer clic se despliega
   la transcripción completa y el reproductor de la grabación.
   Expone window.Calls = { init, load, refreshIfVisible }.
   ========================================================= */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);

  let deps = null;              // { rangeParams, authHeaders }
  let page = 1;
  let search = '';
  let data = null;
  const open = new Set();       // ids desplegados
  const details = new Map();    // id -> detalle (transcripción completa)

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Enruta la grabación por el proxy del panel (mismo origen → sin problemas de CORS).
  const proxyRec = u => u ? '/api/recordings/proxy?url=' + encodeURIComponent(u) : '';
  const fmtNum = n => (Number(n) || 0).toLocaleString('es-DO');
  function fmtMoney(v) {
    if (v == null) return '—';
    const ccy = (data && data.currency) || 'USD';
    return (Number(v) || 0).toLocaleString('es-DO', { style: 'currency', currency: ccy });
  }
  function fmtDur(secs) {
    if (secs == null) return '—';
    const s = Math.round(Number(secs) || 0);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    const p2 = n => String(n).padStart(2, '0');
    return h ? `${h}:${p2(m)}:${p2(ss)}` : `${m}:${p2(ss)}`;
  }
  function fmtDurLong(secs) {
    const s = Math.round(Number(secs) || 0);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h) return `${h} h ${m} min`;
    if (m) return `${m} min`;
    return `${s} s`;
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch (_) { return '—'; }
  }

  // Recap del rango completo (no solo de la página).
  function renderRecap() {
    const box = $('#callRecap');
    const agentsBox = $('#callAgents');
    const r = data && data.recap;
    if (!r) { box.innerHTML = ''; box.hidden = true; agentsBox.innerHTML = ''; return; }
    box.hidden = false;
    const tile = (label, value, sub) =>
      `<div class="quo__stat"><div class="quo__stat-val">${value}</div><div class="quo__stat-lbl">${label}</div>${sub ? `<div class="quo__stat-sub">${sub}</div>` : ''}</div>`;
    box.innerHTML =
      tile('Llamadas', fmtNum(r.calls)) +
      tile('Coste total', fmtMoney(r.totalCost), 'Prom. ' + fmtMoney(r.avgCost) + '/llamada') +
      tile('Duración total', fmtDurLong(r.totalDurationSecs), 'Prom. ' + fmtDur(r.avgDurationSecs) + '/llamada');

    // Desglose por agente
    const ag = r.agents || [];
    if (!ag.length) { agentsBox.innerHTML = ''; return; }
    agentsBox.innerHTML = `<div class="call__agents-title">Por agente</div>` +
      ag.map(a => `<span class="call__agent">
        <b>${esc(a.agent)}</b>
        <span class="dim">${fmtNum(a.calls)} llam. · ${fmtDur(a.durationSecs)} · ${fmtMoney(a.cost)}</span>
      </span>`).join('');
  }

  function detailRow(id) {
    const d = details.get(id);
    if (!d) return `<tr class="quo__detail"><td colspan="7"><div class="quo__loading">Cargando transcripción…</div></td></tr>`;
    if (d.error) return `<tr class="quo__detail"><td colspan="7"><div class="quo__err">Error: ${esc(d.error)}</div></td></tr>`;

    // La grabación va por el proxy del propio panel: el host de origen no manda
    // CORS y el <audio> falla (0:00 / no suena) si se apunta directo.
    const rec = d.recordingUrl
      ? `<div class="call__rec">
           <audio controls preload="none" src="${esc(proxyRec(d.recordingUrl))}"></audio>
           <a class="q__btn q__btn--dl" href="${esc(d.recordingUrl)}" target="_blank" rel="noopener">↗ Abrir grabación</a>
         </div>`
      : `<div class="dim">Sin grabación.</div>`;
    const tr = d.transcript
      ? `<div class="call__transcript">${esc(d.transcript)}</div>`
      : `<div class="dim">Sin transcripción.</div>`;

    return `<tr class="quo__detail"><td colspan="7">
      <div class="quo__panel">
        ${rec}
        <div class="call__transcript-lbl">Transcripción</div>
        ${tr}
      </div>
    </td></tr>`;
  }

  function render() {
    const d = data;
    const body = $('#callsBody');
    if (!d) return;
    renderRecap();

    if (!d.items || !d.items.length) {
      body.innerHTML = `<tr><td colspan="7" class="msgs__empty">Sin llamadas en el rango.</td></tr>`;
      $('#callsPager').innerHTML = '';
      return;
    }

    body.innerHTML = d.items.map(x => {
      const isOpen = open.has(x.id);
      const head = `<tr class="quo__row ${isOpen ? 'quo__row--open' : ''}" data-id="${esc(x.id)}">
        <td class="quo__exp"><span class="quo__caret">${isOpen ? '▾' : '▸'}</span></td>
        <td class="nowrap">${fmtDate(x.at)}</td>
        <td>${x.agent ? esc(x.agent) : '<span class="dim">—</span>'}</td>
        <td class="nowrap">${x.phone ? esc(x.phone) : '<span class="dim">—</span>'}</td>
        <td class="num nowrap">${fmtDur(x.durationSecs)}</td>
        <td class="num">${fmtMoney(x.cost)}</td>
        <td class="nowrap">${x.recordingUrl ? '🎧 Sí' : '<span class="dim">—</span>'}</td>
      </tr>`;
      return head + (isOpen ? detailRow(x.id) : '');
    }).join('');

    const pages = Math.max(1, Math.ceil(d.total / d.limit));
    const first = d.total ? (d.page - 1) * d.limit + 1 : 0;
    const last = Math.min(d.page * d.limit, d.total);
    $('#callsPager').innerHTML = `
      <span>${fmtNum(first)}–${fmtNum(last)} de ${fmtNum(d.total)} llamadas</span>
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
      const res = await fetch('/api/calls?' + params.toString(), { headers: deps.authHeaders() });
      data = await res.json();
      render();
    } catch (e) {
      $('#callsBody').innerHTML = `<tr><td colspan="7" class="msgs__empty">Error: ${esc(e.message)}</td></tr>`;
    }
  }

  async function toggle(id) {
    if (open.has(id)) { open.delete(id); render(); return; }
    open.add(id);
    render();
    if (details.has(id)) { render(); return; }
    try {
      const res = await fetch('/api/calls/' + id, { headers: deps.authHeaders() });
      const d = await res.json();
      details.set(id, res.ok ? d.call : { error: d.error || 'No se pudo cargar' });
    } catch (e) {
      details.set(id, { error: e.message });
    }
    if (open.has(id)) render();
  }

  function refreshIfVisible() {
    page = 1; open.clear(); details.clear();
    if (!$('#tabLlamadas').hidden) load();
  }

  function init(ctx) {
    deps = ctx;
    $('#callsBody').addEventListener('click', e => {
      const row = e.target.closest('.quo__row');
      if (row) toggle(row.dataset.id);
    });
    $('#callsPager').addEventListener('click', e => {
      const b = e.target.closest('.pgbtn');
      if (!b || b.disabled) return;
      page += b.dataset.pg === 'next' ? 1 : -1;
      if (page < 1) page = 1;
      open.clear();
      load();
    });
    let t = null;
    $('#callSearch').addEventListener('input', e => {
      clearTimeout(t);
      const v = e.target.value.trim();
      t = setTimeout(() => { search = v; page = 1; open.clear(); load(); }, 350);
    });
    $('#callRefresh').addEventListener('click', () => { details.clear(); load(); });
  }

  window.Calls = { init, load, refreshIfVisible };
})();
