// WebGL2 against WebGPU, config by config, on one machine in one run.
//
// Every other harness measures ONE backend. `webgpuBootCheck.js` gets closest — it renders the same
// scene on both and compares the compressed size of the result — but a single scalar can only say
// "about two percent off", and two percent has no owner. This one renders the same list of renderer
// configurations through both backends and diffs the 8x8 mean/stddev signatures per configuration, so
// a difference arrives named: `debugMetallic` disagrees, `debugNormal` does not.
//
// It compares the two backends AGAINST EACH OTHER, not against a stored picture. Recording a WebGPU
// baseline now would freeze today's bugs as correct — the exact failure that once let `basicSkinned`
// render as a torn fan for weeks with a green gate, because the baseline had captured the corruption.
// WebGL2 is the reference because it is the one that ships.
//
//   verify:  npm run harness:backenddiff          (compares against backendDiff.json)
//   record:  CLEO_BACKEND_DIFF=write ...          (writes it — see the ratchet rules below)
//   scene:   CLEO_SCENE=full|every|every2d, CLEO_PIPELINE=forward   as with the other drivers
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const { compare, captureSignature } = require('./signature');
const { CONFIGS, EXTRA_CHANNELS, captureConfigs } = require('./passConfigs');

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
  // The translator the page installs. Staged like the bundle so a stale copy is impossible,
  // and so the custom-material path this scene contains is actually reachable on WebGPU.
  ['src/graphics/rhi/webgpu/naga/nagaGlsl.js', 'naga/nagaGlsl.js'],
  ['src/graphics/rhi/webgpu/naga/nagaGlsl_bg.wasm', 'naga/nagaGlsl_bg.wasm'],
]);

/**
 * The scene the page is asked to build. `base` is the default; the rest are opt-in and each carries
 * its OWN baselines, because a baseline that moves for two reasons at once can attribute neither.
 *
 *   full     terrain, foliage and volumetric clouds
 *   every    full, plus the material and geometry gap — authored maps, a two-map channel pack,
 *            transparent / wireframe / double-sided, submeshes, model LOD, instanced LOD
 *   every2d  the orthographic profile: tilemap layers, sprites and unlit quads under an ortho camera
 */
const SCENES = ['full', 'every', 'every2d'];
const sceneOf = () => SCENES.includes(process.env.CLEO_SCENE) ? process.env.CLEO_SCENE : 'base';
const scene = sceneOf();
const pipeline = process.env.CLEO_PIPELINE === 'forward' ? 'forward' : 'deferred';
const profile = `${pipeline}.${scene}`;
const baselinePath = path.join(__dirname, 'backendDiff.json');
const writing = process.env.CLEO_BACKEND_DIFF === 'write';

const profileDir = path.join(os.tmpdir(), 'cleo-backenddiff-profile');
fs.mkdirSync(profileDir, { recursive: true });
app.setPath('userData', profileDir);
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const results = [];
const check = (name, ok, detail) => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '   -> ' + String(detail ?? '')}`);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const ALL = CONFIGS.concat(EXTRA_CHANNELS);

/** Kept alive until `finish()`; see `runBackend`. */
const openWindows = [];

/**
 * `?seed=1` on both windows, so the two renderers build the SAME SSAO kernel.
 *
 * Without it the kernel and its rotation-noise texture come from an unseeded `Math.random` at renderer
 * construction, and the two windows differ for a reason that is not about either backend. With it,
 * `ssao` and `debugSSAO` become ordinary comparable configurations. Motion-dependent ones stay
 * excluded — those are phase-dependent, which no seed fixes.
 */
const MOTION_DEPENDENT = new Set(ALL.filter(c => c.motion).map(c => c.name));

function queryFor(backend) {
  const params = new URLSearchParams();
  if (pipeline === 'forward') params.set('forward', '1');
  if (scene !== 'base') params.set('scene', scene);
  params.set('seed', '1');
  params.set('backend', backend);
  // Harmless when WEBGPU_IMPLEMENTED is true and required when it is not: acquisition is gated
  // separately from "the renderer draws through it", and this driver wants the device either way.
  if (backend === 'webgpu') params.set('cleoWebgpuProbe', '1');
  return '?' + params.toString();
}

async function runBackend(backend) {
  const win = new BrowserWindow({
    width: 1000, height: 700, show: false, backgroundColor: '#202028',
    webPreferences: { contextIsolation: true },
  });
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level === 3) errors.push(message); });
  win.webContents.on('render-process-gone', (_e, d) => {
    console.log(`!! ${backend} renderer gone ` + JSON.stringify(d)); app.exit(2);
  });

  await win.loadURL('app://mesh/index.html' + queryFor(backend));
  const js = (src) => win.webContents.executeJavaScript(src);

  let ready = false;
  for (let i = 0; i < 240; i++) {
    const r = await js('window.__ready === true ? "ok" : (window.__error || null)').catch(() => null);
    if (r === 'ok') { ready = true; break; }
    if (r) { check(`${backend}: scene built`, false, String(r).slice(0, 500)); return null; }
    await sleep(250);
  }
  if (!ready) { check(`${backend}: scene built`, false, 'timed out'); return null; }

  // The check that stops this whole driver from quietly comparing WebGL2 with itself. A backend
  // REQUEST can be refused — `resolveBackendRequest` has the last word — and every signature below
  // would then match perfectly for the worst possible reason.
  const got = await js('window.__renderer && window.__renderer.backend').catch(() => null);
  check(`${backend}: the request was honoured`, got === backend, `acquired ${got}`);
  if (got !== backend) return null;

  const capture = () => captureSignature(win, sleep);
  // `CLEO_DIFF_SHOT=<config>[,<config>...]` writes the SAME configurations from both backends, side
  // by side on disk.
  // The ranked table says which configuration disagrees; it cannot say how, and a delta cannot be
  // looked at. Two PNGs named for their backend can.
  const onShot = async (name) => {
    if (!(process.env.CLEO_DIFF_SHOT || '').split(',').includes(name)) return;
    const img = await win.webContents.capturePage();
    const out = path.join(__dirname, 'shots', `diff-${name}-${backend}.png`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, img.toPNG());
    console.log('      shot: ' + out);
  };
  const captured = await captureConfigs(ALL, { js, capture, sleep, onShot });
  for (const m of captured.missing)
    check(`${backend}/${m.name}: every setting exists on the renderer`, false, 'ignored: ' + m.ignored.join(', '));

  // NOT destroyed here. Tearing the first window down before the second one loads made the second
  // `loadURL` fail outright with ERR_FAILED against the same `app://` URL that had just worked. Both
  // are hidden and the second is only driven after the first has finished capturing, so keeping them
  // alive costs nothing and removes a teardown race from a driver whose whole job is comparison.
  openWindows.push(win);
  return { ...captured, errors };
}

