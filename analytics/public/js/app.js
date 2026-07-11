(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const cssvar = n => getComputedStyle(document.body).getPropertyValue(n).trim();
  const colors = () => ({ received: cssvar('--received'), sent: cssvar('--sent') });
  let current = null, days = 30;
  let msgPage = 1, msgData = null, msgSearch = '';

  const fmtNum = n => (Number(n) || 0).toLocaleString('es-MX');
  const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function fmtCost(v, ccy) {
    if (!v) return '—';
    const dec = v < 1 ? 4 : 2;
    return (ccy || 'USD') + ' ' + Number(v).toLocaleString('es-MX', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }
  function fmtUsd(v, dec) {
    if (v == null) return '—';
    const d = dec || 3;
    return '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtSecs(s) {
    if (s == null) return '—';
    if (s < 90) return Math.round(s) + ' s';
    if (s < 3600) { const m = s / 60; return (m >= 10 ? Math.round(m) : m.toFixed(1)) + ' min'; }
    return (s / 3600).toFixed(1) + ' h';
  }
  function fmtExec(secs) {
    if (secs == null) return '—';
    if (secs < 60) { const r = Math.round(secs * 10) / 10; return (Number.isInteger(r) ? r : r.toFixed(1)) + ' s'; }
    return fmtSecs(secs);
  }
  function relTime(iso) {
    if (!iso) return '';
    const d = (Date.now() - new Date(iso).getTime()) / 1000;
    if (d < 60) return 'hace instantes';
    if (d < 3600) return 'hace ' + Math.floor(d / 60) + ' min';
    if (d < 86400) return 'hace ' + Math.floor(d / 3600) + ' h';
    return 'hace ' + Math.floor(d / 86400) + ' d';
  }
  function fmtDateTime(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
    catch (_) { return '—'; }
  }
  const dayLabel = day => { const p = String(day).split('-'); return p.length === 3 ? p[2] + '/' + p[1] : day; };

  function kpi(label, dot, value, sub, muted) {
    return `<div class="kpi ${muted ? 'kpi--muted' : ''}">
      <div class="kpi__label">${dot ? `<span class="kpi__dot" style="background:${dot}"></span>` : ''}${label}</div>
      <div class="kpi__value">${value}</div>
      <div class="kpi__sub">${sub || ''}</div></div>`;
  }

  function render() {
    const s = current; if (!s) return;
    const col = colors();
    $('#rangeLabel').textContent = (s.range.days >= 100000 ? 'Todo el histórico' : `Últimos ${s.range.days} días`) + ` · ${s.range.tz}`;

    // KPIs
    const rt = s.responseTime;
    const ex = s.execTime || {};
    const ai = s.aiCost || {};
    const q = s.quotes || {};
    $('#kpis').innerHTML = [
      kpi('Enviados', col.sent, fmtNum(s.kpi.sent), 'mensajes salientes'),
      kpi('Recibidos', col.received, fmtNum(s.kpi.received), 'mensajes entrantes'),
      kpi('Tiempo de respuesta', '', fmtSecs(rt.medianSecs), `mediana · prom ${fmtSecs(rt.avgSecs)} · p90 ${fmtSecs(rt.p90Secs)}`),
      kpi('Tiempo de ejecución', '', ex.samples ? fmtExec(ex.medianSecs) : '—', ex.samples ? `mediana · prom ${fmtExec(ex.avgSecs)} · p90 ${fmtExec(ex.p90Secs)} · ${fmtNum(ex.samples)} runs` : 'sin datos aún', !ex.samples),
      kpi('Consumo IA', '', ai.runs ? fmtUsd(ai.totalUsd) : '—', ai.runs ? `${fmtNum(ai.runs)} runs · ${(ai.byModel || []).map(m => `${m.model}: ${fmtUsd(m.usd)}`).join(' · ')}` : 'sin datos aún', !ai.runs),
      kpi('Último enviado', '', fmtDateTime(s.kpi.lastSentAt), relTime(s.kpi.lastSentAt)),
      kpi('Conversaciones', '', fmtNum(s.kpi.activeConversations), 'con actividad en el rango'),
      kpi('Cotizaciones', '', q.available ? fmtNum(q.count) : 'Pendiente', q.available ? (q.amount ? 'RD$ ' + fmtNum(Math.round(q.amount)) + ' cotizado' : 'enviadas en el rango') : 'configurar MSSQL', !q.available)
    ].join('');

    // Legends
    const leg = `<span><i style="background:${col.received}"></i>Recibidos</span><span><i style="background:${col.sent}"></i>Enviados</span>`;
    $('#legendDay').innerHTML = leg; $('#legendHour').innerHTML = leg;

    const series = [
      { key: 'received', label: 'Recibidos', color: col.received },
      { key: 'sent', label: 'Enviados', color: col.sent }
    ];
    Charts.lineChart($('#chartDay'), { data: s.byDay.length ? s.byDay : [{ day: '—', sent: 0, received: 0 }], series, xLabel: d => dayLabel(d.day), height: 250 });
    Charts.groupedBar($('#chartHour'), { data: s.byHour, series, xLabel: d => d.hour + 'h', tipLabel: d => String(d.hour).padStart(2, '0') + ':00', height: 230 });

    // hora pico
    const peak = s.byHour.reduce((a, b) => (b.sent + b.received) > (a.sent + a.received) ? b : a, s.byHour[0] || { hour: 0, sent: 0, received: 0 });
    $('#hourNote').textContent = (peak.sent + peak.received) > 0 ? `Pico de actividad: ${String(peak.hour).padStart(2, '0')}:00–${String((peak.hour + 1) % 24).padStart(2, '0')}:00` : 'Sin datos en el rango';

    // tipos enviados
    const types = s.byType || [];
    const maxT = Math.max(1, ...types.map(t => t.n));
    $('#chartType').innerHTML = types.length
      ? types.map(t => `<div class="tbar"><span class="tbar__name">${t.type}</span><div class="tbar__track"><div class="tbar__fill" style="width:${(t.n / maxT) * 100}%"></div></div><span class="tbar__val">${fmtNum(t.n)}</span></div>`).join('')
      : '<p class="card__note">Sin mensajes enviados en el rango.</p>';
  }

  function msgCell(text, type) {
    if (text) return escapeHtml(text);
    const t = String(type || 'text').toLowerCase();
    const label = t === 'image' ? '🖼️ imagen'
      : (t === 'audio' || t === 'voice' || t === 'ptt') ? '🎤 audio'
      : t === 'video' ? '🎬 video'
      : t === 'document' ? '📎 documento'
      : t === 'sticker' ? '🏷️ sticker' : '—';
    return `<span class="dim">${label}</span>`;
  }

  function renderMessages() {
    const d = msgData; if (!d) return;
    const body = $('#msgsBody');
    if (!d.items.length) {
      body.innerHTML = `<tr><td colspan="9" class="msgs__empty">Sin intercambios en el rango.</td></tr>`;
    } else {
      body.innerHTML = d.items.map(m => `<tr>
        <td class="nowrap">${fmtDateTime(m.inAt || m.outAt)}</td>
        <td class="nowrap">${m.phone ? escapeHtml(m.phone) : '<span class="dim">—</span>'}${m.name ? `<div class="msgs__name">${escapeHtml(m.name)}</div>` : ''}</td>
        <td class="msgs__in"><span class="msgs__text">${msgCell(m.inText, m.inType)}</span></td>
        <td class="msgs__out"><span class="msgs__text">${msgCell(m.outText, m.outType)}</span></td>
        <td class="num">${m.execSecs != null ? fmtExec(m.execSecs) : '<span class="dim">—</span>'}</td>
        <td class="cap">${m.model ? escapeHtml(m.model) : '<span class="dim">—</span>'}</td>
        <td class="num">${m.costUsd != null ? fmtUsd(m.costUsd) : '<span class="dim">—</span>'}</td>
        <td class="num">${fmtCost(m.cost, d.cost.currency)}</td>
        <td class="cap dim">${escapeHtml(m.status || '—')}</td>
      </tr>`).join('');
    }
    // paginador
    const pages = Math.max(1, Math.ceil(d.total / d.limit));
    const first = d.total ? (d.page - 1) * d.limit + 1 : 0;
    const last = Math.min(d.page * d.limit, d.total);
    $('#msgsPager').innerHTML = `
      <span>${fmtNum(first)}–${fmtNum(last)} de ${fmtNum(d.total)} intercambios</span>
      <div class="pager__btns">
        <button class="pgbtn" data-pg="prev" ${d.page <= 1 ? 'disabled' : ''}>← Anterior</button>
        <span class="pager__n">Pág. ${d.page} / ${pages}</span>
        <button class="pgbtn" data-pg="next" ${d.page >= pages ? 'disabled' : ''}>Siguiente →</button>
      </div>`;
    const rateNote = d.cost.out
      ? `Coste por respuesta a tarifa ${fmtCost(d.cost.out, d.cost.currency)}.`
      : 'Coste sin tarifa configurada (MSG_COST_OUT).';
    $('#msgsNote').textContent = rateNote + ' Cada fila empareja un mensaje entrante del cliente con la respuesta del bot; "Ejecución" es el tiempo que tardó el bot en generar la respuesta (por run).';
  }

  async function loadMessages() {
    try {
      const params = new URLSearchParams({ days: String(days), page: String(msgPage), limit: '50' });
      if (msgSearch) params.set('search', msgSearch);
      const res = await fetch('/api/messages?' + params.toString());
      msgData = await res.json();
      renderMessages();
    } catch (e) {
      $('#msgsBody').innerHTML = `<tr><td colspan="9" class="msgs__empty">Error: ${escapeHtml(e.message)}</td></tr>`;
    }
  }

  async function load() {
    try {
      const res = await fetch('/api/stats?days=' + days);
      current = await res.json();
      render();
    } catch (e) { $('#kpis').innerHTML = `<div class="kpi kpi--muted"><div class="kpi__value">Error</div><div class="kpi__sub">${e.message}</div></div>`; }
  }

  function applyTheme(t) { document.documentElement.setAttribute('data-theme', t); document.body.setAttribute('data-theme', t); try { localStorage.setItem('an_theme', t); } catch (_) {} }

  function init() {
    let t = 'light'; try { t = localStorage.getItem('an_theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); } catch (_) {}
    applyTheme(t);
    $('#rangeSeg').addEventListener('click', e => {
      const b = e.target.closest('.seg'); if (!b) return;
      $('#rangeSeg').querySelectorAll('.seg').forEach(x => x.classList.remove('seg--active'));
      b.classList.add('seg--active');
      days = b.dataset.days === 'all' ? 'all' : Number(b.dataset.days);
      msgPage = 1;
      load(); loadMessages();
    });
    $('#tabs').addEventListener('click', e => {
      const b = e.target.closest('.tab'); if (!b) return;
      $('#tabs').querySelectorAll('.tab').forEach(x => x.classList.remove('tab--active'));
      b.classList.add('tab--active');
      const t = b.dataset.tab;
      $('#tabResumen').hidden = t !== 'resumen';
      $('#tabMensajes').hidden = t !== 'mensajes';
    });
    $('#msgsPager').addEventListener('click', e => {
      const b = e.target.closest('.pgbtn'); if (!b || b.disabled) return;
      msgPage += b.dataset.pg === 'next' ? 1 : -1;
      if (msgPage < 1) msgPage = 1;
      loadMessages();
    });
    let searchTimer = null;
    $('#msgSearch').addEventListener('input', e => {
      const v = e.target.value.trim();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { msgSearch = v; msgPage = 1; loadMessages(); }, 350);
    });
    $('#btnRefresh').addEventListener('click', () => { load(); loadMessages(); });
    $('#btnTheme').addEventListener('click', () => {
      applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
      render(); // re-pinta con los colores del tema
      renderMessages();
    });
    load(); loadMessages();
    setInterval(() => { load(); loadMessages(); }, 60000); // refresco cada minuto
  }
  document.addEventListener('DOMContentLoaded', init);
})();
