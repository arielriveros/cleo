// Frame-time distribution, WebGL2 against WebGPU, on one machine in one run.
//
// The complaint this exists to diagnose: WebGPU shows noticeable lag spikes on a scene WebGL2 renders
// smoothly — and, told carefully, WebGL2 shows the SAME spikes, just far milder. That reframes the
// question. The trigger is shared; what differs is how much each backend amplifies it. So the useful
// measurement is not "how fast is a frame" but "how bad is the tail, and what is happening on the
// frames in it".
//
// Hence: percentiles, not means. A mean improvement with the spikes intact is not a fix, and a mean is
// exactly the statistic that hides a tail. p99 and max are the numbers to move.
//
// Every frame also carries the WebGPU object counts recorded during it — bind groups, pipelines,
// encoders, submits, buffer writes — so a spike arrives with its cause attached rather than as a number
// to theorise about:
//
//   spikes where `pipeline > 0`      -> lazy pipeline compilation (a material came into view)
//   spikes with every counter flat   -> allocation / GC pressure
//   a high FLOOR rather than spikes  -> per-frame submit overhead
//
//   run:    npm run harness:frametime
//   scene:  CLEO_SCENE=full|every|every2d, CLEO_PIPELINE=forward   as with the other drivers
//   frames: CLEO_FRAMES=600
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

const root = path.resolve(process.env.CLEO_MESH_DIR || path.join(__dirname, 'pages', 'mesh'));
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
  ['src/graphics/rhi/webgpu/naga/nagaGlsl.js', 'naga/nagaGlsl.js'],
  ['src/graphics/rhi/webgpu/naga/nagaGlsl_bg.wasm', 'naga/nagaGlsl_bg.wasm'],
]);

const SCENES = ['full', 'every', 'every2d'];
const scene = SCENES.includes(process.env.CLEO_SCENE) ? process.env.CLEO_SCENE : 'base';
const pipeline = process.env.CLEO_PIPELINE === 'forward' ? 'forward' : 'deferred';
const FRAMES = Number(process.env.CLEO_FRAMES || 600);

const profileDir = path.join(os.tmpdir(), 'cleo-frametime-profile');
fs.mkdirSync(profileDir, { recursive: true });
app.setPath('userData', profileDir);
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failed = false;
const fail = (name, detail) => { failed = true; console.log(`FAIL  ${name}   -> ${String(detail ?? '')}`); };

function queryFor(backend) {
  const params = new URLSearchParams();
  if (pipeline === 'forward') params.set('forward', '1');
  if (scene !== 'base') params.set('scene', scene);
  params.set('seed', '1');
  params.set('backend', backend);
  if (backend === 'webgpu') params.set('cleoWebgpuProbe', '1');
  return '?' + params.toString();
}

/**
 * The page-side probe, as source text.
 *
 * It counts into a bucket that is read and cleared from a `requestAnimationFrame` callback registered
 * AFTER the engine's own, so by the time it runs the engine has already rendered and the bucket holds
 * that frame's work. Ordering of rAF callbacks is registration order, and `engine.run()` happens while
 * the page is built — long before this is installed.
 *
 * Two clocks are recorded per frame and they answer different questions. `ms` is the rAF-to-rAF period,
 * which is what a person actually perceives as a stutter but is quantised by vsync. `cpu` is the
 * engine's own `frameStats.frameMs`, the CPU cost of building the frame, which is not quantised and is
 * the thing a fix has to move.
 */
