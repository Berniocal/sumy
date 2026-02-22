/* app.js */
const $ = (id) => document.getElementById(id);

const modeEl = $("mode");
const intensityEl = $("intensity");
const intensityHintEl = $("intensityHint");
const volumeEl = $("volume");
const volValueEl = $("volValue");
const timerEl = $("timer");
const timerHintEl = $("timerHint");

const toggleBtn = $("toggleBtn");
const stopBtn = $("stopBtn");
const fadeBtn = $("fadeBtn");
const statusEl = $("status");

const installBtn = $("installBtn");

let deferredPrompt = null;

let ctx = null;
let noiseNode = null;         // AudioWorkletNode
let mainGain = null;          // GainNode
let presetFilter1 = null;     // BiquadFilterNode
let presetFilter2 = null;     // BiquadFilterNode
let lfo = null;              // OscillatorNode (modulation)
let lfoGain = null;          // GainNode (mod depth)
let timerHandle = null;
let isRunning = false;

const LS_KEY = "noisePWA_v1";

function loadState(){
  try{
    const s = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    if (s.mode) modeEl.value = s.mode;
    if (Number.isFinite(s.intensity)) intensityEl.value = String(s.intensity);
    if (Number.isFinite(s.volume)) volumeEl.value = String(s.volume);
    if (Number.isFinite(s.timer)) timerEl.value = String(s.timer);
  }catch{}
}
function saveState(){
  const s = {
    mode: modeEl.value,
    intensity: Number(intensityEl.value),
    volume: Number(volumeEl.value),
    timer: Number(timerEl.value),
  };
  localStorage.setItem(LS_KEY, JSON.stringify(s));
}

function setStatus(msg){ statusEl.textContent = msg; }

function intensityHint(v){
  const n = Number(v);
  if (n < 20) return "jemné";
  if (n < 45) return "spíš jemné";
  if (n < 65) return "střední";
  if (n < 85) return "silné";
  return "hodně silné";
}

function updateUI(){
  volValueEl.textContent = volumeEl.value;
  intensityHintEl.textContent = intensityHint(intensityEl.value);

  if (!isRunning){
    toggleBtn.textContent = "▶ Spustit";
    stopBtn.disabled = true;
    fadeBtn.disabled = true;
    setStatus("Připraveno. Klikni na Spustit.");
  } else {
    toggleBtn.textContent = "⏸ Pozastavit";
    stopBtn.disabled = false;
    fadeBtn.disabled = false;
  }

  const t = Number(timerEl.value);
  timerHintEl.textContent = t > 0 ? `vypne za ${t} min` : "—";
}

function mapModeToNoiseType(mode){
  // noise-worklet: 0 white,1 pink,2 brown
  if (mode === "pink") return 1;
  if (mode === "brown") return 2;
  // presets use mostly pink/brown base (smoother)
  if (mode === "waterfall") return 1;
  if (mode === "wind") return 1;
  if (mode === "fan") return 2;
  if (mode === "vacuum") return 0;
  return 0;
}

function setNoiseParams(){
  if (!noiseNode) return;

  const mode = modeEl.value;
  const intensity = Number(intensityEl.value) / 100;
  const vol = Number(volumeEl.value) / 100;

  // Base noise level (keep headroom; presets may boost)
  const baseLevel = 0.18 + 0.35 * intensity;

  noiseNode.parameters.get("type").setValueAtTime(mapModeToNoiseType(mode), ctx.currentTime);
  noiseNode.parameters.get("level").setValueAtTime(baseLevel, ctx.currentTime);

  // main volume (squared curve feels nicer at low volume)
  const v = vol * vol;
  mainGain.gain.setValueAtTime(v, ctx.currentTime);

  applyPreset(mode, intensity);
}

function disconnectPresetNodes(){
  if (!ctx || !noiseNode) return;

  try{ noiseNode.disconnect(); }catch{}
  try{ presetFilter1?.disconnect(); }catch{}
  try{ presetFilter2?.disconnect(); }catch{}
  try{ lfoGain?.disconnect(); }catch{}
}

