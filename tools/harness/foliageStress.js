// The gate on the bound that merged foliage batching removed.
//
// Foliage used to draw one instanced call per spatial CELL. That was slow — draw count grew with
// terrain area — but it bounded every submission to about a cell's worth of instances, whatever the
// prototype weighed. Merging the cells of a bucket into one call is the fix for the draw count, and it
// took that bound away with it: `generateFoliageEverywhere` followed by a layer's "first sight" (which
// skips the admission budget deliberately) puts every cell on screen in the same frame, so a heavy
// prototype becomes a single multi-second `drawElementsInstanced`. The watchdog then removes the
// device: `Renderer11::mapResource` fails, `DXGI_ERROR_DEVICE_REMOVED`, and every later GL call reports
// `CONTEXT_LOST_KHR`. It is not a slow frame, it is a dead context.
//
// The gate is deliberately NOT "did it crash". Reproducing a device removal to prove a fix means taking
// out the GPU of whoever runs the check, and a machine fast enough to survive the bad build would
// report a pass. So this asserts the invariant that makes the crash impossible instead: no single
// instanced draw may exceed the triangle budget. That holds on any hardware, and it fails loudly on the
// build that hung.
//
//   run:     npm run harness:foliage
//   scale:   CLEO_SEGMENTS=288 CLEO_INSTANCES=600 CLEO_FRAMES=90
//   forward: CLEO_PIPELINE=forward
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, 'pages', 'foliage');
const REPO = path.resolve(__dirname, '..', '..');

const src = path.join(REPO, 'dist', 'cleo.js');
if (!fs.existsSync(src)) {
  console.error('missing dist/cleo.js — run `npm run build:dev` first');
  process.exit(1);
}
fs.copyFileSync(src, path.join(root, 'cleo.js'));

const pipeline = process.env.CLEO_PIPELINE === 'forward' ? 'forward' : 'deferred';
const SEGMENTS = Number(process.env.CLEO_SEGMENTS || 288);
const INSTANCES = Number(process.env.CLEO_INSTANCES || 600);
const FRAMES = Number(process.env.CLEO_FRAMES || 90);
// `CLEO_LODS=1` equips the prototype with the ladder and the card it should have. Run both and the
// difference is what LOD and impostors are actually worth on this machine, rather than in theory.
const WITH_LODS = process.env.CLEO_LODS === '1';

