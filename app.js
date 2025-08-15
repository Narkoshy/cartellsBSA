// Estat de l'app
const state = {
  running:false,
  ctx:null, src:null, analyser:null,
  data:null,
  ema:null,

  // Mode i llindars
  mode:'night', // 'day' | 'night'
  K:60, // calibratge (offset en dB)
  emaAlpha:0.80,
  greenMax:35,
  amberMax:45,
  userTweakedThresholds:false,

  // Mitjanes i pics
  peaks:[],
  avgWindow:[],

  // Pantalla
  wakeLock:null,

  // Programació Dia/Nit
  autoMode:true,
  nightStart:"22:00",
  nightEnd:"07:00",
  _autoTimer:null,
  _manualOverride:false,

  // Estabilització/histeresi
  startedAt:0,
  initialGraceMs:2000,   // arrencar en verd 2s
  lastStatus:'green',
  hysteresis:1           // 1 dB d'histeresi per canviar de color
};

// Colors sòlids per al traç del gauge (evita l'efecte "ambre" inicial del degradat)
const COLORS = { green:'#22c55e', amber:'#f59e0b', red:'#ef4444' };

// Referències UI
const els = {
  banner: document.getElementById('banner'),
  modeEmoji: document.getElementById('modeEmoji'),
  modeText: document.getElementById('modeText'),
  toggleMode: document.getElementById('toggleMode'),
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  dbText: document.getElementById('dbText'),
  statusText: document.getElementById('statusText'),
  progress: document.getElementById('progress'),
  avgText: document.getElementById('avgText'),
  peaksText: document.getElementById('peaksText'),
  kSlider: document.getElementById('kSlider'),
  kVal: document.getElementById('kVal'),
  emaSlider: document.getElementById('emaSlider'),
  emaVal: document.getElementById('emaVal'),
  greenSlider: document.getElementById('greenSlider'),
  greenVal: document.getElementById('greenVal'),
  amberSlider: document.getElementById('amberSlider'),
  amberVal: document.getElementById('amberVal'),

  // Nous controls d'horari
  autoMode: document.getElementById('autoMode'),
  nightStart: document.getElementById('nightStart'),
  nightEnd: document.getElementById('nightEnd'),

  statusPill: document.getElementById('statusPill'),
  statusLabel: document.getElementById('statusLabel'),
};

function showBanner(type, msg){
  els.banner.className = 'banner show';
  els.banner.style.background = type==='error' ? 'rgba(239,68,68,.12)' : type==='warn' ? 'rgba(245,158,11,.12)' : 'rgba(34,197,94,.12)';
  els.banner.style.borderColor = type==='error' ? 'rgba(239,68,68,.35)' : type==='warn' ? 'rgba(245,158,11,.35)' : 'rgba(34,197,94,.35)';
  els.banner.textContent = msg;
}

// ---------- Llegenda contextual ----------
const legendText = {
  green:  'Verd: soroll baix – òptim per al descans i la comunicació.',
  amber:  'Ambre: soroll moderat – pot interferir amb el descans o la concentració.',
  red:    'Vermell: soroll alt – risc clar de molèstia o estrès acústic.'
};

// ---------- Mode i llindars ----------
function setMode(mode){
  state.mode = mode;
  if(mode==='day'){
    els.modeEmoji.textContent='☀️'; els.modeText.textContent='Dia';
    if(!state.userTweakedThresholds){ state.greenMax=45; state.amberMax=55; els.greenSlider.value=45; els.amberSlider.value=55; }
  }else{
    els.modeEmoji.textContent='🌙'; els.modeText.textContent='Nit';
    if(!state.userTweakedThresholds){ state.greenMax=35; state.amberMax=45; els.greenSlider.value=35; els.amberSlider.value=45; }
  }
  updateThresholdLabels();

  // Color inicial del gauge en verd per evitar "ambre" visual al començar
  els.progress?.setAttribute('stroke', COLORS.green);
}

function updateThresholdLabels(){
  els.greenVal.textContent = state.greenMax + " dB";
  els.amberVal.textContent = state.amberMax + " dB";
}

