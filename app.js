/* app.js – pouze výběr zvuku + Play/Stop + intenzita + hlasitost */

const $ = (id) => document.getElementById(id);

const soundBtn   = $("soundBtn");
const toggleBtn  = $("toggleBtn");
const intensity  = $("intensity");
const volume     = $("volume");
const statusEl   = $("status");

const soundModal = $("soundModal");
const soundClose = $("soundClose");

const installBtn = $("installBtn");

let deferredPrompt = null;

// Audio state
let ctx = null;
let masterGain = null;
let nodes = [];              // everything we create so we can stop/disconnect
let currentSound = "white";
let isPlaying = false;

// Pokud chceš absolutní jistotu ticha na všech mobilech, dej true (Stop zavře AudioContext)
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
  nodes.push(n);
  return n;
}

/* =========================
   Modal pouze pro výběr zvuku
   ========================= */

function closeSoundModal(){
  soundModal.hidden = true;
  document.body.classList.remove("modalOpen");
  soundBtn?.setAttribute("aria-expanded", "false");

  if (soundModal._onBackdrop){
    soundModal.removeEventListener("click", soundModal._onBackdrop);
    soundModal._onBackdrop = null;
  }
}

function openSoundModal(){
  soundModal.hidden = false;
  document.body.classList.add("modalOpen");
  soundBtn?.setAttribute("aria-expanded", "true");

  const onBackdrop = (e) => {
    if (e.target === soundModal) closeSoundModal();
  };
  soundModal._onBackdrop = onBackdrop;
  soundModal.addEventListener("click", onBackdrop);
}

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

function hardMuteNow(){
  if (!ctx || !masterGain) return;
  try{
    masterGain.gain.cancelScheduledValues(ctx.currentTime);
    masterGain.gain.setValueAtTime(0.0, ctx.currentTime);
  }catch{}
}

function clearNodesHard(){
  if (!ctx) { nodes = []; return; }

  hardMuteNow();

  for (const n of nodes){
    try{ if (typeof n.stop === "function") n.stop(0); }catch{}
  }
  for (const n of nodes){
    try{ n.disconnect(); }catch{}
  }

  nodes = [];
}

function buildChainFor(mode){
  const shape = intensity01();

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

  const modGain = addNode(ctx.createGain());
  modGain.gain.value = 1.0;

  let lfo = null, lfoDepth = null;
  function addLFO(freqHz, depth){
    lfo = addNode(ctx.createOscillator());
    lfo.type = "sine";
    lfo.frequency.value = freqHz;

    lfoDepth = addNode(ctx.createGain());
    lfoDepth.gain.value = depth;

    modGain.gain.setValueAtTime(1.0, ctx.currentTime);
    lfo.connect(lfoDepth);
    lfoDepth.connect(modGain.gain);
    lfo.start();
  }

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
  closeSoundModal();

  await ensureAudio();
  try{ await ctx.resume(); }catch{}

  clearNodesHard();
  buildChainFor(currentSound);
  applyVolume();

  isPlaying = true;
  toggleBtn.textContent = "■ Stop";
  setStatus(labelFor(currentSound));
}

async function stopHard(){
  if (!ctx){
    isPlaying = false;
    toggleBtn.textContent = "▶ Play";
    setStatus("Stop.");
    return;
  }

  clearNodesHard();

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
  if (!isPlaying || !ctx) return;

  const g = volToGain(Number(volume.value));
  hardMuteNow();
  clearNodesHard();
  buildChainFor(currentSound);
  masterGain.gain.setValueAtTime(g, ctx.currentTime);
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

document.addEventListener("visibilitychange", async () => {
  if (document.hidden){
    closeSoundModal();
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

/* init */
soundBtn.childNodes[0].textContent = labelFor(currentSound) + " ";
toggleBtn.textContent = "▶ Play";
setStatus("Připraveno.");
closeSoundModal();
