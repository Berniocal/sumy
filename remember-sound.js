/* Zapamatování naposledy vybraného zvuku mezi spuštěními aplikace. */
(() => {
  const STORAGE_KEY = "sumyCurrentSound";
  const validSounds = new Set([
    "white",
    "pink",
    "brown",
    "waterfall",
    "waterfall_real",
    "sea_real",
    "wind_real",
    "rain_real",
    "rain",
    "wind",
    "fan",
    "vacuum",
  ]);

  function updateSoundButtonLabel() {
    if (!soundBtn) return;

    const first = soundBtn.childNodes[0];
    if (first && first.nodeType === Node.TEXT_NODE) {
      first.textContent = labelFor(currentSound) + " ";
    } else {
      soundBtn.textContent = labelFor(currentSound);
    }
  }

  try {
    const savedSound = localStorage.getItem(STORAGE_KEY);
    if (validSounds.has(savedSound)) {
      currentSound = savedSound;
      updateSoundButtonLabel();
    }
  } catch {}

  soundModal?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-sound]");
    const selectedSound = button?.dataset.sound;
    if (!validSounds.has(selectedSound)) return;

    try {
      localStorage.setItem(STORAGE_KEY, selectedSound);
    } catch {}
  });
})();
