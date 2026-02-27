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

let timerEnabled = false;
let timerSeconds = 0;
let timerEndAt = 0;
let timerTickInterval = null;

// Modal výběr zvuku
const soundModal = $("soundModal");
const soundModalList = $("soundModalList");
const soundClose = $("soundClose");

const presetsBtn = $("presetsBtn");
const presetsModal = $("presetsModal");
const presetsModalList = $("presetsModalList");
const presetsClose = $("presetsClose");

// ====== Audio (WebAudio) ======
let ctx = null;
let masterGain = null;

let noiseNode = null;      // AudioWorkletNode
let fileSource = null;     // AudioBufferSourceNode (pro "real" MP3)

let presetFilter1 = null;
let presetFilter2 = null;
let lfo = null;
let lfoGain = null;

let isPlaying = false;

// Buffery pro real nahrávky
let realWaterfallBuffer = null;
let realSeaBuffer = null;
let realWindBuffer = null;
let realRainBuffer = null;

let realWaterfallBufferPromise = null;
let realSeaBufferPromise = null;
let realWindBufferPromise = null;
let realRainBufferPromise = null;

// ====== Stav UI ======
let currentMode = localStorage.getItem("sumyMode") || "white";
let currentPreset = localStorage.getItem("sumyPreset") || "none";

function setStatus(t){
  if (statusEl) statusEl.textContent = t || "";
}

function updateToggleUI(){
  if (!toggleBtn) return;
  toggleBtn.textContent = isPlaying ? "Stop" : "Play";
  toggleBtn.setAttribute("aria-pressed", isPlaying ? "true" : "false");
}

function clamp01(x){
  return Math.max(0, Math.min(1, x));
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
}

function openSoundModal(){
  soundModal.hidden = false;
  soundModal.style.display = "flex";
  document.body.classList.add("modalOpen");
}

function closePresetsModal(){
  presetsModal.hidden = true;
  presetsModal.style.display = "none";
  document.body.classList.remove("modalOpen");
}

function openPresetsModal(){
  presetsModal.hidden = false;
  presetsModal.style.display = "flex";
  document.body.classList.add("modalOpen");
}

const SOUND_LIST = [
  { id:"white", label:"Bílý šum" },
  { id:"pink", label:"Růžový šum" },
  { id:"brown", label:"Hnědý šum" },
  { id:"fan", label:"Ventilátor (synt.)" },
  { id:"waterfall_real", label:"Vodopády (real)" },
  { id:"sea_real", label:"Moře (real)" },
  { id:"wind_real", label:"Vítr (real)" },
  { id:"rain_real", label:"Déšť (real)" },
];

const PRESETS_LIST = [
  { id:"none", label:"Bez presetů" },
  { id:"sleep", label:"Spánek (jemný)" },
  { id:"focus", label:"Soustředění (jasnější)" },
  { id:"relax", label:"Relax (teplejší)" },
];

function renderSoundModal(){
  if (!soundModalList) return;
  soundModalList.innerHTML = "";
  SOUND_LIST.forEach((s) => {
    const btn = document.createElement("button");
    btn.className = "modalItem";
    btn.type = "button";
    btn.textContent = s.label;
    btn.dataset.id = s.id;
    if (s.id === currentMode) btn.classList.add("active");
    btn.addEventListener("click", async () => {
      currentMode = s.id;
      localStorage.setItem("sumyMode", currentMode);
      closeSoundModal();
      await rebuildIfPlaying();
      updateSoundBtnLabel();
      renderSoundModal();
    });
    soundModalList.appendChild(btn);
  });
}

function renderPresetsModal(){
  if (!presetsModalList) return;
  presetsModalList.innerHTML = "";
  PRESETS_LIST.forEach((p) => {
    const btn = document.createElement("button");
    btn.className = "modalItem";
    btn.type = "button";
    btn.textContent = p.label;
    btn.dataset.id = p.id;
    if (p.id === currentPreset) btn.classList.add("active");
    btn.addEventListener("click", async () => {
      currentPreset = p.id;
      localStorage.setItem("sumyPreset", currentPreset);
      closePresetsModal();
      await rebuildIfPlaying();
      updatePresetsBtnLabel();
      renderPresetsModal();
    });
    presetsModalList.appendChild(btn);
  });
}

function labelForMode(id){
  return SOUND_LIST.find((x) => x.id === id)?.label || id;
}

function labelForPreset(id){
  return PRESETS_LIST.find((x) => x.id === id)?.label || id;
}

