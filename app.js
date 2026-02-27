/* app.js – pouze výběr zvuku + Play/Stop + intenzita + hlasitost
   Audio je zpět jako v 1. verzi: AudioWorklet (noise-worklet.js), bez smyčkování bufferu.
   + chování jako ve verzi, která hrála i při zhasnuté/zavřené obrazovce: na visibilitychange audio nezastavujeme.
*/

const $ = (id) => document.getElementById(id);

const soundBtn   = $("soundBtn");
const toggleBtn  = $("toggleBtn");
const intensity  = $("intensity");
const volume     = $("volume");
const statusEl   = $("status");

// Timer
const timerDisplay = $("timerDisplay");
const timerToggle  = $("timerToggle");
const timerModal   = $("timerModal");
const timerCancel  = $("timerCancel");
const timerOk      = $("timerOk");
const timerTopH    = $("timerTopH");
const timerTopM    = $("timerTopM");
const timerTopS    = $("timerTopS");
const wheelH       = $("wheelH");
const wheelM       = $("wheelM");
const wheelS       = $("wheelS");

const soundModal = $("soundModal");
const soundClose = $("soundClose");

const installBtn = $("installBtn");

let deferredPrompt = null;

// Audio
let ctx = null;
let masterGain = null;        // GainNode (volume)
let noiseNode = null;         // AudioWorkletNode

// Real audio loop (waterfalls)
let realWaterfallBuffer = null;
let realWaterfallBufferPromise = null;
let fileSource = null;


let presetFilter1 = null;     // BiquadFilterNode
let presetFilter2 = null;     // BiquadFilterNode
let lfo = null;               // OscillatorNode
let lfoGain = null;           // GainNode (mod depth)

let currentSound = "white";
let isPlaying = false;

// Timer state
let timerEnabled = false;
let timerDurationSec = 90 * 60; // default 01:30:00
let timerRemainingSec = timerDurationSec;
let timerInterval = null;
let timerIsRunning = false;
let timerEndAtMs = 0;

// Picker state (modal)
let pickerH = 1;
let pickerM = 30;
let pickerS = 0;
let wheelsBuilt = false;

function setStatus(t){ statusEl.textContent = t; }

function pad2(n){
  const x = Math.max(0, Math.floor(Number(n) || 0));
  return String(x).padStart(2, "0");
}

function secondsToHMS(totalSec){
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return { h, m, s: ss };
}

function hmsToSeconds(h, m, s){
  const hh = Math.max(0, Math.min(99, Math.floor(Number(h) || 0)));
  const mm = Math.max(0, Math.min(59, Math.floor(Number(m) || 0)));
  const ss = Math.max(0, Math.min(59, Math.floor(Number(s) || 0)));
  return hh * 3600 + mm * 60 + ss;
}

