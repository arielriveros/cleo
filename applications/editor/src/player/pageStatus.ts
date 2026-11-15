// The page around a running game: its loading screen and the boot failure that covers it. Its own module
// so the published player's entry (index.tsx) can show progress and errors before it loads the engine.

/** Cover the page with a boot failure. Logger-independent: a published game has no Logger by then. */
export function showError(err: unknown): void {
  const pre = document.createElement('pre');
  pre.id = 'cleo-error';
  pre.textContent = 'Failed to start game:\n\n' + ((err as any)?.stack || String(err));
  document.body.appendChild(pre);
  document.getElementById('cleo-loading')?.remove();
}

/** The loading screen's line of text (#cleo-loading-text), when the page has one. */
export function setLoadingText(text: string): void {
  const el = document.getElementById('cleo-loading-text');
  if (el) el.textContent = text;
}

// Lift #cleo-loading once frames are actually flowing. The first frames of a first launch compile every
// shader the scene needs, each one a long stall, so "a frame ran" is not enough: wait for a run of quick
// frames. Counting starts after startScene's deferred scene.start (100 ms), which spawns more to compile.
// A machine too slow to ever manage that still gets the game after a frame cap.
export function hideLoadingWhenSmooth(): void {
  // When the first frame after boot finished: how long the window waited, shader builds included.
  requestAnimationFrame(() => { (window as any).CLEO_FIRST_FRAME_MS = performance.now(); });
  const el = document.getElementById('cleo-loading');
  if (!el) return;
  const from = performance.now() + 300;
  let last = performance.now(), smooth = 0, frames = 0;
  const tick = (now: number) => {
    smooth = now >= from && now - last < 100 ? smooth + 1 : 0;
    last = now;
    if (smooth >= 10 || ++frames >= 240) {
      el.classList.add('done');
      setTimeout(() => el.remove(), 500);
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
