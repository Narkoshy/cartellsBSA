<!-- admin/auth-guard.js -->
<script type="module">
  import { createClient } from "https://unpkg.com/@supabase/supabase-js@2/dist/esm/index.js";

  const SUPABASE_URL = "https://wnkgzpgagprncbtqnzrw.supabase.co";
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indua2d6cGdhZ3BybmNidHFuenJ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTUxNjQyNTQsImV4cCI6MjA3MDc0MDI1NH0.sXkV7N9Y2nDOTA3tZpWkAhs2SCGriXJWyieglxxFIRY";
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // 1) Si no hay sesión → redirige a login
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) {
    window.location.replace("./login.html");
  }

  // 2) Expone utilidades globales
  window.__auth = {
    supabase,
    async signOut(){
      await supabase.auth.signOut();
      window.location.replace("./login.html");
    },
    async getUser(){
      const { data: { user } } = await supabase.auth.getUser();
      return user || null;
    }
  };

  // 3) (Opcional) Rellena datos de usuario si hay contenedores
  const who = document.querySelector('#currentUserEmail');
  if (who && session?.user?.email) who.textContent = session.user.email;

  // 4) Protege reactivo: si cambia el estado a "signed_out", saca de aquí
  supabase.auth.onAuthStateChange((_event, sess) => {
    if (!sess?.user) window.location.replace("./login.html");
  });
</script>