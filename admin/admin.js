// admin.js — Gestió de cartells/protocols (CRUD + revisió)
// -------------------------------------------------------------------
// - Usa EXCLUSIVAMENT el client global creat per auth-guard: window.supabaseClient
// - Sense redeclarar cap promesa/cliente duplicat
// - CRUD sobre taula `documents` i pujades al bucket `cartells`
// - Badges de revisió (ok/soon/overdue) segons valid_from + review.months
// -------------------------------------------------------------------

console.log("Panell d'administració carregat.");

const SUPABASE_BUCKET = "cartells";

// Estat en memòria
let supabase = null;
let items = [];

// Refs de la UI
const els = {
  drop:     document.getElementById("dropzone"),
  browse:   document.getElementById("btnBrowse"),
  file:     document.getElementById("fileInput"),
  items:    document.getElementById("items"),
  publish:  document.getElementById("btnPublish"),
  tpl:      document.getElementById("itemTpl"),
  email:    document.getElementById("currentUserEmail"),
};

// ===== Utilitats comunes =====
const BYTES_KB = 1024, BYTES_MB = 1024 * 1024;
function formatSize(bytes = 0){
  if (bytes >= BYTES_MB) return `${(bytes / BYTES_MB).toFixed(1)} MB`;
  if (bytes >= BYTES_KB) return `${Math.round(bytes / BYTES_KB)} KB`;
  return `${bytes} B`;
}
const toArray = (s) => (s||"").split(",").map(v=>v.trim()).filter(Boolean);
const genLocalId = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
function extFromMime(mt=""){
  if (mt.startsWith("image/")){
    const e = mt.split("/")[1].toLowerCase();
    if (["jpeg","jpg","png","gif","webp","bmp","avif"].includes(e)) return e==="jpeg"?"jpg":e;
    return "img";
  }
  if (mt === "application/pdf") return "pdf";
  return "bin";
}
function debounce(fn, ms=250){
  let t=null;
  return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args), ms); };
}

// ===== Revisió / caducitat =====
const DAY_MS = 24*60*60*1000;
const SOON_THRESHOLD_MS = 30*DAY_MS;

function getReviewMonths(){
  const m = Number(localStorage.getItem("review.months") || 12);
  return Math.max(1, m);
}
function getReviewState(validFrom, months){
  if (!validFrom) return "ok";
  const start = new Date(validFrom);
  if (isNaN(start)) return "ok";
  const until = new Date(start);
  until.setMonth(until.getMonth() + months);
  const left = until.getTime() - Date.now();
  if (left <= 0) return "overdue";
  if (left < SOON_THRESHOLD_MS) return "soon";
  return "ok";
}
function reviewDateText(validFrom, months){
  if (!validFrom) return "";
  const d = new Date(validFrom);
  if (isNaN(d)) return "";
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0,10);
}
function makeReviewBadge(state, untilDateText){
  const span = document.createElement("span");
  span.className = "rev-badge " + (state==="overdue"?"rev-overdue":state==="soon"?"rev-soon":"rev-ok");
  span.textContent = (state==="overdue"?"Caducat":state==="soon"?"Proper a caducar":"En termini")
                   + (untilDateText?` · Rev. ${untilDateText}`:"");
  return span;
}