function formatHMS(totalSec){
  const {h,m,s} = secondsToHMS(totalSec);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

function parseHMS(text){
  const t = String(text || "").trim();
  const m = t.match(/^(\d{1,2})\s*:\s*(\d{1,2})\s*:\s*(\d{1,2})$/);
  if (!m) return null;
  const sec = hmsToSeconds(m[1], m[2], m[3]);
  return sec;
}

function updateTimerUI(){
  if (!timerDisplay) return;
  timerDisplay.textContent = formatHMS(timerIsRunning ? timerRemainingSec : timerDurationSec);

  if (timerToggle){
    timerToggle.textContent = timerEnabled ? "Vypnout" : "Zapnout";
    timerToggle.setAttribute("aria-pressed", timerEnabled ? "true" : "false");
  }
}

function clearTimerInterval(){
  if (timerInterval){
    clearInterval(timerInterval);
    timerInterval = null;
  }
  timerIsRunning = false;
  timerEndAtMs = 0;
}

function stopTimerOnly(){
  clearTimerInterval();
  timerRemainingSec = timerDurationSec;
  updateTimerUI();
}

function startCountdownFromDuration(){
  if (!timerEnabled) return;
  clearTimerInterval();
  timerRemainingSec = timerDurationSec;
  timerIsRunning = true;
  timerEndAtMs = Date.now() + (timerDurationSec * 1000);
  updateTimerUI();

  // Použijeme "end time" (méně driftu a funguje líp po uspání/zhasnutí obrazovky)
  timerInterval = setInterval(async () => {
    const now = Date.now();
    timerRemainingSec = Math.max(0, Math.ceil((timerEndAtMs - now) / 1000));
    updateTimerUI();

    if (timerRemainingSec <= 0){
      clearTimerInterval();
      // po doběhnutí timer vypneme a zastavíme zvuk
      timerEnabled = false;
      timerRemainingSec = timerDurationSec;
      updateTimerUI();
      if (isPlaying){
        try{ await stopHard(); }catch{}
      }
    }
  }, 250);
}

function labelFor(mode){
  switch(mode){
    case "white": return "Bílý šum";
    case "pink": return "Růžový šum";
    case "brown": return "Hnědý šum";
    case "waterfall": return "Vodopád";
    case "waterfall_real": return "Vodopády (real)";
    case "rain": return "Déšť";
    case "wind": return "Vítr";
    case "fan": return "Ventilátor";
    case "vacuum": return "Vysavač";
    default: return "Šum";
  }
}

function volToGain(v){
  const x = Math.max(0, Math.min(1, v / 100));
  return Math.pow(x, 1.6);
}

function intensity01(){
  return Math.max(0, Math.min(1, Number(intensity.value) / 100));
}

/* =========================
   Modal pouze pro výběr zvuku
   ========================= */

function closeSoundModal(){
  soundModal.hidden = true;
  soundModal.style.display = "none";
  document.body.classList.remove("modalOpen");
  soundBtn?.setAttribute("aria-expanded", "false");

  if (soundModal._onBackdrop){
    soundModal.removeEventListener("click", soundModal._onBackdrop);
    soundModal._onBackdrop = null;
  }
}

/* =========================
   Timer modal
   ========================= */

function closeTimerModal(){
  if (!timerModal) return;
  timerModal.hidden = true;
  timerModal.style.display = "none";
  document.body.classList.remove("modalOpen");
  if (timerModal._onBackdrop){
    timerModal.removeEventListener("click", timerModal._onBackdrop);
    timerModal._onBackdrop = null;
  }
}

function openTimerModal(){
  if (!timerModal) return;

  // nastav výchozí hodnoty pickeru z uložené délky
  const cur = secondsToHMS(timerDurationSec);
  pickerH = Math.max(0, Math.min(99, cur.h));
  pickerM = Math.max(0, Math.min(59, cur.m));
  pickerS = Math.max(0, Math.min(59, cur.s));

  if (!wheelsBuilt){
    buildWheels();
    wheelsBuilt = true;
  }
  syncPickerUI(true);

  timerModal.hidden = false;
  timerModal.style.display = "flex";
  document.body.classList.add("modalOpen");

  const onBackdrop = (e) => {
    if (e.target === timerModal) closeTimerModal();
  };
  timerModal._onBackdrop = onBackdrop;
  timerModal.addEventListener("click", onBackdrop);

}

function buildWheel(listEl, max){
  if (!listEl) return;
  listEl.innerHTML = "";
  for (let i = 0; i <= max; i++){
    const div = document.createElement("div");
    div.className = "wheelItem";
    div.textContent = pad2(i);
    div.dataset.value = String(i);
    listEl.appendChild(div);
  }
}

function getItemHeight(listEl){
  const item = listEl?.querySelector(".wheelItem");
  if (!item) return 56;
  const r = item.getBoundingClientRect();
  return Math.max(40, Math.round(r.height || 56));
}

function scrollToValue(listEl, value, behavior="instant"){
  if (!listEl) return;
  const h = getItemHeight(listEl);
  const v = Math.max(0, Math.floor(Number(value) || 0));
  const top = v * h;
  try{
    listEl.scrollTo({ top, behavior });
  }catch{
    listEl.scrollTop = top;
  }
}

function valueFromScroll(listEl, max){
  const h = getItemHeight(listEl);
  const idx = Math.round((listEl?.scrollTop || 0) / h);
  return Math.max(0, Math.min(max, idx));
}

function setActiveItem(listEl, value){
  if (!listEl) return;
  const items = listEl.querySelectorAll(".wheelItem");
  items.forEach((it) => it.classList.toggle("isActive", Number(it.dataset.value) === value));
}

function syncTop(){
  if (timerTopH) timerTopH.textContent = pad2(pickerH);
  if (timerTopM) timerTopM.textContent = pad2(pickerM);
  if (timerTopS) timerTopS.textContent = pad2(pickerS);
}

function syncPickerUI(jump=false){
  syncTop();
  scrollToValue(wheelH, pickerH, jump ? "instant" : "smooth");
  scrollToValue(wheelM, pickerM, jump ? "instant" : "smooth");
  scrollToValue(wheelS, pickerS, jump ? "instant" : "smooth");
  setActiveItem(wheelH, pickerH);
  setActiveItem(wheelM, pickerM);
  setActiveItem(wheelS, pickerS);
}

function promptKeyboardEdit(){
  const cur = `${pad2(pickerH)}:${pad2(pickerM)}:${pad2(pickerS)}`;
  const val = window.prompt("Zadej čas (HH:MM:SS)", cur);
  if (val === null) return;
  const sec = parseHMS(val);
  if (sec === null) return;
  const hms = secondsToHMS(sec);
  pickerH = Math.max(0, Math.min(99, hms.h));
  pickerM = Math.max(0, Math.min(59, hms.m));
  pickerS = Math.max(0, Math.min(59, hms.s));
  syncPickerUI(true);
}

function attachWheelLogic(listEl, max, getVal, setVal){
  if (!listEl) return;

  let raf = 0;
  const onScroll = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const v = valueFromScroll(listEl, max);
      if (v !== getVal()){
        setVal(v);
        syncTop();
      }
      setActiveItem(listEl, v);
    });
  };

  listEl.addEventListener("scroll", onScroll, { passive: true });

  // Tap on item
  listEl.addEventListener("click", (e) => {
    const it = e.target.closest(".wheelItem");
    if (!it) return;
    const v = Math.max(0, Math.min(max, Number(it.dataset.value)));
    setVal(v);
    syncPickerUI(false);
  });

  // Keyboard arrows
  listEl.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const cur = getVal();
    const next = Math.max(0, Math.min(max, cur + (e.key === "ArrowUp" ? -1 : 1)));
    setVal(next);
    syncPickerUI(false);
  });
}

