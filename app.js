/* Šumy – čistá verze s tvrdým STOP (absolutní ticho) */

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

let currentSound = "white";
let isPlaying = false;

// WebAudio state
let ctx = null;
let masterGain = null;
let sourceNodes = [];       // nodes we created (for disconnect)
let rafId = null;           // for any running animation if needed
let lfoTimer = null;        // interval / timers if used

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

function setStatus(t){ statusEl.textContent = t; }

function openModal(modal){
  modal.hidden = false;
  // klik mimo kartu zavře
  const onBackdrop = (e) => {
    if (e.target === modal) closeModal(modal, onBackdrop);
  };
  modal._onBackdrop = onBackdrop;
  modal.addEventListener("click", onBackdrop);
}

function closeModal(modal, fn){
  modal.hidden = true;
  if (fn) modal.removeEventListener("click", fn);
}

function clamp01(x){ return Math.max(0, Math.min(1, x)); }

function volToGain(v){
  // 0..100 -> 0..1, mírná „log“ křivka (příjemnější)
  const x = clamp01(v / 100);
  return Math.pow(x, 1.6);
}

function intensityToShape(v){
  // 0..100 -> 0..1
  return clamp01(v / 100);
}

async function ensureAudio(){
  if (ctx && masterGain) return;

  ctx = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = ctx.createGain();
  masterGain.gain.value = 0.0; // start silent
  masterGain.connect(ctx.destination);

  setStatus("Audio připraveno.");
}

function makeNoiseBuffer(type, seconds = 2){
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.floor(seconds * sr));
  const buf = ctx.createBuffer(1, len, sr);
  const data = buf.getChannelData(0);

  // White base
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1);

  if (type === "pink"){
    // Simple Voss-McCartney-ish filter (lehké růžové)
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
    // Brownian = integrace white (silné basy)
    let last = 0;
    for (let i=0; i<len; i++){
      last = (last + data[i] * 0.02);
      data[i] = Math.max(-1, Math.min(1, last)) * 3.5;
    }
  }

  // normalizace
  let max = 0;
  for (let i=0; i<len; i++) max = Math.max(max, Math.abs(data[i]));
  if (max > 0) for (let i=0; i<len; i++) data[i] /= max;

  return buf;
}

function addNode(n){
  sourceNodes.push(n);
  return n;
}

function clearNodesHard(){
  // 1) okamžitě umlčet (hlavní věc proti „zbytkovému šumu“)
  try{
    if (masterGain && ctx) {
      masterGain.gain.cancelScheduledValues(ctx.currentTime);
      masterGain.gain.setValueAtTime(0.0, ctx.currentTime);
    }
  }catch(_){}

  // 2) zastavit zdroje (bufferSource)
  for (const n of sourceNodes){
    try{ if (typeof n.stop === "function") n.stop(0); }catch(_){}
  }

  // 3) odpojit všechno
  for (const n of sourceNodes){
    try{ n.disconnect(); }catch(_){}
  }
  sourceNodes = [];

  // 4) zrušit případné timery
  if (rafId){ cancelAnimationFrame(rafId); rafId = null; }
  if (lfoTimer){ clearInterval(lfoTimer); lfoTimer = null; }
}

async function stopHard(){
  if (!ctx) return;

  clearNodesHard();

  // 5) suspend/close pro „absolutní“ ticho (některé mobily rády nechávají něco běžet)
  try{ await ctx.suspend(); }catch(_){}
  try{ await ctx.close(); }catch(_){}

  ctx = null;
  masterGain = null;

  isPlaying = false;
  toggleBtn.textContent = "▶ Play";
  setStatus("Stop.");
}

function applyVolume(){
  if (!ctx || !masterGain) return;
  const g = volToGain(Number(volume.value));
  masterGain.gain.setValueAtTime(g, ctx.currentTime);
}