function applyPreset(mode, intensity){
  // Rebuild chain: noise -> [filters] -> mainGain -> destination
  disconnectPresetNodes();

  presetFilter1 = ctx.createBiquadFilter();
  presetFilter2 = ctx.createBiquadFilter();

  // default: clean path
  presetFilter1.type = "allpass";
  presetFilter2.type = "allpass";

  // LFO movement
  lfo = ctx.createOscillator();
  lfoGain = ctx.createGain();
  lfo.type = "sine";

  lfoGain.gain.value = 0.0;
  lfo.frequency.value = 0.15;

  // Chain
  noiseNode.connect(presetFilter1);
  presetFilter1.connect(presetFilter2);
  presetFilter2.connect(mainGain);

  // LFO -> mainGain.gain (small depth)
  try{
    lfo.connect(lfoGain);
    lfoGain.connect(mainGain.gain);
  }catch{}

  if (mode === "white" || mode === "pink" || mode === "brown"){
    presetFilter1.type = "lowpass";
    presetFilter1.frequency.value = 8000 - 5500 * (1 - intensity);
    presetFilter1.Q.value = 0.2;

    presetFilter2.type = "highpass";
    presetFilter2.frequency.value = 20 + 80 * intensity;
    presetFilter2.Q.value = 0.1;

    lfo.frequency.value = 0.08 + 0.22 * intensity;
    lfoGain.gain.value = 0.00 + 0.02 * intensity;
  }

  if (mode === "waterfall"){
    presetFilter1.type = "bandpass";
    presetFilter1.frequency.value = 800 + 900 * intensity;
    presetFilter1.Q.value = 0.4 + 0.9 * intensity;

    presetFilter2.type = "highshelf";
    presetFilter2.frequency.value = 2500;
    presetFilter2.gain.value = -6 + 2 * intensity;

    lfo.frequency.value = 0.12 + 0.35 * intensity;
    lfoGain.gain.value = 0.01 + 0.03 * intensity;
  }

  if (mode === "wind"){
    presetFilter1.type = "lowpass";
    presetFilter1.frequency.value = 600 + 900 * intensity;
    presetFilter1.Q.value = 0.6;

    presetFilter2.type = "highpass";
    presetFilter2.frequency.value = 40 + 120 * intensity;
    presetFilter2.Q.value = 0.2;

    lfo.frequency.value = 0.05 + 0.18 * intensity;
    lfoGain.gain.value = 0.03 + 0.06 * intensity;
  }

  if (mode === "fan"){
    presetFilter1.type = "lowpass";
    presetFilter1.frequency.value = 300 + 550 * intensity;
    presetFilter1.Q.value = 0.9;

    presetFilter2.type = "peaking";
    presetFilter2.frequency.value = 120 + 120 * intensity;
    presetFilter2.Q.value = 1.2;
    presetFilter2.gain.value = 2 + 4 * intensity;

    lfo.frequency.value = 0.9 + 1.6 * intensity;
    lfoGain.gain.value = 0.005 + 0.015 * intensity;
  }

  if (mode === "vacuum"){
    presetFilter1.type = "highpass";
    presetFilter1.frequency.value = 120 + 220 * intensity;
    presetFilter1.Q.value = 0.6;

    presetFilter2.type = "highshelf";
    presetFilter2.frequency.value = 1500;
    presetFilter2.gain.value = 2 + 6 * intensity;

    lfo.frequency.value = 0.25;
    lfoGain.gain.value = 0.004;
  }

  try{ lfo.start(); }catch{}
}

async function ensureAudio(){
  if (ctx) return;

  ctx = new (window.AudioContext || window.webkitAudioContext)();
  mainGain = ctx.createGain();
  mainGain.gain.value = 0.0;
  mainGain.connect(ctx.destination);

  await ctx.audioWorklet.addModule("noise-worklet.js");
  noiseNode = new AudioWorkletNode(ctx, "noise-processor", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2]
  });

  setNoiseParams();
}

function startTimerIfNeeded(){
  clearTimer();
  const t = Number(timerEl.value);
  if (!t || t <= 0) return;

  const ms = t * 60 * 1000;
  const startAt = Date.now();
  setStatus(`Hraje… (timer ${t} min)`);
  timerHandle = setInterval(() => {
    const left = ms - (Date.now() - startAt);
    if (left <= 0){
      clearTimer();
      stopNow();
      return;
    }
    const mm = Math.ceil(left / 60000);
    timerHintEl.textContent = `zbývá ~${mm} min`;
  }, 1000);
}

function clearTimer(){
  if (timerHandle){
    clearInterval(timerHandle);
    timerHandle = null;
  }
  timerHintEl.textContent = Number(timerEl.value) > 0 ? `vypne za ${timerEl.value} min` : "—";
}

async function play(){
  await ensureAudio();

  if (ctx.state === "suspended") await ctx.resume();

  setNoiseParams();
  isRunning = true;
  updateUI();
  startTimerIfNeeded();
  setStatus("Hraje…");
}

function pause(){
  if (!ctx) return;
  mainGain.gain.setTargetAtTime(0, ctx.currentTime, 0.03);
  isRunning = false;
  clearTimer();
  updateUI();
  setStatus("Pozastaveno.");
}

function stopNow(){
  if (!ctx) return;
  mainGain.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
  isRunning = false;
  clearTimer();
  updateUI();
  setStatus("Stop.");
}

function fadeOut(seconds = 10){
  if (!ctx) return;
  const t = ctx.currentTime;
  mainGain.gain.cancelScheduledValues(t);
  const cur = mainGain.gain.value;
  mainGain.gain.setValueAtTime(cur, t);
  mainGain.gain.linearRampToValueAtTime(0, t + seconds);
  setStatus(`Fade out ${seconds} s…`);
  clearTimer();
  setTimeout(() => {
    isRunning = false;
    updateUI();
    setStatus("Stop (fade out dokončen).");
  }, seconds * 1000 + 80);
}

/* UI events */
modeEl.addEventListener("change", () => { saveState(); if (ctx) setNoiseParams(); });
intensityEl.addEventListener("input", () => {
  intensityHintEl.textContent = intensityHint(intensityEl.value);
  saveState();
  if (ctx) setNoiseParams();
});
volumeEl.addEventListener("input", () => {
  volValueEl.textContent = volumeEl.value;
  saveState();
  if (ctx) setNoiseParams();
});
timerEl.addEventListener("change", () => {
  saveState();
  if (isRunning) startTimerIfNeeded();
  updateUI();
});

toggleBtn.addEventListener("click", async () => {
  try{
    if (!isRunning) await play();
    else pause();
  }catch(err){
    console.error(err);
    setStatus("Nepodařilo se spustit audio (zkus kliknout znovu).");
  }
});

stopBtn.addEventListener("click", () => stopNow());
fadeBtn.addEventListener("click", () => fadeOut(10));

/* PWA install */
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  installBtn.hidden = false;
});

installBtn.addEventListener("click", async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  installBtn.hidden = true;
});

/* Service worker */
if ("serviceWorker" in navigator){
  window.addEventListener("load", async () => {
    try{
      await navigator.serviceWorker.register("sw.js");
    }catch(e){
      console.warn("SW register failed", e);
    }
  });
}

/* init */
loadState();
updateUI();