function buildWheels(){
  buildWheel(wheelH, 99);
  buildWheel(wheelM, 59);
  buildWheel(wheelS, 59);

  attachWheelLogic(wheelH, 99, () => pickerH, (v) => (pickerH = v));
  attachWheelLogic(wheelM, 59, () => pickerM, (v) => (pickerM = v));
  attachWheelLogic(wheelS, 59, () => pickerS, (v) => (pickerS = v));

  // Top display click -> keyboard edit
  timerTopH?.addEventListener("click", promptKeyboardEdit);
  timerTopM?.addEventListener("click", promptKeyboardEdit);
  timerTopS?.addEventListener("click", promptKeyboardEdit);
}

function openSoundModal(){
  soundModal.hidden = false;
  soundModal.style.display = "flex";
  document.body.classList.add("modalOpen");
  soundBtn?.setAttribute("aria-expanded", "true");

  const onBackdrop = (e) => {
    if (e.target === soundModal) closeSoundModal();
  };
  soundModal._onBackdrop = onBackdrop;
  soundModal.addEventListener("click", onBackdrop);
}

/* =========================
   AUDIO (worklet jako v 1. verzi)
   ========================= */

function hardMuteNow(){
  if (!ctx || !masterGain) return;
  const t = ctx.currentTime;
  try{
    masterGain.gain.cancelScheduledValues(t);
    masterGain.gain.setValueAtTime(0.0, t);
  }catch{}
}

function disconnectChain(){
  // zastav přehrávání WAV smyčky (pokud běží)
  try{ fileSource?.stop(); }catch{}
  try{ fileSource?.disconnect(); }catch{}
  fileSource = null;

  // odpoj šum a presety, zastav LFO
  try{ noiseNode?.disconnect(); }catch{}
  try{ presetFilter1?.disconnect(); }catch{}
  try{ presetFilter2?.disconnect(); }catch{}

  try{ lfoGain?.disconnect(); }catch{}
  try{ lfo?.stop(); }catch{}
  try{ lfo?.disconnect(); }catch{}

  presetFilter1 = null;
  presetFilter2 = null;
  lfo = null;
  lfoGain = null;
}

