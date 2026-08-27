// Builds the "Realistic Landscape" example project out of the decimated art from decimateTrees.mjs.
//
// The scene is assembled by the REAL engine, in a real GPU process, and then serialized: models come
// back through `GLTFLoader`, materials through `Material.PBR`, the terrain through `Terrain`, and the
// node tree through `Scene.serialize()`. Nothing about the scene's shape is reimplemented here, which
// is the point — a hand-rolled scene writer drifts from the parser the editor actually uses, and the
// failure mode is a project that imports with pieces quietly missing.
//
// Same shape as tools/harness/meshCheck.js (fixed profile dir, an `app:` protocol rooted at a staging
// tree, poll `window.__ready`), because that is the established way to drive `dist/cleo.js` headlessly
// in this repo.
//
//   npm run build:dev                        # the bundle this stages must be current
//   node tools/terrain/decimateTrees.mjs
//   npm run build:landscape
//
// Env:
//   CLEO_HEADLESS=1    hide the window (the cover image will be blank)
//   CLEO_TERRAIN_DIR   staging dir from stage 1   (default <tmp>/cleo-terrain-build)
//   CLEO_OUT           output .zip                (default <tmp>/realistic-landscape.cleoproj.zip)
const { app, BrowserWindow, protocol, net, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..', '..');
const PAGE = path.join(REPO, 'tools', 'harness', 'pages', 'landscape');
const STAGE = path.resolve(process.env.CLEO_TERRAIN_DIR || path.join(os.tmpdir(), 'cleo-terrain-build'));
const OUT = path.resolve(process.env.CLEO_OUT || path.join(os.tmpdir(), 'realistic-landscape.cleoproj.zip'));
const SHOT = path.join(REPO, 'tools', 'harness', 'shots');

// jszip lives in editor/node_modules, the same place editor/tools/add-example.mjs resolves it from.
const JSZip = require(path.join(REPO, 'editor', 'node_modules', 'jszip'));

// --------------------------------------------------------------------------------------------
// The editor's own asset packer, loaded straight from source.
//
// Format 2 exists precisely for this scene's problem: a foliage prototype's geometry appears in the
// model library, in the terrain material's `foliageInclude` rule, in the scene's copy of that rule,
// and again in the scattered layer — four copies of every vertex as JSON decimals. `packBundleAssets`
// content-interns them into one `assets.bin` chunk, taking the bundle from ~250 MB to ~35.
//
// Re-implementing that here was the alternative, and it is the same trap the format's own header
// warns about: two writers of one contract drift, and the reader is the editor. `bundleAssets.ts` is
// deliberately DOM-free, engine-free and JSZip-free (it runs inside the project worker, and its unit
// tests run under vitest's node environment), and imports only `chunkBlob` and `bytes` — so sucrase,
// already a dependency of the engine, is enough to run the real thing.
const { transform } = require(path.join(REPO, 'node_modules', 'sucrase'));
function loadEditorModule(rel) {
  const full = path.join(REPO, 'editor', 'src', 'utils', rel + '.ts');
  const { code } = transform(fs.readFileSync(full, 'utf8'), {
    transforms: ['typescript', 'imports'], filePath: full,
  });
  const module = { exports: {} };
  const localRequire = (spec) => spec.startsWith('./')
    ? loadEditorModule(spec.slice(2))
    : require(spec);
  new Function('require', 'module', 'exports', code)(localRequire, module, module.exports);
  return module.exports;
}
const editorModules = new Map();
const editorModuleCached = (rel) => {
  if (!editorModules.has(rel)) editorModules.set(rel, loadEditorModule(rel));
  return editorModules.get(rel);
};

if (!fs.existsSync(path.join(STAGE, 'decimate-report.json'))) {
  console.error(`missing staged art in ${STAGE} — run \`node tools/terrain/decimateTrees.mjs\` first`);
  process.exit(1);
}
const engineSrc = path.join(REPO, 'dist', 'cleo.js');
if (!fs.existsSync(engineSrc)) {
  console.error('missing dist/cleo.js — run `npm run build:dev` first');
  process.exit(1);
}
// Stage the engine bundle next to the page, so a forgotten rebuild is a loud missing-file error rather
// than a new scene quietly built by an old engine.
fs.mkdirSync(PAGE, { recursive: true });
fs.copyFileSync(engineSrc, path.join(PAGE, 'cleo.js'));

const profileDir = path.join(os.tmpdir(), 'cleo-landscape-profile');
fs.mkdirSync(profileDir, { recursive: true });
app.setPath('userData', profileDir);
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const problems = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '   -> ' + String(detail ?? '')}`);
  if (!ok) problems.push(name);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function until(fn, ms, step = 500) {
  const deadline = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* not ready yet */ }
    if (Date.now() > deadline) return null;
    await sleep(step);
  }
}

app.whenReady().then(async () => {
  // Two roots behind one scheme: `app://build/...` is the staged art, everything else is the page. The
  // art is hundreds of megabytes and has no business being copied next to an HTML file.
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (!pathname || pathname === '/') pathname = '/index.html';
    const root = url.hostname === 'build' ? STAGE : PAGE;
    const filePath = path.resolve(path.join(root, pathname));
    if (!filePath.startsWith(root)) return new Response('Forbidden', { status: 403 });
    if (!fs.existsSync(filePath)) return new Response('Not found: ' + pathname, { status: 404 });
    return net.fetch(pathToFileURL(filePath).toString());
  });

  // Shown by default, because the cover image is a capture of this window and Windows hands back a
  // blank frame for one that was never composited. This is a build step someone runs by hand, so a
  // visible window is also the cheapest possible progress bar.
  const win = new BrowserWindow({
    width: 1600, height: 900, show: process.env.CLEO_HEADLESS !== '1',
    backgroundColor: '#101014',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level === 3) errors.push(message);
    else if (message.startsWith('[build]')) console.log('  ' + message.slice(8).trim());
  });

  await win.loadURL('app://page/index.html');
  const js = (src) => win.webContents.executeJavaScript(src);

  const ready = await until(() =>
    js('window.__ready === true ? true : (window.__error ? { err: window.__error } : null)'), 600000);
  if (!ready || ready.err) {
    check('scene built', false, (ready && ready.err) || 'never became ready');
    // The per-piece sizes survive the failure, and they are the diagnosis: this pipeline's ceiling
    // is V8's string limit on a JSON intermediate, not disk or GPU.
    const sizes = await js('window.__sizes ? window.__sizes() : null').catch(() => null);
    if (sizes) console.log('piece sizes (MB): ' + JSON.stringify(sizes));
    console.error(errors.slice(0, 20).join('\n'));
    app.exit(1); return;
  }

  // --- The gate. A bundle that renders nothing is not a scene, whatever its JSON looks like. -------
  const report = await js('window.__report()');
  console.log(JSON.stringify({ ...report, models: report.models.length + ' models' }, null, 2));
  check('scene built and engine running', true);
  check('frames are rendering', report.stats.drawCalls > 0, JSON.stringify(report.stats));
  check('triangles were submitted', report.stats.triangles > 0, JSON.stringify(report.stats));
  // A directional light's rotation is its direction; the sun has to be shining DOWN on the terrain.
  check('the sun is above the horizon', report.sunForward[1] < -0.15, report.sunForward);
  check('all four terrain layers carry a material', report.terrainLayers === 4, report.terrainLayers);
  check('every paint layer has real coverage', report.coverage.every(c => c > 2), report.coverage);
  // Layer 2 is scree and layer 3 is the creek bed; neither carries ground cover, and a vista that opens
  // on bare ground is the failure this check exists to catch.
  check('the camera stands on a layer with cover', report.camera.layer === 0 || report.camera.layer === 1,
    JSON.stringify(report.camera));
  check('foliage was scattered', report.foliage.length > 0 && report.foliage.every(f => f.count > 0),
    JSON.stringify(report.foliage.filter(f => !f.count)));
  // Only MESH prototypes carry a LOD chain; a billboard is one crossed quad and has exactly one level.
  check('every mesh foliage prototype kept its LOD levels',
    report.foliage.filter(f => f.kind === 'mesh').every(f => f.levels >= 2),
    JSON.stringify(report.foliage.filter(f => f.kind === 'mesh' && f.levels < 2)));
  // A layer that reaches MAX_INSTANCES is silently short of what its density asked for, and the only
  // symptom is thinner cover on one part of the map. `want` near 3.0 is where a rule starts to risk it.
  check('no foliage layer clipped at MAX_INSTANCES', report.foliage.every(f => !f.clipped),
    JSON.stringify(report.foliage.filter(f => f.clipped).map(f => `${f.name}:${f.count}`)));

  // --- The ground cover ---------------------------------------------------------------------------
  //
  // Grass is MESH out to its impostor distance and cards only past it. It used to be the other way
  // round — standalone billboard rules at 11.3/m² against mesh rules at 0.38, both starting at
  // distance 0, so the near field was flat quads. These gate the arrangement, not just the presence:
  // a standalone billboard layer has no near cut and would put cards back underfoot.
  const grass = report.foliage.filter(f => /^grass clump /.test(f.name));
  check('grass is scattered as meshes', grass.length === 5 && grass.every(f => f.kind === 'mesh' && f.count > 0),
    JSON.stringify(grass.map(f => `${f.name}:${f.kind}:${f.count}`)));
  check('no standalone billboard foliage layer', report.foliage.every(f => f.kind !== 'billboard'),
    JSON.stringify(report.foliage.filter(f => f.kind === 'billboard').map(f => f.name)));
  check('every grass layer hands off to a card impostor',
    grass.every(f => f.impostor > 0 && f.impostor < f.cull),
    JSON.stringify(grass.map(f => `${f.name}: impostor ${f.impostor} cull ${f.cull}`)));
  // Three levels, not two: the 14-30 m ring holds four times the clumps of 6-14 m and would cost more
  // than LOD0 and LOD1 together if it ran on LOD1.
  check('grass carries three mesh LOD levels', grass.every(f => f.levels >= 3),
    JSON.stringify(grass.map(f => `${f.name}:${f.levels}`)));
  // All five staged prototypes in use. `grass_medium_02_b` was staged, shipped in the model library and
  // referenced by no rule at all — dead weight in the bundle that no existing gate could see.
  // The scale range is DERIVED from each prototype's measured height, because the clumps are 12-40 cm
  // authored and differ 2.6x between variants — they were sharing the range the CARDS used, where a
  // 1x1 quad's scale IS its height in metres, so 0.85-1.6 meant 85-160 cm there and 10-25 cm here. The
  // ground cover was invisible at any distance and the frame stats could not show it: the triangles
  // were all submitted, just too small to see.
  check('grass tufts are a plausible height', report.tufts.length === 5
    && report.tufts.every(t => t.world[0] >= 0.15 && t.world[1] <= 1.0 && t.world[1] > t.world[0]),
    JSON.stringify(report.tufts));
  check('every staged grass prototype is used',
    ['a', 'b', 'c', 'd', 'e'].every(n => grass.some(f => f.name === 'grass clump ' + n)),
    JSON.stringify(grass.map(f => f.name)));
  // A card that came out fully opaque means the alpha cutout is doing nothing and every blade is a
  // rectangle; one that came out nearly empty means the compositing missed.
  check('every grass card has a usable alpha silhouette',
    report.cards.length === 3 && report.cards.every(c => c.coverage > 4 && c.coverage < 55),
    JSON.stringify(report.cards));
  // Both ground materials have to actually reach the terrain, or one of them is dead weight.
  const layerTex = report.layerTextures.join(' ');
  check('both ground surfaces are on the terrain',
    layerTex.includes('Ground103') && layerTex.includes('Ground110'), layerTex);
  // Every cut-out atlas must have been flooded. Without it the mip chain averages the black background
  // in and the foliage renders as black silhouettes at range — see the page's dilation block.
  const dilatedIds = report.dilated.map(d => d.id);
  const needDilation = ['grass_medium_02_diff_1k.jpg', 'searsia_burchellii_diff_1k.jpg',
                        'pine_tree_01_twig_diff_1k.jpg', 'rock_moss_set_02_diff_1k.jpg'];
  check('every cut-out atlas was dilated', needDilation.every(id => dilatedIds.includes(id)),
    needDilation.filter(id => !dilatedIds.includes(id)).join(', '));
  check('the tiling ground set was left alone',
    !dilatedIds.some(id => id.startsWith('Ground103')), dilatedIds.filter(id => id.startsWith('Ground103')));
  // --- Alpha cutout -------------------------------------------------------------------------------
  //
  // Which materials get a cutoff is decided by measuring how much of each primitive's rendered surface
  // lands on its atlas's background, so these checks gate the MEASUREMENT as much as the wiring. The
  // named expectations come from sampling the source meshes by hand: searsia leaves 62.6%, twigs
  // 34.0%, grass 16.6%, pine needles 13.8%, every bark/trunk 0.0%.
  const factOf = (name) => report.materials.find(m => m.material === name);
  const MASKED = ['searsia_burchellii_leaves', 'searsia_burchellii_twigs',
                  'pine_tree_01_twig', 'grass_medium_02'];
  const SOLID = ['searsia_burchellii', 'pine_tree_01_bark', 'pine_tree_01_trunk_b',
                 'pine_tree_01_dead_branches', 'rock_moss_set_02'];
  check('every cut-out material got an alpha cutoff',
    MASKED.every(n => (factOf(n)?.cutoff ?? 0) > 0),
    JSON.stringify(MASKED.map(n => `${n}:${factOf(n)?.cutoff ?? 'missing'}`)));
  // The rock atlas has 22% background but its closed meshes never sample it — a cutout there would
  // punch holes rather than cut leaves, so this is the half of the measurement that must NOT fire.
  // Every LOD of one material must reach the SAME verdict. They share a texture and a UV layout, so a
  // disagreement means the measurement is unstable — which is how a mirrored V went unnoticed: it read
  // one rock LOD at 0% and another at 100%, and the material library, which dedupes by name and keeps
  // the first, then disagreed with the scene.
  const spread = {};
  for (const m of report.materials) (spread[m.material] ??= new Set()).add(m.cutoff);
  const unstable = Object.entries(spread).filter(([, v]) => v.size > 1).map(([k]) => k);
  check('the cutout verdict is stable across LODs', unstable.length === 0,
    unstable.map(n => `${n}: ${report.materials.filter(m => m.material === n).map(m => m.background + '%').join(', ')}`).join(' | '));
  check('no solid material was masked',
    SOLID.every(n => (factOf(n)?.cutoff ?? 0) === 0),
    JSON.stringify(SOLID.map(n => `${n}:${factOf(n)?.cutoff ?? 'missing'} @${factOf(n)?.background}%`)));
  check('every masked material ships an alpha texture',
    MASKED.every(n => report.masked.some(id => id.startsWith(n.replace(/_$/, '').split('_').slice(0, 2).join('_')))),
    JSON.stringify(report.masked));
  check('every model loaded with geometry', report.models.every(m => m.triangles > 0),
    JSON.stringify(report.models.filter(m => !m.triangles)));
  check('the light probe baked', report.probeBaked, report.probeBaked);
  check('no console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
  // Named explicitly: a lost context makes every later failure look like something else entirely —
  // blank captures, and textures that report "used after destroy" from a handle never created.
  check('the GL context survived', !report.contextLost, 'the scene overloaded the GPU');
  // A hard budget, not a guideline, and CALIBRATED rather than guessed: 14.2M took the GPU process
  // down (exit_code 34) and 10.0M ran clean through the whole build including the second terrain the
  // round trip allocates. 11M sits below the observed failure with room, and the failure it prevents
  // arrives disguised as blank screenshots and textures that report "used after destroy".
  check('the frame stays inside its triangle budget', report.stats.triangles < 11e6,
    `${(report.stats.triangles / 1e6).toFixed(1)}M peak triangles`);

  // Dump the processed atlases next to the shots, so a dilation regression is one look away.
  for (const id of ['grass_medium_02_diff_1k.jpg', 'searsia_burchellii_diff_1k.jpg',
                    'rock_moss_set_02_diff_1k.jpg',
                    'grass_card_0.png', 'grass_card_1.png', 'grass_card_2.png']) {
    const b64 = await js(`window.__textureBytes(${JSON.stringify(id)})`);
    if (b64) fs.writeFileSync(path.join(SHOT, 'atlas.' + id), Buffer.from(b64, 'base64'));
  }

  // --- Cover image --------------------------------------------------------------------------------
  //
  // A capture of the composited window, not a renderer readback. `screenshotOffscreen` is the asset
  // thumbnail path: it skips the sky, the clouds and the god rays and keys alpha off scene depth, so a
  // landscape comes back as black silhouettes on transparency. What the gallery card should show is
  // what the window shows.
  fs.mkdirSync(SHOT, { recursive: true });
  // Retried, because a compositor snapshot of a heavy frame can come back before the page has painted
  // one. A blank PNG is ~2.5 kB whatever the window size, so its length is the tell.
  const shoot = async (name, tries = 6) => {
    let img, png;
    for (let i = 0; i < tries; i++) {
      img = (await win.webContents.capturePage()).resize({ width: 960 });
      png = img.toPNG();
      if (png.length > 20000) break;
      await sleep(1200);
    }
    fs.writeFileSync(path.join(SHOT, name), png);
    return { img, png };
  };

  // Diagnostic angles first, hero last so the window is left on the shot that becomes the cover.
  // Two of these exist because judging a landscape from one 960-pixel frame is guesswork: an overhead
  // pass says whether the terrain is being drawn at all, and an eye-level one says whether the ground
  // cover reads as ground cover.
  // Both heights come from the terrain at their OWN spot. A fixed height put the ground camera under
  // the surface, and an underground view of backface-culled terrain reads exactly like a broken scene.
  const mid = await js('window.__terrainProbe(0, 0)');
  const near = await js('window.__terrainProbe(40, 40)');
  const views = [
    ['landscape.overhead.png', [0, mid.height + 210, 150], [55, 180, 0]],
    ['landscape.ground.png', [40, near.height + 2, 40], [4, 200, 0]],
  ];
  for (const [name, pos, rot] of views) {
    const r = await js(`window.__setCamera(${JSON.stringify(pos)}, ${JSON.stringify(rot)})`);
    await shoot(name);
    const rb = await js('window.__readback(640)');
    if (rb) fs.writeFileSync(path.join(SHOT, name.replace('.png', '.readback.png')), Buffer.from(rb.split(',')[1], 'base64'));
    console.log(`  ${name.padEnd(26)} ${r.triangles} tris, ${r.objects} objects,`
      + ` activeIsOurs=${r.activeIsOurs} at ${r.activePos?.map(v => v.toFixed(1))} fwd ${r.activeFwd?.map(v => v.toFixed(2))}`);
  }
  const hero = await js('window.__heroCamera');
  await js(`window.__setCamera(${JSON.stringify(hero.pos)}, ${JSON.stringify(hero.rot)}, 60)`);
  for (const channel of ['albedo', 'depth', 'normal'])
    if (await js(`window.__debugView(${JSON.stringify(channel)})`)) await shoot(`landscape.${channel}.png`);
  await js(`window.__debugView("final", 40)`);
  const { img: capture, png: cover } = await shoot('landscape.png');
  check('the cover image is not blank', !capture.isEmpty() && cover.length > 20000, cover.length + ' bytes');

  // --- Light probe --------------------------------------------------------------------------------
  //
  // `probeBaked` above only says a capture RAN. This says what came back. A probe that bakes black
  // contributes nothing to the lighting and shows an empty square in the editor's inspector, and the
  // only cheap way to tell that apart from a working bake is to look at the pixels: mean brightness
  // AND spread, because a uniformly grey capture (sky missing, clear colour only) has a fine mean.
  const stats = (png) => {
    const bm = nativeImage.createFromBuffer(png).getBitmap(); // BGRA
    let sum = 0, sum2 = 0, n = 0;
    for (let i = 0; i < bm.length; i += 4) {
      const l = (bm[i + 2] * 299 + bm[i + 1] * 587 + bm[i] * 114) / 1000;
      sum += l; sum2 += l * l; n++;
    }
    const mean = sum / n;
    return { mean: +mean.toFixed(1), stdev: +Math.sqrt(Math.max(0, sum2 / n - mean * mean)).toFixed(1) };
  };
  const probeShot = await js('window.__probeShot(512)');
  let probeStats = null;
  if (probeShot?.uri) {
    const png = Buffer.from(probeShot.uri.split(',')[1], 'base64');
    fs.writeFileSync(path.join(SHOT, 'landscape.probe.png'), png);
    probeStats = stats(png);
  }
  console.log('  probe ' + JSON.stringify({ ...probeShot, uri: undefined }) + ' ' + JSON.stringify(probeStats));
  check('the light probe captured an image', !!probeShot?.uri,
    probeShot?.found ? `baked=${probeShot.baked} hasMaps=${probeShot.hasMaps}` : 'no probe in the scene');
  // 8/255 is well under any real sky and well over the black a failed capture returns.
  check('the light probe capture is not black', (probeStats?.mean ?? 0) > 8, JSON.stringify(probeStats));
  // A sky-to-ground cube spans a wide range; a flat fill (clear colour, or one face smeared over all
  // six) does not. This is the half that catches "it captured SOMETHING but not the scene".
  check('the light probe capture has real contrast', (probeStats?.stdev ?? 0) > 6, JSON.stringify(probeStats));

  // --- Round trip ---------------------------------------------------------------------------------
  //
  // Asked for AFTER the screenshots, because verifying costs a second complete copy of the terrain and
  // the page drops the original to make room for it. Nothing below needs the live scene.
  console.log('  verifying the round trip…');
  const reparse = await js('window.__verify()');
  check('the scene round-trips through the parser', reparse.ok, reparse.error);
  check('the reparsed scene renders', reparse.triangles > 0, JSON.stringify(reparse));
  check('the reparsed terrain kept its layers', reparse.layers === 4, reparse.layers);
  check('the reparsed terrain kept its foliage', reparse.foliage === report.scattered,
    `${reparse.foliage} of ${report.scattered}`);
  // The probe as the EDITOR gets it: baked from the deserialized scene, not the one built in memory.
  const rProbe = await js('window.__reparsedProbeShot(512)');
  let rProbeStats = null;
  if (rProbe?.uri) {
    const png = Buffer.from(rProbe.uri.split(',')[1], 'base64');
    fs.writeFileSync(path.join(SHOT, 'landscape.probe.reparsed.png'), png);
    rProbeStats = stats(png);
  }
  console.log('  reparsed probe ' + JSON.stringify({ ...rProbe, uri: undefined }) + ' ' + JSON.stringify(rProbeStats));
  check("the reparsed scene's light probe is not black", (rProbeStats?.mean ?? 0) > 8,
    JSON.stringify({ probe: reparse.probe, stats: rProbeStats }));

  // --- Pull the pieces out ------------------------------------------------------------------------
  //
  // Chunked: libraries/models.json is tens of megabytes of decimal geometry, and moving a string that
  // size across executeJavaScript in one piece is the kind of thing that works until it doesn't.
  // Nothing left to render: the page hands the GPU back before the transfer starts.
  await js('window.__quiesce()');

  // 16 MB a hop rather than 4. The scene piece alone is ~430 MB, and at 4 MB that is 108 round trips
  // through executeJavaScript for one entry.
  const CHUNK = 16 * 1024 * 1024;
  const pieces = await js('window.__pieces()');
  const got = new Map();
  for (const p of pieces) {
    const parts = [];
    for (let off = 0; off < p.size; off += CHUNK)
      parts.push(await js(`window.__pieceChunk(${JSON.stringify(p.key)}, ${off}, ${CHUNK})`));
    const joined = parts.join('');
    got.set(p.key, p.base64 ? Buffer.from(joined, 'base64') : JSON.parse(joined));
  }

  // --- Pack ---------------------------------------------------------------------------------------
  const { packBundleAssets } = editorModuleCached('bundleAssets');
  const sceneKey = pieces.find(p => p.key.startsWith('scene:')).key;
  const sceneId = sceneKey.slice('scene:'.length);
  const bundle = {
    manifest: got.get('manifest'),
    scenes: { [sceneId]: got.get(sceneKey) },
    libraries: Object.fromEntries(pieces
      .filter(p => p.key.startsWith('lib:'))
      .map(p => [p.key.slice(4), got.get(p.key)])),
    vfs: got.get('vfs'),
    textures: got.get('textureIndex').map(row => ({
      id: row.id, mime: row.mime, config: row.config,
      // The packer wants an ArrayBuffer; a Buffer is a VIEW into a shared pool, so `.buffer` alone
      // would hand it the whole pool and index into the wrong bytes.
      bytes: got.get('tex:' + row.id).buffer.slice(
        got.get('tex:' + row.id).byteOffset,
        got.get('tex:' + row.id).byteOffset + got.get('tex:' + row.id).byteLength),
    })),
  };
  // Filled in here rather than in the page, which cannot capture its own window. `add-example.mjs`
  // reads exactly this to write the gallery's thumbnail.png.
  bundle.manifest.sceneMetas[0].thumbnail = 'data:image/png;base64,' + cover.toString('base64');

  const jsonBefore = JSON.stringify(bundle.scenes).length + JSON.stringify(bundle.libraries).length;
  const { blob, index } = await packBundleAssets(bundle);
  const jsonAfter = JSON.stringify(bundle.scenes).length + JSON.stringify(bundle.libraries).length;
  console.log(`\ninterned ${(jsonBefore / 1e6).toFixed(1)} MB of JSON payloads`
    + ` -> ${(jsonAfter / 1e6).toFixed(1)} MB JSON + ${(blob.byteLength / 1e6).toFixed(1)} MB assets.bin`);

  const zip = new JSZip();
  const put = (p, data) => { zip.file(p, data); return data.length ?? data.byteLength; };
  const j = (p, v) => console.log(`  ${p.padEnd(34)} ${(put(p, JSON.stringify(v)) / 1e6).toFixed(2)} MB`);
  j('manifest.json', bundle.manifest);
  j('vfs.json', bundle.vfs);
  for (const [name, lib] of Object.entries(bundle.libraries)) j(`libraries/${name}.json`, lib);
  j(`scenes/${sceneId}.json`, bundle.scenes[sceneId]);
  j('assets.json', index);
  // Not DEFLATE'd: the blob is already-compressed image bytes and float data, where deflating hundreds
  // of megabytes buys a few percent for a lot of wall clock.
  zip.file('assets.bin', Buffer.from(blob), { compression: 'STORE' });
  console.log(`  ${'assets.bin'.padEnd(34)} ${(blob.byteLength / 1e6).toFixed(2)} MB`);

  const buf = await zip.generateAsync({
    type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 },
  });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, buf);

  console.log(`\nbundle  ${OUT}   ${(buf.length / 1e6).toFixed(1)} MB`);
  console.log(`shot    ${path.join(SHOT, 'landscape.png')}`);
  console.log(problems.length ? `\n${problems.length} FAILED: ${problems.join(', ')}` : '\nall checks passed');
  app.exit(problems.length ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
