// Renders real geometry through the engine's public API and reports the frame stats.
//
// Complements bootCheck.js: that one proves the editor boots after the M0 async-device change, this
// one proves M1's vertex-layout rewrite still produces correct geometry. It drives `cleo.js` directly,
// so there is no project gate and no editor UI to fight.
//
// Run from desktop/ with ELECTRON_RUN_AS_NODE unset:
//   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron tools/__meshCheck.tmp.js
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
const shotDir = process.env.CLEO_SHOT_DIR || path.join(__dirname, 'shots');
fs.mkdirSync(shotDir, { recursive: true });

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-mesh-')));
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const results = [];
const errors = [];
const check = (name, ok, detail) => {
  results.push({ ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '   -> ' + String(detail ?? '')}`);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function until(fn, ms = 30000, step = 250) {
  const deadline = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* not ready */ }
    if (Date.now() > deadline) return null;
    await sleep(step);
  }
}

app.whenReady().then(async () => {
  protocol.handle('app', (request) => {
    let pathname = decodeURIComponent(new URL(request.url).pathname);
    if (!pathname || pathname === '/') pathname = '/index.html';
    const filePath = path.resolve(path.join(root, pathname));
    if (!filePath.startsWith(root)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(filePath).toString());
  });

  const win = new BrowserWindow({
    width: 1000, height: 700, show: process.env.CLEO_SHOW === '1',
    backgroundColor: '#202028',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.on('console-message', (_e, level, message) => { if (level === 3) errors.push(message); });

  await win.loadURL('app://mesh/index.html');
  const js = (src) => win.webContents.executeJavaScript(src);

  const ready = await until(() => js('window.__ready === true ? true : (window.__error ? { err: window.__error } : null)'), 45000);
  if (ready && ready.err) { check('scene built', false, ready.err); app.exit(1); return; }
  check('scene built and engine running', ready === true, 'never became ready');

  // Let a few frames land so frameStats reflects a steady frame, not the first one.
  await sleep(3000);
  const stats = await js('window.__stats ? window.__stats() : null');
  check('frames are rendering', stats && stats.drawCalls > 0, JSON.stringify(stats));

  // Three models, each with real index counts. If the vertex layout were wrong the draws would still
  // happen — this is not the check that catches it, the screenshot is — but zero triangles would mean
  // nothing was submitted at all.
  check('triangles were submitted', stats && stats.triangles > 0, JSON.stringify(stats));
  if (stats) {
    console.log(`      drawCalls=${stats.drawCalls} triangles=${stats.triangles} vertices=${stats.vertices} objects=${stats.objects} culled=${stats.culled} instanced=${stats.instancedDrawCalls} instances=${stats.instances}`);
    console.log(`      shadedMpx=${(stats.shadedMpx ?? 0).toFixed?.(2) ?? stats.shadedMpx} stateChanges=${stats.stateChanges}`);
  }

  // The instanced path: four nodes sharing one Model must collapse into instanced draws, which is what
  // exercises the per-instance mat4 layout across attribute slots 5..8.
  check('instanced draws happened', stats && stats.instancedDrawCalls > 0 && stats.instances >= 4,
        JSON.stringify(stats && { i: stats.instancedDrawCalls, n: stats.instances }));

  // Texture uploads: the scene has a mipmapped 2D image on two materials and a sky that bakes into a
  // cubemap. Both land in the renderer's GPU-memory accounting, which is zero if nothing was allocated.
  const rs = await js('window.__renderStats ? window.__renderStats() : null');
  check('textures are resident on the GPU', rs && rs.gpuBytes > 0, JSON.stringify(rs && { gpuBytes: rs.gpuBytes }));
  if (rs) console.log('      gpuBytes=' + rs.gpuBytes + ' (' + (rs.gpuBytes / 1048576).toFixed(1) + ' MB)');

  // The skinned path, including its shadow-cascade draw. Construction alone is not the assertion —
  // it succeeded even while initializeAnimatedVAO was throwing — so the object count carries it: 7
  // unskinned nodes plus this one.
  const sk = await js('({ ok: !!window.__skinned, err: window.__skinnedError || null })');
  check('skinned mesh built', sk.ok, sk.err);
  check('skinned mesh reached the draw list', stats && stats.objects >= 8, JSON.stringify(stats && { objects: stats.objects }));

  // TileMesh: its own buffers, its own vertex layout, both migrated this milestone.
  const tm = await js('window.__tilemapInfo ? window.__tilemapInfo() : { err: window.__tilemapError || "not built" }');
  console.log('      tilemap: ' + JSON.stringify(tm));
  check('tilemap chunks were built and drawn', stats && stats.tilemapDraws > 0,
        JSON.stringify(stats && { chunks: stats.tilemapChunks, draws: stats.tilemapDraws }));

  // The present pass is WGSL-authored, so its u_exposure is a std140 block member, not a loose
  // uniform. Changing it must change the picture — if the block were never uploaded it would read as
  // zeros and every frame would come out black, which the stats above would not notice.
  const meanLuma = async () => {
    // capturePage returns the LAST COMPOSITED frame, which lags a change by one capture — measuring
    // once produced a clean off-by-one where the dim frame showed up in the next reading. Take a
    // throwaway capture first so the measured one is current.
    await win.webContents.capturePage();
    await sleep(250);
    const img = await win.webContents.capturePage();
    const b = img.toBitmap();
    let sum = 0;
    for (let i = 0; i < b.length; i += 4) sum += 0.2126 * b[i + 2] + 0.7152 * b[i + 1] + 0.0722 * b[i];
    return sum / (b.length / 4);
  };
  const brightBefore = await meanLuma();
  await js('window.__setExposure(0.15)');
  await sleep(600);
  const dim = await meanLuma();
  await js('window.__setExposure(2.0)');
  await sleep(600);
  const restored = await meanLuma();
  console.log('      luma: default=' + brightBefore.toFixed(1) + ' exposure0.15=' + dim.toFixed(1) +
              ' restored=' + restored.toFixed(1));
  check('uniform block drives the image (exposure responds)', dim < brightBefore * 0.75, 'exposure had no effect');
  check('exposure change is reversible', Math.abs(restored - brightBefore) < 2.0, 'did not return to baseline');

  // Every custom-material prelude, compiled and linked by the real driver.
  //
  // Guarded by a deadline: an executeJavaScript whose page died never settles, and an unguarded await
  // on one turned a 40-second harness run into a six-minute timeout with no output at all.
  const evalJson = async (src, label) => {
    const raced = await Promise.race([
      js(src).then(JSON.parse, (e) => ({ __failed: String(e && e.message || e) })),
      sleep(60000).then(() => ({ __failed: 'timed out after 60s' })),
    ]);
    if (raced && raced.__failed) { check(label, false, raced.__failed); return null; }
    return raced;
  };

  const custom = await evalJson('JSON.stringify(window.__compileCustom())', 'custom preludes evaluated');
  if (custom) {
    for (const mode of ['screen', 'forward', 'deferred']) {
      const r = custom[mode];
      check(mode + ' custom prelude compiles on a real driver', r.ok,
            String(r.error || '').split(String.fromCharCode(10)).slice(0, 4).join(' | '));
    }
    check('a broken custom shader still reports its error', !custom.broken.ok && !!custom.broken.error,
          'a failing compile was reported as ok');
    // No translator is installed outside the editor, so nothing here may produce WGSL. If it did, naga
    // would be reachable from the engine bundle and every published game would carry 1.3 MB of it.
    check('no WGSL is produced without a translator installed',
          !custom.screen.hasWgsl && !custom.screen.wgslError,
          'the engine translated with no translator installed');
  }

  check('no uncaught errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  const image = await win.webContents.capturePage();
  const shotPath = path.join(shotDir, 'mesh.png');
  fs.writeFileSync(shotPath, image.toPNG());
  console.log('      screenshot: ' + shotPath);

  const failed = results.filter(r => !r.ok).length;
  console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED'));
  app.exit(failed === 0 ? 0 : 1);
});
