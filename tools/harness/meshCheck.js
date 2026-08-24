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
const { compare, captureSignature } = require('./signature');

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
// CLEO_SCENE=full adds the terrain/foliage/cloud content the base scene lacks. It gets its OWN
// baselines and its own screenshot rather than replacing the base ones: a scene that grows and a
// shader that regressed would otherwise be the same failure, and neither could be attributed.
const scene = process.env.CLEO_SCENE === 'full' ? 'full' : 'base';
const sceneTag = scene === 'base' ? '' : '.' + scene;
const shotName = (process.env.CLEO_PIPELINE === 'forward' ? 'mesh.forward' : 'mesh') + sceneTag + '.png';
fs.mkdirSync(shotDir, { recursive: true });

// A FIXED profile directory, reused across runs.
//
// It was `mkdtempSync`, which leaves the profile behind on every run because these scripts end
// with `app.exit()` and never clean up. Several hundred harness runs filled the system drive to
// zero bytes free — Electron writes a real Chromium profile in there, several megabytes each.
// A fixed path is also faster to start, and these run sequentially so there is nothing to collide
// with.
const profileDir = path.join(os.tmpdir(), 'cleo-mesh-profile');
fs.mkdirSync(profileDir, { recursive: true });
app.setPath('userData', profileDir);
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const results = [];
const errors = [];
const warnings = [];
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
  // Level 3 is an error, level 2 a warning. Warnings are collected separately rather than ignored:
  // a shader that logs one per frame, or a few hundred at startup, is a real defect that no pixel
  // check can see — and noise at that volume is how a genuine warning gets missed.
  win.webContents.on('console-message', (_e, level, message) => {
    if (level === 3) errors.push(message);
    else if (level === 2) warnings.push(message);
  });

  // CLEO_PIPELINE=forward runs the same scene through the forward renderer, which is the only way the
  // forward material shaders (materials/pbr.fs, default.fs) get exercised at all.
  // CLEO_EXTRAS bisects the material/topology grid; see `extras` in the page.
  const params = new URLSearchParams();
  if (process.env.CLEO_PIPELINE === 'forward') params.set('forward', '1');
  if (process.env.CLEO_EXTRAS) params.set('extras', process.env.CLEO_EXTRAS);
  if (scene !== 'base') params.set('scene', scene);
  const query = params.toString() ? '?' + params.toString() : '';
  await win.loadURL('app://mesh/index.html' + query);
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

  // The `?scene=full` content, when it is on. Built inside a try/catch in the page so that a bad API
  // call surfaces as a named failure here rather than as an empty screenshot.
  if (scene === 'full') {
    const sceneError = await js('window.__fullSceneError');
    check('full scene built', !sceneError, String(sceneError || '').split('\n').slice(0, 6).join(' | '));
    // Clouds OFF for everything that follows, back on for the sky check at the end.
    //
    // They contribute no pixels from this camera (the slab is behind every ray — see __lookUp), but the
    // temporal reconstruction still runs, and it traces a different 1/16 Bayer slot each frame. Whatever
    // it leaves behind therefore depends on which frame the capture lands on, and the shading signature
    // drifted by 4/128 stddev cells between two runs of an unchanged build — in different cells each
    // time. A baseline that moves on its own is worse than no baseline: it trains you to ignore it.
    await js('window.__setClouds({ enabled: false })');

    const foliage = await js('window.__foliageCounts ? window.__foliageCounts() : null');
    console.log('      foliage: ' + JSON.stringify(foliage));
    // Zero instances is the silent failure mode: the layers exist, the terrain draws, and the four
    // instanced programs simply never bind — which looks like a pass everywhere except coverage.
    check('foliage layers have instances',
          Array.isArray(foliage) && foliage.length === 2 && foliage.every(f => f.count > 0),
          JSON.stringify(foliage));

    // Sprites reach the scene at all. They are the one draw path whose geometry is rebuilt on the CPU
    // every frame (the camera-facing constraint rewrites the model matrix), so "it is in the list" and
    // "it drew the right shape" are genuinely different questions — the signature answers the second.
    const spriteCount = await js('window.__spriteCount ? window.__spriteCount() : -1');
    check('sprites reached the scene', spriteCount === 2, 'scene.sprites.size = ' + spriteCount);

    // The two always-on-top paths. Both are counted rather than eyeballed because both fail silently:
    // a gizmo that loses its depth-test-off state is still drawn, just hidden behind the geometry it
    // is supposed to annotate, and the skeleton overlay's two instanced draws simply stop appearing.
    const gizmoCount = await js('window.__gizmoCount ? window.__gizmoCount() : -1');
    check('gizmo reached the scene', gizmoCount === 1, 'isGizmo nodes = ' + gizmoCount);

    // A screen-space custom material that actually DRAWS. The harness compiled all three custom
    // preludes and drew none of them, so the runtime-compiled program, the ping-ponged compose
    // buffers and the prelude's engine-then-user sampler ordering had no pixel coverage at all.
    const screenMats = await js('window.__screenMaterialCount ? window.__screenMaterialCount() : -1');
    check('screen material is on the camera', screenMats === 1,
          'activeCamera.screenMaterials.length = ' + screenMats);

    // Forward and deferred custom materials that RASTERISE. Both were compile-tested and neither was
    // ever drawn, so their runtime-compiled programs — lighting, shadow lookups, user samplers — had
    // no pixel coverage. Both sample a user texture unconditionally, so a material that is black
    // because it is unlit and one that is black because its sampler is bound wrong stay distinguishable.
    const customDrawn = await js('window.__customDrawn ? window.__customDrawn() : -1');
    const customErr = await js('window.__customDrawError');
    check('custom materials drew', customDrawn === 2, 'nodes=' + customDrawn + ' ' + (customErr || ''));

    // `probePreview` targets its own FBO, so no viewport signature can ever cover it. Invoke it and
    // assert on the returned PNG being a real image rather than the '' the early-outs return.
    const preview = await js('window.__probePreview ? window.__probePreview(64) : null');
    check('probe preview rendered',
          typeof preview === 'string' && preview.startsWith('data:image/png') && preview.length > 500,
          preview ? 'len=' + preview.length : String(preview));
  }
  if (stats) {
    console.log(`      drawCalls=${stats.drawCalls} rhi=${stats.rhiDrawCalls} triangles=${stats.triangles} vertices=${stats.vertices} objects=${stats.objects} culled=${stats.culledObjects}/${stats.culledInstances} instanced=${stats.instancedDrawCalls} instances=${stats.instances}`);
    console.log(`      shadedMpx=${(stats.shadedMpx ?? 0).toFixed?.(2) ?? stats.shadedMpx} stateChanges=${stats.stateChanges}`);
  }

  // The instanced path: four nodes sharing one Model must collapse into instanced draws, which is what
  // exercises the per-instance mat4 layout across attribute slots 5..8.
  // The frame stats, against a recorded baseline.
  //
  // These were printed for a human to eyeball, which is not a gate: through the whole WGSL migration
  // the "byte-identical to the previous milestone" property rested on somebody noticing a changed
  // number. Recorded here instead, so a conversion that quietly drops a draw call or a submesh fails.
  //
  //   re-record:  CLEO_MESH_BASELINE=write  (do this ONLY for a deliberate scene change)
  const pipeline = await js('window.__pipeline').catch(() => 'deferred');
  console.log('      pipeline=' + pipeline);
  // Keyed by pipeline: forward draws each object with a material shader while deferred fills a
  // G-buffer and lights it once, so the two legitimately submit different work.
  const statsBaselinePath = path.join(__dirname, `meshBaseline.${pipeline}${sceneTag}.json`);
  // `rhiDrawCalls` is tracked for the same reason the others are, and one more: a draw that falls back
  // from the RHI command model to `Mesh` produces identical pixels AND identical draw counts, so it is
  // the only number that can catch that regression.
  const TRACKED = ['drawCalls', 'triangles', 'vertices', 'objects', 'culledObjects', 'culledInstances',
                   'instancedDrawCalls', 'instances', 'rhiDrawCalls'];
  const compareStats = (label, file, sample) => {
    const current = {};
    for (const k of TRACKED) current[k] = sample[k];
    if (process.env.CLEO_MESH_BASELINE === 'write') {
      fs.writeFileSync(file, JSON.stringify(current, null, 2));
      console.log(`      ${label} baseline written to ` + file);
    } else if (fs.existsSync(file)) {
      const want = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const drift = TRACKED.filter(k => want[k] !== current[k])
                           .map(k => `${k}: ${want[k]} -> ${current[k]}`);
      check(`${label} match the baseline`, drift.length === 0, drift.join(', '));
    } else {
      check(`${label} have a baseline`, false,
            'no ' + path.basename(file) + ' — run with CLEO_MESH_BASELINE=write');
    }
  };
  compareStats('frame stats', statsBaselinePath, stats);

  // Instancing is a deferred-path feature here: the forward renderer draws these objects individually,
  // so demanding an instanced draw in forward mode would fail for a reason that is not a defect.
  if (pipeline === 'forward') {
    console.log('      (skipping the instancing check — forward draws these objects individually)');
  } else check('instanced draws happened', stats && stats.instancedDrawCalls > 0 && stats.instances >= 4,
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

  // Frustum culling actually rejects work.
  //
  // Turn the camera 180 degrees away from everything and assert that every model is rejected. Worth its
  // own framing because the default shot cannot tell a correct cull test from NO cull test: with the
  // whole scene in view both produce the same picture and the same counts. The deferred pipeline's
  // forward-overlay queues (opaque Blinn-Phong/custom, and transparent) were collected with no test at
  // all for exactly as long as that was true, so those models drew wherever the camera pointed.
  //
  // Base profile only. The full scene adds gizmos, which deliberately bypass culling.
  if (scene === 'base') {
    const modelCount = await js('window.__modelCount ? window.__modelCount() : -1');
    await js('window.__lookAway(true)');
    // capturePage forces a frame: this window is never shown, so rAF alone is throttled and the stats
    // can otherwise still describe the previous framing.
    await win.webContents.capturePage();
    await sleep(300);
    await win.webContents.capturePage();
    const away = await js('window.__stats()');   // frameStats: renderer.stats omits rhiDrawCalls
    await js('window.__lookAway(false)');
    await win.webContents.capturePage();
    await sleep(300);
    await win.webContents.capturePage();
    console.log(`      facing away: objects=${away.objects} culledObjects=${away.culledObjects}`
                + ` of ${modelCount} models, drawCalls=${away.drawCalls} triangles=${away.triangles}`
                + ` tilemapDraws=${away.tilemapDraws}`);
    check('every model is frustum-culled when the camera faces away',
          modelCount > 0 && away.culledObjects === modelCount,
          `culledObjects=${away.culledObjects} modelCount=${modelCount}`);
    // The counter above only proves each model was TESTED. What proves it was not drawn anyway is the
    // recorded away-facing frame stats: a queue that skips the cull test submits its triangles here and
    // nowhere else, because every other framing in this harness has the whole scene in view.
    compareStats('away-facing frame stats',
                 path.join(__dirname, `meshBaseline.${pipeline}.away.json`), away);
  }

  // Draw the selection outline over a SKINNED BASIC mesh.
  //
  // No picture baseline, on purpose — the silhouette there is still wrong and recording it would pin a
  // defect. What this DOES cover is the GL-error and shader-warning checks below, and that is not
  // theoretical: on the legacy `Mesh.draw` path this exact selection raised GL_INVALID_OPERATION three
  // times a frame and rendered the mesh itself as a torn fan, because the outline program re-initialised
  // the mesh's VAO to its own attribute layout and the geometry pass then drew against it. The Basic
  // family is the one where those layouts differ (no normal/tangent/bitangent), and the scene's own
  // selection is a PBR cube, so nothing here ever exercised it.
  //
  // `CLEO_OUTLINE_TAG=<label>` additionally writes `shots/outline-<label>.png` for eyeballing.
  {
    console.log('      outline over: ' + await js("window.__select('basicSkinned')"));
    await win.webContents.capturePage();
    await sleep(300);
    const img = await win.webContents.capturePage();
    if (process.env.CLEO_OUTLINE_TAG)
      fs.writeFileSync(path.join(shotDir, `outline-${process.env.CLEO_OUTLINE_TAG}.png`), img.toPNG());
    await js("window.__select()");   // give the scene its own selection back
    await win.webContents.capturePage();
    await sleep(200);
  }

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

  // Did the probe actually bake? `probesForFrame` skips any probe without baked maps, so an unbaked
  // one contributes nothing and looks exactly like broken IBL.
  const probe = await js('JSON.stringify(window.__probeState())').then(JSON.parse).catch(() => null);
  console.log('      probe: ' + JSON.stringify(probe));
  check('light probe baked its cubemaps', !!probe && probe.baked === true, JSON.stringify(probe));

  // Shading, against a recorded signature.
  //
  // Frame stats prove the right geometry was submitted; they say nothing about what came out. That gap
  // mattered most for the forward pipeline, which the pass harness never exercises — converting
  // materials/pbr.fs could have changed every lit pixel without moving a single number above.
  const shadingPath = path.join(__dirname, `meshShading.${pipeline}${sceneTag}.json`);
  const sig = await captureSignature(win, sleep);
  if (process.env.CLEO_MESH_BASELINE === 'write') {
    fs.writeFileSync(shadingPath, JSON.stringify({ signature: sig }, null, 2));
    console.log('      shading baseline written to ' + shadingPath);
  } else if (fs.existsSync(shadingPath)) {
    const want = JSON.parse(fs.readFileSync(shadingPath, 'utf-8')).signature;
    const d = compare(want, sig);
    // Name WHICH values moved, not just how many: cell N of the 8x8 grid, and whether it was the mean
    // (even index) or the standard deviation (odd), which says "the colour shifted" versus "the
    // sharpness changed" — very different causes.
    const moved = [];
    for (let i = 0; i < want.length / 2; i++) {
      const a = parseInt(want.slice(i * 2, i * 2 + 2), 16);
      const b = parseInt(sig.slice(i * 2, i * 2 + 2), 16);
      if (Math.abs(a - b) > 4) moved.push(`cell${i >> 1}${i % 2 ? '.sd' : '.mean'} ${a}->${b}`);
    }
    check('shading matches the baseline', d.material === 0,
          `${d.material}/128 values differ beyond the noise floor: ${moved.join(', ')}`);
  } else {
    check('shading has a baseline', false, 'no ' + path.basename(shadingPath));
  }

  // The volumetric clouds, which need their own view.
  //
  // Their slab sits at altitude 800..1500 and the scene camera is pitched 30 degrees down, so no view
  // ray in the shot above ever points at it: the pass ran, bound its three programs and composited
  // exactly nothing. That is the whole reason a bind counter is not a coverage measurement. Aim at the
  // sky, hold the result to a signature, and — because the sky behind the clouds is white haze and the
  // clouds are white, which moves the frame MEAN by about 0.1/255 — also prove the pass is what
  // produced it by turning it off and requiring the picture to change.
  //
  // Done last, and restored afterwards, so the framing this needs cannot leak into any check above.
  //
  // Deferred only. The cloud pass reads the G-buffer depth to bound each ray and is dispatched from the
  // deferred overlay, so under CLEO_PIPELINE=forward it never runs at all — asserting there would be
  // asserting that a pass the pipeline does not have produces pixels.
  if (scene === 'full' && pipeline === 'deferred') {
    await js('window.__lookUp(true)');
    await js('window.__setClouds({ enabled: true })');
    const skySig = await captureSignature(win, sleep);

    await js('window.__setClouds({ enabled: false })');
    const noCloudSig = await captureSignature(win, sleep);
    const delta = compare(skySig, noCloudSig);
    check('the cloud pass visibly changes the sky', delta.material > 8,
          delta.material + '/128 signature values move when the clouds are switched off');

    await js('window.__setClouds({ enabled: true })');
    await js('window.__lookUp(false)');

    const cloudPath = path.join(__dirname, `meshClouds.${pipeline}.json`);
    if (process.env.CLEO_MESH_BASELINE === 'write') {
      fs.writeFileSync(cloudPath, JSON.stringify({ signature: skySig }, null, 2));
      console.log('      cloud baseline written to ' + cloudPath);
    } else if (fs.existsSync(cloudPath)) {
      const want = JSON.parse(fs.readFileSync(cloudPath, 'utf-8')).signature;
      const d = compare(want, skySig);
      check('clouds match the baseline', d.material === 0,
            d.material + '/128 values differ beyond the noise floor');
    } else {
      check('clouds have a baseline', false, 'no ' + path.basename(cloudPath));
    }
  }

  // Driver-level GL errors, which are neither exceptions nor `[Shader]` warnings and were therefore
  // invisible to both checks below.
  //
  // Not hypothetical: the IBL fallback cube was built as a TEXTURE_2D and then allocated as a
  // TEXTURE_CUBE_MAP, so every run logged "Zero is bound to target" plus five "no texture bound to
  // target" at boot, allocated nothing, and left a 2D texture bound to cube samplers. Nothing threw,
  // no pixel moved in this scene, and the harness passed. `allocateCube` throws on that mismatch now;
  // this catches the next one of its kind.
  const glMessages = [...errors, ...warnings].filter(
    w => /GL_INVALID|WebGL: INVALID|GL_OUT_OF_MEMORY|glTexStorage|no texture bound/.test(w));
  check('no driver GL errors', glMessages.length === 0,
        glMessages.slice(0, 4).map(m => m.slice(0, 160)).join(' | '));

  // Shader warnings, of any kind.
  //
  // Nothing here throws, so a warning is often the ONLY signal that a uniform is not reaching the GPU —
  // "type this block writer does not handle" means a value is silently never written. Volume matters
  // too: uniform-alias registration once logged a few hundred warnings per shader, which is how a real
  // one (`u_view` genuinely declared in two blocks, only one of them being written) went unnoticed.
  const shaderWarnings = warnings.filter(w => /\[Shader\]/.test(w));
  check('no shader warnings', shaderWarnings.length === 0,
        shaderWarnings.length + ' warning(s), e.g. ' + (shaderWarnings[0] || '').slice(0, 140));

  check('no uncaught errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  // Settle before the screenshot. The cloud check above re-aims the camera at the sky and puts it
  // back, and a capture issued in the same tick as the restore photographs the frame BEFORE it —
  // a picture of the sky filed as the scene shot. Nothing asserts on this image, which is exactly
  // why it has to be right: it is what a human looks at when a signature moves.
  for (let f = 0; f < 4; f++) { await win.webContents.capturePage(); await sleep(80); }

  const image = await win.webContents.capturePage();
  const shotPath = path.join(shotDir, shotName);
  fs.writeFileSync(shotPath, image.toPNG());
  console.log('      screenshot: ' + shotPath);

  const failed = results.filter(r => !r.ok).length;
  console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED'));
  app.exit(failed === 0 ? 0 : 1);
});