const PROBE = `
window.__frameProbe = (frames, orbit) => new Promise((resolve) => {
  const zero = () => ({ bindGroup: 0, pipeline: 0, encoder: 0, submit: 0, writeBuffer: 0,
                        texture: 0, buffer: 0, writeTexture: 0, shaderModule: 0, mapAsync: 0 });
  let counters = zero();
  const undo = [];
  const patch = (obj, name, key) => {
    if (!obj || typeof obj[name] !== 'function') return;
    const real = obj[name];
    obj[name] = function () { counters[key]++; return real.apply(this, arguments); };
    undo.push(() => { obj[name] = real; });
  };
  if (typeof GPUDevice !== 'undefined') {
    patch(GPUDevice.prototype, 'createBindGroup', 'bindGroup');
    patch(GPUDevice.prototype, 'createRenderPipeline', 'pipeline');
    patch(GPUDevice.prototype, 'createCommandEncoder', 'encoder');
    patch(GPUQueue.prototype, 'submit', 'submit');
    patch(GPUQueue.prototype, 'writeBuffer', 'writeBuffer');
    // Widened after the first run: bind-group creation went to zero and the ~180ms spike did not move,
    // so its cause is something these did not yet count. A texture or buffer allocation, a mip-chain
    // upload, or a map are each far more expensive here than the WebGL2 call they replaced.
    patch(GPUDevice.prototype, 'createTexture', 'texture');
    patch(GPUDevice.prototype, 'createBuffer', 'buffer');
    patch(GPUDevice.prototype, 'createShaderModule', 'shaderModule');
    patch(GPUQueue.prototype, 'writeTexture', 'writeTexture');
    patch(GPUBuffer.prototype, 'mapAsync', 'mapAsync');
  }
  const samples = [];
  let last = performance.now();
  let n = 0;
  const step = () => {
    const now = performance.now();
    const ms = now - last;
    last = now;
    const stats = (window.__renderer && window.__renderer.stats) || {};
    // The first delta spans whatever happened before the probe was installed; it is not a frame.
    // 'at' is the frame INDEX (no backticks in here - this whole probe is a template literal). A lone
    // outlier at index 0-2 is the cost of STARTING to move, which is a different complaint from one in
    // the middle of a steady orbit; the index tells them apart.
    if (n > 0) samples.push(Object.assign({ at: n, ms, cpu: stats.frameMs || 0 }, counters));
    counters = zero();
    if (orbit && window.__moveCamera) {
      // A slow circle around the scene, so materials enter and leave view. Deterministic on purpose:
      // an unseeded controller would make two backends orbit differently and the tails incomparable.
      const t = n * 0.02;
      window.__moveCamera(Math.cos(t) * 3 - 3, Math.sin(t * 0.7) * 1.5, Math.sin(t) * 3);
    }
    if (++n <= frames) requestAnimationFrame(step);
    else { undo.forEach((f) => f()); resolve(samples); }
  };
  requestAnimationFrame(step);
});
'installed'`;

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

function summarise(samples, key) {
  const sorted = samples.map(s => s[key]).sort((a, b) => a - b);
  const worstCount = Math.max(1, Math.round(samples.length * 0.01));
  const worst = samples.slice().sort((a, b) => b[key] - a[key]).slice(0, worstCount);
  const mean = (rows, k) => rows.reduce((t, r) => t + r[k], 0) / (rows.length || 1);
  return {
    p50: pct(sorted, 0.50), p95: pct(sorted, 0.95), p99: pct(sorted, 0.99),
    max: sorted[sorted.length - 1],
    all: { bindGroup: mean(samples, 'bindGroup'), pipeline: mean(samples, 'pipeline'),
           encoder: mean(samples, 'encoder'), submit: mean(samples, 'submit'),
           writeBuffer: mean(samples, 'writeBuffer') },
    worst: { bindGroup: mean(worst, 'bindGroup'), pipeline: mean(worst, 'pipeline'),
             encoder: mean(worst, 'encoder'), submit: mean(worst, 'submit'),
             writeBuffer: mean(worst, 'writeBuffer') },
  };
}

const f1 = (n) => n.toFixed(1);
const KEYS = ['bindGroup', 'pipeline', 'encoder', 'submit', 'writeBuffer',
              'texture', 'buffer', 'writeTexture', 'shaderModule', 'mapAsync'];
/** The individual worst frames, verbatim. A mean over the worst 1% can hide a lone 180ms outlier. */
function worstFrames(samples, key, n) {
  return samples.slice().sort((a, b) => b[key] - a[key]).slice(0, n).map(s =>
    f1(s[key]) + 'ms @' + s.at + ' {' + KEYS.filter(k => s[k]).map(k => k + ' ' + s[k]).join(' ') + '}');
}
function report(backend, phase, samples) {
  for (const key of ['ms', 'cpu']) {
    const s = summarise(samples, key);
    const label = key === 'ms' ? 'frame period' : 'cpu frameMs ';
    console.log(`   ${backend.padEnd(6)} ${phase.padEnd(6)} ${label}  ` +
                `p50 ${f1(s.p50).padStart(6)}  p95 ${f1(s.p95).padStart(6)}  ` +
                `p99 ${f1(s.p99).padStart(6)}  max ${f1(s.max).padStart(7)}`);
    // Printed for BOTH clocks on purpose. The spike this harness was written to find shows up in the
    // frame PERIOD and not in the engine's own `frameMs` at all — so attributing counters only to
    // the worst CPU frames would describe the wrong frames entirely.
    if (key === 'ms')
      console.log('   ' + ' '.repeat(21) + 'worst frames  ' + worstFrames(samples, 'ms', 3).join('   '));
    {
      const c = s.all, w = s.worst;
      console.log(`   ${' '.repeat(21)}per-frame  bindGroup ${f1(c.bindGroup)}  pipeline ${f1(c.pipeline)}  ` +
                  `encoder ${f1(c.encoder)}  submit ${f1(c.submit)}  writeBuffer ${f1(c.writeBuffer)}`);
      console.log(`   ${' '.repeat(21)}worst 1%   bindGroup ${f1(w.bindGroup)}  pipeline ${f1(w.pipeline)}  ` +
                  `encoder ${f1(w.encoder)}  submit ${f1(w.submit)}  writeBuffer ${f1(w.writeBuffer)}`);
    }
  }
}