// ---------- Sliders ----------
els.kSlider.addEventListener('input', e=>{
  state.K = parseFloat(e.target.value);
  els.kVal.textContent = "+" + state.K + " dB";
});
els.emaSlider.addEventListener('input', e=>{
  state.emaAlpha = parseFloat(e.target.value);
  els.emaVal.textContent = state.emaAlpha.toFixed(2);
});
els.greenSlider.addEventListener('input', e=>{
  state.userTweakedThresholds = true;
  state.greenMax = parseFloat(e.target.value);
  if(state.greenMax > state.amberMax-1){ state.greenMax = state.amberMax-1; e.target.value = state.greenMax; }
  updateThresholdLabels();
});
els.amberSlider.addEventListener('input', e=>{
  state.userTweakedThresholds = true;
  state.amberMax = parseFloat(e.target.value);
  if(state.amberMax < state.greenMax+1){ state.amberMax = state.greenMax+1; e.target.value = state.amberMax; }
  updateThresholdLabels();
});

// ---------- Programació Dia/Nit ----------
function timeStrToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return (h*60 + m) % 1440;
}
function isInNightRange(now = new Date(), startStr, endStr) {
  const minutes = now.getHours()*60 + now.getMinutes();
  const start = timeStrToMinutes(startStr);
  const end = timeStrToMinutes(endStr);
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return (minutes >= start) || (minutes < end); // creua mitjanit
}
function loadSchedule() {
const adv = document.getElementById('advSettings');
if (adv){
  adv.open = localStorage.getItem('advOpen') === '1';
  adv.addEventListener('toggle', ()=> localStorage.setItem('advOpen', adv.open ? '1' : '0'));
}
  const auto = localStorage.getItem('autoMode');
  const ns = localStorage.getItem('nightStart');
  const ne = localStorage.getItem('nightEnd');
  if (auto !== null) state.autoMode = auto === 'true';
  if (ns) state.nightStart = ns;
  if (ne) state.nightEnd = ne;
  els.autoMode.checked = state.autoMode;
  els.nightStart.value = state.nightStart;
  els.nightEnd.value = state.nightEnd;
}
function saveSchedule() {
  localStorage.setItem('autoMode', String(state.autoMode));
  localStorage.setItem('nightStart', state.nightStart);
  localStorage.setItem('nightEnd', state.nightEnd);
}
function applyAutoModeTick() {
  if (!state.autoMode || state._manualOverride) return;
  const shouldBeNight = isInNightRange(new Date(), state.nightStart, state.nightEnd);
  setMode(shouldBeNight ? 'night' : 'day');
}
function scheduleAutoTimer() {
  if (state._autoTimer) clearInterval(state._autoTimer);
  state._autoTimer = setInterval(applyAutoModeTick, 30000); // 30s és suficient
}

// Botons principals
els.toggleMode.addEventListener('click', ()=>{
  if (state.autoMode) {
    state._manualOverride = true;
    els.autoMode.checked = false;
    state.autoMode = false;
    saveSchedule();
  }
  setMode(state.mode==='night' ? 'day' : 'night');
});
els.startBtn.addEventListener('click', async ()=>{
  if (state.ctx && state.ctx.state === 'suspended') await state.ctx.resume();
  start();
});
els.stopBtn.addEventListener('click', stop);

// Inputs d'horari
els.autoMode.addEventListener('change', ()=>{
  state.autoMode = els.autoMode.checked;
  state._manualOverride = !state.autoMode ? true : false;
  saveSchedule();
  if (state.autoMode) applyAutoModeTick();
});
els.nightStart.addEventListener('change', ()=>{
  state.nightStart = els.nightStart.value || '22:00';
  saveSchedule();
  applyAutoModeTick();
});
els.nightEnd.addEventListener('change', ()=>{
  state.nightEnd = els.nightEnd.value || '07:00';
  saveSchedule();
  applyAutoModeTick();
});

// ---------- Lògica de nivells ----------
// Regla de color amb gràcia inicial i histeresi
function statusFromDB(db){
  const now = performance.now();
  // Gràcia inicial: arrenca verd tret que superi clarament ambre
  if (now - state.startedAt < state.initialGraceMs) {
    if (db > state.amberMax + 2) return 'amber';
    return 'green';
  }

  // Histeresi per evitar "bombeig"
  const h = state.hysteresis;
  const last = state.lastStatus;

  if (last === 'green'){
    if (db <= state.greenMax + h) return 'green';
    if (db <= state.amberMax + h) return 'amber';
    return 'red';
  }
  if (last === 'amber'){
    if (db < state.greenMax - h) return 'green';
    if (db <= state.amberMax + h) return 'amber';
    return 'red';
  }
  // last === 'red'
  if (db > state.amberMax - h) return 'red';
  if (db > state.greenMax + h) return 'amber';
  return 'green';
}

