// WebGL2 beside WebGPU, as PICTURES, for every configuration of every profile.
//
// `backendDiff.js` answers "are the two backends the same?" and answers it well — but it answers it as
// 128 numbers per capture and a ranked table. That is the right shape for a gate and the wrong shape
// for a person: a delta cannot be looked at. `CLEO_DIFF_SHOT` exists because of that gap and writes
// exactly two PNGs for one named configuration at a time. This writes all of them, plus the difference
// between each pair, plus a page to read them in.
//
// It is a VIEWER, not a gate. Nothing here fails a build; `backendDiff.js` remains the thing that does.
// The numbers printed beside each pair come from the same `compare()` the gate uses, so the two cannot
// disagree about what they are looking at.
//
//   npm run harness:compare
//   CLEO_COMPARE_PROFILES=deferred.every,forward.every2d   restrict the run (default: all four)
//   CLEO_COMPARE_DIR=<dir>                                 where it goes (default: shots/compare)
//   CLEO_COMPARE_GAIN=8                                    difference amplification
const { app, BrowserWindow, protocol, net, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const { compare, signature } = require('./signature');
const { CONFIGS, EXTRA_CHANNELS, captureConfigs } = require('./passConfigs');

const root = path.resolve(process.env.CLEO_MESH_DIR || path.join(__dirname, 'pages', 'mesh'));
const outDir = path.resolve(process.env.CLEO_COMPARE_DIR || path.join(__dirname, 'shots', 'compare'));

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
stage(root, [
  ['dist/cleo.js', 'cleo.js'],
  // The translator the page installs — see backendDiff.js. Without it the custom materials in these
  // scenes have no WGSL, cannot build a WebGPU program, and are skipped: the gallery would then show
  // a difference that is an artefact of the harness rather than of the backend.
  ['src/graphics/rhi/webgpu/naga/nagaGlsl.js', 'naga/nagaGlsl.js'],
  ['src/graphics/rhi/webgpu/naga/nagaGlsl_bg.wasm', 'naga/nagaGlsl_bg.wasm'],
]);

// A FIXED profile directory, reused across runs — see captureGallery.js for why this is not mkdtemp.
const profileDir = path.join(os.tmpdir(), 'cleo-compare-profile');
fs.mkdirSync(profileDir, { recursive: true });
app.setPath('userData', profileDir);
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ALL = CONFIGS.concat(EXTRA_CHANNELS);
/** Phase-dependent, and no seed fixes that. Shown, but never counted — as in `backendDiff`. */
const MOTION_DEPENDENT = new Set(ALL.filter(c => c.motion).map(c => c.name));
const GAIN = Number(process.env.CLEO_COMPARE_GAIN || 8);

/**
 * Every window this run opens, kept alive to the end.
 *
 * Not an oversight and not a leak: tearing a window down before the next one loads makes that
 * `loadURL` fail outright with ERR_FAILED against the same `app://` URL that had just worked.
 * `backendDiff.js` hit this first and says so; this driver opens EIGHT windows rather than two, so
 * it would hit it seven times. They are all hidden and only one is ever driven at a time.
 */
const openWindows = [];

/** The four profiles this gallery covers, as (scene, pipeline) pairs. */
const PROFILES = [
  { name: 'deferred.every', scene: 'every', pipeline: 'deferred',
    blurb: 'Every static feature the renderer can be asked for, deferred.' },
  { name: 'forward.every', scene: 'every', pipeline: 'forward',
    blurb: 'The same scene through the forward pipeline, which takes different draw paths.' },
  { name: 'deferred.every2d', scene: 'every2d', pipeline: 'deferred',
    blurb: 'The orthographic 2D scene: tilemap layers, sprites, unlit and transparent quads.' },
  { name: 'forward.every2d', scene: 'every2d', pipeline: 'forward',
    blurb: 'The 2D scene through the forward pipeline.' },
];

const wanted = (process.env.CLEO_COMPARE_PROFILES || '').split(',').map(s => s.trim()).filter(Boolean);
const profiles = wanted.length ? PROFILES.filter(p => wanted.includes(p.name)) : PROFILES;

function queryFor(profile, backend) {
  const params = new URLSearchParams();
  if (profile.pipeline === 'forward') params.set('forward', '1');
  if (profile.scene !== 'base') params.set('scene', profile.scene);
  // The same seed both windows get in `backendDiff`, so the two renderers build the SAME SSAO kernel
  // and the comparison is about the backend rather than about an unseeded Math.random.
  params.set('seed', '1');
  params.set('backend', backend);
  // Required while WEBGPU_IMPLEMENTED is false, harmless after: acquisition is gated separately from
  // "the renderer draws through it", and this driver wants the device either way.
  if (backend === 'webgpu') params.set('cleoWebgpuProbe', '1');
  return '?' + params.toString();
}

/**
 * Capture the page twice and return both the raw bitmap and its signature.
 *
 * Twice is not superstition: `capturePage` returns the last COMPOSITED frame, so it lags a state change
 * by one call. `signature.js` carries the same note — measuring once produced a clean off-by-one where
 * a changed frame showed up in the reading after it.
 */
async function grab(win) {
  await win.webContents.capturePage();
  await sleep(300);
  const img = await win.webContents.capturePage();
  const size = img.getSize();
  return { png: img.toPNG(), bitmap: img.toBitmap(), width: size.width, height: size.height };
}

/**
 * The amplified per-pixel difference of two BGRA bitmaps, as a PNG.
 *
 * The maximum absolute channel difference, multiplied by `GAIN` and clamped, written as grey on black.
 * The amplification is the whole point: an honest difference of 4/255 is invisible, and "invisible" is
 * exactly the answer this image must not give by accident. The page states the gain beside the image so
 * nobody reads brightness as magnitude.
 */
function differenceImage(a, b) {
  if (a.width !== b.width || a.height !== b.height) return null;
  const n = a.width * a.height;
  const out = Buffer.alloc(n * 4);
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    // BGRA in, BGRA out. Alpha is skipped deliberately: the captures are opaque, and a difference in
    // an alpha nobody composites would read as a difference in the picture.
    const d = Math.max(Math.abs(a.bitmap[o] - b.bitmap[o]),
                       Math.abs(a.bitmap[o + 1] - b.bitmap[o + 1]),
                       Math.abs(a.bitmap[o + 2] - b.bitmap[o + 2]));
    if (d > worst) worst = d;
    const v = Math.min(255, d * GAIN);
    out[o] = v; out[o + 1] = v; out[o + 2] = v; out[o + 3] = 255;
  }
  return { png: nativeImage.createFromBitmap(out, { width: a.width, height: a.height }).toPNG(), worst };
}

