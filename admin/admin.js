// admin.js — Gestió de cartells/protocols (CRUD + revisió)
// -------------------------------------------------------------------
// - Lee/escribe en la tabla `documents`.
// - Sube archivos al bucket `cartells` (thumbs en `cartells/thumbs/...`).
// - Mantiene la UI (orden, metadatos, publicación, preview).
// - “Publica canvis” guarda el order_index actual.
// - Cálculo de caducidad a partir de `valid_from` + meses (review.months)
//   con estados: ok | soon | overdue y badge visible en cada ítem.
// - Reacciona al evento `reviewMonthsChanged` lanzado por admin/index.html.
// -------------------------------------------------------------------

console.log("Panell d'administració carregat.");

/* =========================
   CONFIG SUPABASE
   ========================= */
const SUPABASE_URL      = "https://wnkgzpgagprncbtqnzrw.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indua2d6cGdhZ3BybmNidHFuenJ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTUxNjQyNTQsImV4cCI6MjA3MDc0MDI1NH0.sXkV7N9Y2nDOTA3tZpWkAhs2SCGriXJWyieglxxFIRY";
const SUPABASE_BUCKET   = "cartells";

// Crea/espera el cliente de Supabase de forma segura
let _supabaseClientPromise = (async () => {
  try {
    if (!window.supabase) {
      await new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
        s.onload = res; s.onerror = rej; document.head.appendChild(s);
      });
    }
    // @ts-ignore
    const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    console.log("🔌 Supabase inicialitzat");

    // Exponer para auth-guard (opcional)
    window.__supabase = client;

    // Muestra email de sesión si está disponible
    try {
      const { data } = await client.auth.getUser();
      const email = data?.user?.email || "—";
      const span = document.getElementById("currentUserEmail");
      if (span) span.textContent = email;
      // Exponer helpers de sesión por si quieres usar el botón de “Tancar sessió”
      window.__auth = {
        async signOut() {
          await client.auth.signOut();
          location.reload();
        }
      };
    } catch {}

    return client;
  } catch (e) {
    console.error("❌ No s'ha pogut inicialitzar Supabase:", e);
    alert("No s'ha pogut inicialitzar Supabase. Revisa URL/KEY i permisos.");
    return null;
  }
})();

async function getSupabase() {
  const client = await _supabaseClientPromise;
  if (!client) throw new Error("Supabase no disponible");
  return client;
}

/* =========================
   CONSTANTS & UTILITATS
   ========================= */
const els = {
  drop:     document.getElementById("dropzone"),
  browse:   document.getElementById("btnBrowse"),
  file:     document.getElementById("fileInput"),
  items:    document.getElementById("items"),
  publish:  document.getElementById("btnPublish"),
  tpl:      document.getElementById("itemTpl"),
};

const ORIGIN_OPTIONS = [
  "Hospitalització",
  "Urgències",
  "Àrea Quirúrgica",
  "Biotecnologia",
  "Consultes Externes",
];

const BYTES_KB = 1024;
const BYTES_MB = 1024 * 1024;

function formatSize(bytes = 0) {
  if (bytes >= BYTES_MB) return `${(bytes / BYTES_MB).toFixed(1)} MB`;
  if (bytes >= BYTES_KB) return `${Math.round(bytes / BYTES_KB)} KB`;
  return `${bytes} B`;
}
const toArray = (s) => s.split(",").map(v => v.trim()).filter(Boolean);
const genLocalId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function extFromMime(mt = "") {
  if (mt.startsWith("image/")) {
    const e = mt.split("/")[1].toLowerCase();
    if (["jpeg","jpg","png","gif","webp","bmp","avif"].includes(e)) return e === "jpeg" ? "jpg" : e;
    return "img";
  }
  if (mt === "application/pdf") return "pdf";
  return "bin";
}

/* ================
   REVISIÓ / CADUCITAT
   ================ */
const DAY_MS = 24 * 60 * 60 * 1000;
const SOON_THRESHOLD_MS = 30 * DAY_MS;

