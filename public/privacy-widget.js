/* =========================================================
   privacy-widget.js — Aceptación de la Política de Privacidad.

   Pop-up bloqueante para los administradores que aún no aceptaron la versión
   vigente. Es UNO solo para todos los paneles: se sirve desde el inbox y cada
   panel lo carga por <script src="https://whatsapp.neboaiconsulting.com/privacy-widget.js">,
   así un cambio aquí llega a todos sin copiar archivos. El registro de quién
   aceptó vive en el backend del inbox (/api/privacy/*), al que se llama con el
   token Supabase del panel (login compartido).

   Uso, tras el login:
     PrivacyWidget.init({ getToken: () => token, app: 'cobranzas' });
   `apiBase` es opcional: por defecto, el origen desde el que se cargó este script.

   Si el inbox no responde, NO se bloquea el panel: se reintenta en la próxima carga.
   ========================================================= */
(function (global) {
  'use strict';
  if (global.PrivacyWidget) return;

  var ORIGEN = (function () {
    try { return new URL(document.currentScript.src).origin; } catch (_) { return ''; }
  })();

  var CSS = [
    '.pw-overlay{position:fixed;inset:0;z-index:2147483000;background:rgba(15,18,25,.72);display:flex;align-items:center;justify-content:center;padding:16px;font-family:"Segoe UI",system-ui,-apple-system,Arial,sans-serif;}',
    '.pw-card{background:#fff;color:#1a1d24;width:100%;max-width:780px;max-height:92vh;border-radius:14px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,.45);}',
    '.pw-head{padding:18px 22px 14px;border-bottom:1px solid #e2e4ea;}',
    '.pw-head h2{margin:0;font-size:18px;font-weight:700;color:#1a1d24;}',
    '.pw-head p{margin:6px 0 0;font-size:13.5px;line-height:1.45;color:#5b6272;}',
    '.pw-scroll{flex:1 1 auto;min-height:160px;overflow-y:auto;background:#fbfbfc;}',
    '.pw-cargando{padding:40px 22px;text-align:center;color:#5b6272;font-size:14px;}',
    '.pw-foot{padding:14px 22px 18px;border-top:1px solid #e2e4ea;background:#fff;}',
    '.pw-aviso{margin:0 0 10px;font-size:12.5px;color:#8c4b3c;}',
    '.pw-aviso[hidden]{display:none;}',
    '.pw-check{display:flex;align-items:flex-start;gap:10px;font-size:14px;line-height:1.4;color:#1a1d24;cursor:pointer;}',
    '.pw-check input{width:18px;height:18px;margin:1px 0 0;flex:0 0 auto;accent-color:#34496e;cursor:pointer;}',
    '.pw-check--off{color:#9aa1b0;cursor:not-allowed;}',
    '.pw-check--off input{cursor:not-allowed;}',
    '.pw-acciones{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px;flex-wrap:wrap;}',
    '.pw-link{font-size:13px;color:#34496e;}',
    '.pw-btn{border:0;border-radius:9px;padding:11px 20px;font-size:14px;font-weight:600;color:#fff;background:#34496e;cursor:pointer;}',
    '.pw-btn:disabled{background:#c4c9d4;cursor:not-allowed;}',
    '.pw-error{margin:10px 0 0;font-size:13px;color:#b42318;}',
    '.pw-error[hidden]{display:none;}',
    '@media (max-width:520px){.pw-overlay{padding:0}.pw-card{max-height:100vh;height:100%;border-radius:0}}'
  ].join('');

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // Trae la página de la política y la monta dentro de un shadow root, para que sus
  // estilos (pensados para una página entera) no toquen el panel que la aloja.
  async function montarPolitica(host, apiBase) {
    var res = await fetch(apiBase + '/privacidad', { credentials: 'omit' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    var hoja = doc.querySelector('.hoja') || doc.body;
    hoja.querySelectorAll('script, iframe, object, embed').forEach(function (n) { n.remove(); });
    hoja.querySelectorAll('a[href]').forEach(function (a) {
      try { a.href = new URL(a.getAttribute('href'), apiBase + '/privacidad').href; } catch (_) {}
      a.target = '_blank'; a.rel = 'noopener';
    });
    var estilos = Array.prototype.map.call(doc.querySelectorAll('style'), function (s) { return s.textContent; }).join('\n')
      .replace(/:root:not\(\[data-theme="light"\]\)/g, ':host([data-theme="dark"])')
      .replace(/:root\[data-theme="dark"\]/g, ':host([data-theme="dark"])')
      .replace(/:root\b/g, ':host')
      .replace(/(^|[\s,}])body(\s*[{,])/g, '$1.pw-doc$2');
    var root = host.attachShadow({ mode: 'open' });
    var st = document.createElement('style');
    st.textContent = estilos + '\n.pw-doc{padding:0 22px 28px !important;margin:0}\nheader.tapa{padding-top:30px !important}';
    var cont = document.createElement('div');
    cont.className = 'pw-doc';
    cont.appendChild(document.importNode(hoja, true));
    root.appendChild(st);
    root.appendChild(cont);
  }

  function mostrar(cfg, estado) {
    if (document.querySelector('.pw-overlay')) return;
    if (!document.getElementById('pw-style')) {
      var st = el('style'); st.id = 'pw-style'; st.textContent = CSS; document.head.appendChild(st);
    }

    var overlay = el('div', 'pw-overlay');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'pw-titulo');

    var card = el('div', 'pw-card');
    var head = el('div', 'pw-head');
    var h2 = el('h2', null, 'Política de Privacidad'); h2.id = 'pw-titulo';
    head.appendChild(h2);
    head.appendChild(el('p', null, 'Como administrador, necesitas leerla y aceptarla para seguir usando el panel. Solo se pide una vez por versión (vigente: ' + (estado.version || '1.0') + ').'));

    var scroll = el('div', 'pw-scroll');
    scroll.tabIndex = 0;
    var doc = el('div');
    var cargando = el('div', 'pw-cargando', 'Cargando la política…');
    scroll.appendChild(cargando);
    scroll.appendChild(doc);

    var foot = el('div', 'pw-foot');
    var aviso = el('p', 'pw-aviso', 'Desplázate hasta el final del texto para poder aceptar.');
    var label = el('label', 'pw-check pw-check--off');
    var check = el('input'); check.type = 'checkbox'; check.disabled = true;
    label.appendChild(check);
    label.appendChild(el('span', null, 'He leído y acepto la Política de Privacidad.'));
    var acciones = el('div', 'pw-acciones');
    var link = el('a', 'pw-link', 'Abrir en otra pestaña');
    link.href = cfg.apiBase + '/privacidad'; link.target = '_blank'; link.rel = 'noopener';
    var btn = el('button', 'pw-btn', 'Aceptar y continuar'); btn.type = 'button'; btn.disabled = true;
    acciones.appendChild(link); acciones.appendChild(btn);
    var error = el('p', 'pw-error'); error.hidden = true;
    foot.appendChild(aviso); foot.appendChild(label); foot.appendChild(acciones); foot.appendChild(error);

    card.appendChild(head); card.appendChild(scroll); card.appendChild(foot);
    overlay.appendChild(card);

    var overflowPrevio = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.body.appendChild(overlay);

    function habilitar() {
      if (!check.disabled) return;
      check.disabled = false;
      label.classList.remove('pw-check--off');
      aviso.hidden = true;
    }
    function revisarFinal() {
      if (scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 32) habilitar();
    }
    scroll.addEventListener('scroll', revisarFinal);
    check.addEventListener('change', function () { btn.disabled = !check.checked; });

    montarPolitica(doc, cfg.apiBase).then(function () {
      cargando.remove();
      setTimeout(revisarFinal, 300);   // si el texto cabe entero, no hay nada que desplazar
    }).catch(function () {
      // No se pudo traer el texto: se deja leerla en otra pestaña y aceptar igualmente.
      cargando.textContent = 'No se pudo mostrar la política aquí. Ábrela con el enlace de abajo, léela y luego acepta.';
      habilitar();
    });

    btn.addEventListener('click', async function () {
      if (!check.checked) return;
      btn.disabled = true; btn.textContent = 'Guardando…'; error.hidden = true;
      try {
        var token = await cfg.getToken();
        var r = await fetch(cfg.apiBase + '/api/privacy/accept', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ app: cfg.app || null, version: estado.version || null })
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        overlay.remove();
        document.body.style.overflow = overflowPrevio;
      } catch (e) {
        error.textContent = 'No se pudo registrar la aceptación (' + e.message + '). Inténtalo de nuevo.';
        error.hidden = false;
        btn.disabled = false; btn.textContent = 'Aceptar y continuar';
      }
    });

    scroll.focus();
  }

  var PrivacyWidget = {
    // Consulta si este usuario debe aceptar y, si le falta, muestra el pop-up.
    async init(opts) {
      var cfg = {
        apiBase: String((opts && opts.apiBase) || ORIGEN || '').replace(/\/$/, ''),
        getToken: (opts && opts.getToken) || function () { return null; },
        app: (opts && opts.app) || null
      };
      try {
        // En algunos paneles el token tarda un instante en estar listo tras el login.
        var token = await cfg.getToken();
        for (var i = 0; !token && i < 10; i++) {
          await new Promise(function (ok) { setTimeout(ok, 1000); });
          token = await cfg.getToken();
        }
        if (!token) return;
        var r = await fetch(cfg.apiBase + '/api/privacy/status', { headers: { Authorization: 'Bearer ' + token } });
        if (!r.ok) return;
        var estado = await r.json();
        if (estado && estado.required && !estado.accepted) mostrar(cfg, estado);
      } catch (_) { /* el inbox no respondió: no se bloquea el panel */ }
    }
  };

  global.PrivacyWidget = PrivacyWidget;
})(window);
