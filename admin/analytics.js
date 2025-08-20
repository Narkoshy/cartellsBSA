// admin/analytics.js — Quadre de comandament (lectura robusta)

(() => {
  // ===== Utilidades =====
  const byId = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Evita problemas con ids acentuados: solo getElementById
  const el = {
    // KPIs
    kpiActius:     byId('kpiActius'),
    kpiConsultes:  byId('kpiConsultes'),
    kpiDocs:       byId('kpiDocs'),
    kpiCad:        byId('kpiCad'),

    // Inputs
    monthsInput:   byId('monthsInput'),
    btnRefresh:    byId('btnRefresh'),

    // Tablas/zonas
    taulaUltimes:  byId('taulaÚltimes'),
    taulaCad:      byId('taulaCad'),
    taulaDocs:     byId('taulaDocs'),

    // Charts
    cvsTop:        byId('chartTop'),
    cvsServeis:    byId('chartServeis'),
    cvsSerie:      byId('chartSèrie'),
    cvsTipus:      byId('chartTipus'),

    // Export
    expCsv:        byId('expCsv'),
    expJson:       byId('expJson'),
    expTableCsv:   byId('expTableCsv'),

    // Filtres del llistat
    searchInput:   byId('searchInput'),
    filterServei:  byId('filterServei'),
    filterEstat:   byId('filterEstat'),
  };

  // ===== Espera auth y cliente =====
  async function waitAuthReady() {
    if (document.body.classList.contains('auth-ready')) return;
    await new Promise(res => document.addEventListener('auth-ready', res, { once:true }));
  }
  async function getSupabaseClient(maxMs = 4000) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      if (window.supabaseClient?.auth) return window.supabaseClient;
      await sleep(50);
    }
    // Fallback: si alguien cargó UMD global
    if (window.supabase?.createClient) {
      const SUPABASE_URL  = (window.ENV_SUPABASE_URL  || "https://wnkgzpgagprncbtqnzrw.supabase.co").trim();
      const SUPABASE_ANON = (window.ENV_SUPABASE_ANON || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indua2d6cGdhZ3BybmNidHFuenJ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTUxNjQyNTQsImV4cCI6MjA3MDc0MDI1NH0.sXkV7N9Y2nDOTA3tZpWkAhs2SCGriXJWyieglxxFIRY").trim();
      window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
        auth: { persistSession:true, autoRefreshToken:true, detectSessionInUrl:true }
      });
      return window.supabaseClient;
    }
    throw new Error('Supabase no inicialitzat');
  }

  // ===== Datasets (para export) =====
  const datasets = {
    top5: [],
    serveis: [],
    series: [],
    tipusDocs: [],
    ultimesAdmin: [],
    docsCad: [],
    docsTable: [],
  };

  // ===== Consultas con fallback =====
  async function selectFirst(names, select = '*', filters = (q)=>q) {
    const supabase = await getSupabaseClient();
    for (const name of names) {
      try {
        let q = supabase.from(name).select(select);
        q = filters(q);
        const { data, error } = await q;
        if (!error) return { data, used: name };
        if (error?.code !== 'PGRST205') { // error real (no existe en schema cache -> probamos otra)
          console.warn(`[analytics] error en ${name}:`, error);
          return { data: [], used: name, error };
        }
      } catch (e) {
        console.warn(`[analytics] excepción en ${name}:`, e);
      }
    }
    return { data: [], used: null, error: new Error('cap vista coincident') };
  }

  // --- Top5 por doc (30d) ---
  async function readTop5() {
    const sinceIso = new Date(Date.now() - 30*864e5).toISOString();
    // 1) Vistas si existen
    let { data, used } = await selectFirst(
      ['v_top5_last_30', 'view_logs_top_docs'],
      '*'
    );
    if (used) {
      const items = (data||[]).map(r => ({
        doc_id: r.doc_id || r.id || null,
        title: r.title || r.doc_title || '—',
        views: Number(r.views || r.count || 0),
      }));
      return items.slice(0, 5);
    }
    // 2) Fallback: contamos en cliente desde view_logs
    const supabase = await getSupabaseClient();
    const { data: logs, error } = await supabase
      .from('view_logs')
      .select('doc_id')
      .gte('created_at', sinceIso)
      .limit(10000);
    if (error) { console.warn('[top5 fallback] view_logs:', error); return []; }
    const counts = new Map();
    (logs||[]).forEach(l => counts.set(l.doc_id, (counts.get(l.doc_id)||0)+1));
    // cruzamos con documents para los títulos
    const { data: docs } = await supabase.from('documents').select('id,title');
    const titleById = new Map((docs||[]).map(d => [d.id, d.title||'—']));
    return Array.from(counts.entries())
      .map(([doc_id, views]) => ({ doc_id, title: titleById.get(doc_id)||'—', views }))
      .sort((a,b)=>b.views-a.views).slice(0,5);
  }

  // --- Uso por servicio (30d) ---
  async function readUsageByService() {
    const { data, used } = await selectFirst(
      ['v_usage_by_service_30', 'view_logs_by_service'],
      '*'
    );
    if (used) {
      return (data||[]).map(r => ({
        service: r.service || r.origin || '—',
        views: Number(r.views || r.count || 0),
      }));
    }
    // Fallback: contamos en cliente por service
    const sinceIso = new Date(Date.now() - 30*864e5).toISOString();
    const supabase = await getSupabaseClient();
    const { data: logs } = await supabase.from('view_logs').select('doc_id').gte('created_at', sinceIso).limit(10000);
    const ids = [...new Set((logs||[]).map(l=>l.doc_id))];
    const { data: docs } = await supabase.from('documents').select('id,service').in('id', ids);
    const svcById = new Map((docs||[]).map(d => [d.id, d.service || '—']));
    const acc = {};
    (logs||[]).forEach(l => {
      const svc = svcById.get(l.doc_id) || '—';
      acc[svc] = (acc[svc]||0) + 1;
    });
    return Object.entries(acc).map(([service, views]) => ({ service, views }));
  }

  // --- Serie por día (30d) ---
  async function readViewsByDay() {
    const { data, used } = await selectFirst(
      ['v_views_by_day_30', 'view_logs_daily'],
      '*'
    );
    if (used) {
      return (data||[]).map(r => ({
        day: r.day || r.date || r.d || r.ts || null,
        views: Number(r.views || r.count || 0),
      })).sort((a,b)=> String(a.day).localeCompare(String(b.day)));
    }
    // Fallback: contamos por fecha desde view_logs
    const sinceIso = new Date(Date.now() - 30*864e5).toISOString();
    const supabase = await getSupabaseClient();
    const { data: logs } = await supabase.from('view_logs').select('created_at').gte('created_at', sinceIso).limit(10000);
    const acc = {};
    (logs||[]).forEach(l => {
      const d = (l.created_at||'').slice(0,10);
      if (!d) return;
      acc[d] = (acc[d]||0) + 1;
    });
    return Object.entries(acc).map(([day, views])=>({ day, views })).sort((a,b)=>a.day.localeCompare(b.day));
  }

  // --- Docs por tipo ---
  async function readDocsByKind() {
    const { data, used } = await selectFirst(['v_docs_by_kind', 'documents_by_kind'], '*');
    if (used) return (data||[]).map(r => ({ kind: r.kind || '—', count: Number(r.count || r.n || 0) }));
    const supabase = await getSupabaseClient();
    const { data: docs } = await supabase.from('documents').select('kind');
    const acc = {};
    (docs||[]).forEach(d => { const k = d.kind || '—'; acc[k] = (acc[k]||0)+1; });
    return Object.entries(acc).map(([kind,count])=>({ kind, count }));
  }

  // --- Últimes 5 admin ---
  async function readLast5Admin() {
    const { data } = await selectFirst(['v_last5_admin', 'admin_actions_last5', 'admin_actions_recent'], '*');
    return (data||[]).map(r => ({
      action: r.action || r.verb || '—',
      actor:  r.actor_email || r.actor || r.email || '—',
      when:   r.created_at || r.ts || r.at || null,
      title:  r.doc_title || r.title || '—',
    }));
  }

  // --- Documents bàsics + caducitat + consultes(30d) per taula ---
  function addMonths(d, months) {
    const dt = new Date(d);
    if (isNaN(dt)) return null;
    return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + months, dt.getUTCDate()));
  }
  function daysBetween(a,b){ return Math.floor((b-a)/86400000); }

  function computeCaducitat(docs, months){
    const now = new Date();
    const soonDays = 30;
    let cad=0, soon=0, ok=0;
    const det=[];
    for (const d of docs){
      const basisStr = d.valid_from || d.updated_at || d.created_at || null;
      const basis = basisStr ? new Date(basisStr) : null;
      const expireAt = basis ? addMonths(basis, months) : null;
      let status = 'sense-data';
      if (expireAt){
        if (expireAt < now) status = 'caducat';
        else status = (daysBetween(now, expireAt) <= soonDays) ? 'proper' : 'ok';
      }
      if (status==='caducat') cad++; else if (status==='proper') soon++; else if (status==='ok') ok++;
      det.push({ id:d.id, title:d.title||'—', expireAt: expireAt ? expireAt.toISOString().slice(0,10) : null, status });
    }
    return { caducats: cad, propers: soon, enTermini: ok, detalls: det };
  }

  async function readDocsAndViewsForTable(vigenciaMonths){
    const supabase = await getSupabaseClient();
    const [{ data: docs }, viewsMap] = await Promise.all([
      supabase.from('documents').select('id,title,kind,service,published,created_at,updated_at,valid_from'),
      (async()=>{
        // contamos view_logs últimos 30d -> mapa doc_id -> views
        const sinceIso = new Date(Date.now() - 30*864e5).toISOString();
        try{
          const { data: logs, error } = await supabase
            .from('view_logs')
            .select('doc_id,created_at')
            .gte('created_at', sinceIso)
            .limit(20000);
          if (error) { console.warn('[views table] view_logs:', error); return new Map(); }
          const m = new Map();
          (logs||[]).forEach(l => m.set(l.doc_id, (m.get(l.doc_id)||0)+1));
          return m;
        }catch(e){ return new Map(); }
      })()
    ]);

    const cad = computeCaducitat(docs||[], vigenciaMonths);
    const cadById = new Map(cad.detalls.map(x=>[x.id,x]));
    const rows = (docs||[]).map(d => {
      const c = cadById.get(d.id);
      return {
        id: d.id,
        title: d.title || '—',
        kind: d.kind || '—',
        service: d.service || '—',
        published: d.published === true ? 'Sí' : 'No',
        user: '—', // si más adelante guardáis owner/actor en documents, lo pintamos aquí
        expireAt: c?.expireAt || '—',
        status: c?.status || '—',
        views30: Number(viewsMap.get(d.id) || 0),
      };
    });
    return { rows, cadSummary: cad };
  }

  // ===== Render =====
  function setNumber(node, n){ if (node) node.textContent = (n==null ? '—' : String(n)); }
  function renderKpis({ actius, consultesTotals, docsTotals, cad }){
    setNumber(el.kpiActius, actius);
    setNumber(el.kpiConsultes, consultesTotals);
    setNumber(el.kpiDocs, docsTotals);
    if (el.kpiCad) el.kpiCad.textContent = `${cad.caducats} / ${cad.propers}`;
  }
  function ensureChart(canvasEl, type, data, options={}){
    if (!canvasEl) return null;
    if (canvasEl.__chart) { canvasEl.__chart.destroy(); canvasEl.__chart = null; }
    const c = new Chart(canvasEl, { type, data, options });
    canvasEl.__chart = c;
    return c;
  }
  function renderCharts({ top5, serveis, series, tipus }){
    datasets.top5 = top5;
    datasets.serveis = serveis;
    datasets.series = series;
    datasets.tipusDocs = tipus;

    ensureChart(el.cvsTop, 'bar', {
      labels: top5.map(x=>x.title),
      datasets: [{ label:'Consultes (30 dies)', data: top5.map(x=>x.views) }]
    }, { plugins:{legend:{display:false}}, scales:{y:{beginAtZero:true}} });

    ensureChart(el.cvsServeis, 'bar', {
      labels: serveis.map(x=>x.service||'—'),
      datasets: [{ label:'Consultes per servei (30 dies)', data: serveis.map(x=>x.views) }]
    }, { plugins:{legend:{display:false}}, scales:{y:{beginAtZero:true}} });

    ensureChart(el.cvsSerie, 'line', {
      labels: series.map(x=>x.day),
      datasets: [{ label:'Consultes / dia (30 dies)', data: series.map(x=>x.views), tension:0.25 }]
    }, { plugins:{legend:{display:false}}, scales:{y:{beginAtZero:true}} });

    ensureChart(el.cvsTipus, 'bar', {
      labels: tipus.map(x=>x.kind),
      datasets: [{ label:'Documents per tipus', data: tipus.map(x=>x.count) }]
    }, { plugins:{legend:{display:false}}, scales:{y:{beginAtZero:true}} });
  }
  const esc = (s)=>String(s).replace(/[&<>"']/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  function renderUltimes(items){
    datasets.ultimesAdmin = items;
    const tb = el.taulaUltimes;
    if (!tb) return;
    tb.innerHTML = '';
    if (!items.length){ tb.innerHTML = `<tr><td colspan="3" class="muted">—</td></tr>`; return; }
    for (const it of items){
      const when = it.when ? new Date(it.when).toLocaleString() : '—';
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${esc(it.title||'—')}</td><td>${esc(it.actor||'—')}</td><td>${esc(when)}</td>`;
      tb.appendChild(tr);
    }
  }
  function renderCadSummary(cad){
    datasets.docsCad = cad.detalls;
    const tb = el.taulaCad;
    if (!tb) return;
    tb.innerHTML = `
      <tr><td>Caducats</td><td>${cad.caducats}</td></tr>
      <tr><td>Propers (&le; 30 dies)</td><td>${cad.propers}</td></tr>
      <tr><td>En termini</td><td>${cad.enTermini}</td></tr>
    `;
  }
  function badge(status){
    if (status==='ok') return `<span class="badge b-ok">En termini</span>`;
    if (status==='proper') return `<span class="badge b-soon">Proper (&le;30d)</span>`;
    if (status==='caducat') return `<span class="badge b-over">Caducat</span>`;
    return `<span class="badge">${esc(status||'—')}</span>`;
  }
  function renderDocsTable(rows){
    datasets.docsTable = rows;
    const tb = el.taulaDocs;
    if (!tb) return;
    const txt = (v)=> esc(v==null?'—':v);
    if (!rows.length){ tb.innerHTML = `<tr><td colspan="8" class="muted">—</td></tr>`; return; }
    tb.innerHTML = rows.map(r => `
      <tr>
        <td>${txt(r.title)}</td>
        <td>${txt(r.kind)}</td>
        <td>${txt(r.service)}</td>
        <td class="nowrap">${txt(r.published)}</td>
        <td>${txt(r.user)}</td>
        <td class="nowrap">${txt(r.expireAt)}</td>
        <td>${badge(r.status)}</td>
        <td class="nowrap">${r.views30}</td>
      </tr>
    `).join('');
  }

  // ===== Export =====
  el.expJson?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(datasets, null, 2)], { type:'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `analytics-${new Date().toISOString().slice(0,10)}.json`;
    a.click(); URL.revokeObjectURL(a.href);
  });
  el.expCsv?.addEventListener('click', () => {
    const parts = [];
    const csvCell = (v)=> {
      if (v==null) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
    };
    const push = (name, rows) => {
      if (!rows?.length) return;
      const cols = Object.keys(rows[0]);
      parts.push(`# ${name}`); parts.push(cols.join(','));
      for (const r of rows) parts.push(cols.map(k => csvCell(r[k])).join(','));
      parts.push('');
    };
    push('top5', datasets.top5);
    push('serveis', datasets.serveis);
    push('series', datasets.series);
    push('tipusDocs', datasets.tipusDocs);
    push('ultimesAdmin', datasets.ultimesAdmin);
    push('docsCad', datasets.docsCad);
    push('docsTable', datasets.docsTable);
    const blob = new Blob([parts.join('\n')], { type:'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `analytics-${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
  });
  el.expTableCsv?.addEventListener('click', () => {
    const rows = datasets.docsTable||[];
    const cols = ['title','kind','service','published','user','expireAt','status','views30'];
    const head = cols.join(',');
    const csvCell = (v)=> {
      if (v==null) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
    };
    const body = rows.map(r => cols.map(k => csvCell(r[k])).join(',')).join('\n');
    const blob = new Blob([head+'\n'+body], { type:'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `documents-${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
  });

  // ===== Filtres tabla (búsqueda/servei/estat) =====
  function applyFilters(allRows){
    const q = (el.searchInput?.value||'').trim().toLowerCase();
    const svc = el.filterServei?.value || '';
    const st  = el.filterEstat?.value || '';
    return allRows.filter(r => {
      const matchQ = !q || [r.title,r.kind,r.service,r.user].some(v => String(v||'').toLowerCase().includes(q));
      const matchSvc = !svc || r.service === svc;
      const norm = (s)=> s==='proper' ? 'soon' : (s==='caducat' ? 'overdue' : (s==='ok' ? 'ok' : s));
      const matchSt = !st || norm(r.status) === st;
      return matchQ && matchSvc && matchSt;
    });
  }

  el.searchInput?.addEventListener('input', () => renderDocsTable(applyFilters(datasets.docsTable)));
  el.filterServei?.addEventListener('change', () => renderDocsTable(applyFilters(datasets.docsTable)));
  el.filterEstat?.addEventListener('change', () => renderDocsTable(applyFilters(datasets.docsTable)));

  // ===== Ciclo de refresco =====
  async function refreshAll(){
    try{
      const vigencia = Math.max(1, Number(el.monthsInput?.value || 12));

      // Cargamos en paralelo
      const [ top5, serveis, series, tipus, ultimes ] = await Promise.all([
        readTop5(),
        readUsageByService(),
        readViewsByDay(),
        readDocsByKind(),
        readLast5Admin(),
      ]);

      // Docs + caducitat + views para tabla
      const { rows: tableRows, cadSummary } = await readDocsAndViewsForTable(vigencia);

      // KPIs
      const actius = tableRows.filter(r => r.published === 'Sí').length;
      const consultesTotals = series.reduce((acc,x)=>acc + (x.views||0), 0);
      const docsTotals = tableRows.length;

      // Render
      renderKpis({ actius, consultesTotals, docsTotals, cad: cadSummary });
      renderCharts({ top5, serveis, series, tipus });
      renderUltimes(ultimes);
      renderCadSummary(cadSummary);
      renderDocsTable(applyFilters(tableRows));
    } catch (e) {
      console.error('[analytics] refreshAll:', e);
    }
  }

  el.btnRefresh?.addEventListener('click', refreshAll);
  el.monthsInput?.addEventListener('change', refreshAll);

  // Bootstrap
  document.addEventListener('DOMContentLoaded', async () => {
    try{
      await waitAuthReady();
      await getSupabaseClient();
      await refreshAll();
    }catch(e){
      console.error('[analytics] bootstrap error:', e);
    }
  });
})();