function paintStatus(status){
  state.lastStatus = status;
  els.statusPill.classList.remove('status-green','status-amber','status-red');
  if(status==='green'){ els.statusPill.classList.add('status-green'); els.statusLabel.textContent = 'Verd'; }
  if(status==='amber'){ els.statusPill.classList.add('status-amber'); els.statusLabel.textContent = 'Ambre'; }
  if(status==='red'){ els.statusPill.classList.add('status-red'); els.statusLabel.textContent = 'Vermell'; }

  // Missatge curt i tooltip amb llegenda
  els.statusText.textContent = status === 'green' ? 'Verd' : status === 'amber' ? 'Ambre' : 'Vermell';
  els.statusPill.title = legendText[status];
}

function updateGauge(db){
  const clamped = Math.max(0, Math.min(80, db)); // 0..80 dB rang visual
  const circumference = 2*Math.PI*84; // ~528
  const ratio = clamped/80;
  const offset = circumference * (1 - ratio);
  els.progress.setAttribute('stroke-dashoffset', offset.toFixed(1));
  els.dbText.textContent = `${db.toFixed(0)} dB`;

  const st = statusFromDB(db);

  // Força color sòlid segons estat (substitueix el degradat de l’SVG)
  els.progress.setAttribute('stroke', COLORS[st]);

  paintStatus(st);
}

function updateAverages(db){
  const now = performance.now();
  state.avgWindow.push({t: now, v: db});
  state.peaks.push({t: now, v: db});
  const cutoff = now - 300000; // 5 min
  state.avgWindow = state.avgWindow.filter(p => p.t >= cutoff);
  state.peaks = state.peaks.filter(p => p.t >= cutoff);
  const avg = state.avgWindow.reduce((a,b)=>a+b.v,0) / Math.max(1,state.avgWindow.length);
  els.avgText.textContent = isFinite(avg) ? avg.toFixed(0) : '--';
  const max = state.peaks.reduce((m,p)=>Math.max(m,p.v), -Infinity);
  const min = state.peaks.reduce((m,p)=>Math.min(m,p.v), Infinity);
  els.peaksText.textContent = (isFinite(max) && isFinite(min)) ? `Pics últims 5 min: mín ${min.toFixed(0)} dB · màx ${max.toFixed(0)} dB` : 'Pics últims 5 min: —';
}

// ---------- Filtres: A‑weighting (IIR en cascada) ----------
function createAWeightingChain(audioCtx) {
  const fs = Math.round(audioCtx.sampleRate);
  let sections;
  if (Math.abs(fs - 44100) < 200) {
    sections = [
      { a1: -1.31861375911, a2:  0.32059452332, b0: 0.95616638497, b1: -1.31960414122, b2: 0.36343775625 },
      { a1: -1.88558607420, a2:  0.88709946900, b0: 0.94317138580, b1: -1.88634277160, b2: 0.94317138580 },
      { a1: -1.31859445445, a2:  0.32058831623, b0: 0.69736775447, b1: -0.42552769920, b2: -0.27184005527 },
    ];
  } else if (Math.abs(fs - 48000) < 400) {
    sections = [
      { a1: -1.34730722798, a2:  0.34905752979, b0: 0.96525096525, b1: -1.34730163086, b2: 0.38205066561 },
      { a1: -1.89387049481, a2:  0.89515976917, b0: 0.94696969696, b1: -1.89393939393, b2: 0.94696969696 },
      { a1: -1.34730722798, a2:  0.34905752979, b0: 0.64666542810, b1: -0.38362237137, b2: -0.26304305672 },
    ];
  } else {
    console.warn(`Fs=${fs} Hz sense taula dedicada; s'usa 44.1 kHz com a aproximació.`);
    sections = [
      { a1: -1.31861375911, a2:  0.32059452332, b0: 0.95616638497, b1: -1.31960414122, b2: 0.36343775625 },
      { a1: -1.88558607420, a2:  0.88709946900, b0: 0.94317138580, b1: -1.88634277160, b2: 0.94317138580 },
      { a1: -1.31859445445, a2:  0.32058831623, b0: 0.69736775447, b1: -0.42552769920, b2: -0.27184005527 },
    ];
  }
  const s1 = new IIRFilterNode(audioCtx, { feedforward:[sections[0].b0, sections[0].b1, sections[0].b2], feedback:[1, sections[0].a1, sections[0].a2] });
  const s2 = new IIRFilterNode(audioCtx, { feedforward:[sections[1].b0, sections[1].b1, sections[1].b2], feedback:[1, sections[1].a1, sections[1].a2] });
  const s3 = new IIRFilterNode(audioCtx, { feedforward:[sections[2].b0, sections[2].b1, sections[2].b2], feedback:[1, sections[2].a1, sections[2].a2] });
  s1.connect(s2); s2.connect(s3);
  return { input:s1, output:s3 };
}