/**
 * Walk every configuration on one backend, keeping the bitmap of each.
 *
 * The walk itself is `captureConfigs`, the same function `passCheck` and `backendDiff` use. Reusing it
 * rather than writing a second loop is what keeps this page showing the frames the GATE measures: the
 * reset discipline it applies between configurations (DEFAULTS spread wholesale so one cannot leak into
 * the next, sky state reset because it lives on a node rather than the renderer, motion stopped) is
 * subtle, and a second copy of it would drift without anything noticing.
 */
async function runBackend(profile, backend) {
  const win = new BrowserWindow({
    width: 1000, height: 700, show: false, backgroundColor: '#202028',
    webPreferences: { contextIsolation: true },
  });
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level === 3) errors.push(message); });
  win.webContents.on('render-process-gone', (_e, d) => {
    console.log(`  !! ${backend} renderer gone ` + JSON.stringify(d));
  });

  await win.loadURL('app://mesh/index.html' + queryFor(profile, backend));
  const js = (src) => win.webContents.executeJavaScript(src);

  let ready = false;
  for (let i = 0; i < 240; i++) {
    const r = await js('window.__ready === true ? "ok" : (window.__error || null)').catch(() => null);
    if (r === 'ok') { ready = true; break; }
    if (r) { console.log(`  !! ${backend}: scene failed — ` + String(r).slice(0, 300));
             openWindows.push(win); return null; }
    await sleep(250);
  }
  if (!ready) { console.log(`  !! ${backend}: timed out building the scene`);
                openWindows.push(win); return null; }

  // The line that stops this gallery quietly comparing WebGL2 with itself. A backend REQUEST can be
  // refused — `resolveBackendRequest` has the last word — and every pair below would then be identical
  // for the worst possible reason, which is the one failure a page of pictures cannot show you.
  const got = await js('window.__renderer && window.__renderer.backend').catch(() => null);
  if (got !== backend) {
    console.log(`  !! ${backend}: request not honoured — acquired ${got}. Skipping this profile.`);
    openWindows.push(win);
    return null;
  }

  const frames = new Map();
  let pending = null;
  const capture = async () => {
    pending = await grab(win);
    return signature(pending.bitmap, pending.width, pending.height);
  };
  // `captureConfigs` captures the signature first and then calls `onShot`, so the frame the hook files
  // away is the one that was just measured rather than a second, later one.
  const onShot = async (name) => { frames.set(name, pending); pending = null; };

  const { signatures, stats, missing } = await captureConfigs(ALL, { js, capture, sleep, onShot });
  openWindows.push(win);   // see openWindows — NOT destroyed here
  return { signatures, stats, missing, frames, errors };
}

