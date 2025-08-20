// admin/auth-guard.js — resiliente (ESM + UMD) y sin hard-refresh

// === Ajustes (puedes inyectar por window.ENV_* en prod) ===
const SUPABASE_URL  = (window.ENV_SUPABASE_URL  || "https://wnkgzpgagprncbtqnzrw.supabase.co").trim();
const SUPABASE_ANON = (window.ENV_SUPABASE_ANON || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indua2d6cGdhZ3BybmNidHFuenJ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTUxNjQyNTQsImV4cCI6MjA3MDc0MDI1NH0.sXkV7N9Y2nDOTA3tZpWkAhs2SCGriXJWyieglxxFIRY").trim();

// === Utilidades básicas ===
const isLogin = /\/login\.html$/i.test(location.pathname);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(location.origin);

// Evita doble inicialización si se incluye dos veces accidentalmente
if (window.__AUTH_GUARD_BOOTED__) {
  // Ya en marcha: no hacer nada más (pero expón el cliente si existe)
  if (window.supabaseClient) {
    exposeClient(window.supabaseClient);
  }
} else {
  window.__AUTH_GUARD_BOOTED__ = true;
  boot().catch(err => {
    console.error("[auth-guard] fallo en boot:", err);
    // En caso extremo deja ver la página (útil para depurar)
    window.__AUTH_OK__?.();
  });
}

// === Arranque principal ===
async function boot() {
  const client = await getClient();
  exposeClient(client);

  if (isLogin) {
    // Si ya hay sesión, vete a redirect o index
    const { data: { session } } = await client.auth.getSession();
    if (session?.user) {
      const params = new URLSearchParams(location.search);
      const to = params.get("redirect") || "./index.html";
      // Evita loop si ya apunta al mismo lugar
      if (!samePathAsCurrent(to)) location.replace(to);
      return;
    }
    // Mostrar login
    window.__AUTH_OK__?.();
    // Escucha cambios por si el login ocurre en caliente
    client.auth.onAuthStateChange((_event, s) => {
      if (s?.user) {
        const params = new URLSearchParams(location.search);
        const to = params.get("redirect") || "./index.html";
        if (!samePathAsCurrent(to)) location.replace(to);
      }
    });
    return;
  }

  // Páginas protegidas (admin/*): espera sesión estable
  const session = await getStableSession(client, 8, 150);
  if (session?.user) {
    window.__SESSION_EMAIL__ = session.user.email || "—";
    safeAuthOk();
  } else {
    // Redirige a login con vuelta
    const redirect = encodeURIComponent(location.pathname + location.search);
    location.replace(`./login.html?redirect=${redirect}`);
    return;
  }

  // Reacciona a cambios (sign out, etc.)
  client.auth.onAuthStateChange((event, sessionNow) => {
    if (event === "SIGNED_OUT" || !sessionNow) {
      const redirect = encodeURIComponent(location.pathname + location.search);
      location.replace(`./login.html?redirect=${redirect}`);
    }
  });
}

// === Carga del SDK de Supabase (intenta ESM y cae a UMD) ===
async function getCreateClient() {
  // 0) ¿Ya existe el global?
  if (window.supabase?.createClient) return window.supabase.createClient;

  // 1) ESM con jsDelivr (+esm da CORS correcto). Pin de versión:
  try {
    const ver = "2.55.0"; // fija si quieres reproducibilidad
    const cacheBust = isLocalhost ? `?v=${Date.now()}` : "";
    const mod = await import(`https://cdn.jsdelivr.net/npm/@supabase/supabase-js@${ver}/+esm${cacheBust}`);
    if (mod?.createClient) return mod.createClient;
  } catch (e) {
    console.warn("[auth-guard] ESM import falló, probando UMD…", e);
  }

  // 2) Fallback UMD (window.supabase)
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
    // En dev, fuerza refresco si hay caché agresiva del navegador
    if (isLocalhost) s.src += `?v=${Date.now()}`;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error("No se pudo cargar supabase UMD"));
    document.head.appendChild(s);
  });

  if (!window.supabase?.createClient) {
    throw new Error("supabase global no disponible tras UMD");
  }
  return window.supabase.createClient;
}

async function getClient() {
  // Reutiliza el mismo cliente entre páginas admin/*
  if (window.supabaseClient?.auth) return window.supabaseClient;

  const createClient = await getCreateClient();
  const client = createClient(SUPABASE_URL, SUPABASE_ANON, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storage: window.localStorage, // explícito
    },
    global: {
      // Opcional: evita que fetch guarde en cache en dev
      fetch: (url, opts = {}) => {
        const noCache = isLocalhost ? { cache: "no-store" } : {};
        return fetch(url, { ...opts, ...noCache });
      },
    },
  });

  window.supabaseClient = client;
  return client;
}

// === Helpers de sesión/DOM ===
async function getStableSession(client, maxAttempts = 6, delayMs = 120) {
  for (let i = 0; i < maxAttempts; i++) {
    const { data: { session } } = await client.auth.getSession();
    if (session) return session;
    await sleep(delayMs);
  }
  return null;
}

function safeAuthOk() {
  // Llama a __AUTH_OK__ solo una vez
  if (!document.body.classList.contains("auth-ready")) {
    window.__AUTH_OK__?.();
  }
}

function exposeClient(client) {
  // Idempotente; algunos scripts esperan esto
  window.supabaseClient = client;
}

function samePathAsCurrent(relOrAbs) {
  try {
    const u = new URL(relOrAbs, location.href);
    return (u.pathname + u.search) === (location.pathname + location.search);
  } catch { return false; }
}