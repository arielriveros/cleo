// Per-pass visual signatures, so converting a shader cannot regress a pass nobody is looking at.
//
// The mesh harness proves geometry and draw counts, and it has caught real bugs — but its scene renders
// with bloom, SSAO, motion blur and chromatic aberration all OFF. Converting the ~24 fullscreen programs
// to WGSL would rewrite exactly those passes with no gate underneath them: draw counts would not move,
// the screenshot would not move, and a broken bloom would ship.
//
// So each configuration below turns one pass on, renders, and reduces the frame to an 8x8 grid of
// quantised cell means. That signature is stable across runs (it survives dithering and sub-pixel AA)
// and sensitive to anything a shader rewrite would plausibly get wrong — a channel swap, a lost blur, a
// wrong exposure, an inverted mask.
//
//   record:  CLEO_PASS_BASELINE=write   -> writes passBaseline.json
//   verify:  (default)                  -> compares against it
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

const root = path.resolve(process.env.CLEO_MESH_DIR || path.join(__dirname, 'pages', 'mesh'));

// Stage the engine bundle next to the page it is loaded from. Doing it here rather than expecting a
// manual copy is what makes a stale `cleo.js` impossible: the harness always tests the dist that exists
// right now, and a forgotten rebuild shows up as an old bundle rather than as a mystery pass.
const REPO = path.resolve(__dirname, '..', '..');
function stage(pageDir, files) {
  for (const [from, to] of files) {
    const src = path.join(REPO, from);
    if (!fs.existsSync(src)) {
      console.error('missing ' + from + ' — run `npm run build:dev` first');
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(path.join(pageDir, to)), { recursive: true });
    fs.copyFileSync(src, path.join(pageDir, to));
  }
}