// ===== Helpers Supabase (usen la variable 'supabase' un cop inicialitzada) =====
async function listDocuments(){
  const { data, error } = await supabase
    .from("documents")
    .select("id,title,service,kind,code,version,valid_from,languages,tags,external_url,mime,file_url,thumb_url,size,published,order_index,updated_at")
    .order("order_index", { ascending:true, nullsFirst:true })
    .order("updated_at", { ascending:false });
  if (error) throw error;
  return data||[];
}
async function insertDocument(rec){
  const { data, error } = await supabase.from("documents").insert(rec).select().single();
  if (error) throw error;
  return data;
}
async function updateDocument(id, patch){
  const { data, error } = await supabase
    .from("documents")
    .update({ ...patch, updated_at:new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}
async function deleteDocument(id){
  const { error } = await supabase.from("documents").delete().eq("id", id);
  if (error) throw error;
}
async function uploadToBucket(path, fileOrBlob, opts){
  const options = { upsert:true, contentType:fileOrBlob.type, ...(opts||{}) };
  const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(path, fileOrBlob, options);
  if (error && !/The resource already exists/i.test(error.message||"")) throw error;
  return supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(path).data.publicUrl;
}
async function removeFromBucket(path){
  await supabase.storage.from(SUPABASE_BUCKET).remove([path]);
}
function bucketPathFromPublicUrl(publicUrl){
  try{
    const u = new URL(publicUrl);
    const prefix = `/storage/v1/object/public/${SUPABASE_BUCKET}/`;
    const ix = u.pathname.indexOf(prefix);
    if (ix === -1) return null;
    return u.pathname.slice(ix + prefix.length);
  }catch{ return null; }
}

// ===== Render de la llista =====
async function render(){
  els.items.innerHTML = "";

  if (!items.length){
    const empty = document.createElement("li");
    empty.className = "item empty";
    empty.innerHTML = `<div class="meta"><p class="muted">Encara no hi ha elements. Puja imatges o PDFs per començar.</p></div>`;
    els.items.appendChild(empty);
    return;
  }

  items.forEach((it, idx) => {
    const li = els.tpl.content.firstElementChild.cloneNode(true);

    // Refs
    const th         = li.querySelector(".thumb");
    const info       = li.querySelector(".fileinfo");
    const title      = li.querySelector(".title");
    const pub        = li.querySelector(".published");
    const kind       = li.querySelector(".kind");
    const originSel  = li.querySelector(".origin");
    const code       = li.querySelector(".code");
    const version    = li.querySelector(".version");
    const validFrom  = li.querySelector(".validFrom");
    const languages  = li.querySelector(".languages");
    const tags       = li.querySelector(".tags");
    const exturl     = li.querySelector(".exturl");
    const revSlot    = li.querySelector(".rev-slot");
    const btnUp      = li.querySelector(".up");
    const btnDown    = li.querySelector(".down");
    const btnPreview = li.querySelector(".preview");
    const btnRemove  = li.querySelector(".remove");
    const btnThumbSet   = li.querySelector(".thumb-set");
    const btnThumbClear = li.querySelector(".thumb-clear");
    const inputThumb    = li.querySelector(".thumb-input");

    // Valors inicials
    title.value     = it.title || "";
    pub.checked     = it.published === true;
    kind.value      = it.kind || ((it.mime === "application/pdf") ? "protocol" : "cartell");

    if (originSel){
      if (it.service && !Array.from(originSel.options).some(o => o.value === it.service)){
        const extra = document.createElement("option");
        extra.value = it.service; extra.textContent = it.service;
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

    // Thumb preview
    function applyThumbPreview(){
      if (it.thumb_url){
        th.style.backgroundImage = `url(${it.thumb_url})`;
        th.textContent = "";
        btnThumbClear.disabled = false;
        return;
      }
      if ((it.mime||"").startsWith("image/") && it.file_url){
        th.style.backgroundImage = `url(${it.file_url})`;
        th.textContent = "";
        btnThumbClear.disabled = true;
        return;
      }
      th.style.backgroundImage = "";
      th.textContent = (it.mime==="application/pdf")? "📄" : "🖼";
      btnThumbClear.disabled = !it.thumb_url;
    }
    applyThumbPreview();

    // Badge revisió
    function applyReviewBadge(){
      const months = getReviewMonths();
      const vf     = validFrom.value || it.valid_from || "";
      const state  = getReviewState(vf, months);
      const until  = reviewDateText(vf, months);
      li.setAttribute("data-review", state);
      if (revSlot){
        revSlot.innerHTML = "";
        revSlot.appendChild(makeReviewBadge(state, until));
      }
    }
    applyReviewBadge();

    // Reordenació
    btnUp.onclick = async () => {
      if (idx === 0) return;
      swapOrder(idx, idx-1);
      await saveOrderIndexes();
      await refresh();
    };
    btnDown.onclick = async () => {
      if (idx >= items.length-1) return;
      swapOrder(idx, idx+1);
      await saveOrderIndexes();
      await refresh();
    };

    // Eliminar
    btnRemove.onclick = async () => {
      if (!confirm("Segur que vols esborrar aquest element?")) return;
      try { await safeDeleteFilesForItem(it); } catch(e){ console.warn("Bucket delete:", e?.message||e); }
      try { await deleteDocument(it.id); await refresh(); }
      catch (e){ console.error(e); alert("No s'ha pogut esborrar el registre."); }
    };

    // Previsualitzar
    btnPreview.onclick = () => { if (it.file_url) window.open(it.file_url, "_blank", "noopener,noreferrer"); };

    // Persistència (debounce)
    const debouncedUpdate = debounce(async (patch) => {
      try{
        const upd = await updateDocument(it.id, patch);
        Object.assign(it, upd);
        if (patch.service !== undefined || patch.valid_from !== undefined){
          applyReviewBadge();
          document.dispatchEvent(new CustomEvent("itemChanged", { detail:{ id: it.id }}));
        }
      }catch(e){
        console.error(e); alert("No s'ha pogut desar el canvi.");
      }
    }, 300);

    title.oninput      = () => debouncedUpdate({ title: title.value.trim() });
    pub.onchange       = () => debouncedUpdate({ published: pub.checked });
    kind.onchange      = () => debouncedUpdate({ kind: kind.value });
    originSel?.addEventListener("change", () => debouncedUpdate({ service: originSel.value || null }));
    code.oninput       = () => debouncedUpdate({ code: code.value.trim() || null });
    version.oninput    = () => debouncedUpdate({ version: version.value.trim() || null });
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

    // Miniatura
    btnThumbSet.onclick = () => inputThumb.click();
    inputThumb.onchange = async () => {
      const f = inputThumb.files?.[0];
      if (!f) return;
      if (!f.type.startsWith("image/")){
        alert("La miniatura ha de ser una imatge.");
        inputThumb.value = "";
        return;
      }
      try{
        const tExt  = extFromMime(f.type || "image/jpeg");
        const tPath = `thumbs/${it.id}.${tExt}`;
        const url   = await uploadToBucket(tPath, f, { upsert:true, contentType:f.type });
        const upd   = await updateDocument(it.id, { thumb_url: url });
        Object.assign(it, upd);
        applyThumbPreview();
      }catch(e){
        console.error("Error guardant miniatura:", e);
        alert("No s'ha pogut guardar la miniatura.");
      }finally{
        inputThumb.value = "";
      }
    };

    btnThumbClear.onclick = async () => {
      if (!it.thumb_url) return;
      try{
        const path = bucketPathFromPublicUrl(it.thumb_url);
        if (path) await removeFromBucket(path);
      }catch(e){ console.warn("No s'ha pogut esborrar la miniatura del bucket:", e?.message||e); }
      try{
        const upd = await updateDocument(it.id, { thumb_url: null });
        Object.assign(it, upd);
        applyThumbPreview();
      }catch(e){
        console.error(e); alert("No s'ha pogut treure la miniatura.");
      }
    };

    // Accessibilitat (ALT+↑/↓ per reordenar)
    li.querySelector(".title")?.addEventListener("keydown", async (e) => {
      if (e.altKey && (e.key==="ArrowUp" || e.key==="ArrowDown")){
        e.preventDefault();
        const newIdx = e.key==="ArrowUp" ? idx-1 : idx+1;
        if (newIdx<0 || newIdx>=items.length) return;
        swapOrder(idx, newIdx);
        await saveOrderIndexes();
        await refresh();
        els.items.children[newIdx]?.querySelector(".title")?.focus();
      }
    });

    els.items.appendChild(li);
  });
}

// ===== Ordenació =====
function swapOrder(i,j){
  [items[i], items[j]] = [items[j], items[i]];
  items.forEach((it, k) => { it.order_index = k+1; });
}
async function saveOrderIndexes(){
  for (const it of items){
    try{ await updateDocument(it.id, { order_index: it.order_index }); }
    catch(e){ console.warn("No s'ha pogut desar l'ordre d'un element", it.id, e?.message); }
  }
}

// ===== Pujada d'arxius =====
async function handleFiles(fileList){
  const files = Array.from(fileList).filter(f => f.type.startsWith("image/") || f.type==="application/pdf");
  if (!files.length) return;

  const prev = els.publish?.textContent;
  if (els.publish){ els.publish.disabled = true; els.publish.textContent = "⬆️ Pujant…"; }

  try{
    for (const f of files){
      const idLike = genLocalId();
      const ext    = extFromMime(f.type || "");
      const path   = `${idLike}.${ext}`;
      const url    = await uploadToBucket(path, f, { upsert:true, contentType:f.type });

      const base = {
        title: f.name.replace(/\.[^.]+$/, ""),
        service: null,
        kind: (f.type==="application/pdf") ? "protocol" : "cartell",
        code: null,
        version: null,
        valid_from: new Date().toISOString().slice(0,10),
        languages: null,
        tags: null,
        external_url: null,
        mime: f.type || "application/octet-stream",
        file_url: url,
        thumb_url: null,
        size: f.size || null,
        published: true,
        order_index: (items.length ? Math.max(...items.map(x=>x.order_index||0)) : 0) + 1,
      };

      const row = await insertDocument(base);
      items.push(row);
    }
    await refresh();
  }catch(e){
    console.error("Error pujant/insertant:", e);
    alert("Alguna pujada ha fallat. Revisa la consola.");
  }finally{
    if (els.publish){ els.publish.textContent = prev; els.publish.disabled = false; }
  }
}

// ===== Publicació (desa ordre) =====
els.publish?.addEventListener("click", async () => {
  try{
    els.publish.disabled = true;
    const prev = els.publish.textContent;
    els.publish.textContent = "💾 Desant…";
    await saveOrderIndexes();
    els.publish.textContent = "✅ Desat!";
    setTimeout(()=>{ els.publish.textContent = prev; els.publish.disabled = false; }, 1000);
  }catch(err){
    console.error("Error al publicar:", err);
    alert("Hi ha hagut un error en la publicació.");
    els.publish.disabled = false;
  }
});

// ===== Drag & Drop / File picker =====
["dragenter","dragover"].forEach(ev =>
  els.drop?.addEventListener(ev, (e)=>{
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    els.drop.classList.add("drag");
  })
);
["dragleave","drop"].forEach(ev =>
  els.drop?.addEventListener(ev, (e)=>{
    e.preventDefault();
    els.drop.classList.remove("drag");
  })
);
els.drop?.addEventListener("drop", (e)=>{
  handleFiles(e.dataTransfer.files).catch(err=>{
    console.error(err); alert("No s'ha pogut afegir els fitxers.");
  });
});
els.browse?.addEventListener("click", (e)=>{
  e.preventDefault();
  if (!els.file) return;
  els.file.value = "";
  els.file.click();
});
els.file?.addEventListener("change", (e)=>{
  const files = e.target.files;
  if (!files || !files.length) return;
  handleFiles(files).catch(err=>{
    console.error(err); alert("Hi ha hagut un error pujant els fitxers.");
  }).finally(()=>{ e.target.value = ""; });
});

// ===== Refresh cicle =====
async function refresh(){
  items = await listDocuments();
  await render();
  document.dispatchEvent(new CustomEvent("itemsRendered", { detail:{ count: items.length }}));
}

// ===== Reacciona a canvi global de mesos (per recalcular badges) =====
document.addEventListener("reviewMonthsChanged", () => {
  Array.from(document.querySelectorAll("#items > .item")).forEach(li => {
    const vfInput = li.querySelector(".validFrom");
    const revSlot = li.querySelector(".rev-slot");
    const months  = getReviewMonths();
    const vf      = vfInput?.value || "";
    const state   = getReviewState(vf, months);
    const until   = reviewDateText(vf, months);
    li.setAttribute("data-review", state);
    if (revSlot){
      revSlot.innerHTML = "";
      revSlot.appendChild(makeReviewBadge(state, until));
    }
  });
  document.dispatchEvent(new CustomEvent("itemsRendered"));
});

// ===== INIT: espera a auth-ready =====
async function init(){
  try{
    supabase = window.supabaseClient;
    if (!supabase) throw new Error("Supabase no disponible (auth-guard no carregat?)");

    // Pinta email d'usuari
    try{
      const { data: { user } } = await supabase.auth.getUser();
      if (els.email) els.email.textContent = user?.email || window.__SESSION_EMAIL__ || "—";
    }catch{ if (els.email) els.email.textContent = "—"; }

    await refresh();
  }catch(err){
    console.error("Error a l'init:", err);
    alert("Hi ha hagut un error inicialitzant el panell (llista).");
  }
}

// Si el guard ja ha marcat el body, arrenca; si no, espera l'esdeveniment.
if (document.body.classList.contains("auth-ready")){
  init();
} else {
  document.addEventListener("auth-ready", init, { once:true });
}

// ===== Neteja fitxers del bucket quan esborrem l'ítem =====
async function safeDeleteFilesForItem(it){
  if (it.file_url){
    const p = bucketPathFromPublicUrl(it.file_url);
    if (p){ try{ await removeFromBucket(p); }catch{} }
  }
  if (it.thumb_url){
    const p = bucketPathFromPublicUrl(it.thumb_url);
    if (p){ try{ await removeFromBucket(p); }catch{} }
  }
}