/* app.js – Šumy (PWA) čisté UI + spolehlivé modaly + tvrdý STOP */

const $ = (id) => document.getElementById(id);

const soundBtn   = $("soundBtn");
const toggleBtn  = $("toggleBtn");
const intensity  = $("intensity");
const volume     = $("volume");
const statusEl   = $("status");

const soundModal = $("soundModal");
const soundClose = $("soundClose");

const helpBtn    = $("helpBtn");
const helpModal  = $("helpModal");
const helpClose  = $("helpClose");

const installBtn = $("installBtn");

let deferredPrompt = null;

// Audio state
let ctx = null;
let masterGain = null;
let sourceNodes = [];
let currentSound = "white";
let isPlaying = false;

// Když chceš naprosté ticho vždy a hned, dej true (Stop zavře AudioContext)
const HARD_CLOSE_CONTEXT_ON_STOP = false;

function setStatus(t){ statusEl.textContent = t; }

function labelFor(mode){
  switch(mode){
    case "white": return "Bílý šum";
    case "pink": return "Růžový šum";
    case "brown": return "Hnědý šum";
    case "waterfall": return "Vodopád";
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

function addNode(n){
  sourceNodes.push(n);
  return n;
}

/* =========================
   MODALS (anti-zaseknutí)
   ========================= */

const MODALS = [soundModal, helpModal];

function closeAllModals(){
  for (const m of MODALS){
    if (!m) continue;
    m.hidden = true;
    if (m._onBackdrop){
      m.removeEventListener("click", m._onBackdrop);
      m._onBackdrop = null;
    }
  }
  document.body.classList.remove("modalOpen");
  soundBtn?.setAttribute("aria-expanded", "false");
}

// otevři přes history, aby Android back zavřel modal
function openModal(modal){
  closeAllModals();
  modal.hidden = false;
  document.body.classList.add("modalOpen");

  const onBackdrop = (e) => {
    if (e.target === modal) {
      // zavřít přes back, aby seděla historie
      try{ history.back(); }catch{ closeAllModals(); }
    }
  };
  modal._onBackdrop = onBackdrop;
  modal.addEventListener("click", onBackdrop);

  try{
    history.pushState({ modal: true }, "");
  }catch{}
}

window.addEventListener("popstate", () => {
  // při back zavřeme modaly
  closeAllModals();
});

/* =========================
   AUDIO
   ========================= */

async function ensureAudio(){
  if (ctx && masterGain) return;

  ctx = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = ctx.createGain();
  masterGain.gain.value = 0.0;
  masterGain.connect(ctx.destination);
}

function makeNoiseBuffer(type, seconds = 2){
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.floor(seconds * sr));
  const buf = ctx.createBuffer(1, len, sr);
  const data = buf.getChannelData(0);

  // white base
  for (let i=0; i<len; i++) data[i] = (Math.random() * 2 - 1);

  if (type === "pink"){
    let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
    for (let i=0; i<len; i++){
      const w = data[i];
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
      data[i] = pink * 0.11;
    }
  }

  if (type === "brown"){
    let last = 0;
    for (let i=0; i<len; i++){
      last = (last + data[i] * 0.02);
      data[i] = Math.max(-1, Math.min(1, last)) * 3.5;
    }
  }

  // normalize
  let max = 0;
  for (let i=0; i<len; i++) max = Math.max(max, Math.abs(data[i]));
  if (max > 0) for (let i=0; i<len; i++) data[i] /= max;

  return buf;
}

function clearNodesHard(){
  if (!ctx || !masterGain) {
    sourceNodes = [];
    return;
  }

  // 1) okamžitě 0
  try{
    masterGain.gain.cancelScheduledValues(ctx.currentTime);
    masterGain.gain.setValueAtTime(0.0, ctx.currentTime);
  }catch{}

  // 2) stop všech zdrojů (bufferSource / osc)
  for (const n of sourceNodes){
    try{ if (typeof n.stop === "function") n.stop(0); }catch{}
  }

  // 3) disconnect všech
  for (const n of sourceNodes){
    try{ n.disconnect(); }catch{}
  }

  sourceNodes = [];
}

function buildChainFor(mode){
  const shape = intensity01();

  // base noise type
  const baseType =
    (mode === "pink" || mode === "waterfall" || mode === "wind" || mode === "rain") ? "pink" :
    (mode === "brown" || mode === "fan") ? "brown" :
    "white";

  const src = addNode(ctx.createBufferSource());
  src.buffer = makeNoiseBuffer(baseType, 2);
  src.loop = true;

  const hp = addNode(ctx.createBiquadFilter());
  hp.type = "highpass";
  hp.frequency.value = 10;

  const lp = addNode(ctx.createBiquadFilter());
  lp.type = "lowpass";
  lp.frequency.value = 600 + 15000 * shape;

  const pre = addNode(ctx.createGain());
  pre.gain.value = 1.0;

  // modulační gain
  const modGain = addNode(ctx.createGain());
  modGain.gain.value = 1.0;

  // LFO pro presety
  let lfo = null, lfoDepth = null;
  function addLFO(freqHz, depth){
    lfo = addNode(ctx.createOscillator());
    lfo.type = "sine";
    lfo.frequency.value = freqHz;

    lfoDepth = addNode(ctx.createGain());
    lfoDepth.gain.value = depth;

    // LFO přičítá do modGain.gain (kolem 1.0)
    modGain.gain.setValueAtTime(1.0, ctx.currentTime);
    lfo.connect(lfoDepth);
    lfoDepth.connect(modGain.gain);

    lfo.start();
  }

  // Presety
  if (mode === "waterfall"){
    hp.frequency.value = 80;
    lp.frequency.value = 9000 + 7000 * shape;
    addLFO(0.35, 0.10);
  } else if (mode === "rain"){
    hp.frequency.value = 250;
    lp.frequency.value = 7000 + 9000 * shape;
    addLFO(0.6, 0.06);
  } else if (mode === "wind"){
    hp.frequency.value = 40;
    lp.frequency.value = 1800 + 3500 * shape;
    addLFO(0.20, 0.18);
  } else if (mode === "fan"){
    hp.frequency.value = 60;
    lp.frequency.value = 2200 + 5000 * shape;
    addLFO(0.9, 0.05);
  } else if (mode === "vacuum"){
    hp.frequency.value = 120;
    lp.frequency.value = 5000 + 11000 * shape;
    addLFO(1.2, 0.04);
  } else if (mode === "pink"){
    hp.frequency.value = 10;
    lp.frequency.value = 3500 + 9000 * shape;
  } else if (mode === "brown"){
    hp.frequency.value = 10;
    lp.frequency.value = 1400 + 6000 * shape;
  } else { // white
    hp.frequency.value = 10;
    lp.frequency.value = 6000 + 10000 * shape;
  }

  // chain
  src.connect(hp);
  hp.connect(lp);
  lp.connect(pre);
  pre.connect(modGain);
  modGain.connect(masterGain);

  src.start();
}

function applyVolume(){
  if (!ctx || !masterGain) return;
  const g = volToGain(Number(volume.value));
  masterGain.gain.setValueAtTime(g, ctx.currentTime);
}

async function start(){
  await ensureAudio();
  try{ await ctx.resume(); }catch{}

  // jistota: před startem vyčistit
  clearNodesHard();

  buildChainFor(currentSound);
  applyVolume();

  isPlaying = true;
  toggleBtn.textContent = "■ Stop";
  setStatus(labelFor(currentSound));
}

async function stopHard(){
  if (!ctx) {
    isPlaying = false;
    toggleBtn.textContent = "▶ Play";
    setStatus("Stop.");
    return;
  }

  clearNodesHard();

  // Mobilní jistota: suspend / close
  try{ await ctx.suspend(); }catch{}
  if (HARD_CLOSE_CONTEXT_ON_STOP){
    try{ await ctx.close(); }catch{}
    ctx = null;
    masterGain = null;
  }

  isPlaying = false;
  toggleBtn.textContent = "▶ Play";
  setStatus("Stop.");
}

function rebuildIfPlaying(){
  if (!isPlaying) return;
  if (!ctx) return;

  // bezpečné přestavení bez „zbytků“
  const g = volToGain(Number(volume.value));
  try{
    masterGain.gain.cancelScheduledValues(ctx.currentTime);
    masterGain.gain.setValueAtTime(0.0, ctx.currentTime);
  }catch{}

  clearNodesHard();
  buildChainFor(currentSound);

  try{
    masterGain.gain.setValueAtTime(g, ctx.currentTime);
  }catch{}
}

/* =========================
   UI events
   ========================= */

// Sound modal
soundBtn.addEventListener("click", () => {
  soundBtn.setAttribute("aria-expanded", "true");
  openModal(soundModal);
});
soundClose.addEventListener("click", () => {
  try{ history.back(); }catch{ closeAllModals(); }
});
soundModal.addEventListener("click", (e) => {
  const b = e.target.closest("[data-sound]");
  if (!b) return;
  currentSound = b.dataset.sound;
  soundBtn.childNodes[0].textContent = labelFor(currentSound) + " ";
  setStatus(labelFor(currentSound));
  rebuildIfPlaying();
  try{ history.back(); }catch{ closeAllModals(); }
});

// Help modal
helpBtn.addEventListener("click", () => openModal(helpModal));
helpClose.addEventListener("click", () => {
  try{ history.back(); }catch{ closeAllModals(); }
});

// Play/Stop button
toggleBtn.addEventListener("click", async () => {
  try{
    if (!isPlaying) await start();
    else await stopHard();
  }catch(err){
    console.error(err);
    setStatus("Nepodařilo se spustit audio (zkus kliknout znovu).");
  }
});

// sliders
intensity.addEventListener("input", () => {
  rebuildIfPlaying();
});
volume.addEventListener("input", () => {
  if (!isPlaying) return;
  applyVolume();
});

// když app jde do pozadí: ticho + zavřít modaly
document.addEventListener("visibilitychange", async () => {
  if (document.hidden){
    closeAllModals();
    if (isPlaying) await stopHard();
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

// init label (kdyby HTML mělo něco jiného)
if (soundBtn) soundBtn.childNodes[0].textContent = labelFor(currentSound) + " ";
setStatus("Připraveno.");
toggleBtn.textContent = "▶ Play";