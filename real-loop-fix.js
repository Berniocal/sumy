/* Plynulá smyčka real zvuků bez slyšitelného propadu hlasitosti.
   Přepisuje původní lineární crossfade z app.js za equal-power crossfade.
   U nekorelovaných zvuků (déšť, moře, vítr, vodopád) lineární průběh
   v polovině překryvu ztrácí přibližně 3 dB výkonu. Sin/cos křivky
   udržují součet výkonů přibližně konstantní. */

startCrossfadeRealLoop = function(buffer, label){
  if (!ctx || !masterGain || !buffer) return null;

  const crossfade = Math.min(5.0, Math.max(2.2, buffer.duration * 0.20));
  const segment = Math.max(1.0, buffer.duration - crossfade);
  const layerGain = 0.82;
  const curvePoints = 128;

  const fadeInCurve = new Float32Array(curvePoints);
  const fadeOutCurve = new Float32Array(curvePoints);
  for (let i = 0; i < curvePoints; i++){
    const x = i / (curvePoints - 1);
    // Equal-power: sin² + cos² = 1.
    fadeInCurve[i] = Math.sin(x * Math.PI * 0.5) * layerGain;
    fadeOutCurve[i] = Math.cos(x * Math.PI * 0.5) * layerGain;
  }

  const state = {
    stopped: false,
    timers: [],
    sources: [],
    gains: [],
    nextStart: ctx.currentTime + 0.04,
    stop(){
      this.stopped = true;
      this.timers.forEach((id) => clearTimeout(id));
      this.timers = [];
      const now = ctx.currentTime;
      for (const g of this.gains){
        try{
          g.gain.cancelScheduledValues(now);
          g.gain.setValueAtTime(g.gain.value, now);
          g.gain.linearRampToValueAtTime(0, now + 0.28);
        }catch{}
      }
      const oldSources = this.sources.slice();
      const oldGains = this.gains.slice();
      setTimeout(() => {
        oldSources.forEach((src) => {
          try{ src.stop(); }catch{}
          try{ src.disconnect(); }catch{}
        });
        oldGains.forEach((g) => { try{ g.disconnect(); }catch{}; });
      }, 380);
    }
  };

  function scheduleOne(when){
    if (state.stopped) return;

    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    src.buffer = buffer;
    src.loop = false;

    const fadeOutStart = when + segment;
    const end = when + buffer.duration;

    gain.gain.setValueAtTime(0, when);
    gain.gain.setValueCurveAtTime(fadeInCurve, when, crossfade);
    gain.gain.setValueAtTime(layerGain, when + crossfade);
    gain.gain.setValueAtTime(layerGain, fadeOutStart);
    gain.gain.setValueCurveAtTime(fadeOutCurve, fadeOutStart, crossfade);
    gain.gain.setValueAtTime(0, end);

    src.connect(gain);
    gain.connect(masterGain);

    state.sources.push(src);
    state.gains.push(gain);

    try{ src.start(when, 0); }catch{}

    const cleanupDelay = Math.max(0, (end + 0.5 - ctx.currentTime) * 1000);
    const cleanupId = setTimeout(() => {
      try{ src.stop(); }catch{}
      try{ src.disconnect(); }catch{}
      try{ gain.disconnect(); }catch{}
      state.sources = state.sources.filter((x) => x !== src);
      state.gains = state.gains.filter((x) => x !== gain);
    }, cleanupDelay);
    state.timers.push(cleanupId);
  }

  function pump(){
    if (state.stopped) return;

    const lookAhead = ctx.currentTime + 16;
    while (state.nextStart < lookAhead){
      scheduleOne(state.nextStart);
      state.nextStart += segment;
    }

    const id = setTimeout(pump, 4000);
    state.timers.push(id);
  }

  pump();
  setStatus(label);
  return state;
};