function getReviewMonths() {
  const m = Number(localStorage.getItem("review.months") || 12);
  return Math.max(1, m);
}
function getReviewState(validFrom, months) {
  if (!validFrom) return "ok";
  const start = new Date(validFrom);
  if (isNaN(start.getTime())) return "ok";
  const until = new Date(start);
  until.setMonth(until.getMonth() + months);
  const left = until.getTime() - Date.now();
  if (left <= 0) return "overdue";
  if (left < SOON_THRESHOLD_MS) return "soon";
  return "ok";
}
function reviewDateText(validFrom, months) {
  if (!validFrom) return "";
  const d = new Date(validFrom);
  if (isNaN(d.getTime())) return "";
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0,10);
}
function makeReviewBadge(state, untilDateText) {
  const span = document.createElement("span");
  span.className =
    "rev-badge " +
    (state === "overdue" ? "rev-overdue" : state === "soon" ? "rev-soon" : "rev-ok");
  span.textContent =
    (state === "overdue" ? "Caducat" : state === "soon" ? "Proper a caducar" : "En termini") +
    (untilDateText ? ` · Rev. ${untilDateText}` : "");
  return span;
}

/* =========================
   ESTAT (en memòria)
   ========================= */
let items = []; // registros de `documents`

/* =========================
   SUPABASE HELPERS
   ========================= */
async function listDocuments() {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from("documents")
    .select("id,title,service,kind,code,version,valid_from,languages,tags,external_url,mime,file_url,thumb_url,size,published,order_index,updated_at")
    .order("order_index", { ascending: true, nullsFirst: true })
    .order("updated_at", { ascending: false });

  if (error) throw error;
  return data || [];
}