// ---------- Micròfon ----------
async function start(){
  try{
    if(!isSecureContext && location.hostname !== 'localhost'){
      showBanner('error', 'Cal HTTPS o localhost per usar el micròfon. Puja la web a un host amb HTTPS o usa http://localhost.');
      return;
    }
    if(state.running) return;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation:false, noiseSuppression:false, autoGainControl:false }
    });

    state.ctx = new (window.AudioContext || window.webkitAudioContext)();
    state.src = state.ctx.createMediaStreamSource(stream);

    // A‑weighting IIR (3 seccions en cascada)
    const aW = createAWeightingChain(state.ctx);

    // Analitzador després del filtre (mesura ja ponderada A)
    state.analyser = state.ctx.createAnalyser();
    state.analyser.fftSize = 2048;

    // Ruta: mic -> A‑weighting -> analyser
    state.src.connect(aW.input);
    aW.output.connect(state.analyser);

    state.data = new Float32Array(state.analyser.fftSize);
    state.running = true;
    state.startedAt = performance.now();   // gràcia en verd
    state.lastStatus = 'green';
    // Assegura verd visual d'inici
    els.progress?.setAttribute('stroke', COLORS.green);

    showBanner('success', 'Micròfon actiu. Processament en local (no s\'emmagatzema àudio).');
    requestWakeLock();
    tick();
  }catch(err){
    console.error(err);
    if(err && err.name === 'NotAllowedError'){
      showBanner('error', 'Permís denegat. A macOS: Preferències del sistema → Privacitat → Micròfon → activa el navegador i recarrega.');
    }else if(err && err.name === 'NotFoundError'){
      showBanner('error', 'No s\'ha trobat micròfon. Revisa connexions o permisos del dispositiu.');
    }else{
      showBanner('error', 'No s\'ha pogut accedir al micròfon. Usa HTTPS o http://localhost i accepta el permís.');
    }
  }
}
function stop(){
  state.running = false;
  if(state.ctx) state.ctx.close();
  state.ctx = null; state.src = null; state.analyser = null; state.data = null; state.ema = null;
  releaseWakeLock();
  showBanner('warn', 'Micròfon aturat.');
}

function rmsFromBuffer(buf){
  let sum = 0;
  for(let i=0;i<buf.length;i++){ const v = buf[i]; sum += v*v; }
  return Math.sqrt(sum / buf.length);
}

function tick(){
  if(!state.running) return;
  state.analyser.getFloatTimeDomainData(state.data);
  const rms = rmsFromBuffer(state.data);
  const dbfs = 20 * Math.log10(rms + 1e-12); // dBFS (negatiu)
  let db = dbfs + state.K; // offset de calibratge (A‑weighting ja aplicat abans de l'analyser)
  state.ema = (state.ema==null) ? db : state.ema*state.emaAlpha + db*(1-state.emaAlpha);
  updateGauge(state.ema);
  updateAverages(state.ema);
  requestAnimationFrame(tick);
}

// ---------- Wake Lock (mantenir pantalla encesa) ----------
async function requestWakeLock(){
  try{
    if ('wakeLock' in navigator && !state.wakeLock){
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', ()=>{ state.wakeLock=null; });
      document.addEventListener('visibilitychange', async ()=>{
        if(document.visibilityState==='visible' && !state.wakeLock){
          try{ state.wakeLock = await navigator.wakeLock.request('screen'); }catch(e){}
        }
      });
    }
  }catch(e){}
}
function releaseWakeLock(){ try{ state.wakeLock?.release(); }catch(e){} }

// ---------- INIT ----------
loadSchedule();
applyAutoModeTick();
scheduleAutoTimer();