app.whenReady().then(async () => {
  protocol.handle('app', (request) => {
    let pathname = decodeURIComponent(new URL(request.url).pathname);
    if (!pathname || pathname === '/') pathname = '/index.html';
    const filePath = path.resolve(path.join(root, pathname));
    if (!filePath.startsWith(root)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(filePath).toString());
  });

  console.log(`\n  profile: ${profile}\n`);

  // Sequential, not concurrent. Two Electron windows both driving a GPU would contend for it, and the
  // signature is a picture: a frame captured while the other backend is mid-bake is not the frame.
  const reference = await runBackend('webgl2');
  if (!reference) { finish(); return; }
  const subject = await runBackend('webgpu');
  if (!subject) { finish(); return; }

  // Loaded in BOTH modes. Reading it only when verifying meant recording one profile silently
  // discarded every other profile in the file, because the writer had nothing to merge into.
  const baseline = fs.existsSync(baselinePath)
    ? JSON.parse(fs.readFileSync(baselinePath, 'utf-8')) : null;
  const expected = (baseline && baseline.profiles && baseline.profiles[profile]) || null;
  if (!writing && !expected)
    console.log(`  (no recorded expectation for ${profile} — reporting only)`);

  const deltas = {};
  for (const cfg of ALL) {
    const a = reference.signatures[cfg.name];
    const b = subject.signatures[cfg.name];
    if (!a || !b) continue;
    deltas[cfg.name] = compare(a, b);
  }

  // Ranked, worst first. The whole point of this driver is that the next thing to fix has a NAME, and
  // a list sorted by how wrong each channel is says which name.
  const ranked = Object.entries(deltas).sort((x, y) => y[1].material - x[1].material);
  console.log('  webgl2 vs webgpu, worst first:');
  for (const [name, d] of ranked) {
    const tag = MOTION_DEPENDENT.has(name) ? '  (motion — not gated)' : '';
    console.log(`      ${String(name).padEnd(18)} ${String(d.material).padStart(3)}/128 differ   ` +
                `worst ${String(d.worst).padStart(3)}${tag}`);
  }
  console.log('');

  // Frame stats beside the signature, for every configuration where the two disagree on WORK rather
  // than on shading. A signature says the pictures differ; this says whether the same passes even ran.
  const statLine = (r, n) => {
    const s = r.stats[n] || {};
    return `${s.drawCalls ?? '?'}d/${s.fullscreenPasses ?? '?'}f`;
  };
  const workDiffers = ALL.filter(c => {
    const a = reference.stats[c.name] || {}, b = subject.stats[c.name] || {};
    return a.drawCalls !== b.drawCalls || a.fullscreenPasses !== b.fullscreenPasses;
  });
  if (workDiffers.length) {
    console.log('  configurations where the two backends submit DIFFERENT work (draws/fullscreen passes):');
    for (const c of workDiffers)
      console.log(`      ${String(c.name).padEnd(18)} webgl2 ${statLine(reference, c.name).padEnd(10)}` +
                  `webgpu ${statLine(subject, c.name)}`);
    console.log('');
  }

  // A CHECK, not a footnote — and it is a check because it was a footnote when it mattered most.
  //
  // The game loop logs a frame error without rescheduling, so one bad frame ends the session and every
  // configuration after it re-reads the same stale image. That shows up here as the subject submitting
  // 1 draw where the reference submits 151, and until now it printed as an informational block under
  // an "ALL PASS" line. A whole profile whose WebGPU session died on the first frame therefore passed.
  //
  // Both backends walk the same scene with the same seed, so equal work is not a tolerance question:
  // there is no legitimate reason for the draw or fullscreen-pass counts to differ. If one ever earns
  // a difference, it belongs in this condition with the reason, not in a number nobody reads.
  check('both backends submit the same work on every configuration', workDiffers.length === 0,
        workDiffers.map(c => `${c.name} ${statLine(reference, c.name)} vs ${statLine(subject, c.name)}`)
          .slice(0, 4).join(' | ') + (workDiffers.length > 4 ? ` | +${workDiffers.length - 4} more` : ''));

  const matching = ranked.filter(([n, d]) => !MOTION_DEPENDENT.has(n) && d.material === 0).length;
  const gated = ranked.filter(([n]) => !MOTION_DEPENDENT.has(n)).length;
  console.log(`  ${matching}/${gated} gated configurations are pixel-identical across backends\n`);

  if (writing) {
    const out = (baseline && baseline.profiles) ? baseline : { why: WHY, profiles: {} };
    out.why = WHY;
    out.profiles[profile] = Object.fromEntries(
      ranked.filter(([n]) => !MOTION_DEPENDENT.has(n)).map(([n, d]) => [n, d.material]));
    fs.writeFileSync(baselinePath, JSON.stringify(out, null, 2) + '\n');
    console.log('  recorded ' + profile + ' to ' + baselinePath);
  } else if (expected) {
    // A RATCHET, not a baseline: a configuration may match better than recorded, never worse. That
    // asymmetry is what makes the file safe to commit while the port is still landing — it records how
    // far apart the backends are today and refuses to let them drift further, without ever asserting
    // that today's difference is correct.
    for (const [name, d] of ranked) {
      if (MOTION_DEPENDENT.has(name)) continue;
      const was = expected[name];
      if (was === undefined) { check(`${name} has a recorded expectation`, false, 'not in ' + profile); continue; }
      check(`${name} is no further apart than recorded`, d.material <= was,
            `${d.material}/128 differ, recorded ${was} (worst delta ${d.worst})`);
      if (d.material < was)
        console.log(`      ${name} IMPROVED: ${was} -> ${d.material}. Lower it in the commit that earned it.`);
    }
  }

  // Console errors on either side. A validation failure that invalidates a command buffer can leave a
  // signature that looks plausible, so the message stream is its own check rather than a footnote.
  const notable = (list) => list.filter(m => /bind group|pipeline|render pass|Invalid|uncaptured|usage/i.test(m));
  for (const [name, run] of [['webgl2', reference], ['webgpu', subject]]) {
    const bad = notable(run.errors);
    check(`${name} raises no validation errors`, bad.length === 0, bad.slice(0, 3).join(' | '));
  }

  finish();
});

