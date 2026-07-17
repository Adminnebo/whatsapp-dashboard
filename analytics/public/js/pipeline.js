/* =========================================================
   pipeline.js (frontend) — Tablero Kanban de oportunidades.
   Columnas = etapas; tarjetas = oportunidades (con canal y cotización).
   Arrastrar-soltar mueve la tarjeta de etapa (persiste vía PATCH).
   Click en la tarjeta abre la cotización (cabecera + líneas + PDF).
   Expone window.Pipeline = { init, load }.
   ========================================================= */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const CHANNELS = {
    whatsapp:   { label: 'WhatsApp',   icon: '💬' },
    instagram:  { label: 'Instagram',  icon: '📸' },
    facebook:   { label: 'Facebook',   icon: '📘' },
    pagina_web: { label: 'Página web', icon: '🌐' }
  };

  let pipeline = null, stages = [], opps = [];
  let filterChannel = '', search = '', searchTimer = null, dragId = null, loaded = false, lastOverCol = null;

  function authHeaders() { return (window.Auth && Auth.currentToken) ? { Authorization: 'Bearer ' + Auth.currentToken } : {}; }
  async function api(url, opts) {
    const o = Object.assign({}, opts || {});
    o.headers = Object.assign({ 'Content-Type': 'application/json' }, authHeaders(), o.headers || {});
    const r = await fetch(url, o);
    if (!r.ok) { let m = r.status; try { m = (await r.json()).error || m; } catch (_) {} throw new Error(m); }
    return r.json();
  }

  const fmtNum = n => (Number(n) || 0).toLocaleString('es-DO');
  function fmtRD(v) { return v == null ? '' : 'RD$ ' + (Number(v) || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function relTime(iso) {
    if (!iso) return '';
    const d = (Date.now() - new Date(iso).getTime()) / 1000;
    if (d < 60) return 'hace instantes';
    if (d < 3600) return 'hace ' + Math.floor(d / 60) + ' min';
    if (d < 86400) return 'hace ' + Math.floor(d / 3600) + ' h';
    return 'hace ' + Math.floor(d / 86400) + ' d';
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('es-DO', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch (_) { return '—'; }
  }

  function channelBadge(ch) {
    const key = String(ch || '').toLowerCase();
    const meta = CHANNELS[key];
    if (!meta) return '';
    return `<span class="chip chip--${key} oppcard__chan">${meta.icon} ${meta.label}</span>`;
  }

  function cardHtml(o) {
    return `<article class="oppcard" draggable="true" data-id="${o.id}" data-stage="${o.stageId || ''}">
      <div class="oppcard__top">
        <span class="oppcard__title">${esc(o.title || 'Sin nombre')}</span>
        ${channelBadge(o.channel)}
      </div>
      ${o.quoteNumber != null ? `<div class="oppcard__quote">🧾 cotización ${esc(o.quoteNumber)}${o.quoteAmount ? ` · ${fmtRD(o.quoteAmount)}` : ''}</div>` : ''}
      <div class="oppcard__meta">
        ${o.phone ? `<span class="oppcard__phone">📞 ${esc(o.phone)}</span>` : '<span></span>'}
        <span class="oppcard__time">${relTime(o.updatedAt)}</span>
      </div>
    </article>`;
  }

  function render() {
    const wrap = $('#boardWrap');
    if (!stages.length) { wrap.innerHTML = '<p class="board__err">Sin etapas configuradas.</p>'; return; }
    const byStage = {};
    opps.forEach(o => { (byStage[o.stageId] = byStage[o.stageId] || []).push(o); });
    // Descendente: mayor position arriba. Como cada oportunidad nueva entra con
    // MAX(position)+1, las más recientes quedan arriba; el arrastre manual manda igual.
    Object.values(byStage).forEach(list => list.sort((a, b) => b.position - a.position));

    wrap.innerHTML = stages.map(s => {
      const list = byStage[s.id] || [];
      const total = list.reduce((a, o) => a + (Number(o.quoteAmount) || 0), 0);
      return `<section class="col" data-stage="${s.id}">
        <header class="col__head" style="--stage:${s.color || '#888'}">
          <span class="col__dot"></span>
          <span class="col__name">${esc(s.name)}</span>
          <span class="col__count">${list.length}</span>
        </header>
        ${total ? `<div class="col__sum">${fmtRD(total)}</div>` : '<div class="col__sum col__sum--empty"></div>'}
        <div class="col__body" data-stage="${s.id}">
          ${list.map(cardHtml).join('') || '<div class="col__empty">—</div>'}
        </div>
      </section>`;
    }).join('');
  }

  // ---- Drag & drop (mueve de etapa, posición fraccionada, persiste con PATCH) ----
  function getAfterElement(container, y) {
    const els = [...container.querySelectorAll('.oppcard:not(.oppcard--dragging)')];
    let closest = { offset: -Infinity, el: null };
    for (const child of els) {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) closest = { offset, el: child };
    }
    return closest.el;
  }

  // Recalcula contador/suma/placeholder de una columna sin re-renderizar todo.
  function updateColMeta(stageId) {
    const col = $('#boardWrap').querySelector(`.col[data-stage="${stageId}"]`);
    if (!col) return;
    const list = opps.filter(o => String(o.stageId) === String(stageId));
    const cnt = col.querySelector('.col__count'); if (cnt) cnt.textContent = list.length;
    const sum = list.reduce((a, o) => a + (Number(o.quoteAmount) || 0), 0);
    const sumEl = col.querySelector('.col__sum');
    if (sumEl) { sumEl.textContent = sum ? fmtRD(sum) : ''; sumEl.classList.toggle('col__sum--empty', !sum); }
    const body = col.querySelector('.col__body');
    const empty = body.querySelector('.col__empty');
    if (list.length && empty) empty.remove();
    else if (!list.length && !empty) body.insertAdjacentHTML('beforeend', '<div class="col__empty">—</div>');
  }

  async function onDrop(body, clientY) {
    const stageId = body.dataset.stage;
    const moved = opps.find(o => o.id === dragId);
    if (!moved) return;
    const card = $('#boardWrap').querySelector(`.oppcard[data-id="${moved.id}"]`);
    if (!card) return;
    const after = getAfterElement(body, clientY);
    // La columna se pinta en DESCENDENTE (mayor position arriba). La tarjeta soltada
    // queda justo encima de `after`, así que su position va entre la de arriba (mayor)
    // y la de `after` (menor).
    const inStage = opps.filter(o => String(o.stageId) === String(stageId) && o.id !== dragId).sort((a, b) => b.position - a.position);
    let idx = inStage.length;
    if (after) { const aid = after.dataset.id; const f = inStage.findIndex(o => o.id === aid); if (f >= 0) idx = f; }
    const above = idx > 0 ? inStage[idx - 1].position : null;         // tarjeta de arriba (mayor)
    const below = idx < inStage.length ? inStage[idx].position : null; // tarjeta de abajo (menor)
    let newPos;
    if (above == null && below == null) newPos = 0;                   // columna vacía
    else if (above == null) newPos = below + 1;                       // soltada arriba del todo
    else if (below == null) newPos = above - 1;                       // soltada abajo del todo
    else newPos = (above + below) / 2;                               // entre dos
    const prevStage = String(moved.stageId);
    moved.stageId = String(stageId); moved.position = newPos;

    // Movimiento quirúrgico en el DOM: mueve solo la tarjeta (preserva el scroll,
    // sin reconstruir las demás columnas → fluido aun con cientos de tarjetas).
    const emptyEl = body.querySelector('.col__empty'); if (emptyEl) emptyEl.remove();
    if (after) body.insertBefore(card, after); else body.appendChild(card);
    card.dataset.stage = stageId;
    if (prevStage !== String(stageId)) { updateColMeta(prevStage); updateColMeta(stageId); }

    try {
      await api('/api/opportunities/' + moved.id, { method: 'PATCH', body: JSON.stringify({ stageId: Number(stageId), position: newPos }) });
    } catch (e) {
      moved.stageId = prevStage; render();
      alert('No se pudo mover: ' + e.message);
    }
  }

  // ---- Modal de oportunidad: datos listados + adjunto PDF (Ver / Descargar) ----
  let currentPdf = null, currentPdfName = null;

  function pdfName(o) {
    if (o.quoteNumber != null) return 'Cotización ' + o.quoteNumber + '.pdf';
    try { const base = decodeURIComponent(new URL(o.quotePdfUrl).pathname.split('/').pop() || ''); if (base) return base; } catch (_) {}
    return 'Cotización.pdf';
  }

  function fieldRow(label, value) {
    if (!value) return '';
    return `<div class="q__field"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
  }

  function openQuote(id) {
    const o = opps.find(x => x.id === id);
    if (!o) return;
    const pdf = o.quotePdfUrl;
    currentPdf = pdf || null;
    currentPdfName = pdf ? pdfName(o) : null;

    let html = `<div class="q__head">
      <div class="q__headinfo">
        <div class="q__num">Oportunidad</div>
        <div class="q__client">${esc(o.title || 'Sin nombre')}</div>
      </div>
    </div>`;

    // Datos en el cuerpo, listados.
    html += `<dl class="q__fields">
      ${fieldRow('Canal', channelBadge(o.channel) || '<span class="q__dim">—</span>')}
      ${fieldRow('Fecha', '📅 ' + esc(fmtDate(o.createdAt)))}
      ${fieldRow('Teléfono', o.phone ? '📞 ' + esc(o.phone) : '<span class="q__dim">—</span>')}
      ${o.quoteNumber != null ? fieldRow('Cotización', `🧾 Nº ${esc(o.quoteNumber)}${o.quoteAmount ? ' · ' + fmtRD(o.quoteAmount) : ''}`) : ''}
    </dl>`;

    // Adjunto PDF (debajo).
    if (pdf) {
      html += `<div class="q__attach">
        <div class="q__file">
          <div class="q__fileicon">📄</div>
          <div class="q__fileinfo">
            <div class="q__filename">${esc(currentPdfName)}</div>
            <div class="q__filemeta">Documento · PDF</div>
          </div>
        </div>
        <div class="q__fileactions">
          <button class="q__btn q__btn--ver" type="button">👁 Ver</button>
          <a class="q__btn q__btn--dl" href="${esc(pdf)}" download target="_blank" rel="noopener">⬇ Descargar</a>
        </div>
      </div>`;
    } else {
      html += `<p class="q__loading">Esta oportunidad no tiene PDF de cotización adjunto.</p>`;
    }
    $('#quoteBody').innerHTML = html;
    $('#quoteModal').hidden = false;
  }
  function closeQuote() { const m = $('#quoteModal'); if (m) { m.hidden = true; $('#quoteBody').innerHTML = ''; } }

  // ---- Popup interno de vista previa del PDF ----
  function openViewer() {
    if (!currentPdf) return;
    const fr = $('#pdfFrame');
    fr.src = currentPdf;
    $('#pdfViewerName').textContent = currentPdfName || 'Vista previa';
    $('#pdfViewerOpen').href = currentPdf;
    $('#pdfViewer').hidden = false;
  }
  function closeViewer() { const v = $('#pdfViewer'); if (v) { v.hidden = true; $('#pdfFrame').src = 'about:blank'; } }

  async function load() {
    try {
      const params = new URLSearchParams();
      if (filterChannel) params.set('channel', filterChannel);
      if (search) params.set('search', search);
      // Siempre relee las etapas (por si se agregan/renombran/renumeran en el servidor)
      // y las oportunidades, en paralelo.
      const [p, o] = await Promise.all([
        api('/api/pipelines'),
        api('/api/opportunities?' + params.toString())
      ]);
      pipeline = (p.pipelines || [])[0] || null;
      stages = pipeline ? pipeline.stages : [];
      opps = o.items;
      render();
    } catch (e) {
      $('#boardWrap').innerHTML = '<p class="board__err">Error: ' + esc(e.message) + '</p>';
    }
  }

  function init() {
    const wrap = $('#boardWrap');
    // Drag & drop por delegación
    const clearOver = () => { if (lastOverCol) { lastOverCol.classList.remove('col--over'); lastOverCol = null; } };
    wrap.addEventListener('dragstart', e => { const c = e.target.closest('.oppcard'); if (!c) return; dragId = c.dataset.id; c.classList.add('oppcard--dragging'); });
    wrap.addEventListener('dragend', e => { const c = e.target.closest('.oppcard'); if (c) c.classList.remove('oppcard--dragging'); clearOver(); dragId = null; });
    wrap.addEventListener('dragover', e => {
      const body = e.target.closest('.col__body'); if (!body) return;
      e.preventDefault();
      const col = body.parentElement;
      if (col !== lastOverCol) { clearOver(); col.classList.add('col--over'); lastOverCol = col; }  // solo cambia el resaltado si cambió de columna
    });
    wrap.addEventListener('drop', e => { const body = e.target.closest('.col__body'); if (!body || !dragId) return; e.preventDefault(); clearOver(); onDrop(body, e.clientY); });
    // Click en tarjeta → cotización
    wrap.addEventListener('click', e => { const c = e.target.closest('.oppcard'); if (!c) return; if (wrap.dataset.panned === '1') { wrap.dataset.panned = ''; return; } openQuote(c.dataset.id); });

    // Desplazamiento horizontal arrastrando con el mouse en espacio vacío.
    let panning = false, panStartX = 0, panScroll = 0;
    wrap.addEventListener('mousedown', e => {
      if (e.button !== 0 || e.target.closest('.oppcard')) return;  // sobre tarjeta → drag nativo
      panning = true; panStartX = e.pageX; panScroll = wrap.scrollLeft; wrap.classList.add('board--panning');
    });
    window.addEventListener('mousemove', e => {
      if (!panning) return;
      const dx = e.pageX - panStartX;
      if (Math.abs(dx) > 4) wrap.dataset.panned = '1';
      wrap.scrollLeft = panScroll - dx;
    });
    window.addEventListener('mouseup', () => { if (!panning) return; panning = false; wrap.classList.remove('board--panning'); });
    // Rueda del mouse → scroll horizontal cuando no hay scroll vertical pendiente en la columna.
    wrap.addEventListener('wheel', e => { if (e.deltaY && !e.shiftKey && !e.target.closest('.col__body')) { wrap.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });

    $('#pipeChan').addEventListener('change', e => { filterChannel = e.target.value; load(); });
    $('#pipeSearch').addEventListener('input', e => { const v = e.target.value.trim(); clearTimeout(searchTimer); searchTimer = setTimeout(() => { search = v; load(); }, 350); });
    $('#pipeRefresh').addEventListener('click', () => load());
    $('#quoteClose').addEventListener('click', closeQuote);
    $('#quoteModal').addEventListener('click', e => { if (e.target.id === 'quoteModal') closeQuote(); });
    // Botón "Ver" (delegado, porque el cuerpo del modal se reconstruye)
    $('#quoteBody').addEventListener('click', e => { if (e.target.closest('.q__btn--ver')) openViewer(); });
    // Popup de vista previa
    $('#pdfViewerClose').addEventListener('click', closeViewer);
    $('#pdfViewer').addEventListener('click', e => { if (e.target.id === 'pdfViewer') closeViewer(); });
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (!$('#pdfViewer').hidden) closeViewer();   // primero cierra el preview
      else closeQuote();
    });
  }

  window.Pipeline = {
    init,
    load: () => { loaded = true; return load(); },
    loadedOnce: () => loaded
  };
})();
