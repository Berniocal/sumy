/* Media Session API – systémové ovládání přehrávání v Androidu / PWA
   Web Audio (AudioContext) samo o sobě na Androidu často nevytvoří mediální
   oznámení. Proto při přehrávání udržujeme aktivní i skrytý HTMLAudioElement.
   Ten slouží pouze jako „most“ pro systémové ovládání; skutečný šum dál
   vytváří app.js přes Web Audio API.
*/
(() => {
  if (!("mediaSession" in navigator) || !("MediaMetadata" in window)) return;

  const toggleBtn = document.getElementById("toggleBtn");
  const soundModal = document.getElementById("soundModal");
  if (!toggleBtn) return;

  const icon = new URL("icons/icon-512.png", document.baseURI).href;

  // Vytvoří krátkou téměř neslyšitelnou WAV smyčku. Není muted, protože
  // ztlumené médium Android někdy jako aktivní přehrávání vůbec nezobrazí.
  function createQuietWavUrl(){
    const sampleRate = 8000;
    const seconds = 2;
    const samples = sampleRate * seconds;
    const bytesPerSample = 2;
    const dataSize = samples * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const writeText = (offset, text) => {
      for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };

    writeText(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeText(8, "WAVE");
    writeText(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true);
    view.setUint16(32, bytesPerSample, true);
    view.setUint16(34, 16, true);
    writeText(36, "data");
    view.setUint32(40, dataSize, true);

    // Velmi tichý sinus, aby médium nebylo digitálně úplně prázdné.
    for (let i = 0; i < samples; i++) {
      const value = Math.round(Math.sin(2 * Math.PI * 35 * i / sampleRate) * 2);
      view.setInt16(44 + i * 2, value, true);
    }

    return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
  }

  const mediaBridge = document.createElement("audio");
  mediaBridge.id = "androidMediaBridge";
  mediaBridge.src = createQuietWavUrl();
  mediaBridge.loop = true;
  mediaBridge.preload = "auto";
  mediaBridge.volume = 1;
  mediaBridge.setAttribute("playsinline", "");
  mediaBridge.style.display = "none";
  document.body.appendChild(mediaBridge);

  function currentLabel(){
    const soundBtn = document.getElementById("soundBtn");
    return (soundBtn?.textContent || "Šum").replace("▾", "").trim();
  }

  function appIsPlaying(){
    return toggleBtn.textContent.includes("Stop");
  }

  function updateMetadata(){
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentLabel(),
      artist: "Šumy",
      album: "Generátor šumů",
      artwork: [
        { src: icon, sizes: "512x512", type: "image/png" }
      ]
    });
  }

  function setPlaybackState(state){
    try { navigator.mediaSession.playbackState = state; } catch {}
  }

  async function startBridge(){
    updateMetadata();
    try {
      await mediaBridge.play();
      setPlaybackState("playing");
    } catch (err) {
      console.warn("Systémové mediální ovládání se nepodařilo aktivovat:", err);
    }
  }

  function stopBridge(){
    try { mediaBridge.pause(); } catch {}
    try { mediaBridge.currentTime = 0; } catch {}
    setPlaybackState("paused");
  }

  async function requestPlay(){
    await startBridge();
    if (!appIsPlaying()) toggleBtn.click();
  }

  function requestPause(){
    stopBridge();
    if (appIsPlaying()) toggleBtn.click();
  }

  // Zachytíme uživatelský klik ještě v rámci stejného gesta. To je důležité,
  // protože Android blokuje programové audio spuštěné až s odstupem.
  toggleBtn.addEventListener("click", () => {
    if (!appIsPlaying()) {
      startBridge();
    } else {
      stopBridge();
    }
  }, true);

  try { navigator.mediaSession.setActionHandler("play", requestPlay); } catch {}
  try { navigator.mediaSession.setActionHandler("pause", requestPause); } catch {}
  try { navigator.mediaSession.setActionHandler("stop", requestPause); } catch {}
  try { navigator.mediaSession.setActionHandler("seekbackward", null); } catch {}
  try { navigator.mediaSession.setActionHandler("seekforward", null); } catch {}
  try { navigator.mediaSession.setActionHandler("previoustrack", null); } catch {}
  try { navigator.mediaSession.setActionHandler("nexttrack", null); } catch {}

  const buttonObserver = new MutationObserver(() => {
    updateMetadata();
    if (appIsPlaying()) {
      if (mediaBridge.paused) startBridge();
      else setPlaybackState("playing");
    } else {
      stopBridge();
    }
  });
  buttonObserver.observe(toggleBtn, { childList: true, subtree: true, characterData: true });

  soundModal?.addEventListener("click", (event) => {
    if (event.target.closest("[data-sound]")) setTimeout(updateMetadata, 0);
  });

  mediaBridge.addEventListener("play", () => setPlaybackState("playing"));
  mediaBridge.addEventListener("pause", () => {
    if (!appIsPlaying()) setPlaybackState("paused");
  });

  updateMetadata();
  setPlaybackState("none");
})();