// admin/auth-guard.js — resiliente (ESM + UMD) i sense hard‑refresh

// === Ajustos (poden venir per window.ENV_* en prod) ===
const SUPABASE_URL  = (window.ENV_SUPABASE_URL  || "https://wnkgzpgagprncbtqnzrw.supabase.co").trim();
const SUPABASE_ANON = (window.ENV_SUPABASE_ANON || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indua2d6cGdhZ3BybmNidHFuenJ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTUxNjQyNTQsImV4cCI6MjA3MDc0MDI1NH0.sXkV7N9Y2nDOTA3tZpWkAhs2SCGriXJWyieglxxFIRY").trim();

// === Utils ===
const isLogin      = /\/login\.html$/i.test(location.pathname);
const sleep        = (ms) => new Promise(r => setTimeout(r, ms));
const isLocalhost  = /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(location.origin);

// Evita doble arrencada si s'inclou dues vegades accidentalment
if (window.__AUTH_GUARD_BOOTED__) {
  // Ja està en marxa: només exposem el client si existeix
  if (window.supabaseClient) exposeClient(window.supabaseClient);
} else {
  window.__AUTH_GUARD_BOOTED__ = true;
  boot().catch(err => {
    console.error("[auth-guard] error en boot:", err);
    // En cas extrem permet veure la pàgina (útil per depurar)
    safeAuthOk();
  });
}

// === Arrencada principal ===
async function boot() {
  const client = await getClient();
  exposeClient(client);

  if (isLogin) {
    // Si ja hi ha sessió → redirigeix a on toqui
    const { data: { session } } = await client.auth.getSession();
    if (session?.user) {
      const params = new URLSearchParams(location.search);
      const to = params.get("redirect") || "./index.html";
      if (!samePathAsCurrent(to)) location.replace(to);
      return;
    }
    // Mostra el login i escolta canvis
    safeAuthOk();
    client.auth.onAuthStateChange((_event, s) => {
      if (s?.user) {
        const params = new URLSearchParams(location.search);
        const to = params.get("redirect") || "./index.html";
        if (!samePathAsCurrent(to)) location.replace(to);
      }
    });
    return;
  }

  // Pàgines protegides: espera sessió “estable”
  const session = await getStableSession(client, 8, 150);
  if (session?.user) {
    window.__SESSION_EMAIL__ = session.user.email || "—";
    safeAuthOk();
  } else {
    // Sense sessió → a login amb retorn
    const redirect = encodeURIComponent(location.pathname + location.search);
    location.replace(`./login.html?redirect=${redirect}`);
    return;
  }

  // Reacciona a canvis (p. ex. signOut)
  client.auth.onAuthStateChange((event, sessionNow) => {
    if (event === "SIGNED_OUT" || !sessionNow?.user) {
      const redirect = encodeURIComponent(location.pathname + location.search);
      location.replace(`./login.html?redirect=${redirect}`);
    }
  });
}

// === Carrega del SDK de Supabase (intenta ESM i cau a UMD) ===
async function getCreateClient() {
  // 0) Global ja present?
  if (window.supabase?.createClient) return window.supabase.createClient;

  // 1) ESM via jsDelivr (+esm dona CORS correcte). Pina la versió.
  try {
    const ver = "2.55.0"; // fixa si vols reproduïbilitat
    const cacheBust = isLocalhost ? `?v=${Date.now()}` : "";
    const mod = await import(`https://cdn.jsdelivr.net/npm/@supabase/supabase-js@${ver}/+esm${cacheBust}`);
    if (mod?.createClient) return mod.createClient;
  } catch (e) {
    console.warn("[auth-guard] import ESM ha fallat, provant UMD…", e);
  }

  // 2) Fallback UMD (window.supabase)
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
    if (isLocalhost) s.src += `?v=${Date.now()}`; // evita caché agressiva en dev
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error("No s'ha pogut carregar supabase UMD"));
    document.head.appendChild(s);
  });

  if (!window.supabase?.createClient) {
    throw new Error("supabase global no disponible després d'UMD");
  }
  return window.supabase.createClient;
}

async function getClient() {
  // Reutilitza el mateix client a tot admin/*
  if (window.supabaseClient?.auth) return window.supabaseClient;

  const createClient = await getCreateClient();
  const client = createClient(SUPABASE_URL, SUPABASE_ANON, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storage: window.localStorage,
    },
    global: {
      // En dev, evita que fetch deixi res en caché
      fetch: (url, opts = {}) => {
        const noCache = isLocalhost ? { cache: "no-store" } : {};
        return fetch(url, { ...opts, ...noCache });
      },
    },
  });

  window.supabaseClient = client;
  return client;
}

// === Helpers de sessió / DOM ===
async function getStableSession(client, maxAttempts = 6, delayMs = 120) {
  for (let i = 0; i < maxAttempts; i++) {
    const { data: { session } } = await client.auth.getSession();
    if (session?.user) return session;
    await sleep(delayMs);
  }
  return null;
}

function safeAuthOk() {
  // Crida __AUTH_OK__ només una vegada (el callback posa body.auth-ready)
  if (!document.body.classList.contains("auth-ready")) {
    window.__AUTH_OK__?.();
  }
}

function exposeClient(client) {
  // Idempotent; alguns scripts ho esperen
  window.supabaseClient = client;
}

function samePathAsCurrent(relOrAbs) {
  try {
    const u = new URL(relOrAbs, location.href);
    return (u.pathname + u.search) === (location.pathname + location.search);
  } catch { return false; }
}