async function insertDocument(rec) {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from("documents")
    .insert(rec)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function updateDocument(id, patch) {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from("documents")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function deleteDocument(id) {
  const supabase = await getSupabase();
  const { error } = await supabase.from("documents").delete().eq("id", id);
  if (error) throw error;
}

async function uploadToBucket(path, fileOrBlob, opts) {
  const supabase = await getSupabase();
  const options = { upsert: true, contentType: fileOrBlob.type, ...(opts||{}) };
  const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(path, fileOrBlob, options);
  if (error && error.message && !/The resource already exists/i.test(error.message)) throw error;
  return supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(path).data.publicUrl;
}

async function removeFromBucket(path) {
  const supabase = await getSupabase();
  await supabase.storage.from(SUPABASE_BUCKET).remove([path]);
}

/* =========================
   RENDER LLISTA
   ========================= */
async function render() {
  els.items.innerHTML = "";

  if (!items.length) {
    const empty = document.createElement("li");
    empty.className = "item empty";
    empty.innerHTML = `<div class="meta"><p class="muted">Encara no hi ha elements. Puja imatges o PDFs per començar.</p></div>`;
    els.items.appendChild(empty);
    return;
  }

  items.forEach((it, idx) => {
    const li = els.tpl.content.firstElementChild.cloneNode(true);

    // REFERÈNCIES BASE
    const th   = li.querySelector(".thumb");
    const info = li.querySelector(".fileinfo");

    // CAMPS DE FORMULARI
    const title     = li.querySelector(".title");
    const pub       = li.querySelector(".published");
    const kind      = li.querySelector(".kind");
    let   originSel = li.querySelector(".origin");
    const code      = li.querySelector(".code");
    const version   = li.querySelector(".version");
    const validFrom = li.querySelector(".validFrom");
    const languages = li.querySelector(".languages");
    const tags      = li.querySelector(".tags");
    const exturl    = li.querySelector(".exturl");
    const revSlot   = li.querySelector(".rev-slot");

    // BOTONS MINIATURA
    const btnThumbSet   = li.querySelector(".thumb-set");
    const btnThumbClear = li.querySelector(".thumb-clear");
    const inputThumb    = li.querySelector(".thumb-input");

    // VALORS INICIALS
    title.value     = it.title || "";
    pub.checked     = it.published === true;
    kind.value      = it.kind || ((it.mime === "application/pdf") ? "protocol" : "cartell");

    if (originSel && originSel.tagName.toLowerCase() === "select") {
      if (it.service && !ORIGIN_OPTIONS.includes(it.service)) {
        const extra = document.createElement("option");
        extra.value = it.service;
        extra.textContent = it.service;
        originSel.appendChild(extra);
      }
      originSel.value = it.service || "";
    }

    code.value      = it.code || "";
    version.value   = it.version || "";
    validFrom.value = it.valid_from ? String(it.valid_from).slice(0,10) : "";
    languages.value = Array.isArray(it.languages) ? it.languages.join(", ") : (it.languages || "");
    tags.value      = Array.isArray(it.tags) ? it.tags.join(", ") : (it.tags || "");
    exturl.value    = it.external_url || "";

    info.textContent = `${(it.file_url ? (new URL(it.file_url)).pathname.split('/').pop() : 'fitxer')}${it.size ? ` · ${formatSize(it.size)}` : ''}`;

    // THUMB PREVIEW
    function applyThumbPreview() {
      if (it.thumb_url) {
        th.style.backgroundImage = `url(${it.thumb_url})`;
        th.textContent = "";
        btnThumbClear.disabled = false;
        return;
      }
      if ((it.mime || "").startsWith("image/") && it.file_url) {
        th.style.backgroundImage = `url(${it.file_url})`;
        th.textContent = "";
        btnThumbClear.disabled = true;
        return;
      }
      th.style.backgroundImage = "";
      th.textContent = (it.mime === "application/pdf") ? "📄" : "🖼";
      btnThumbClear.disabled = !it.thumb_url;
    }
    applyThumbPreview();

    // === REVISIÓ / BADGE ===
    function applyReviewBadge() {
      const months  = getReviewMonths();
      const vf      = validFrom.value || it.valid_from || "";
      const state   = getReviewState(vf, months);
      const until   = reviewDateText(vf, months);
      li.setAttribute("data-review", state);
      if (revSlot) {
        revSlot.innerHTML = "";
        revSlot.appendChild(makeReviewBadge(state, until));
      }
    }
    applyReviewBadge();

    // ACCIONS: ordre
    li.querySelector(".up").onclick = async () => {
      if (idx === 0) return;
      swapOrder(idx, idx - 1);
      await saveOrderIndexes();
      await refresh();
    };
    li.querySelector(".down").onclick = async () => {
      if (idx >= items.length - 1) return;
      swapOrder(idx, idx + 1);
      await saveOrderIndexes();
      await refresh();
    };

    // ACCIONS: eliminar
    li.querySelector(".remove").onclick = async () => {
      if (!confirm("Segur que vols esborrar aquest element?")) return;
      try { await safeDeleteFilesForItem(it); } catch (e) { console.warn("Bucket delete:", e?.message||e); }
      try { await deleteDocument(it.id); await refresh(); }
      catch (e) { console.error(e); alert("No s'ha pogut esborrar el registre."); }
    };

    // ACCIONS: previsualitzar
    li.querySelector(".preview").onclick = () => {
      if (!it.file_url) return;
      window.open(it.file_url, "_blank", "noopener,noreferrer");
    };

    // ESCRIPTURA (UI -> DB), con debounce
    const debouncedUpdate = debounce(async (patch) => {
      try {
        const upd = await updateDocument(it.id, patch);
        Object.assign(it, upd);
        // si cambió el servicio o fecha, re‑pinta
        if (patch.service !== undefined || patch.valid_from !== undefined) {
          applyReviewBadge();
          // Notificar a posibles contadores externos
          document.dispatchEvent(new CustomEvent("itemChanged", { detail: { id: it.id }}));
        }
      } catch (e) {
        console.error(e);
        alert("No s'ha pogut desar el canvi.");
      }
    }, 300);

    title.oninput   = () => debouncedUpdate({ title: title.value.trim() });
    pub.onchange    = () => debouncedUpdate({ published: pub.checked });
    kind.onchange   = () => debouncedUpdate({ kind: kind.value });
    if (originSel) originSel.addEventListener("change", () => debouncedUpdate({ service: originSel.value || null }));
    code.oninput    = () => debouncedUpdate({ code: code.value.trim() || null });
    version.oninput = () => debouncedUpdate({ version: version.value.trim() || null });
    validFrom.onchange = () => { debouncedUpdate({ valid_from: validFrom.value || null }); applyReviewBadge(); };

    languages.oninput = () => {
      const v = languages.value.trim();
      const val = v.includes(",") ? toArray(v) : (v || null);
      debouncedUpdate({ languages: Array.isArray(val) ? val : (val ? [val] : null) });
    };
    tags.oninput = () => {
      const v = tags.value.trim();
      const val = v.includes(",") ? toArray(v) : (v || null);
      debouncedUpdate({ tags: Array.isArray(val) ? val : (val ? [val] : null) });
    };
    exturl.oninput = () => debouncedUpdate({ external_url: exturl.value.trim() || null });

    // MINIATURA (thumb)
    btnThumbSet.onclick = () => inputThumb.click();
    inputThumb.onchange = async () => {
      const f = inputThumb.files?.[0];
      if (!f) return;
      if (!f.type.startsWith("image/")) {
        alert("La miniatura ha de ser una imatge.");
        inputThumb.value = "";
        return;
      }
      try {
        const tExt  = extFromMime(f.type || "image/jpeg");
        const tPath = `thumbs/${it.id}.${tExt}`;
        const url   = await uploadToBucket(tPath, f, { upsert: true, contentType: f.type });
        const upd   = await updateDocument(it.id, { thumb_url: url });
        Object.assign(it, upd);
        applyThumbPreview();
      } catch (e) {
        console.error("Error guardant miniatura:", e);
        alert("No s'ha pogut guardar la miniatura.");
      } finally {
        inputThumb.value = "";
      }
    };

    btnThumbClear.onclick = async () => {
      if (!it.thumb_url) return;
      try {
        const path = bucketPathFromPublicUrl(it.thumb_url);
        if (path) await removeFromBucket(path);
      } catch (e) {
        console.warn("No s'ha pogut esborrar la miniatura del bucket:", e?.message || e);
      }
      try {
        const upd = await updateDocument(it.id, { thumb_url: null });
        Object.assign(it, upd);
        applyThumbPreview();
      } catch (e) {
        console.error(e);
        alert("No s'ha pogut treure la miniatura.");
      }
    };

    // ACCESSIBILITAT: reordenació amb teclat
    const titleEl = li.querySelector(".title");
    titleEl.addEventListener("keydown", async (e) => {
      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        const newIdx = e.key === "ArrowUp" ? idx - 1 : idx + 1;
        if (newIdx < 0 || newIdx >= items.length) return;
        swapOrder(idx, newIdx);
        await saveOrderIndexes();
        await refresh();
        const newLi = els.items.children[newIdx];
        newLi?.querySelector(".title")?.focus();
      }
    });

    els.items.appendChild(li);
  });
}

/* =========================
   ORDENACIÓ
   ========================= */
function swapOrder(i, j) {
  const a = items[i], b = items[j];
  [items[i], items[j]] = [b, a];
  items.forEach((it, k) => { it.order_index = k + 1; });
}

async function saveOrderIndexes() {
  for (const it of items) {
    try { await updateDocument(it.id, { order_index: it.order_index }); }
    catch (e) { console.warn("No s'ha pogut desar l'ordre d'un element", it.id, e?.message); }
  }
}

/* =========================
   PUJADA D’ARXIUS -> INSERT
   ========================= */
async function handleFiles(fileList) {
  const files = Array.from(fileList).filter(f =>
    f.type.startsWith("image/") || f.type === "application/pdf"
  );
  if (!files.length) return;

  const prev = els.publish?.textContent;
  if (els.publish) { els.publish.disabled = true; els.publish.textContent = "⬆️ Pujant…"; }

  try {
    for (const f of files) {
      const idLike = genLocalId();
      const ext    = extFromMime(f.type || "");
      const path   = `${idLike}.${ext}`;
      const url    = await uploadToBucket(path, f, { upsert: true, contentType: f.type });

      const base = {
        title: f.name.replace(/\.[^.]+$/, ""),
        service: null,
        kind: (f.type === "application/pdf") ? "protocol" : "cartell",
        code: null,
        version: null,
        valid_from: new Date().toISOString().slice(0,10), // por defecto: hoy
        languages: null,
        tags: null,
        external_url: null,
        mime: f.type || "application/octet-stream",
        file_url: url,
        thumb_url: null,
        size: f.size || null,
        published: true,
        order_index: (items.length ? Math.max(...items.map(x => x.order_index || 0)) : 0) + 1,
      };

      const row = await insertDocument(base);
      items.push(row);
    }

    await refresh();
  } catch (e) {
    console.error("Error pujant/insertant:", e);
    alert("Alguna pujada ha fallat. Revisa la consola.");
  } finally {
    if (els.publish) { els.publish.textContent = prev; els.publish.disabled = false; }
  }
}

/* =========================
   ESDEVENIMENTS UI
   ========================= */
["dragenter", "dragover"].forEach(ev =>
  els.drop?.addEventListener(ev, (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    els.drop.classList.add("drag");
  })
);
["dragleave", "drop"].forEach(ev =>
  els.drop?.addEventListener(ev, (e) => {
    e.preventDefault();
    els.drop.classList.remove("drag");
  })
);
els.drop?.addEventListener("drop", (e) => {
  handleFiles(e.dataTransfer.files).catch(err => {
    console.error(err);
    alert("No s'ha pogut afegir els fitxers.");
  });
});

els.browse?.addEventListener("click", (e) => {
  e.preventDefault();
  if (!els.file) return;
  els.file.value = "";
  els.file.click();
});

els.file?.addEventListener("change", (e) => {
  const files = e.target.files;
  if (!files || !files.length) return;
  handleFiles(files).catch(err => {
    console.error(err);
    alert("Hi ha hagut un error pujant els fitxers.");
  }).finally(() => {
    e.target.value = "";
  });
});

/* =========================
   PUBLICACIÓ (desa ordre)
   ========================= */
els.publish?.addEventListener("click", async () => {
  try {
    els.publish.disabled = true;
    const prev = els.publish.textContent;
    els.publish.textContent = "💾 Desant…";
    await saveOrderIndexes();
    els.publish.textContent = "✅ Desat!";
    setTimeout(() => { els.publish.textContent = prev; els.publish.disabled = false; }, 1000);
  } catch (err) {
    console.error("Error al publicar:", err);
    alert("Hi ha hagut un error en la publicació.");
    els.publish.disabled = false;
  }
});

/* =========================
   INIT & REFRESH
   ========================= */
async function refresh() {
  items = await listDocuments();
  await render();
  // Notifica para que los contadores de la barra puedan re-evaluar
  document.dispatchEvent(new CustomEvent("itemsRendered", { detail: { count: items.length }}));
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
    await getSupabase(); // espera al cliente
    await refresh();
  } catch (err) {
    console.error("Error a l'init:", err);
    alert("Hi ha hagut un error inicialitzant el panell (llista).");
  }
});

