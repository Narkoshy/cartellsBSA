// config.js — Auditoria només de carteles.html i admin/index.html
// -----------------------------------------------
// - Sense efectes col·laterals (només lectura).
// - Proves “reals” contra Supabase (SELECT) per validar claus/policies.
// - La resta de punts que depenen de runtime en cada pàgina es marquen “Prova manual”.
// -----------------------------------------------

// === CONFIG (agafa del guard si existeix) ===
const SUPABASE_URL  = (window.ENV_SUPABASE_URL  || "https://wnkgzpgagprncbtqnzrw.supabase.co").trim();
const SUPABASE_ANON = (window.ENV_SUPABASE_ANON || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indua2d6cGdhZ3BybmNidHFuenJ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTUxNjQyNTQsImV4cCI6MjA3MDc0MDI1NH0.sXkV7N9Y2nDOTA3tZpWkAhs2SCGriXJWyieglxxFIRY").trim();

// ==== APPS A AUDITAR ====
const APPS = [
  {
    id: 'cartells',
    name: 'Cartells i Protocols (carrusel)',
    path: '../carteles.html',
    checks: [
      { id:'page_200',     title:'Pàgina accessible (200)',            desc:'El fitxer carteles.html es carrega bé.',        weight:1 },
      { id:'supabase_ro',  title:'Supabase (lectura documents)',       desc:'SELECT a taula `documents` OK.',                 weight:2 },
      { id:'filters',      title:'Filtres de servei/tipus (manual)',   desc:'Persistència i canvi sense errors.',             weight:1 },
      { id:'carousel',     title:'Carrusel i zoom (manual)',           desc:'Swiper s’inicialitza i navega.',                 weight:1 },
      { id:'links',        title:'Botó “Obrir” (manual)',              desc:'Obre imatge/PDF correctament.',                  weight:1 },
      { id:'autosleep',    title:'Retorn automàtic (manual)',          desc:'Compte enrere i retorn al monitor.',             weight:1 },
    ]
  },
  {
    id: 'admin',
    name: 'Admin (gestor de fitxers)',
    path: './index.html',
    checks: [
      { id:'page_200',     title:'Pàgina accessible (200)',            desc:'El fitxer admin/index.html es carrega bé.',      weight:1 },
      { id:'auth_guard',   title:'Auth guard referenciat',             desc:'Inclou `auth-guard.js` a la pàgina.',            weight:2 },
      { id:'supabase_ro',  title:'Supabase (lectura documents)',       desc:'SELECT a taula `documents` OK.',                 weight:2 },
      { id:'thumbnails',   title:'Miniatures presents (si n’hi ha)',   desc:'Alguns registres tenen `thumb_url`.',            weight:1 },
      { id:'filters_admin',title:'Filtres llista (manual)',            desc:'Filtra per servei/text correctament.',           weight:1 },
      { id:'review',       title:'Semàfors de revisió (manual)',       desc:'Càlcul ok / proper / caducat.',                  weight:1 },
    ]
  },
];

// ==== Helpers DOM ====
const $  = (s, r=document)=>r.querySelector(s);
const $$ = (s, r=document)=>Array.from(r.querySelectorAll(s));

const grid = $('#auditGrid');
const tpl  = $('#cardTpl');

const results = {}; // { appId: { status, checks: {checkId: {status, note}} } }
const sevOrder = { ok:0, warn:1, err:2 };
const worst = (a,b)=> sevOrder[a] >= sevOrder[b] ? a : b;

// ==== Render targetes ====
function renderCards(){
  grid.innerHTML = '';
  for (const app of APPS){
    const card = tpl.content.firstElementChild.cloneNode(true);
    card.dataset.app = app.id;
    card.querySelector('.app-name').textContent = app.name;
    card.querySelector('.app-path').textContent = app.path;

    const chip = card.querySelector('.app-chip');
    chip.textContent = 'Sense dades';
    chip.className = 'chip ok app-chip';

    const runBtn = card.querySelector('.app-run');
    runBtn.addEventListener('click', ()=> runAudit(app.id));

    const list = card.querySelector('.checks');
    for (const c of app.checks){
      const row = document.createElement('div');
      row.className = 'check';
      row.dataset.check = c.id;
      row.innerHTML = `
        <div>
          <div class="title">${c.title}</div>
          <div class="desc">${c.desc}</div>
        </div>
        <div class="right">
          <span class="chip ok" data-role="status">pendent</span>
          <button class="btn-sm" data-role="fix" type="button">Provar</button>
        </div>
      `;
      row.querySelector('[data-role="fix"]').addEventListener('click', ()=> testCheck(app, c, row));
      list.appendChild(row);
    }
    grid.appendChild(card);
  }
}

// ==== Core de proves (no destructiu) ====
async function testCheck(app, check, rowEl){
  let status = 'ok', note = '';

  try {
    if (check.id === 'page_200') {
      const res = await fetch(app.path, { method:'GET', cache:'no-store' });
      status = res.ok ? 'ok' : 'err';
      note   = res.ok ? `HTTP ${res.status}` : `HTTP ${res.status}`;
    }

    else if (check.id === 'auth_guard') {
      // comprovem que el HTML conté auth-guard.js
      const html = await (await fetch(app.path, { cache:'no-store' })).text();
      const has = /auth-guard\.js/.test(html);
      status = has ? 'ok' : 'err';
      note   = has ? 'auth-guard.js detectat' : 'No s’ha trobat auth-guard.js';
    }

    else if (check.id === 'supabase_ro') {
      const supabase = await ensureSupabase();
      // lectura segura de documents (primeres 1‑3 files)
      const { data, error } = await supabase
        .from("documents")
        .select("id, title, file_url, thumb_url")
        .limit(3);

      if (error) {
        status = 'err';
        note = `SELECT error: ${error.message || error}`;
      } else {
        status = 'ok';
        note = `Docs: ${data?.length ?? 0}`;
      }
    }

    else if (check.id === 'thumbnails') {
      const supabase = await ensureSupabase();
      const { data, error } = await supabase
        .from("documents")
        .select("id, thumb_url")
        .not("thumb_url", "is", null)
        .limit(1);

      if (error) {
        status = 'warn';
        note = `No he pogut comprovar: ${error.message || error}`;
      } else if ((data?.length || 0) > 0) {
        status = 'ok';
        note = 'Hi ha miniatures';
      } else {
        status = 'warn';
        note = 'Cap miniatura trobada (opcional)';
      }
    }

    // Checks manualment verificables a cada pàgina
    else if (['filters','carousel','links','autosleep','filters_admin','review'].includes(check.id)) {
      status = 'warn';
      note = 'Prova manual recomanada a la pàgina corresponent';
    }

    else {
      status = 'ok';
      note = 'Sense incidències';
    }
  } catch (e) {
    status = 'err';
    note = (e && e.message) ? e.message : String(e);
  }

  // Pinta fila
  const badge = rowEl.querySelector('[data-role="status"]');
  badge.textContent = status.toUpperCase();
  badge.className = `chip ${status}`;

  // Desa resultat i actualitza resum
  results[app.id] = results[app.id] || { status:'ok', checks:{} };
  results[app.id].checks[check.id] = { status, note };
  updateAppChip(app.id);
  updateGlobalSummary();
}

// ==== Resums ====
function updateAppChip(appId){
  const card = grid.querySelector(`.card[data-app="${appId}"]`);
  if (!card) return;
  const chip = card.querySelector('.app-chip');

  const appRes = results[appId];
  if (!appRes || !appRes.checks) {
    chip.textContent = 'Sense dades';
    chip.className = 'chip ok app-chip';
    return;
  }
  const worstStatus = Object.values(appRes.checks).reduce((acc, c)=> worst(acc, c.status), 'ok');
  appRes.status = worstStatus;

  chip.textContent = worstStatus === 'ok' ? 'OK' : worstStatus === 'warn' ? 'AVÍS' : 'ERROR';
  chip.className = `chip ${worstStatus} app-chip`;
}

async function runAudit(appId){
  const app = APPS.find(a => a.id === appId);
  if (!app) return;
  const card = grid.querySelector(`.card[data-app="${appId}"]`);
  const rows = $$('.check', card);
  for (const r of rows){
    const id = r.dataset.check;
    const check = app.checks.find(c => c.id === id);
    // eslint-disable-next-line no-await-in-loop
    await testCheck(app, check, r);
  }
}

async function runAll(){
  for (const app of APPS){
    // eslint-disable-next-line no-await-in-loop
    await runAudit(app.id);
  }
}

function updateGlobalSummary(){
  const chip = document.getElementById('summaryChip');
  const all = Object.values(results).map(r => r.status || 'ok');
  const g = all.reduce((acc, s)=> worst(acc, s), 'ok');
  chip.textContent = `Global: ${g.toUpperCase()}`;
  chip.className = `chip ${g}`;
}

// ==== Export JSON ====
function exportJSON(){
  const payload = {
    generatedAt: new Date().toISOString(),
    base: location.href,
    apps: APPS.map(a => ({ id:a.id, name:a.name, path:a.path })),
    results
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'audit-report.json';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// ==== Supabase helper (reutilitza client del guard si el tens) ====
async function ensureSupabase(){
  if (window.supabaseClient) return window.supabaseClient;
  // carrega UMD si cal
  if (!window.supabase) {
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  // crea client temporal de lectura
  // eslint-disable-next-line no-undef
  return window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
    auth: { persistSession:false, autoRefreshToken:false, detectSessionInUrl:false },
  });
}

// ==== Init ====
renderCards();
document.getElementById('btnAuditAll')?.addEventListener('click', runAll);
document.getElementById('btnExport')?.addEventListener('click', exportJSON);

// Mostra email si el guard l’ha exposat
window.addEventListener('load', ()=>{
  const email = window.__SESSION_EMAIL__ || '—';
  const span = document.getElementById('currentUserEmail');
  if (span) span.textContent = email;
});