function buildChainFor(mode){
  // Všechny presety jsou ve výsledku šum + filtry + (někde) pomalé vlnění
  const shape = intensityToShape(Number(intensity.value));

  // Základ: loop buffer
  const src = addNode(ctx.createBufferSource());
  src.buffer = makeNoiseBuffer(
    (mode === "pink" || mode === "brown") ? mode : "white",
    2
  );
  src.loop = true;

  // Filtry
  const hp = addNode(ctx.createBiquadFilter());
  hp.type = "highpass";
  hp.frequency.value = 10;

  const lp = addNode(ctx.createBiquadFilter());
  lp.type = "lowpass";

  // „jemnost“ = méně ostré výšky (nižší lowpass)
  // shape=0 -> jemné (nižší cutoff), shape=1 -> ostřejší (vyšší cutoff)
  const lpMin = 500;
  const lpMax = 16000;
  lp.frequency.value = lpMin + (lpMax - lpMin) * shape;

  // Presety: upravíme filtry a přidáme lehké vlnění (waterfall/rain/wind/fan/vacuum)
  const presetGain = addNode(ctx.createGain());
  presetGain.gain.value = 1.0;

  // Modulační vlnění hlasitosti (velmi jemné), aby to působilo „živě“
  const modGain = addNode(ctx.createGain());
  modGain.gain.value = 1.0;

  // LFO (oscillator) -> gain (pro waterfall/wind/fan/vacuum/rain)
  let lfo = null, lfoDepth = null;

  function addLFO(freqHz, depth){ // depth 0..1
    lfo = addNode(ctx.createOscillator());
    lfo.type = "sine";
    lfo.frequency.value = freqHz;

    lfoDepth = addNode(ctx.createGain());
    lfoDepth.gain.value = depth;

    lfo.connect(lfoDepth);
    lfoDepth.connect(modGain.gain);

    // modGain.gain základ 1, LFO přičítá +/- depth
    modGain.gain.setValueAtTime(1.0, ctx.currentTime);
  }

  if (mode === "waterfall"){
    // široké pásmo + jemné vlnění
    hp.frequency.value = 80;
    lp.frequency.value = 9000 + 7000 * shape;
    addLFO(0.35, 0.10);
  } else if (mode === "rain"){
    // ostřejší „šustění“, méně basů
    hp.frequency.value = 250;
    lp.frequency.value = 7000 + 9000 * shape;
    addLFO(0.6, 0.06);
  } else if (mode === "wind"){
    // hodně do středů, pomalejší vlnění
    hp.frequency.value = 40;
    lp.frequency.value = 1800 + 3500 * shape;
    addLFO(0.20, 0.18);
  } else if (mode === "fan"){
    // stabilnější, lehké vlnění
    hp.frequency.value = 60;
    lp.frequency.value = 2200 + 5000 * shape;
    addLFO(0.9, 0.05);
  } else if (mode === "vacuum"){
    // agresivnější, více výšek
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

  // Zapojení: src -> hp -> lp -> presetGain -> modGain -> master
  src.connect(hp);
  hp.connect(lp);
  lp.connect(presetGain);
  presetGain.connect(modGain);
  modGain.connect(masterGain);

  // start
  src.start();

  if (lfo) lfo.start();
}

async function start(){
  await ensureAudio();

  // na mobilech bývá ctx "suspended" dokud není user gesture
  try{ await ctx.resume(); }catch(_){}

  clearNodesHard(); // jistota před startem
  buildChainFor(currentSound);

  // hlasitost až po sestavení řetězce
  applyVolume();

  isPlaying = true;
  toggleBtn.textContent = "■ Stop";
  setStatus(labelFor(currentSound));
}

function updateWhilePlaying(){
  if (!ctx || !masterGain) return;
  // pro jednoduchost: při změně intenzity přestavíme řetězec (bez prasknutí díky okamžitému mute)
  if (isPlaying){
    // rychlé přestavení bez "doznívání"
    const currentVol = volToGain(Number(volume.value));
    masterGain.gain.setValueAtTime(0.0, ctx.currentTime);
    clearNodesHard();

    buildChainFor(currentSound);
    masterGain.gain.setValueAtTime(currentVol, ctx.currentTime);
  }
}

function setSound(mode){
  currentSound = mode;
  soundBtn.childNodes[0].textContent = labelFor(mode) + " ";
  setStatus(labelFor(mode));

  if (isPlaying){
    updateWhilePlaying();
  }
}

/* UI events */

soundBtn.addEventListener("click", () => {
  soundBtn.setAttribute("aria-expanded", "true");
  openModal(soundModal);
});

soundClose.addEventListener("click", () => {
  soundBtn.setAttribute("aria-expanded", "false");
  closeModal(soundModal, soundModal._onBackdrop);
});

soundModal.addEventListener("click", (e) => {
  const b = e.target.closest("[data-sound]");
  if (!b) return;
  setSound(b.dataset.sound);
  soundBtn.setAttribute("aria-expanded", "false");
  closeModal(soundModal, soundModal._onBackdrop);
});

helpBtn.addEventListener("click", () => openModal(helpModal));
helpClose.addEventListener("click", () => closeModal(helpModal, helpModal._onBackdrop));

toggleBtn.addEventListener("click", async () => {
  if (!isPlaying) await start();
  else await stopHard();
});

intensity.addEventListener("input", () => {
  // přestaví jen když hraje
  if (isPlaying) updateWhilePlaying();
});

volume.addEventListener("input", () => {
  if (!isPlaying) return; // mění se až po startu
  applyVolume();
});

// Bezpečnost: když app jde do pozadí, STOP = ticho
document.addEventListener("visibilitychange", async () => {
  if (document.hidden && isPlaying) await stopHard();
});

// Install prompt (ponecháno)
let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  $("installBtn").hidden = false;
});
$("installBtn").addEventListener("click", async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  $("installBtn").hidden = true;
});

// init label
soundBtn.childNodes[0].textContent = labelFor(currentSound) + " ";