stage(root, [['dist/cleo.js', 'cleo.js']]);
const baselinePath = path.join(__dirname, 'passBaseline.json');
const writing = process.env.CLEO_PASS_BASELINE === 'write';

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-pass-')));
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const results = [];
const check = (name, ok, detail) => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '   -> ' + String(detail ?? '')}`);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Each entry restores every key it touches, so configurations cannot leak into each other — the
// defaults are re-applied wholesale before each one rather than undone selectively.
// Note there is no `bloomEnabled` on the renderer: the quality preset folds it into the intensity, so
// bloom is off exactly when `bloomIntensity` is 0. Asking for a key the renderer does not have is caught
// by the `every setting exists` check rather than silently doing nothing.
const DEFAULTS = {
  bloomIntensity: 0, bloomThreshold: 1,
  ssaoEnabled: false, ssaoRadius: 0.5, ssaoPower: 1.0, motionBlurEnabled: false,
  chromaticAberrationStrength: 0, shadowsEnabled: true, renderScale: 1, exposure: 2,
};

const CONFIGS = [
  { name: 'base', patch: {} },
  // bloom*.fs, bloomDownsample, bloomUpsample — 3 programs, none previously exercised.
  { name: 'bloom', patch: { bloomIntensity: 2, bloomThreshold: 0.4 } },
  // ssao.fs + ssaoBlur.fs. NOT exact, and not fixable by tuning: `_generateSSAOKernelAndNoise` builds
  // both the hemisphere kernel and the 4x4 rotation-noise texture from `Math.random()` at renderer
  // construction, so two sessions genuinely produce different AO. That is normal for SSAO, and it means
  // an exact cross-run baseline could never hold — it failed 1 run in 3 before this was tracked down.
  // The pass is still gated on doing something substantial (~20 values move, worst delta 24).
  { name: 'ssao', patch: { ssaoEnabled: true, ssaoRadius: 2.0, ssaoPower: 4.0 }, exact: false },
  // motionBlurVelocity/TileMax/NeighborMax/gather — 4 programs.
  // Motion blur is the one pass that needs the camera actually moving, which makes its output
  // phase-dependent and therefore unsuitable for an exact signature. It is held to a weaker but still
  // real contract: under identical motion, enabling it must change the frame. See `exact: false`.
  { name: 'motionBlurOff', patch: { motionBlurEnabled: false }, motion: 6.0, exact: false },
  { name: 'motionBlur', patch: { motionBlurEnabled: true, motionBlurIntensity: 1 }, motion: 6.0, exact: false },
  { name: 'chromatic', patch: { chromaticAberrationStrength: 4 } },
  // Turns off the cascade path, so a shadow regression shows as base != noShadows staying equal.
  { name: 'noShadows', patch: { shadowsEnabled: false } },
  // Resolution-dependent passes: anything that reads u_resolution or a texel size.
  { name: 'halfScale', patch: { renderScale: 0.5 } },
  // Deliberately excludes SSAO so this one CAN be exact: it exists to prove stacked passes compose,
  // and bloom + chromatic aberration are both deterministic.
  { name: 'combined', patch: { bloomIntensity: 2, bloomThreshold: 0.4, chromaticAberrationStrength: 2, renderScale: 0.75 } },
];

/**
 * Reduce a captured frame to an 8x8 grid of cells, two numbers each: mean luma and standard deviation.
 *
 * The mean alone is not enough, and this was measured rather than assumed — with mean-only signatures,
 * SSAO and a half-resolution render both came out *identical to base*. That is not because nothing
 * happened; it is because a blur preserves local means almost exactly. Since the passes most likely to
 * be converted to WGSL are blurs (bloom down/upsample, gaussian, SSAO blur, motion-blur gather), a
 * statistic blind to blur would have been a gate that could not fail.
 *
 * Standard deviation is the sharpness of a cell, so it moves when a blur radius changes, when an
 * upsample weight is wrong, or when a resolution-dependent pass reads the wrong texel size.
 */
function signature(bitmap, width, height) {
  const GRID = 8;
  const cells = [];
  const q = (v) => Math.min(255, Math.max(0, Math.round(v / 4) * 4)).toString(16).padStart(2, '0');

  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const x0 = Math.floor(gx * width / GRID), x1 = Math.floor((gx + 1) * width / GRID);
      const y0 = Math.floor(gy * height / GRID), y1 = Math.floor((gy + 1) * height / GRID);
      let sum = 0, sumSq = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;               // BGRA
          const luma = 0.2126 * bitmap[i + 2] + 0.7152 * bitmap[i + 1] + 0.0722 * bitmap[i];
          sum += luma; sumSq += luma * luma; n++;
        }
      }
      const mean = sum / Math.max(1, n);
      // Scaled up, because a cell's deviation is small next to its mean and would otherwise quantise
      // away entirely at the same step size.
      const sd = Math.sqrt(Math.max(0, sumSq / Math.max(1, n) - mean * mean)) * 2;
      cells.push(q(mean), q(sd));
    }
  }
  return cells.join('');
}

// One quantisation step. SSAO rotates its sample kernel by a noise texture, so a handful of cells sit
// exactly on a quantisation boundary and flip between recording and verifying — reproducibly, but
// meaninglessly. Ignoring a single-step move keeps the gate usable; it costs almost no sensitivity,
// because every real change measured here is far larger: bloom moves 64 cells by up to 40, chromatic
// aberration by up to 96, dropping shadows by 24.
const NOISE = 4;

/**
 * Compare two signatures.
 *
 * `differing` counts every cell that moved at all — used to prove a pass DID something. `material`
 * counts only cells that moved by more than the noise floor, and is what a baseline mismatch is judged
 * on. Keeping both means "the pass ran" and "the pass still renders the same" stay separate questions.
 */
function compare(a, b) {
  let differing = 0, material = 0, worst = 0;
  const values = a.length / 2;
  for (let i = 0; i < values; i++) {
    const x = parseInt(a.slice(i * 2, i * 2 + 2), 16);
    const y = parseInt(b.slice(i * 2, i * 2 + 2), 16);
    const delta = Math.abs(x - y);
    if (delta > 0) differing++;
    if (delta > NOISE) material++;
    worst = Math.max(worst, delta);
  }
  return { differing, material, worst };
}

app.whenReady().then(async () => {
  protocol.handle('app', (request) => {
    let pathname = decodeURIComponent(new URL(request.url).pathname);
    if (!pathname || pathname === '/') pathname = '/index.html';
    const filePath = path.resolve(path.join(root, pathname));
    if (!filePath.startsWith(root)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(filePath).toString());
  });

  const win = new BrowserWindow({ width: 1000, height: 700, show: false, backgroundColor: '#202028', webPreferences: { contextIsolation: true } });
  win.webContents.on('render-process-gone', (_e, d) => { console.log('!! renderer gone ' + JSON.stringify(d)); app.exit(2); });
  await win.loadURL('app://mesh/index.html');
  const js = (src) => win.webContents.executeJavaScript(src);

  let ready = false;
  for (let i = 0; i < 200; i++) {
    const r = await js('window.__ready === true ? "ok" : (window.__error || null)').catch(() => null);
    if (r === 'ok') { ready = true; break; }
    if (r) { check('scene built', false, String(r).slice(0, 500)); app.exit(1); return; }
    await sleep(250);
  }
  if (!ready) { check('scene built', false, 'timed out'); app.exit(1); return; }

  const capture = async () => {
    // capturePage returns the last COMPOSITED frame, so it lags a state change by one call.
    await win.webContents.capturePage();
    await sleep(300);
    const img = await win.webContents.capturePage();
    const size = img.getSize();
    return signature(img.toBitmap(), size.width, size.height);
  };

  const baseline = (!writing && fs.existsSync(baselinePath))
    ? JSON.parse(fs.readFileSync(baselinePath, 'utf-8')) : null;
  if (!writing && !baseline) console.log('  (no baseline on disk — recording only)');

  const signatures = {};
  const stats = {};
  for (const cfg of CONFIGS) {
    const applied = await js(`JSON.stringify(window.__setRender(${JSON.stringify({ ...DEFAULTS, ...cfg.patch })}))`).then(JSON.parse);
    const wanted = Object.keys({ ...DEFAULTS, ...cfg.patch });
    const ignored = wanted.filter(k => !applied.includes(k));
    if (ignored.length) check(`${cfg.name}: every setting exists on the renderer`, false, 'ignored: ' + ignored.join(', '));

    await js('window.__stopMotion()');
    await sleep(400);
    if (cfg.motion) { await js(`window.__startMotion(${cfg.motion})`); await sleep(400); }
    else await sleep(400);
    signatures[cfg.name] = await capture();
    stats[cfg.name] = await js('JSON.stringify(window.__renderStats())').then(JSON.parse);
    await js('window.__stopMotion()');
  }

  // A configuration whose signature equals `base` did not change the picture, which for these passes
  // means it did not run — the gate would then be watching nothing.
  for (const cfg of CONFIGS) {
    if (cfg.name === 'base' || cfg.motion) continue;   // motion pair is judged against each other below
    const d = compare(signatures.base, signatures[cfg.name]);
    check(`${cfg.name} visibly changes the frame`, d.material > 0,
          'nothing moved beyond the noise floor — the pass did not run, so nothing here is under test');
    if (d.differing) console.log(`      ${cfg.name}: ${d.differing}/128 values differ, worst delta ${d.worst}`);
  }

  // The motion-blur contract, compared against its own motion-matched control rather than against base.
  const mb = compare(signatures.motionBlurOff, signatures.motionBlur);
  check('motion blur changes the frame under motion', mb.differing > 0,
        'identical with the pass on and off — the gather pass did nothing');
  console.log(`      motionBlur vs motionBlurOff: ${mb.differing}/128 values differ, worst delta ${mb.worst}`);

  if (writing) {
    const exact = {};
    for (const cfg of CONFIGS) if (cfg.exact !== false) exact[cfg.name] = signatures[cfg.name];
    fs.writeFileSync(baselinePath, JSON.stringify(exact, null, 2));
    console.log('\nbaseline written to ' + baselinePath);
  } else if (baseline) {
    for (const cfg of CONFIGS) {
      if (cfg.exact === false) continue;   // phase-dependent; held to the weaker contract above
      const was = baseline[cfg.name];
      if (!was) { check(`${cfg.name} has a baseline`, false, 'not in baseline file'); continue; }
      const d = compare(was, signatures[cfg.name]);
      check(`${cfg.name} matches baseline`, d.material === 0,
            `${d.material}/128 values differ beyond the noise floor (worst delta ${d.worst})`);
    }
  }

  console.log('');
  console.log('  draw calls per configuration: ' +
    Object.entries(stats).map(([k, v]) => k + '=' + v.drawCalls).join('  '));

  const failed = results.filter(x => !x).length;
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  app.exit(failed ? 1 : 0);
});
