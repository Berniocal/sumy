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

const soundModal = $("soundModal");
const soundClose = $("soundClose");

const installBtn = $("installBtn");

let deferredPrompt = null;

// Audio
let ctx = null;
let masterGain = null;        // GainNode (volume)
let noiseNode = null;         // AudioWorkletNode

let presetFilter1 = null;     // BiquadFilterNode
let presetFilter2 = null;     // BiquadFilterNode
let lfo = null;               // OscillatorNode
let lfoGain = null;           // GainNode (mod depth)

let currentSound = "white";
let isPlaying = false;

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

  await ensureAudio();
  if (ctx.state === "suspended") await ctx.resume();

  // postavit řetězec + hlasitost
  buildChainFor(currentSound);
  applyVolume();

  isPlaying = true;
  toggleBtn.textContent = "■ Stop";
  setStatus(labelFor(currentSound));
}

async function stopHard(){
  if (!ctx) return;

  // absolutní ticho
  hardMuteNow();
  disconnectChain();

  try{ await ctx.suspend(); }catch{}

  isPlaying = false;
  toggleBtn.textContent = "▶ Play";
  setStatus("Stop.");
}

function rebuildIfPlaying(){
  if (!isPlaying || !ctx) return;

  // přestavět preset (po změně zvuku/intenzity) bez „zbytků“
  hardMuteNow();
  buildChainFor(currentSound);
  applyVolume();
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

document.addEventListener("visibilitychange", () => {
  if (document.hidden){
    // Nezastavujeme audio – ať může hrát na pozadí / při zhasnuté obrazovce.
    // Jen zavřeme případné otevřené okno.
    closeSoundModal();
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
