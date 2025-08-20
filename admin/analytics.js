// admin/analytics.js — Quadre de comandament (lectura resiliente)
// Requereix Chart.js a window.Chart i auth-guard (exposa window.supabaseClient)

(() => {
  const $  = (s, r=document)=>r.querySelector(s);

  // --- Bootstrap Supabase robust (igual que versión anterior) ---
  const SUPABASE_URL  = (window.ENV_SUPABASE_URL  || "https://wnkgzpgagprncbtqnzrw.supabase.co").trim();
  const SUPABASE_ANON = (window.ENV_SUPABASE_ANON || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indua2d6cGdhZ3BybmNidHFuenJ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTUxNjQyNTQsImV4cCI6MjA3MDc0MDI1NH0.sXkV7N9Y2nDOTA3tZpWkAhs2SCGriXJWyieglxxFIRY").trim();

  function waitAuthReady() {
    if (document.body.classList.contains('auth-ready')) return Promise.resolve();
    return new Promise(res => document.addEventListener('auth-ready', res, { once:true }));
  }
  async function getSupabaseClient(maxMs = 4000) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      if (window.supabaseClient?.auth) return window.supabaseClient;
      await new Promise(r => setTimeout(r, 50));
    }
    if (window.supabase?.createClient) {
      const local = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
        auth: { persistSession:false, autoRefreshToken:false, detectSessionInUrl:false }
      });
      window.supabaseClient = local;
      return local;
    }
    throw new Error('Supabase no inicialitzat');
  }

  // UI
  const kpiActius     = $("#kpiActivos");
  const kpiConsultes  = $("#kpiConsultas");
  const kpiDocs       = $("#kpiDocs");
  const kpiCad        = $("#kpiCad");
  const monthsInput   = $("#monthsInput");
  const btnRefresh    = $("#btnRefresh");
  const tablaUltimes  = $("#tablaUltimas");
  const tablaCad      = $("#tablaCad");
  const cvsTop        = $("#chartTop");
  const cvsServeis    = $("#chartServicios");
  const cvsSeries     = $("#chartSeries");
  const cvsTipus      = $("#chartTipos");

  // Datasets per export
  const datasets = {
    top5: [],
    serveis: [],
    sèries: [],
    tipusDocs: [],
    últimesAdmin: [],
    docsCad: [],
  };

  let chartTop, chartServeis, chartSèries, chartTipus;

  // ===== Helper: intenta consultes sobre una llista de vistes/taules =====
  async function selectFirstAvailable(names, select = "*") {
    const supabase = await getSupabaseClient();
    for (const name of names) {
      const { data, error } = await supabase.from(name).select(select);
      if (!error) return { data, used: name };
      if (error?.code !== 'PGRST205') { // error real (no "no existe en schema cache")
        console.warn(`[analytics] error en ${name}:`, error);
        return { data: [], used: name, error };
      }
      // si PGRST205, sigue probando siguiente nombre
    }
    return { data: [], used: null, error: new Error('Cap vista coincident') };
  }

  // ===== Lectures =====
  async function readTop5() {
    const { data } = await selectFirstAvailable(
      ["v_top5_last_30", "view_logs_top_docs"] // <- fallback sugerit pel hint
    );
    return (data||[]).map(r => ({
      doc_id: r.doc_id || r.id || null,
      title: r.title || r.doc_title || "—",
      views: Number(r.views || r.count || 0),
    }));
  }

  async function readUsageByService() {
    const { data } = await selectFirstAvailable(
      ["v_usage_by_service_30", "view_logs_by_service"]
    );
    return (data||[]).map(r => ({
      service: r.service || r.origin || "—",
      views: Number(r.views || r.count || 0),
    }));
  }

  async function readViewsByDay() {
    const { data } = await selectFirstAvailable(
      ["v_views_by_day_30", "view_logs_daily"]
    );
    return (data||[]).map(r => ({
      day: r.day || r.date || r.d || r.ts || null,
      views: Number(r.views || r.count || 0),
    })).sort((a,b)=> String(a.day).localeCompare(String(b.day)));
  }

  async function readDocsByKind() {
    // 1) Intenta vista; 2) si no existe, calcula en client a partir de documents
    const try1 = await selectFirstAvailable(["v_docs_by_kind", "documents_by_kind"]);
    if (try1.used) {
      return (try1.data||[]).map(r => ({
        kind: r.kind || "—",
        count: Number(r.count || r.n || 0),
      }));
    }
    // Fallback: agregat client-side
    const supabase = await getSupabaseClient();
    const { data: docs, error } = await supabase.from("documents").select("kind");
    if (error) { console.warn("[docs_by_kind fallback]", error); return []; }
    const acc = {};
    (docs||[]).forEach(d => {
      const k = d.kind || "—";
      acc[k] = (acc[k]||0) + 1;
    });
    return Object.entries(acc).map(([kind,count])=>({ kind, count }));
  }

  async function readLast5Admin() {
    const { data } = await selectFirstAvailable(
      ["v_last5_admin", "admin_actions_last5", "admin_actions_recent"]
    );
    return (data||[]).map(r => ({
      action: r.action || r.verb || "—",
      actor:  r.actor_email || r.actor || r.email || "—",
      when:   r.created_at || r.ts || r.at || null,
      title:  r.doc_title || r.title || "—",
    }));
  }

  async function readDocumentsBasics() {
    const supabase = await getSupabaseClient();
    const { data, error } = await supabase
      .from("documents")
      .select("id, title, kind, service, published, created_at, updated_at, valid_from");
    if (error) { console.warn("[documents]", error); return []; }
    return data || [];
  }

  // ===== Càlculs caducitat =====
  function addMonths(d, months) {
    const dt = new Date(d);
    if (isNaN(dt)) return null;
    return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + months, dt.getUTCDate()));
  }
  function daysBetween(a, b) { return Math.floor((b - a) / 86400000); }

  function computeCaducitat(docs, months) {
    const now = new Date();
    const soonThresholdDays = 30;
    let cad = 0, soon = 0, ok = 0;
    const det = [];

    for (const d of docs) {
      const vf = d.valid_from || d.validFrom || d.vigent_des_de || d.updated_at || d.created_at;
      const basis = vf ? new Date(vf) : (d.updated_at ? new Date(d.updated_at) : null);
      const expireAt = basis ? addMonths(basis, months) : null;

      let status = "sense-data";
      if (expireAt) {
        if (expireAt < now) status = "caducat";
        else status = (daysBetween(now, expireAt) <= soonThresholdDays) ? "proper" : "ok";
      }

      if (status === "caducat") cad++;
      else if (status === "proper") soon++;
      else if (status === "ok") ok++;

      det.push({
        id: d.id,
        title: d.title || "—",
        expireAt: expireAt ? expireAt.toISOString().slice(0,10) : null,
        status,
      });
    }
    return { caducats: cad, propers: soon, enTermini: ok, detalls: det };
  }

  // ===== Render =====
  function setNumber(el, n) { if (el) el.textContent = (n == null ? "—" : String(n)); }
  function renderKpis({ actius, consultesTotals, docsTotals, cad }) {
    setNumber(kpiActius, actius);
    setNumber(kpiConsultes, consultesTotals);
    setNumber(kpiDocs, docsTotals);
    if (kpiCad) kpiCad.textContent = `${cad.caducats} / ${cad.propers}`;
  }
  function ensureChart(canvasEl, type, data, options={}) {
    if (!canvasEl) return null;
    if (canvasEl.__chart) { canvasEl.__chart.destroy(); canvasEl.__chart = null; }
    const c = new Chart(canvasEl, { type, data, options });
    canvasEl.__chart = c;
    return c;
  }
  function renderChartTop(items) {
    datasets.top5 = items;
    const labels = items.map(x=>x.title);
    const values = items.map(x=>x.views);
    chartTop = ensureChart(cvsTop, "bar", {
      labels, datasets: [{ label: "Consultes (30 dies)", data: values }]
    }, { responsive:true, plugins:{ legend:{ display:false } }, scales:{ y:{ beginAtZero:true } } });
  }
  function renderChartServeis(items) {
    datasets.serveis = items;
    const labels = items.map(x=>x.service || "—");
    const values = items.map(x=>x.views);
    chartServeis = ensureChart(cvsServeis, "bar", {
      labels, datasets: [{ label: "Consultes per servei (30 dies)", data: values }]
    }, { responsive:true, plugins:{ legend:{ display:false } }, scales:{ y:{ beginAtZero:true } } });
  }
  function renderChartSeries(items) {
    datasets.sèries = items;
    const labels = items.map(x=>x.day);
    const values = items.map(x=>x.views);
    chartSèries = ensureChart(cvsSeries, "line", {
      labels, datasets: [{ label: "Consultes / dia (30 dies)", data: values, tension:0.25 }]
    }, { responsive:true, plugins:{ legend:{ display:false } }, scales:{ y:{ beginAtZero:true } } });
  }
  function renderChartTipus(items) {
    datasets.tipusDocs = items;
    const labels = items.map(x=>x.kind);
    const values = items.map(x=>x.count);
    chartTipus = ensureChart(cvsTipus, "bar", {
      labels, datasets: [{ label: "Documents per tipus", data: values }]
    }, { responsive:true, plugins:{ legend:{ display:false } }, scales:{ y:{ beginAtZero:true } } });
  }
  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function renderUltimesTaula(items) {
    datasets.últimesAdmin = items;
    if (!tablaUltimes) return;
    tablaUltimes.innerHTML = "";
    if (!items.length) { tablaUltimes.innerHTML = `<tr><td colspan="3" class="muted">—</td></tr>`; return; }
    for (const it of items) {
      const tr = document.createElement("tr");
      const when = it.when ? new Date(it.when).toLocaleString() : "—";
      tr.innerHTML = `
        <td>${escapeHtml(it.title || "—")}</td>
        <td>${escapeHtml(it.actor || "—")}</td>
        <td>${escapeHtml(when)}</td>
      `;
      tablaUltimes.appendChild(tr);
    }
  }
  function renderCadTaula(stats) {
    datasets.docsCad = stats.detalls;
    if (!tablaCad) return;
    tablaCad.innerHTML = `
      <tr><td>Caducats</td><td>${stats.caducats}</td></tr>
      <tr><td>Propers (&lt;= 30 dies)</td><td>${stats.propers}</td></tr>
      <tr><td>En termini</td><td>${stats.enTermini}</td></tr>
    `;
  }

  // ===== Export =====
  $("#expJson")?.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(datasets, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `analytics-${new Date().toISOString().slice(0,10)}.json`;
    a.click(); URL.revokeObjectURL(a.href);
  });
  $("#expCsv")?.addEventListener("click", () => {
    const parts = [];
    const pushCsv = (name, rows) => {
      if (!rows || !rows.length) return;
      const cols = Object.keys(rows[0]);
      parts.push(`# ${name}`);
      parts.push(cols.join(","));
      for (const r of rows) parts.push(cols.map(k => csvCell(r[k])).join(","));
      parts.push("");
    };
    pushCsv("top5", datasets.top5);
    pushCsv("serveis", datasets.serveis);
    pushCsv("series", datasets.sèries);
    pushCsv("tipusDocs", datasets.tipusDocs);
    pushCsv("ultimesAdmin", datasets.últimesAdmin);
    pushCsv("docsCad", datasets.docsCad);
    const blob = new Blob([parts.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `analytics-${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
  });
  function csvCell(v){ if (v == null) return ""; const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; }

  // ===== Refresh =====
  async function refreshAll() {
    try {
      const vigencia = Math.max(1, Number(monthsInput?.value || 12));
      const [ top5, serveis, series, tipus, ultimes ] = await Promise.all([
        readTop5(),
        readUsageByService(),
        readViewsByDay(),
        readDocsByKind(),
        readLast5Admin(),
      ]);
      const docs = await readDocumentsBasics();

      const actius = docs.filter(d => d.published === true).length;
      const consultesTotals = series.reduce((acc,x)=>acc + (x.views||0), 0);
      const docsTotals = docs.length;

      const cad = computeCaducitat(docs, vigencia);

      renderKpis({ actius, consultesTotals, docsTotals, cad });
      renderChartTop(top5);
      renderChartServeis(serveis);
      renderChartSeries(series);
      renderChartTipus(tipus);
      renderUltimesTaula(ultimes);
      renderCadTaula(cad);
    } catch (e) {
      console.error("[analytics] refreshAll:", e);
    }
  }

  btnRefresh?.addEventListener("click", refreshAll);
  monthsInput?.addEventListener("change", refreshAll);

  document.addEventListener('DOMContentLoaded', async () => {
    try {
      await waitAuthReady().catch(()=>{});
      await getSupabaseClient();
      await refreshAll();
    } catch (e) {
      console.error('[analytics] bootstrap error:', e);
    }
  });
})();