/** Escape for HTML text and attributes. */
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderPage(sections) {
  const rows = (section) => section.rows.map(r => `
      <tr id="${esc(section.name)}--${esc(r.name)}">
        <th scope="row">
          <a class="anchor" href="#${esc(section.name)}--${esc(r.name)}">${esc(r.name)}</a>
          ${r.motion ? '<span class="tag">not gated — motion</span>' : ''}
          <span class="nums ${r.material === 0 ? 'ok' : 'off'}">${r.material}/128 differ</span>
          <span class="nums">worst ${r.worst}</span>
          ${r.pixelWorst !== null ? `<span class="nums">peak pixel ${r.pixelWorst}/255</span>` : ''}
        </th>
        <td><a href="${esc(r.files.webgl2)}"><img loading="lazy" src="${esc(r.files.webgl2)}" alt="WebGL2, ${esc(r.name)}"></a></td>
        <td><a href="${esc(r.files.webgpu)}"><img loading="lazy" src="${esc(r.files.webgpu)}" alt="WebGPU, ${esc(r.name)}"></a></td>
        <td>${r.files.diff
          ? `<a href="${esc(r.files.diff)}"><img loading="lazy" src="${esc(r.files.diff)}" alt="difference, ${esc(r.name)}"></a>`
          : '<span class="nums">sizes differ</span>'}</td>
      </tr>`).join('');

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>cleo — WebGL2 vs WebGPU</title>
<style>
  :root { color-scheme: dark; --bg:#16161c; --panel:#1e1e26; --line:#2e2e3a; --fg:#e6e6ee; --dim:#9a9aae; --ok:#4ec9a0; --off:#e0a04a; }
  * { box-sizing: border-box; }
  body { margin:0; padding:2rem clamp(1rem,3vw,3rem); background:var(--bg); color:var(--fg);
         font:14px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  h1 { font-size:1.5rem; margin:0 0 .25rem; }
  h2 { font-size:1.1rem; margin:2.5rem 0 .25rem; padding-top:1rem; border-top:1px solid var(--line); }
  p.sub { color:var(--dim); margin:.25rem 0 1.25rem; max-width:80ch; }
  table { border-collapse:collapse; width:100%; margin-bottom:1rem; }
  th, td { border-top:1px solid var(--line); padding:.5rem; vertical-align:top; text-align:left; }
  thead th { border-top:none; color:var(--dim); font-weight:normal; position:sticky; top:0;
             background:var(--bg); z-index:1; }
  tbody th { width:20ch; font-weight:normal; }
  img { width:100%; max-width:340px; display:block; background:#000; border:1px solid var(--line); }
  a { color:inherit; }
  .anchor { display:block; font-weight:bold; text-decoration:none; }
  .anchor:hover { text-decoration:underline; }
  .nums { display:block; color:var(--dim); font-size:12px; }
  .nums.ok { color:var(--ok); }
  .nums.off { color:var(--off); }
  .tag { display:inline-block; font-size:11px; color:var(--dim); border:1px solid var(--line);
         border-radius:3px; padding:0 .35rem; margin:.2rem 0; }
  table.summary td, table.summary th { border-top:1px solid var(--line); }
  table.summary { max-width:70rem; }
  code { background:var(--panel); padding:.1rem .3rem; border-radius:3px; }
</style>

<h1>cleo — WebGL2 vs WebGPU</h1>
<p class="sub">
  The same scene, the same configuration, the same seed, rendered by both backends in one run and
  captured side by side. The third column is their difference, amplified <strong>&times;${GAIN}</strong>
  so a small one is visible at all — read it as "where", not as "how much". The numbers are the ones
  <code>harness:backenddiff</code> gates on: how many of the 128 signature values differ beyond the
  noise floor, and the worst of them. <em>Peak pixel</em> is the largest raw channel difference anywhere
  in the frame, before amplification.
</p>
<p class="sub">
  This page is a viewer, not a gate — nothing here fails a build. Motion-dependent configurations are
  shown but never counted: they are phase-dependent and no seed fixes that.
</p>

<h2>Summary</h2>
<table class="summary">
  <thead><tr><th>profile</th><th>pixel-identical</th><th>worst</th><th>console errors</th><th>scene</th></tr></thead>
  <tbody>
${sections.map(s => `    <tr>
      <td><a href="#${esc(s.name)}">${esc(s.name)}</a></td>
      <td class="${s.identical === s.gated ? 'ok' : 'off'}">${s.identical}/${s.gated}</td>
      <td>${s.worst}</td>
      <td>${s.errors === 0 ? '<span class="ok">none</span>' : `<span class="off">${s.errors}</span>`}</td>
      <td>${esc(s.blurb)}</td>
    </tr>`).join('\n')}
  </tbody>
</table>

${sections.map(s => `
<h2 id="${esc(s.name)}">${esc(s.name)}</h2>
<p class="sub">${esc(s.blurb)} ${s.identical}/${s.gated} gated configurations pixel-identical. Worst-first.</p>
<table>
  <thead><tr><th>configuration</th><th>WebGL2</th><th>WebGPU</th><th>difference &times;${GAIN}</th></tr></thead>
  <tbody>${rows(s)}
  </tbody>
</table>`).join('\n')}
</html>
`;
}

app.whenReady().then(async () => {
  protocol.handle('app', (request) => {
    let pathname = decodeURIComponent(new URL(request.url).pathname);
    if (!pathname || pathname === '/') pathname = '/index.html';
    const filePath = path.resolve(path.join(root, pathname));
    if (!filePath.startsWith(root)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(filePath).toString());
  });

  fs.mkdirSync(outDir, { recursive: true });
  const sections = [];

  for (const profile of profiles) {
    console.log(`\n  ${profile.name}`);
    // Sequential, not concurrent: two windows both driving a GPU contend for it, and a frame captured
    // while the other backend is mid-bake is not the frame. Same reason `backendDiff` runs them in turn.
    const a = await runBackend(profile, 'webgl2');
    if (!a) continue;
    const b = await runBackend(profile, 'webgpu');
    if (!b) continue;

    const dir = path.join(outDir, profile.name);
    fs.mkdirSync(dir, { recursive: true });

    const rows = [];
    for (const cfg of ALL) {
      const fa = a.frames.get(cfg.name), fb = b.frames.get(cfg.name);
      if (!fa || !fb) continue;
      const rel = (suffix) => `${profile.name}/${cfg.name}-${suffix}.png`;
      fs.writeFileSync(path.join(outDir, rel('webgl2')), fa.png);
      fs.writeFileSync(path.join(outDir, rel('webgpu')), fb.png);

      const diff = differenceImage(fa, fb);
      if (diff) fs.writeFileSync(path.join(outDir, rel('diff')), diff.png);

      const d = compare(a.signatures[cfg.name], b.signatures[cfg.name]);
      rows.push({
        name: cfg.name,
        motion: MOTION_DEPENDENT.has(cfg.name),
        material: d.material, worst: d.worst,
        pixelWorst: diff ? diff.worst : null,
        files: { webgl2: rel('webgl2'), webgpu: rel('webgpu'), diff: diff ? rel('diff') : null },
      });
    }
    // Worst first, so the interesting comparisons are at the top rather than in configuration order.
    rows.sort((x, y) => (y.material - x.material) || (y.worst - x.worst));

    const gatedRows = rows.filter(r => !r.motion);
    const notable = (list) => list.filter(m => /bind group|pipeline|render pass|Invalid|uncaptured|usage/i.test(m));
    sections.push({
      name: profile.name, blurb: profile.blurb, rows,
      gated: gatedRows.length,
      identical: gatedRows.filter(r => r.material === 0).length,
      worst: gatedRows.reduce((m, r) => Math.max(m, r.worst), 0),
      errors: notable(a.errors).length + notable(b.errors).length,
    });
    console.log(`    ${sections[sections.length - 1].identical}/${gatedRows.length} pixel-identical, `
      + `${rows.length} comparisons written`);
    for (const m of a.missing.concat(b.missing))
      console.log(`    !! ${m.name}: the renderer ignored ${m.ignored.join(', ')}`);
  }

  if (!sections.length) {
    console.log('\n  nothing captured — no profile completed on both backends');
    app.exit(1);
    return;
  }

  const indexPath = path.join(outDir, 'index.html');
  fs.writeFileSync(indexPath, renderPage(sections));
  const images = sections.reduce((n, s) => n + s.rows.length * 3, 0);
  console.log(`\n  ${images} images, ${sections.length} profiles`);
  console.log(`  ${indexPath}`);
  app.exit(0);
});