function updateSoundBtnLabel(){
  if (!soundBtn) return;
  soundBtn.textContent = labelForMode(currentMode);
}

function updatePresetsBtnLabel(){
  if (!presetsBtn) return;
  presetsBtn.textContent = labelForPreset(currentPreset);
}

/* =========================
   Timer UI
   ========================= */

function pad2(n){ return String(n).padStart(2,"0"); }

function formatTimer(sec){
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec/3600);
  const m = Math.floor((sec%3600)/60);
  const s = sec%60;
  if (h>0) return `${h}:${pad2(m)}:${pad2(s)}`;
  return `${m}:${pad2(s)}`;
}

function updateTimerDisplay(){
  if (!timerDisplay) return;
  if (!timerEnabled || timerSeconds<=0){
    timerDisplay.textContent = "—";
    return;
  }
  const now = Date.now();
  const left = Math.max(0, Math.ceil((timerEndAt - now)/1000));
  timerDisplay.textContent = formatTimer(left);
}

function stopTimerTick(){
  if (timerTickInterval){
    clearInterval(timerTickInterval);
    timerTickInterval = null;
  }
}

function startTimerTick(){
  stopTimerTick();
  timerTickInterval = setInterval(() => {
    if (!timerEnabled) return;
    const now = Date.now();
    const left = Math.max(0, Math.ceil((timerEndAt - now)/1000));
    if (left<=0){
      timerEnabled = false;
      timerSeconds = 0;
      timerEndAt = 0;
      stopTimerTick();
      updateTimerDisplay();
      // vypnout přehrávání
      if (isPlaying) stop();
      return;
    }
    updateTimerDisplay();
  }, 250);
}

function openTimerModal(){
  if (!timerModal) return;
  timerModal.hidden = false;
  timerModal.style.display = "flex";
  document.body.classList.add("modalOpen");

  const onBackdrop = (e) => {
    if (e.target === timerModal) closeTimerModal();
  };
  timerModal._onBackdrop = onBackdrop;
  timerModal.addEventListener("click", onBackdrop);

}

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

function scrollToValue(listEl, value, behavior="auto"){
  if (!listEl) return;
  const itemH = getItemHeight(listEl);
  listEl.scrollTo({ top: value*itemH, behavior });
}

function getNearestValue(listEl, max){
  if (!listEl) return 0;
  const itemH = getItemHeight(listEl);
  const v = Math.round(listEl.scrollTop / itemH);
  return Math.max(0, Math.min(max, v));
}

function snapWheel(listEl, max){
  if (!listEl) return;
  const v = getNearestValue(listEl, max);
  scrollToValue(listEl, v, "smooth");
}

function readTimerFromWheels(){
  const h = getNearestValue(wheelH, 23);
  const m = getNearestValue(wheelM, 59);
  const s = getNearestValue(wheelS, 59);
  return h*3600 + m*60 + s;
}

/* =========================
   WebAudio
   ========================= */

function applyVolume(){
  if (!masterGain || !ctx) return;
  const v = clamp01(Number(volume.value)/100);
  // masterGain target: v (bez kliknutí)
  const t = ctx.currentTime;
  try{
    masterGain.gain.cancelScheduledValues(t);
    masterGain.gain.setTargetAtTime(v, t, 0.03);
  }catch{}
}

function fadeIn(){
  if (!masterGain || !ctx) return;
  const v = clamp01(Number(volume.value)/100);
  const t = ctx.currentTime;
  try{
    masterGain.gain.cancelScheduledValues(t);
    masterGain.gain.setValueAtTime(0.0, t);
    masterGain.gain.linearRampToValueAtTime(v, t + 0.08);
  }catch{}
}

function fadeOut(){
  if (!masterGain || !ctx) return;
  const t = ctx.currentTime;
  try{
    masterGain.gain.cancelScheduledValues(t);
    masterGain.gain.setValueAtTime(masterGain.gain.value, t);
    masterGain.gain.linearRampToValueAtTime(0.0, t + 0.08);
  }catch{}
}

function hardMute(){
  if (!masterGain || !ctx) return;
  const t = ctx.currentTime;
  try{
    masterGain.gain.cancelScheduledValues(t);
    masterGain.gain.setValueAtTime(0.0, t);
  }catch{}
}

