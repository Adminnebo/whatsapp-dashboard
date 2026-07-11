/* =========================================================
   auth.js — Wrapper de Supabase Auth reutilizable (frontend).
   Expone window.Auth. Carga la config desde /api/auth/config y supabase-js
   desde CDN. Mantiene Auth.currentToken actualizado para que las llamadas al
   API incluyan el Bearer.
   ========================================================= */
(function (global) {
  'use strict';
  let sb = null, ready = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('No se pudo cargar ' + src));
      document.head.appendChild(s);
    });
  }

  async function init() {
    if (ready) return ready;
    ready = (async () => {
      const cfg = await fetch('/api/auth/config').then(r => r.json()).catch(() => ({ configured: false }));
      Auth.configured = !!cfg.configured;
      if (!cfg.configured) return null;   // sin Supabase: modo abierto (no bloquea)
      if (!global.supabase) await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js');
      sb = global.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, storageKey: 'nebo-auth' }
      });
      const { data } = await sb.auth.getSession();
      Auth.currentToken = data.session ? data.session.access_token : null;
      sb.auth.onAuthStateChange((_e, session) => { Auth.currentToken = session ? session.access_token : null; });
      return sb;
    })();
    return ready;
  }

  const Auth = {
    currentToken: null,
    configured: false,

    async signIn(email, password) {
      await init();
      if (!sb) throw new Error('Auth no configurado');
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      Auth.currentToken = data.session ? data.session.access_token : null;
      return data;
    },
    async signOut() {
      await init();
      if (sb) await sb.auth.signOut();
      Auth.currentToken = null;
      location.href = '/login.html';
    },
    async session() { await init(); if (!sb) return null; const { data } = await sb.auth.getSession(); return data.session; },
    async token() { const s = await Auth.session(); return s ? s.access_token : null; },

    // Redirige a /login.html si no hay sesión; si Supabase no está configurado, no bloquea.
    async requireSession() {
      await init();
      if (!Auth.configured) return { unconfigured: true };
      const s = await Auth.session();
      if (!s) { location.href = '/login.html'; return null; }
      return s;
    },

    // fetch con Authorization Bearer; si el token expiró (401) manda al login.
    async fetch(url, opts) {
      opts = opts || {};
      const t = await Auth.token();
      opts.headers = Object.assign({}, opts.headers, t ? { Authorization: 'Bearer ' + t } : {});
      const res = await fetch(url, opts);
      if (res.status === 401) { location.href = '/login.html'; }
      return res;
    },

    async me() { const r = await Auth.fetch('/api/auth/me'); return r.ok ? r.json() : null; }
  };

  global.Auth = Auth;
})(window);