const openWindows = [];

async function runBackend(backend) {
  const win = new BrowserWindow({
    width: 1000, height: 700, show: false, backgroundColor: '#202028',
    webPreferences: { contextIsolation: true, backgroundThrottling: false },
  });
  openWindows.push(win);
  // SHOWN, unlike every other driver here, and it is the difference between measuring and hanging.
  //
  // `requestAnimationFrame` is driven by the compositor, and a window that has never been shown never
  // composites — so the probe's loop simply does not run. `backgroundThrottling: false` is not enough
  // on its own; it relaxes throttling for a window that draws, it does not make an unshown one draw.
  // The other harnesses get away with `show: false` because they capture single frames on demand
  // rather than timing a loop of them.
  //
  // `showInactive` rather than `show`, so a measurement run does not steal focus from whatever the
  // person at the keyboard is doing.
  win.showInactive();
  win.webContents.on('render-process-gone', (_e, d) => {
    console.log(`!! ${backend} renderer gone ` + JSON.stringify(d)); app.exit(2);
  });

  await win.loadURL('app://mesh/index.html' + queryFor(backend));
  const js = (src) => win.webContents.executeJavaScript(src);

  let ready = false;
  for (let i = 0; i < 240; i++) {
    const r = await js('window.__ready === true ? "ok" : (window.__error || null)').catch(() => null);
    if (r === 'ok') { ready = true; break; }
    if (r) { fail(`${backend}: scene built`, String(r).slice(0, 400)); return null; }
    await sleep(250);
  }
  if (!ready) { fail(`${backend}: scene built`, 'timed out'); return null; }

  // The check that stops this driver from quietly comparing WebGL2 with itself.
  const got = await js('window.__renderer && window.__renderer.backend').catch(() => null);
  if (got !== backend) { fail(`${backend}: the request was honoured`, `acquired ${got}`); return null; }

  await js(PROBE);
  // A warm-up that is NOT measured: the first frames after load compile pipelines and upload textures,
  // which is real work but not the steady state the complaint is about. The orbit phase below is where
  // first-sight compilation is supposed to show up, deliberately.
  await js(`window.__frameProbe(60, false)`);

  const staticSamples = await js(`window.__frameProbe(${FRAMES}, false)`);
  const orbitSamples = await js(`window.__frameProbe(${FRAMES}, true)`);
  return { staticSamples, orbitSamples };
}

async function main() {
  console.log(`frame time: ${pipeline}.${scene}, ${FRAMES} frames per phase`);
  const out = {};
  for (const backend of ['webgl2', 'webgpu']) {
    const r = await runBackend(backend);
    if (!r) continue;
    out[backend] = r;
    report(backend, 'static', r.staticSamples);
    report(backend, 'orbit', r.orbitSamples);
  }

  if (out.webgl2 && out.webgpu) {
    console.log('');
    for (const phase of ['staticSamples', 'orbitSamples']) {
      const a = summarise(out.webgl2[phase], 'cpu');
      const b = summarise(out.webgpu[phase], 'cpu');
      const name = phase === 'staticSamples' ? 'static' : 'orbit';
      console.log(`   ${name.padEnd(6)} cpu p99  webgl2 ${f1(a.p99)}  webgpu ${f1(b.p99)}  ` +
                  `(x${(b.p99 / (a.p99 || 1)).toFixed(2)})    ` +
                  `max  webgl2 ${f1(a.max)}  webgpu ${f1(b.max)}  (x${(b.max / (a.max || 1)).toFixed(2)})`);
    }
  }
  for (const w of openWindows) w.destroy();
  app.exit(failed ? 1 : 0);
}

app.whenReady().then(() => {
  protocol.handle('app', (request) => {
    const rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '');
    return net.fetch(pathToFileURL(path.join(root, rel)).toString());
  });
  main().catch((e) => { console.error(e); app.exit(2); });
});