function disconnectChain(){
  // zastav přehrávání MP3 smyčky (pokud běží)
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
    realWaterfallBufferPromise = fetch("waterfall-real.mp3")
      .then((r) => {
        if (!r.ok) throw new Error("Nelze načíst waterfall-real.mp3");
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

function ensureRealSeaBuffer(){
  if (realSeaBuffer) return realSeaBuffer;
  if (realSeaBuffer) return realSeaBuffer;

  if (!realSeaBufferPromise){
    realSeaBufferPromise = fetch("sea-real.mp3")
      .then((r) => {
        if (!r.ok) throw new Error("Nelze načíst sea-real.mp3");
        return r.arrayBuffer();
      })
      .then((ab) => ctx.decodeAudioData(ab))
      .then((buf) => {
        realSeaBuffer = buf;
        return buf;
      })
      .catch((err) => {
        console.error(err);
        realSeaBufferPromise = null;
        return null;
      });
  }

  return realSeaBufferPromise;
}

function ensureRealWindBuffer(){
  if (realWindBuffer) return realWindBuffer;
  if (realWindBuffer) return realWindBuffer;

  if (!realWindBufferPromise){
    realWindBufferPromise = fetch("wind-real.mp3")
      .then((r) => {
        if (!r.ok) throw new Error("Nelze načíst wind-real.mp3");
        return r.arrayBuffer();
      })
      .then((ab) => ctx.decodeAudioData(ab))
      .then((buf) => {
        realWindBuffer = buf;
        return buf;
      })
      .catch((err) => {
        console.error(err);
        realWindBufferPromise = null;
        return null;
      });
  }

  return realWindBufferPromise;
}

function ensureRealRainBuffer(){
  if (realRainBuffer) return realRainBuffer;
  if (realRainBuffer) return realRainBuffer;

  if (!realRainBufferPromise){
    realRainBufferPromise = fetch("rain-real.mp3")
      .then((r) => {
        if (!r.ok) throw new Error("Nelze načíst rain-real.mp3");
        return r.arrayBuffer();
      })
      .then((ab) => ctx.decodeAudioData(ab))
      .then((buf) => {
        realRainBuffer = buf;
        return buf;
      })
      .catch((err) => {
        console.error(err);
        realRainBufferPromise = null;
        return null;
      });
  }

  return realRainBufferPromise;
}

/* =========================
   Presety pro syntetické šumy
   ========================= */

function applyPresetForSynthetic(mode, preset){
  // Presety se používají jen pro syntetické módy (white/pink/brown/fan)
  // Real nahrávky se nebarví.
  if (!ctx || !noiseNode) return;

  // default: bez presetů
  presetFilter1 = null;
  presetFilter2 = null;
  lfo = null;
  lfoGain = null;

  if (preset === "none") return;

  // Jednoduché presety přes biquad filtry
  const f1 = ctx.createBiquadFilter();
  const f2 = ctx.createBiquadFilter();

  if (preset === "sleep"){
    // jemnější, méně výšek
    f1.type = "lowpass";
    f1.frequency.value = 1500;
    f1.Q.value = 0.7;

    f2.type = "lowpass";
    f2.frequency.value = 5000;
    f2.Q.value = 0.7;
  } else if (preset === "focus"){
    // více středů, méně sub-basu
    f1.type = "highpass";
    f1.frequency.value = 120;
    f1.Q.value = 0.7;

    f2.type = "peaking";
    f2.frequency.value = 1200;
    f2.Q.value = 0.9;
    f2.gain.value = 3.0;
  } else if (preset === "relax"){
    // teplejší, lehce potlačit výšky
    f1.type = "lowpass";
    f1.frequency.value = 3200;
    f1.Q.value = 0.7;

    f2.type = "peaking";
    f2.frequency.value = 250;
    f2.Q.value = 0.9;
    f2.gain.value = 2.0;
  } else {
    return;
  }

  presetFilter1 = f1;
  presetFilter2 = f2;

  // Volitelně: jemný LFO na gain (pro "dýchání") jen pro fan
  if (mode === "fan"){
    lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 0.18;
    lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.04;

    lfo.connect(lfoGain);
    lfoGain.connect(masterGain.gain);
    try{ lfo.start(); }catch{}
  }
}

function mapModeToNoiseType(mode){
  switch(mode){
    case "white": return 0;
    case "pink": return 1;
    case "brown": return 2;
    case "fan": return 3;
    default: return 0;
  }
}

// === Seamless loop pro "real" MP3 (odstraní ticho na konci a začne až po úvodním náběhu) ===
// Pozn.: WebAudio BufferSource umí loopStart/loopEnd. Trimujeme typicky posledních ~150 ms,
// kde u MP3 často zůstane ticho / enkódovací "tail". Startujeme o ~50 ms později.
// Když by nahrávka byla extrémně krátká, spadne to na celý rozsah.
function configureSeamlessRealLoop(source, buffer){
  const head = 0.05;   // přeskoč úplný začátek (klik/lead-in)
  const tail = 0.15;   // přeskoč ticho na konci (typicky 1–2 s u některých MP3)
  const minLoop = 0.40;

  const dur = Math.max(0, Number(buffer?.duration) || 0);
  let loopStart = Math.min(head, Math.max(0, dur - 0.20));
  let loopEnd   = Math.max(loopStart + minLoop, dur - tail);

  // ořezy do bezpečného rozsahu
  loopStart = Math.max(0, Math.min(loopStart, dur));
  loopEnd   = Math.max(0, Math.min(loopEnd, dur));

  // když to nevychází, vrať celý buffer
  if (dur < 0.5 || loopEnd <= loopStart + 0.05){
    loopStart = 0;
    loopEnd = dur;
  }

  source.loop = true;
  // loopStart/loopEnd jsou v sekundách
  source.loopStart = loopStart;
  source.loopEnd = loopEnd;

  return loopStart; // doporučený offset pro start()
}

function buildChainFor(mode){
  if (!ctx || !noiseNode || !masterGain) return;

  // Jemnost/intenzita se vztahuje pouze na syntetické šumy.
  // „Real“ nahrávky se NESMÍ nijak upravovat (žádné filtry / EQ / změny barvy).
  const shape = intensity01();

  // vždy nejdřív čistě odpojit starý řetězec
  disconnectChain();

  // === Vodopady (real) - MP3 loop ===
  if (mode === "waterfall_real"){
    // Buffer musi byt nacteny (zajišťuje start() / rebuildIfPlaying())
    if (!realWaterfallBuffer){
      setStatus("Nacitam vodopady...");
      return;
    }

    fileSource = ctx.createBufferSource();
    fileSource.buffer = realWaterfallBuffer;
    const _offset = configureSeamlessRealLoop(fileSource, fileSource.buffer);

    // Bez úprav zvuku: přímo do masterGain (hlasitosť)
    fileSource.connect(masterGain);

    try{ fileSource.start(0, _offset); }catch{}
    return;
  }

  // === Moře (real) - MP3 loop ===
  if (mode === "sea_real"){
    if (!realSeaBuffer){
      setStatus("Nacitam more...");
      return;
    }
    fileSource = ctx.createBufferSource();
    fileSource.buffer = realSeaBuffer;
    const _offset = configureSeamlessRealLoop(fileSource, fileSource.buffer);

    // Bez úprav zvuku: přímo do masterGain (hlasitosť)
    fileSource.connect(masterGain);

    try{ fileSource.start(0, _offset); }catch{}
    return;
  }

  // === Vítr (real) - MP3 loop ===
  if (mode === "wind_real"){
    if (!realWindBuffer){
      setStatus("Nacitam vitr...");
      return;
    }
    fileSource = ctx.createBufferSource();
    fileSource.buffer = realWindBuffer;
    const _offset = configureSeamlessRealLoop(fileSource, fileSource.buffer);

    // Bez úprav zvuku: přímo do masterGain (hlasitosť)
    fileSource.connect(masterGain);

    try{ fileSource.start(0, _offset); }catch{}
    return;
  }

  // === Déšť (real) - MP3 loop ===
  if (mode === "rain_real"){
    if (!realRainBuffer){
      setStatus("Nacitam dest...");
      return;
    }
    fileSource = ctx.createBufferSource();
    fileSource.buffer = realRainBuffer;
    const _offset = configureSeamlessRealLoop(fileSource, fileSource.buffer);

    // Bez úprav zvuku: přímo do masterGain (hlasitosť)
    fileSource.connect(masterGain);

    try{ fileSource.start(0, _offset); }catch{}
    return;
  }

  // === syntetické šumy ===

  // nastavit typ + „jemnost“ (level)
  const baseLevel = 0.18 + 0.35 * shape;
  noiseNode.parameters.get("type").setValueAtTime(mapModeToNoiseType(mode), ctx.currentTime);
  noiseNode.parameters.get("level").setValueAtTime(baseLevel, ctx.currentTime);

  // presety jen pro syntetiku
  applyPresetForSynthetic(mode, currentPreset);

  // zapoj řetězec: noise -> (preset filtry?) -> master
  if (presetFilter1 && presetFilter2){
    noiseNode.connect(presetFilter1);
    presetFilter1.connect(presetFilter2);
    presetFilter2.connect(masterGain);
  } else {
    noiseNode.connect(masterGain);
  }
}

/* =========================
   Start / Stop
   ========================= */

async function start(){
  try{
    await ensureAudio();

    // přednačíst reálné buffery, když je to vybraný režim
    if (currentMode === "waterfall_real"){
      setStatus("Nacitam vodopady...");
      await ensureRealWaterfallBuffer();
    } else if (currentMode === "sea_real"){
      setStatus("Nacitam more...");
      await ensureRealSeaBuffer();
    } else if (currentMode === "wind_real"){
      setStatus("Nacitam vitr...");
      await ensureRealWindBuffer();
    } else if (currentMode === "rain_real"){
      setStatus("Nacitam dest...");
      await ensureRealRainBuffer();
    }

    setStatus("");
    buildChainFor(currentMode);

    if (ctx.state === "suspended"){
      await ctx.resume();
    }

    fadeIn();
    isPlaying = true;
    updateToggleUI();

    // Timer start/refresh
    if (timerEnabled && timerSeconds>0){
      timerEndAt = Date.now() + timerSeconds*1000;
      startTimerTick();
      updateTimerDisplay();
    }

  }catch(err){
    console.error(err);
    setStatus("Chyba audio: " + (err?.message || err));
  }
}

function stop(){
  try{
    fadeOut();
    // po krátké době odpoj řetězec
    setTimeout(() => {
      try{ disconnectChain(); }catch{}
      try{ hardMute(); }catch{}
    }, 120);
  }catch{}
  isPlaying = false;
  updateToggleUI();
}

async function rebuildIfPlaying(){
  if (!isPlaying) return;

  // pro real režimy: dočti buffer, pokud chybí
  if (currentMode === "waterfall_real" && !realWaterfallBuffer){
    await ensureRealWaterfallBuffer();
  }
  if (currentMode === "sea_real" && !realSeaBuffer){
    await ensureRealSeaBuffer();
  }
  if (currentMode === "wind_real" && !realWindBuffer){
    await ensureRealWindBuffer();
  }
  if (currentMode === "rain_real" && !realRainBuffer){
    await ensureRealRainBuffer();
  }

  // rebuild řetězce
  buildChainFor(currentMode);
  applyVolume();
}

function wireUI(){
  updateSoundBtnLabel();
  updatePresetsBtnLabel();
  renderSoundModal();
  renderPresetsModal();
  updateToggleUI();

  // Volume
  volume?.addEventListener("input", () => applyVolume());

  // Intensity (jen syntetika, ale ovlivní level)
  intensity?.addEventListener("input", () => rebuildIfPlaying());

  // Play/Stop
  toggleBtn?.addEventListener("click", async () => {
    if (!isPlaying) await start();
    else stop();
  });

  // Sound modal open/close
  soundBtn?.addEventListener("click", () => openSoundModal());
  soundClose?.addEventListener("click", () => closeSoundModal());
  soundModal?.addEventListener("click", (e) => {
    if (e.target === soundModal) closeSoundModal();
  });

  // Presets modal open/close
  presetsBtn?.addEventListener("click", () => openPresetsModal());
  presetsClose?.addEventListener("click", () => closePresetsModal());
  presetsModal?.addEventListener("click", (e) => {
    if (e.target === presetsModal) closePresetsModal();
  });

  // Timer modal
  timerToggle?.addEventListener("click", () => openTimerModal());
  timerCancel?.addEventListener("click", () => closeTimerModal());
  timerOk?.addEventListener("click", () => {
    const sec = readTimerFromWheels();
    timerSeconds = sec;
    timerEnabled = sec>0;
    if (timerEnabled){
      timerEndAt = Date.now() + timerSeconds*1000;
      startTimerTick();
    } else {
      stopTimerTick();
      timerEndAt = 0;
    }
    updateTimerDisplay();
    closeTimerModal();
  });

  // wheels
  buildWheel(wheelH, 23);
  buildWheel(wheelM, 59);
  buildWheel(wheelS, 59);

  // default 0
  scrollToValue(wheelH, 0);
  scrollToValue(wheelM, 0);
  scrollToValue(wheelS, 0);

  const snapLater = (listEl, max) => {
    let t = null;
    listEl.addEventListener("scroll", () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => snapWheel(listEl, max), 80);
    }, { passive:true });
  };
  snapLater(wheelH, 23);
  snapLater(wheelM, 59);
  snapLater(wheelS, 59);

  updateTimerDisplay();

  // NEZASTAVOVAT na visibilitychange (kvůli přehrávání na pozadí)
  document.addEventListener("visibilitychange", () => {
    // nic
  });
}

wireUI();