async function ensureAudio(){
  if (ctx && masterGain && noiseNode) return;

  ctx = new (window.AudioContext || window.webkitAudioContext)();

  masterGain = ctx.createGain();
  masterGain.gain.value = 0.0;
  masterGain.connect(ctx.destination);

  await ctx.audioWorklet.addModule("noise-worklet.js");
  noiseNode = new AudioWorkletNode(ctx, "noise-processor", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
}

async function ensureRealWaterfallBuffer(){
  if (realWaterfallBuffer) return realWaterfallBuffer;
  if (!ctx) await ensureAudio();
  if (realWaterfallBuffer) return realWaterfallBuffer;

  if (!realWaterfallBufferPromise){
    realWaterfallBufferPromise = fetch("waterfall-real.wav")
      .then((r) => {
        if (!r.ok) throw new Error("Nelze načíst waterfall-real.wav");
        return r.arrayBuffer();
      })
      .then((ab) => ctx.decodeAudioData(ab))
      .then((buf) => {
        realWaterfallBuffer = buf;
        return buf;
      })
      .catch((err) => {
        console.error(err);
        realWaterfallBufferPromise = null;
        return null;
      });
  }

  return realWaterfallBufferPromise;
}

function mapModeToNoiseType(mode){
  // worklet: 0=white, 1=pink, 2=brown
  if (mode === "pink") return 1;
  if (mode === "brown") return 2;

  // presety: zvolíme „příjemnější“ základ
  if (mode === "waterfall") return 1;
  if (mode === "rain") return 1;
  if (mode === "wind") return 1;
  if (mode === "fan") return 2;
  if (mode === "vacuum") return 0;

  return 0;
}

function applyVolume(){
  if (!ctx || !masterGain) return;
  const g = volToGain(Number(volume.value));
  masterGain.gain.setValueAtTime(g, ctx.currentTime);
}

function buildChainFor(mode){
  if (!ctx || !noiseNode || !masterGain) return;

  const shape = intensity01();

  // vždy nejdřív čistě odpojit starý řetězec
  disconnectChain();

// === Vodopady (real) - WAV loop ===
if (mode === "waterfall_real"){
  // Buffer musi byt nacteny (zajišťuje start() / rebuildIfPlaying())
  if (!realWaterfallBuffer){
    setStatus("Nacitam vodopady...");
    return;
  }

  // Filtry + jemnost podle intensity
  presetFilter1 = ctx.createBiquadFilter();
  presetFilter2 = ctx.createBiquadFilter();

  presetFilter1.type = "lowpass";
  presetFilter1.frequency.value = 7000 + 9000 * shape;
  presetFilter1.Q.value = 0.3;

  presetFilter2.type = "highpass";
  presetFilter2.frequency.value = 40 + 180 * shape;
  presetFilter2.Q.value = 0.2;

  fileSource = ctx.createBufferSource();
  fileSource.buffer = realWaterfallBuffer;
  fileSource.loop = true;

  fileSource.connect(presetFilter1);
  presetFilter1.connect(presetFilter2);
  presetFilter2.connect(masterGain);

  try{ fileSource.start(); }catch{}
  return;
}

  // nastavit typ + „jemnost“ (level)
  const baseLevel = 0.18 + 0.35 * shape;
  noiseNode.parameters.get("type").setValueAtTime(mapModeToNoiseType(mode), ctx.currentTime);
  noiseNode.parameters.get("level").setValueAtTime(baseLevel, ctx.currentTime);

  presetFilter1 = ctx.createBiquadFilter();
  presetFilter2 = ctx.createBiquadFilter();
  presetFilter1.type = "allpass";
  presetFilter2.type = "allpass";

  // LFO – velmi jemné „živé“ vlnění
  lfo = ctx.createOscillator();
  lfoGain = ctx.createGain();
  lfo.type = "sine";
  lfo.frequency.value = 0.15;
  lfoGain.gain.value = 0.0;

  // chain: noise -> f1 -> f2 -> masterGain
  noiseNode.connect(presetFilter1);
  presetFilter1.connect(presetFilter2);
  presetFilter2.connect(masterGain);

  // LFO -> masterGain.gain
  try{
    lfo.connect(lfoGain);
    lfoGain.connect(masterGain.gain);
  }catch{}

  // Základní šumy (jemné vyhlazení)
  if (mode === "white" || mode === "pink" || mode === "brown"){
    presetFilter1.type = "lowpass";
    presetFilter1.frequency.value = 8000 - 5500 * (1 - shape);
    presetFilter1.Q.value = 0.2;

    presetFilter2.type = "highpass";
    presetFilter2.frequency.value = 20 + 80 * shape;
    presetFilter2.Q.value = 0.1;

    lfo.frequency.value = 0.08 + 0.22 * shape;
    lfoGain.gain.value = 0.00 + 0.02 * shape;
  }

  if (mode === "waterfall"){
    presetFilter1.type = "bandpass";
    presetFilter1.frequency.value = 800 + 900 * shape;
    presetFilter1.Q.value = 0.4 + 0.9 * shape;

    presetFilter2.type = "highshelf";
    presetFilter2.frequency.value = 2500;
    presetFilter2.gain.value = -6 + 2 * shape;

    lfo.frequency.value = 0.12 + 0.35 * shape;
    lfoGain.gain.value = 0.01 + 0.03 * shape;
  }

  if (mode === "rain"){
    // podobné jako „pink“ + jemné zrnění ve výškách
    presetFilter1.type = "highpass";
    presetFilter1.frequency.value = 180 + 420 * shape;
    presetFilter1.Q.value = 0.25;

    presetFilter2.type = "lowpass";
    presetFilter2.frequency.value = 6500 + 9000 * shape;
    presetFilter2.Q.value = 0.3;

    lfo.frequency.value = 0.35 + 0.35 * shape;
    lfoGain.gain.value = 0.004 + 0.010 * shape;
  }

  if (mode === "wind"){
    presetFilter1.type = "lowpass";
    presetFilter1.frequency.value = 600 + 900 * shape;
    presetFilter1.Q.value = 0.6;

    presetFilter2.type = "highpass";
    presetFilter2.frequency.value = 40 + 120 * shape;
    presetFilter2.Q.value = 0.2;

    lfo.frequency.value = 0.05 + 0.18 * shape;
    lfoGain.gain.value = 0.03 + 0.06 * shape;
  }

  if (mode === "fan"){
    // stejné ladění jako původní 1. verze
    presetFilter1.type = "lowpass";
    presetFilter1.frequency.value = 300 + 550 * shape;
    presetFilter1.Q.value = 0.9;

    presetFilter2.type = "peaking";
    presetFilter2.frequency.value = 120 + 120 * shape;
    presetFilter2.Q.value = 1.2;
    presetFilter2.gain.value = 2 + 4 * shape;

    lfo.frequency.value = 0.9 + 1.6 * shape;
    lfoGain.gain.value = 0.005 + 0.015 * shape;
  }

  if (mode === "vacuum"){
    presetFilter1.type = "highpass";
    presetFilter1.frequency.value = 120 + 220 * shape;
    presetFilter1.Q.value = 0.6;

    presetFilter2.type = "highshelf";
    presetFilter2.frequency.value = 1500;
    presetFilter2.gain.value = 2 + 6 * shape;

    lfo.frequency.value = 0.25;
    lfoGain.gain.value = 0.004;
  }

  try{ lfo.start(); }catch{}
}

async function start(){
  closeSoundModal();
  closeTimerModal();

  await ensureAudio();
  if (ctx.state === "suspended") await ctx.resume();

  // postavit řetězec + hlasitost
  // pro real vodopady si nejdriv nacti WAV buffer
  if (currentSound === "waterfall_real"){
    const buf = await ensureRealWaterfallBuffer();
    if (!buf){
      // fallback na synteticky vodopad
      currentSound = "waterfall";
    }
  }
  buildChainFor(currentSound);
  applyVolume();

  isPlaying = true;
  toggleBtn.textContent = "■ Stop";
  setStatus(labelFor(currentSound));

  if (timerEnabled){
    startCountdownFromDuration();
  }
}

async function stopHard(){
  if (!ctx) return;

  // stop timer (audio stop)
  stopTimerOnly();

  // absolutní ticho
  hardMuteNow();
  disconnectChain();

  try{ await ctx.suspend(); }catch{}

  isPlaying = false;
  toggleBtn.textContent = "▶ Play";
  setStatus("Stop.");
}

async function rebuildIfPlaying(){
  if (!isPlaying || !ctx) return;

  // přestavět preset (po změně zvuku/intenzity) bez „zbytků“
  hardMuteNow();
// pro real vodopady si nejdriv nacti WAV buffer
if (currentSound === "waterfall_real"){
  const buf = await ensureRealWaterfallBuffer();
  if (!buf){
    currentSound = "waterfall";
  }
}

  buildChainFor(currentSound);
  applyVolume();
}

function saveTimerSettings(){
  try{
    localStorage.setItem("sumyTimerEnabled", timerEnabled ? "1" : "0");
    localStorage.setItem("sumyTimerDurationSec", String(timerDurationSec));
  }catch{}
}

function loadTimerSettings(){
  try{
    const en = localStorage.getItem("sumyTimerEnabled");
    const dur = localStorage.getItem("sumyTimerDurationSec");

    timerEnabled = en === "1";
    const d = Number(dur);
    if (Number.isFinite(d) && d >= 0 && d <= 99*3600 + 59*60 + 59){
      timerDurationSec = Math.floor(d);
    }
    timerRemainingSec = timerDurationSec;
  }catch{}
}

/* =========================
   UI events
   ========================= */

soundBtn.addEventListener("click", () => openSoundModal());
soundClose.addEventListener("click", () => closeSoundModal());

soundModal.addEventListener("click", (e) => {
  const b = e.target.closest("[data-sound]");
  if (!b) return;

  currentSound = b.dataset.sound;

  // nastav text na tlačítku
  const first = soundBtn.childNodes[0];
  if (first && first.nodeType === Node.TEXT_NODE){
    first.textContent = labelFor(currentSound) + " ";
  } else {
    soundBtn.textContent = labelFor(currentSound);
  }

  setStatus(labelFor(currentSound));
  closeSoundModal();
  rebuildIfPlaying();
});

toggleBtn.addEventListener("click", async () => {
  try{
    if (!isPlaying) await start();
    else await stopHard();
  }catch(err){
    console.error(err);
    setStatus("Nepodařilo se spustit audio (zkus kliknout znovu).");
  }
});

intensity.addEventListener("input", () => rebuildIfPlaying());
volume.addEventListener("input", () => { if (isPlaying) applyVolume(); });

// Timer: edit + swipe
// Pozn.: Na některých mobilech (a někdy i na desktopu) se "click" na prvku s pointer událostmi
// nemusí spolehlivě odpálit. Proto otevíráme editor na pointerup, pokud neproběhl swipe.
if (timerDisplay){
  // klávesnice (přístupnost)
  timerDisplay.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " "){
      e.preventDefault();
      openTimerModal();
    }
  });

  // Swipe up/down to change HH / MM / SS (Samsung-like)
  const state = {
    active: false,
    startY: 0,
    startX: 0,
    seg: 1,
    lastStep: 0,
    moved: false,
  };

  const segmentFromX = (clientX) => {
    const r = timerDisplay.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, clientX - r.left));
    const idx = Math.floor((x / r.width) * 3);
    return Math.max(0, Math.min(2, idx));
  };

  const applyDelta = (seg, delta) => {
    const {h,m,s} = secondsToHMS(timerIsRunning ? timerRemainingSec : timerDurationSec);
    let hh = h, mm = m, ss = s;
    if (seg === 0) hh = Math.max(0, Math.min(99, hh + delta));
    if (seg === 1) mm = Math.max(0, Math.min(59, mm + delta));
    if (seg === 2) ss = Math.max(0, Math.min(59, ss + delta));

    const newSec = hmsToSeconds(hh, mm, ss);
    timerDurationSec = newSec;
    timerRemainingSec = timerIsRunning ? newSec : newSec;

    // když timer běží, přepneme ho na „nový“ čas (zjednodušení)
    if (timerIsRunning){
      clearTimerInterval();
      if (timerEnabled && isPlaying) startCountdownFromDuration();
    }

    saveTimerSettings();
    updateTimerUI();
  };

  timerDisplay.addEventListener("pointerdown", (e) => {
    timerDisplay.setPointerCapture?.(e.pointerId);
    state.active = true;
    state.startY = e.clientY;
    state.startX = e.clientX;
    state.seg = segmentFromX(e.clientX);
    state.lastStep = 0;
    timerDisplay._swiped = false;
    state.moved = false;
  });

  timerDisplay.addEventListener("pointermove", (e) => {
    if (!state.active) return;
    const dy = e.clientY - state.startY;
    const dx = e.clientX - state.startX;

    // ignorujeme náhodné mikropohyby
    if (Math.abs(dy) < 8 && Math.abs(dx) < 8) return;

    // když už je to tah, nespouštíme click
    timerDisplay._swiped = true;
    state.moved = true;

    const stepPx = 28;
    const steps = Math.trunc((-dy) / stepPx);
    const delta = steps - state.lastStep;
    if (delta !== 0){
      applyDelta(state.seg, delta);
      state.lastStep = steps;
    }
  });

  const endSwipe = () => {
    state.active = false;
  };

  timerDisplay.addEventListener("pointerup", () => {
    // pokud to nebyl swipe/tah, otevři editor
    if (!timerDisplay._swiped && !state.moved){
      openTimerModal();
    }
    timerDisplay._swiped = false;
    endSwipe();
  });

  timerDisplay.addEventListener("pointercancel", () => {
    timerDisplay._swiped = false;
    endSwipe();
  });
}