const WHY =
  'The ratchet for tools/harness/backendDiff.js. Per configuration, how many of the 128 signature ' +
  'values differ beyond the noise floor between WebGL2 and WebGPU rendering the SAME scene. 0 means ' +
  'the two backends are pixel-identical for that configuration. A number may only go DOWN: this file ' +
  'records how far apart they are today, and refuses to let them drift further, without ever claiming ' +
  'the current difference is correct. Lower an entry in the commit that earns it; raising one needs a ' +
  'reason written next to it. Motion-dependent configurations are excluded — they are phase-dependent ' +
  'and no seed fixes that. ' +
  'RAISED 2026-08-27, one reason: WebGPU had no usable mip chain on any cube it rendered itself. ' +
  '`generateMipmaps` submitted a private encoder while the passes that drew level 0 were still ' +
  'unsubmitted in the frame encoder, so every level above the first was built from a level nothing ' +
  'had written. Both cubes were affected — the probe capture and the sky atmosphere bake. The probe ' +
  'inspector preview measured mean luminance 0.0 against WebGL2 s 110.6, and `prefilter.wgsl`, which ' +
  'samples the source cube at a roughness-derived mip, returned black for every roughness above 0. ' +
  'The chain is real now and agrees with WebGL2 to 0.2 in mean luminance, differing in ~7% of pixels ' +
  'concentrated at cube-face borders. These entries record THAT residual. They went up because a term ' +
  'that was missing came back, not because the backends drifted: a zero here previously meant both ' +
  'backends agreed on nothing, which is exactly the false green the paragraph above warns about.';

function finish() {
  for (const w of openWindows) { try { w.destroy(); } catch { /* already gone */ } }
  const failed = results.filter(x => !x).length;
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  app.exit(failed ? 1 : 0);
}