const profileDir = path.join(os.tmpdir(), 'cleo-foliage-profile');
fs.mkdirSync(profileDir, { recursive: true });
app.setPath('userData', profileDir);
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failed = false;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : '   -> ' + detail}`);
  if (!ok) failed = true;
};

async function main() {
  const win = new BrowserWindow({
    width: 1000, height: 700, show: false, backgroundColor: '#202028',
    webPreferences: { contextIsolation: true, backgroundThrottling: false },
  });
  // SHOWN, for the reason frameTime.js gives at length: rAF is driven by the compositor, and a window
  // that never composites never runs a frame loop — so an unshown window would report a clean pass
  // having rendered nothing at all. `showInactive` so a check does not steal focus.
  win.showInactive();
  win.webContents.on('render-process-gone', (_e, d) => {
    console.log('!! renderer gone ' + JSON.stringify(d));
    app.exit(2);
  });

  const query = `?segments=${SEGMENTS}&instances=${INSTANCES}`
    + (pipeline === 'forward' ? '&forward=1' : '')
    + (WITH_LODS ? '&lods=1' : '');
  await win.loadURL('app://foliage/index.html' + query);
  const js = (s) => win.webContents.executeJavaScript(s);

  let ready = false;
  for (let i = 0; i < 240; i++) {
    const r = await js('window.__ready === true ? "ok" : (window.__error || null)').catch(() => null);
    if (r === 'ok') { ready = true; break; }
    if (r) { check('scene built', false, String(r).slice(0, 400)); app.exit(1); return; }
    await sleep(250);
  }
  if (!ready) { check('scene built', false, 'timed out'); app.exit(1); return; }
  check('scene built', true);

  const foliage = await js('window.__foliage()');
  console.log(`      layer: ${JSON.stringify(foliage)}`);
  check('the layer scattered its instances', foliage.count > 0, JSON.stringify(foliage));
  if (!WITH_LODS) {
    // The premise of the bare run: one detail level and no impostor, so nothing reduces the prototype
    // with distance and every visible instance is the full mesh. That is the state a foliage rule is in
    // when its LOD chain failed to resolve, which is where this investigation started.
    check('the prototype has no LOD relief to hide behind', foliage.levels === 1, `levels=${foliage.levels}`);
  } else {
    check('the LOD ladder reached the layer', foliage.levels > 1, `levels=${foliage.levels}`);
    check('the impostor reached the layer', foliage.impostor === true, JSON.stringify(foliage));
    // Configured is not the same as USED. The bucket counts say whether the card is actually taking
    // over, and a rule can be perfectly authored while every cell still sits on level 0.
    const impostorCells = foliage.bucketCells[foliage.bucketCells.length - 1] || 0;
    check('the impostor bucket is actually drawing', impostorCells > 0,
          `bucketCells=${JSON.stringify(foliage.bucketCells)}`);
  }

  // Warm-up frames are NOT measured: the first frames compile pipelines and upload the prototype, and
  // the admission budget is skipped only on the layer's first sight. What is being gated is the steady
  // state with everything visible.
  await js('window.__resetPeak()');
  await sleep(FRAMES * 16 + 500);

  const lost = await js('window.__contextLost === true');
  check('the GL context survived', lost === false);

  const peak = await js('window.__peakDraw');
  const budget = await js('window.__budget');
  const stats = await js('window.__stats()');
  console.log(`      frame: ${JSON.stringify(stats)}`);
  console.log(`      peak instanced draw: ${Math.round(peak.triangles).toLocaleString()} triangles `
            + `over ${peak.instances} instances, from ${peak.calls} instanced calls`);

  check('the frame actually drew foliage', stats.foliageDraws > 0, JSON.stringify(stats));
  // THE gate, and it is asserted against a ceiling THIS FILE owns rather than against the engine's
  // own constant. Checking the engine against its own budget only proves the chunker is
  // self-consistent: raising FOLIAGE_DRAW_TRIANGLE_BUDGET to infinity raises the threshold with it and
  // the check still passes while the build is back to a 26M-triangle submission. The number below is
  // the independent one, and it is what fails when the cap is gone.
  //
  // 8M triangles: comfortably above the 4M the engine budgets for (so a deliberate tuning change does
  // not trip it) and far below the tens of millions an unbounded merge produces.
  const CEILING = 8_000_000;
  check('a single instanced draw stays under the harness ceiling',
        peak.triangles <= CEILING,
        Math.round(peak.triangles).toLocaleString() + ' > ' + CEILING.toLocaleString());

  // The engine is ALSO checked against its own declared budget, which catches the other failure: a
  // chunker that quietly stops honouring the number it is configured with.
  // A tolerance of one instance, because a chunk is cut at whole CELLS — a cell whose own
  // instance count already exceeds the budget has to go through in one piece, since a draw cannot start
  // part-way into an instance buffer without a base-instance offset that WebGL2 does not have.
  const perInstance = peak.instances > 0 ? peak.triangles / peak.instances : 0;
  const allowed = budget + perInstance;
  check('the chunker honours its own declared budget',
        peak.triangles <= allowed,
        `${Math.round(peak.triangles).toLocaleString()} > ${Math.round(allowed).toLocaleString()}`);

  // The other half of the bargain: the split must not undo the batching. One draw per CELL is what this
  // replaced, so anything near the cell count means the chunking is too aggressive to be worth having.
  check('batching still collapses the per-cell draws',
        stats.foliageDraws < foliage.cells,
        `${stats.foliageDraws} foliage draws vs ${foliage.cells} cells`);

  // The line to compare between a `CLEO_LODS=1` run and a bare one. Triangles is the number the whole
  // exercise moves; draws and peak say whether it was moved by drawing less or by drawing it worse.
  console.log(`      SUMMARY ${WITH_LODS ? 'with-lods ' : 'bare      '}`
    + `triangles ${stats.triangles.toLocaleString()}`
    + `  foliageDraws ${stats.foliageDraws}`
    + `  peakDraw ${Math.round(peak.triangles).toLocaleString()}`);

  win.destroy();
  console.log('');
  console.log(failed ? '1 FAILED' : 'ALL PASS');
  app.exit(failed ? 1 : 0);
}

app.whenReady().then(() => {
  protocol.handle('app', (request) => {
    const rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '');
    return net.fetch(pathToFileURL(path.join(root, rel)).toString());
  });
  main().catch((e) => { console.error(e); app.exit(2); });
});
