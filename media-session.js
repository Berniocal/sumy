/* Media Session API – systémové ovládání přehrávání v Androidu / PWA */
(() => {
  if (!("mediaSession" in navigator) || !("MediaMetadata" in window)) return;

  const toggleBtn = document.getElementById("toggleBtn");
  const soundModal = document.getElementById("soundModal");
  if (!toggleBtn) return;

  const icon = new URL("icons/icon-512.png", document.baseURI).href;

  function currentLabel(){
    const soundBtn = document.getElementById("soundBtn");
    return (soundBtn?.textContent || "Šum").replace("▾", "").trim();
  }

  function isPlaying(){
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

  function updatePlaybackState(){
    navigator.mediaSession.playbackState = isPlaying() ? "playing" : "paused";
  }

  async function requestPlay(){
    if (!isPlaying()) toggleBtn.click();
  }

  async function requestPause(){
    if (isPlaying()) toggleBtn.click();
  }

  try { navigator.mediaSession.setActionHandler("play", requestPlay); } catch {}
  try { navigator.mediaSession.setActionHandler("pause", requestPause); } catch {}
  try { navigator.mediaSession.setActionHandler("stop", requestPause); } catch {}

  const buttonObserver = new MutationObserver(() => {
    updateMetadata();
    updatePlaybackState();
  });
  buttonObserver.observe(toggleBtn, { childList: true, subtree: true, characterData: true });

  soundModal?.addEventListener("click", (event) => {
    if (event.target.closest("[data-sound]")) {
      setTimeout(updateMetadata, 0);
    }
  });

  updateMetadata();
  updatePlaybackState();
})();
