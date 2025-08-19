// admin/auth-guard.js
// Bloquea acceso directo a /admin/* si no hay sesión o si el usuario no es admin.

const FALLBACK_SUPABASE_URL  = "https://wnkgzpgagprncbtqnzrw.supabase.co";
const FALLBACK_SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indua2d6cGdhZ3BybmNidHFuenJ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTUxNjQyNTQsImV4cCI6MjA3MDc0MDI1NH0.sXkV7N9Y2nDOTA3tZpWkAhs2SCGriXJWyieglxxFIRY";

// Preferimos variables inyectadas en runtime/build
const SB_URL  = (window.__SB && window.__SB.url)  || FALLBACK_SUPABASE_URL;
const SB_ANON = (window.__SB && window.__SB.anon) || FALLBACK_SUPABASE_ANON;

async function ensureSupabaseReady() {
  if (!window.supabase) {
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://unpkg.com/@supabase/supabase-js@2";
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  return window.supabase.createClient(SB_URL, SB_ANON);
}

function redirectToLogin() {
  const here = encodeURIComponent(location.pathname + location.search);
  location.replace(`/admin/login.html?redirect=${here}`);
}

function allowPage(user) {
  // Mostrar la página y “exponer” quien eres si quieres
  document.body.style.visibility = "visible";
  const span = document.getElementById("currentUserEmail");
  if (span && user?.email) span.textContent = user.email;
}

function isAdmin(user) {
  if (!user) return false;

  // 1) app_metadata.roles (p. ej. ["admin"])
  const roles = user.app_metadata?.roles || user.app_metadata?.role || [];
  if (Array.isArray(roles) && roles.includes("admin")) return true;
  if (typeof roles === "string" && roles === "admin") return true;

  // 2) user_metadata.role === "admin"
  if (user.user_metadata?.role === "admin") return true;

  // 3) fallback: dominio permitido (opcional)
  // return user.email?.endsWith("@tu-hospital.cat");

  return false;
}

(async () => {
  try {
    const sb = await ensureSupabaseReady();

    // 1) Sesión presente?
    const { data: sessData } = await sb.auth.getSession();
    const session = sessData?.session;
    if (!session) return redirectToLogin();

    // 2) Usuario + rol
    const { data: userData, error } = await sb.auth.getUser();
    if (error || !userData?.user) return redirectToLogin();

    if (!isAdmin(userData.user)) {
      // Opcional: cerrar sesión si no es admin
      try { await sb.auth.signOut(); } catch {}
      return redirectToLogin();
    }

    // 3) Todo OK → mostramos
    allowPage(userData.user);

    // 4) Auto-refresco del token/sesión: si expira, vuelve al login
    sb.auth.onAuthStateChange((_ev, newSession) => {
      if (!newSession) redirectToLogin();
    });

    // 5) Botón “tancar sessió” global (si existe)
    const logoutBtn = document.getElementById("btnLogout") || document.querySelector('[data-action="logout"]');
    if (logoutBtn) {
      logoutBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        try { await sb.auth.signOut(); } finally { redirectToLogin(); }
      });
    }
  } catch (e) {
    console.error("Auth guard error:", e);
    redirectToLogin();
  }
})();