// Timer: enable/disable
if (timerToggle){
  timerToggle.addEventListener("click", () => {
    timerEnabled = !timerEnabled;
    saveTimerSettings();
    updateTimerUI();

    if (!timerEnabled){
      stopTimerOnly();
      return;
    }

    // zapnuto: odpočítávání startne hned (až doběhne, případně vypne šum)
    startCountdownFromDuration();
  });
}

// Timer modal actions
if (timerCancel) timerCancel.addEventListener("click", () => closeTimerModal());
if (timerOk){
  timerOk.addEventListener("click", () => {
    const sec = hmsToSeconds(pickerH, pickerM, pickerS);
    timerDurationSec = sec;
    timerRemainingSec = sec;
    saveTimerSettings();
    updateTimerUI();
    closeTimerModal();

    if (timerEnabled){
      startCountdownFromDuration();
    }
  });
}

if (timerModal){
  timerModal.addEventListener("keydown", (e) => {
    if (e.key === "Escape"){
      e.preventDefault();
      closeTimerModal();
    }
    if (e.key === "Enter"){
      e.preventDefault();
      timerOk?.click();
    }
  });
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden){
    // Nezastavujeme audio – ať může hrát na pozadí / při zhasnuté obrazovce.
    // Jen zavřeme případné otevřené okno.
    closeSoundModal();
    closeTimerModal();
  }
});