/* =========================
   AUXILIARS
   ========================= */
function debounce(fn, ms = 250) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Deducción del path en el bucket a partir de una public URL
function bucketPathFromPublicUrl(publicUrl) {
  try {
    const u = new URL(publicUrl);
    const prefix = `/storage/v1/object/public/${SUPABASE_BUCKET}/`;
    const ix = u.pathname.indexOf(prefix);
    if (ix === -1) return null;
    return u.pathname.slice(ix + prefix.length);
  } catch { return null; }
}

async function safeDeleteFilesForItem(it) {
  if (it.file_url) {
    const p = bucketPathFromPublicUrl(it.file_url);
    if (p) { try { await removeFromBucket(p); } catch {} }
  }
  if (it.thumb_url) {
    const p = bucketPathFromPublicUrl(it.thumb_url);
    if (p) { try { await removeFromBucket(p); } catch {} }
  }
}

/* =========================
   LISTENERS EXTERNS
   ========================= */
// Recalcular badges cuando cambie la política global de meses
document.addEventListener("reviewMonthsChanged", () => {
  Array.from(document.querySelectorAll("#items > .item")).forEach(li => {
    const vfInput = li.querySelector(".validFrom");
    const revSlot = li.querySelector(".rev-slot");
    const months  = getReviewMonths();
    const vf      = vfInput?.value || "";
    const state   = getReviewState(vf, months);
    const until   = reviewDateText(vf, months);
    li.setAttribute("data-review", state);
    if (revSlot) {
      revSlot.innerHTML = "";
      revSlot.appendChild(makeReviewBadge(state, until));
    }
  });
  // Notifica cambios para que el filtro/contador del HTML se actualice
  document.dispatchEvent(new CustomEvent("itemsRendered"));
});