/* =========================
   PWA install
   ========================= */
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (installBtn) installBtn.hidden = false;
});

if (installBtn){
  installBtn.addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    installBtn.hidden = true;
  });
}

/* init */
loadTimerSettings();
soundBtn.childNodes[0].textContent = labelFor(currentSound) + " ";
toggleBtn.textContent = "▶ Play";
setStatus("Připraveno.");
closeSoundModal();
closeTimerModal();
updateTimerUI();


// Service Worker (offline + aktualizace)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("./sw.js");

      // Když už je nová verze připravená (waiting), nabídneme reload
      function promptUpdate() {
        if (!reg.waiting) return;
        const ok = confirm("Je dostupná nová verze aplikace. Načíst teď? (při offline to nevadí)");
        if (ok) {
          reg.waiting.postMessage({ type: "SKIP_WAITING" });
        }
      }

      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener("statechange", () => {
          // nový SW je nainstalovaný, ale čeká na převzetí
          if (nw.state === "installed" && navigator.serviceWorker.controller) {
            promptUpdate();
          }
        });
      });

      // Pokud při registraci už čeká update
      promptUpdate();

      // Po převzetí kontroleru reloadneme, aby běžela nová verze
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        window.location.reload();
      });

      // Průběžná kontrola aktualizací (když se appka otevře / vrátí do popředí)
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") reg.update().catch(() => {});
      });

      // A jednou za 30 minut při běhu stránky (nezatěžuje)
      setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
    } catch (e) {
      // SW není kritický – app může běžet i bez něj (jen nebude offline)
      console.warn("SW register failed", e);
    }
  });
}
