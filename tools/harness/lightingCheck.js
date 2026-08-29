// The lighting gate: does a change to a LIGHT actually change the pixels it should?
//
// Every other visual harness reduces the whole frame to an 8x8 grid, and that is exactly why this one
// exists. A specular highlight is large per PIXEL and tiny in AREA, so a full-frame cell — ~125x87 =
// 10,875 pixels at the standard window — averages it away completely. That was measured, not assumed:
// toggling a 5 cm `sourceRadius` between 0.05 and 0 moves ZERO of the 128 signature values even against
// a mirror-finish sphere; 0.5 m moves zero; a 1 m bulb moves two. Four phases of lighting work
// (photometric units, an energy-conserving BRDF, area lights, specular occlusion) landed with the
// existing gates all green and nothing to catch a regression in any of them.
//
// The fix is not a finer grid over the whole frame — that would make every unrelated pass noisy. It is
// to CROP to the object under test first. `captureSignature(win, sleep, rect)` does that, and the same
// 8x8/quantise/compare machinery then runs at roughly 700x the sensitivity over a 120x120 box.
//
// Each case is a DIFFERENTIAL taken inside one run: set a light one way, capture, set it the other way,
// capture, and assert the two differ beyond the noise floor. That is deliberately not a recorded
// baseline. A differential cannot drift with an unrelated content change, needs no re-record when the
// scene is edited, and — the reason that matters here — stays valid for configurations whose absolute
// pixels are not reproducible across runs at all.
//
//   verify: (default)
//   shot:   CLEO_LIGHTING_SHOT=<case>   -> shots/lighting-<case>-{a,b}.png
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const { compare, captureSignature, NOISE } = require('./signature');

const root = path.resolve(process.env.CLEO_MESH_DIR || path.join(__dirname, 'pages', 'mesh'));

// Stage the engine bundle next to the page, so a forgotten rebuild shows up as an old bundle rather
// than as a mystery pass. Same contract as every other driver here.
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

// Its own profile directory name: two harnesses running at once collide on a Chromium profile lock.
const profileDir = path.join(os.tmpdir(), 'cleo-lighting-profile');
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Half-width of the crop box, as a fraction of the frame. 0.09 is ~120 px at the 1000x700 window. */
const CROP = 0.09;

/**
 * The cases. Each names the object to crop around, and two light states to compare.
 *
 * `subject` is a NODE NAME, not a pixel rect — the page projects its world position, so the box follows
 * the object if the camera or the window ever changes.
 */
const CASES = [
  {
    name: 'sphereLightRadius',
    why: 'a sphere light spreads its highlight; a point light concentrates it',
    subject: 'sphere',
    a: { light: 'lamp', patch: { sourceRadius: 0.5 } },
    b: { light: 'lamp', patch: { sourceRadius: 0.0 } },
  },
  {
    name: 'sunAngularRadius',
    why: 'the sun disc widens its reflection on a smooth surface',
    subject: 'sphere',
    a: { light: 'sun', patch: { angularRadius: 0.3 } },
    b: { light: 'sun', patch: { angularRadius: 0.0 } },
  },
  {
    name: 'sunContribution',
    why: 'the control for the case above: how much of this subject the sun is responsible for at all',
    subject: 'sphere',
    a: { light: 'sun', patch: { angularRadius: 0.0 } },
    b: { light: 'sun', patch: { intensity: 0.0 } },
  },
  {
    name: 'sphereLightIntensity',
    why: 'the control: a light the gate can see at all',
    subject: 'sphere',
    a: { light: 'lamp', patch: { sourceRadius: 0.5 } },
    b: { light: 'lamp', patch: { intensity: 0.0 } },
  },
  {
    // Specular occlusion, and it needs three things arranged at once. AO below 1, which only SSAO
    // supplies in this scene. A SMOOTH surface, because `computeSpecularAO` only diverges from plain
    // AO at low roughness — the exponent is `exp2(-16 * roughness - 1)`, which at the fixture's
    // smoothest 0.25 is 0.03 and leaves the correction under a percent. And a way to turn the feature
    // off, which is what `specularOcclusionEnabled` is for: unlike a light radius there is nothing on
    // the scene to patch, so the flag is the only handle a differential can take.
    name: 'specularOcclusion',
    why: 'a narrow specular cone is not occluded like a hemisphere',
    // The CUBE, not the sphere, and the floor with it. SSAO measures how much of the hemisphere is
    // blocked, so it barely touches a convex sphere floating in space — measured at 1/128 cells there.
    // What it does darken is where two surfaces meet, so the subject has to be something sitting ON
    // the floor with its contact region inside the crop.
    subject: 'floor',
    setup: 'JSON.stringify([window.__setRender({ ssaoEnabled: true, ssaoRadius: 2.0, ssaoPower: 8.0 }),'
         + ' window.__setMaterial("cube", { roughness: 0.05, metallic: 1.0 }),'
         + ' window.__setMaterial("floor", { roughness: 0.05, metallic: 1.0 })])',
    a: { js: 'JSON.stringify(window.__setRender({ specularOcclusionEnabled: true }))' },
    b: { js: 'JSON.stringify(window.__setRender({ specularOcclusionEnabled: false }))' },
    teardown: 'JSON.stringify([window.__setRender({ ssaoEnabled: false, specularOcclusionEnabled: true }),'
            + ' window.__setMaterial("cube", { roughness: 0.45, metallic: 0.1 }),'
            + ' window.__setMaterial("floor", { roughness: 0.9, metallic: 0.0 })])',
  },
  {
    // Geometric specular antialiasing. Like specular occlusion above, there is nothing on the scene to
    // patch — the widening comes from the surface's own screen-space normal derivative — so the
    // renderer flag is the only handle a differential has.
    //
    // A MIRROR SPHERE is the subject for a reason that is arithmetic, not aesthetics. The filter adds a
    // variance kernel to alpha^2 and takes the fourth root, so what it does depends entirely on how big
    // alpha^2 already is. At the fixture's default 0.25 roughness alpha^2 is 3.9e-3 and a smooth
    // sphere's kernel is ~4e-4 — a 1% change nothing can see. At 0.045, the roughness floor, alpha^2 is
    // 4.1e-6, the same kernel dominates it by two orders of magnitude, and roughness comes out near
    // 0.14. Same code, same scene, 3x the roughness: the feature is invisible on rough surfaces BY
    // DESIGN and only a mirror can gate it.
    //
    // No normal map is needed and none is available — `__setMaterial` patches scalar properties only.
    // A sphere supplies its own variance: the normal turns through 180 degrees across the projected
    // disc, fastest at the silhouette, which is where the threshold constant earns its place.
    name: 'specularAA',
    why: 'sub-pixel normal variance widens the specular lobe instead of aliasing it',
    subject: 'sphere',
    setup: 'JSON.stringify(window.__setMaterial("sphere", { roughness: 0.045, metallic: 1.0 }))',
    a: { js: 'JSON.stringify(window.__setRender({ specularAaEnabled: true }))' },
    b: { js: 'JSON.stringify(window.__setRender({ specularAaEnabled: false }))' },
    teardown: 'JSON.stringify([window.__setRender({ specularAaEnabled: true }),'
            + ' window.__setMaterial("sphere", { roughness: 0.25, metallic: 0.8 })])',
  },
  {
    // The freed G-buffer channel, end to end. This is the case that would have caught terrain AO
    // shipping inert: reflectance is authored on a material, packed into `gNormalRoughness.b` by the
    // geometry pass, and read back by the deferred lighting pass — three hops, each of which renders
    // identically to the old fixed 0.04 if it quietly does nothing, because 0.5 IS 0.04.
    //
    // A DIELECTRIC subject, necessarily: reflectance is mixed out entirely at metallic 1, where F0 is
    // the base colour. Smooth, so the specular lobe it scales is concentrated enough to see.
    name: 'reflectance',
    why: 'a dielectric specular level that is authored rather than hardcoded to 0.04',
    subject: 'sphere',
    // Specular AA is turned OFF for this one, and it is not a workaround — it is the only way to
    // measure reflectance rather than measure the two features fighting. Phase 5 widens a mirror at
    // the roughness floor to ~0.14, which spreads the very lobe reflectance scales and cost this case
    // most of its signal: at 0.1 roughness with the filter on it moved 5 cells, one above the floor.
    setup: 'JSON.stringify([window.__setRender({ specularAaEnabled: false }),'
    // A BLACK base colour, so what is left on the sphere is the specular lobe and nothing else. A
    // dielectric reflecting 16% instead of 4% is a real change and a subtle one against a lit diffuse
    // albedo; removing the diffuse is what turns it into a measurement rather than a hint.
         + ' window.__setMaterial("sphere", { baseColor: [0, 0, 0], metallic: 0.0, roughness: 0.045 })])',
    a: { js: 'JSON.stringify(window.__setMaterial("sphere", { reflectance: 1.0 }))' },
    b: { js: 'JSON.stringify(window.__setMaterial("sphere", { reflectance: 0.0 }))' },
    teardown: 'JSON.stringify([window.__setRender({ specularAaEnabled: true }),'
            + ' window.__setMaterial("sphere", { baseColor: [0.3, 0.55, 0.9], reflectance: 0.5,'
            + ' metallic: 0.8, roughness: 0.25 })])',
  },
  {
    // Horizon occlusion compares the reflection ray against the GEOMETRIC normal, so a surface with no
    // normal map cannot gate it: the shading and geometric normals are then the same vector, and
    // `reflect` can never send a ray below the normal it reflected about. The term is identically 1 and
    // the differential measures two identical frames.
    //
    // The base scene has no normal-mapped material and no normal map texture at all — both live inside
    // the `every` block — so `__setNormalMap` builds one on demand, exactly as `__setEnvMap` builds its
    // cube. Authoring one into the scene instead would move every base baseline in the repo to gate one
    // feature.
    //
    // The CUBE, not a sphere. A cube face is flat, so the depth-reconstructed geometric normal the
    // deferred path uses IS the exact face normal, and the case measures the normal map alone. A sphere
    // would also carry the difference between its interpolated normal and its faceted one, which fires
    // this same term — leaving the case unable to say which of the two it had seen.
    //
    // The env map has to be on, because there has to be a reflection to occlude at all, and the probe
    // shrunk to nothing so the fallback is what supplies it. Roughness down: the sharper the lobe, the
    // more of it the horizon takes.
    name: 'horizonOcclusion',
    why: 'a normal map must not reflect sky along a ray that points into the surface',
    subject: 'cube',
    setup: 'JSON.stringify([window.__setEnvMap(true),'
         + ' window.__setProbe({ size: [0.1, 0.1, 0.1] }),'
         + ' window.__setNormalMap("cube", true),'
         + ' window.__setMaterial("cube", { roughness: 0.1, metallic: 0.0 })])',
    a: { js: 'JSON.stringify(window.__setRender({ horizonOcclusionEnabled: true }))' },
    b: { js: 'JSON.stringify(window.__setRender({ horizonOcclusionEnabled: false }))' },
    teardown: 'JSON.stringify([window.__setEnvMap(false),'
            + ' window.__setProbe({ size: [0, 0, 0] }),'
            + ' window.__setNormalMap("cube", false),'
            + ' window.__setRender({ horizonOcclusionEnabled: true }),'
            + ' window.__setMaterial("cube", { roughness: 0.45, metallic: 0.1 })])',
  },
  {
    // Bloom on an EDITOR-AUTHORABLE emissive material, which is the thing that did not work.
    //
    // Bloom itself was never broken — `passBaseline.json` shows the `bloom` config at threshold 0.4
    // moving 148 of 256 signature characters. What could not happen was reaching the threshold from
    // the material side. `emissiveFactor` is a COLOUR authored through a hex picker, so it caps at 1
    // per channel, and bloom thresholds in display-referred terms: at the default exposure a mid-tone
    // emissive arrives at exposed luma 1.0, which is exactly the default threshold, and contributes
    // nothing. Pure white only doubles it. The only fixture in this repo that blooms does it with
    // `emissiveFactor: [2.4, 1.6, 0.4]` — numbers no picker can produce.
    //
    // So the differential toggles BLOOM ITSELF over a hot-but-authorable emissive, with the threshold
    // left at its DEFAULT. Toggling `emissiveIntensity` instead would have been the easier case to
    // write and would have proved the wrong thing — the multiplier also changes how bright the surface
    // is, so it moves the crop whether or not a single photon ever reaches the bright pass. And
    // lowering the threshold would prove less than nothing: that is the setting which makes the whole
    // frame bloom rather than the emissive object.
    name: 'emissiveBloom',
    why: 'an emissive colour a hex picker can produce has to be able to bloom',
    subject: 'cube',
    setup: 'JSON.stringify(window.__setMaterial("cube", { emissiveFactor: [1.0, 0.53, 0.0], baseColor: [0, 0, 0], emissiveIntensity: 8.0 }))',
    a: { js: 'JSON.stringify(window.__setRender({ bloomIntensity: 2.0 }))' },
    b: { js: 'JSON.stringify(window.__setRender({ bloomIntensity: 0.0 }))' },
    teardown: 'JSON.stringify([window.__setRender({ bloomIntensity: 0 }), window.__setMaterial("cube", { emissiveFactor: [0, 0, 0], emissiveIntensity: 1.0, baseColor: [0.85, 0.35, 0.25] })])',
  },
  {
    // The one branch in the deferred lighting pass that no harness scene has ever reached. It needs
    // `scene.environmentMap` set AND a bounded probe: the fallback is scaled by
    // `rest = (1 - w0) * (1 - w1)`, and an unbounded probe makes that zero. Shrinking the probe's volume
    // to nothing is the cheapest way to get `rest = 1` over the whole frame.
    name: 'deferredEnvFallback',
    why: 'the deferred env-map fallback contributes where no probe covers',
    subject: 'sphere',
    setup: 'window.__setProbe({ size: [0.1, 0.1, 0.1] })',
    a: { js: 'window.__setEnvMap(true)' },
    b: { js: 'window.__setEnvMap(false)' },
    teardown: 'window.__setProbe({ size: [0, 0, 0] })',
  },
];

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
    webPreferences: { contextIsolation: true, backgroundThrottling: false },
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    console.log('!! renderer gone ' + JSON.stringify(d));
    app.exit(2);
  });
  await win.loadURL('app://mesh/index.html');
  const js = (src) => win.webContents.executeJavaScript(src);

  let ready = false;
  for (let i = 0; i < 200; i++) {
    const r = await js('window.__ready === true ? "ok" : (window.__error || null)').catch(() => null);
    if (r === 'ok') { ready = true; break; }
    if (r) { check('page initialised', false, String(r).slice(0, 600)); app.exit(1); return; }
    await sleep(250);
  }
  if (!ready) { check('page initialised', false, 'timed out'); app.exit(1); return; }

  // BLOOM OFF for every case that is not about bloom, and this is load-bearing rather than tidy.
  // Bloom lays a wide glow over the whole frame, so a crop measuring a sun disc's width or a specular
  // cone's occlusion measures it through a veil that has nothing to do with either. It was invisible
  // until bloom started working: with the compose buffer mipmapped, the bright pass had been reading
  // an unwritten mip level and contributing nothing, so every case here was quietly measured with
  // bloom effectively off. Fixing that took `sunAngularRadius` from 16 differing cells to 0 and
  // `specularOcclusion` from 20 to 0 — the features had not changed, the measurement had.
  await js('window.__setRender({ bloomIntensity: 0 })');

  const size = win.webContents.getOwnerBrowserWindow().getContentSize();
  const [W, H] = size;

  /** The crop box around a named node, in pixels, clamped to the frame. */
  async function rectFor(subject) {
    const p = await js(`JSON.stringify(window.__projectToScreen(${JSON.stringify(subject)}))`)
      .then((s) => JSON.parse(s));
    if (!p || p.behind) return null;
    const half = Math.round(CROP * Math.min(W, H));
    const cx = Math.round(p.x * W), cy = Math.round(p.y * H);
    const x = Math.max(0, Math.min(W - 2 * half, cx - half));
    const y = Math.max(0, Math.min(H - 2 * half, cy - half));
    return { x, y, width: 2 * half, height: 2 * half };
  }

  /**
   * A state is either a light patch or a raw page expression. The second form exists for the cases
   * that are not about a light at all — the env-map fallback needs the probe volume and the scene's
   * environment map moved together, and neither is a renderer property a pass config could reach.
   */
  async function applyState(state) {
    if (state.js) {
      const applied = await js(state.js);
      return { ok: applied !== null && applied !== undefined, applied: String(applied) };
    }
    const applied = await js(
      `window.__setLight(${JSON.stringify(state.light)}, ${JSON.stringify(state.patch)})`);
    const wanted = Object.keys(state.patch);
    // A renamed light property has to fail here rather than leave the case silently measuring nothing.
    const got = String(applied).split(',').filter(Boolean);
    return { ok: wanted.every((k) => got.includes(k)), applied: String(applied) };
  }

  const shot = process.env.CLEO_LIGHTING_SHOT;
  const shotDir = path.join(__dirname, 'shots');

  // Snapshot every light the cases touch, so each can be put back exactly as the fixture built it.
  const originals = {};
  for (const name of new Set(CASES.flatMap((c) => [c.a.light, c.b.light]).filter(Boolean))) {
    const state = await js(`JSON.stringify(window.__lightState(${JSON.stringify(name)}))`)
      .then((s) => JSON.parse(s));
    if (state && typeof state === 'object') {
      // Only the keys a case can move, and only those the light actually has — a directional light has
      // no `sourceRadius`, a point light no `angularRadius`, and writing undefined would poison it.
      originals[name] = Object.fromEntries(
        Object.entries(state).filter(([, v]) => typeof v === 'number' && isFinite(v)));
    }
    check(`light '${name}' is readable`, !!originals[name], String(state));
  }

  for (const c of CASES) {
    const rect = await rectFor(c.subject);
    if (!rect) { check(`${c.name}: subject '${c.subject}' is on screen`, false, 'not projected'); continue; }

    if (c.setup) {
      // Logged, not silent: a setup that quietly applied nothing is the difference between a gate
      // that measures a feature and one that measures two identical frames.
      const applied = await js(c.setup);
      console.log(`      ${c.name}: setup applied ${String(applied)}`);
    }

    const sa = await applyState(c.a);
    if (!sa.ok) { check(`${c.name}: state A applies`, false, sa.applied); continue; }
    await sleep(250);
    const a = await captureSignature(win, sleep, rect);
    if (shot === c.name) {
      fs.mkdirSync(shotDir, { recursive: true });
      fs.writeFileSync(path.join(shotDir, `lighting-${c.name}-a.png`),
                       (await win.webContents.capturePage(rect)).toPNG());
    }

    const sb = await applyState(c.b);
    if (!sb.ok) { check(`${c.name}: state B applies`, false, sb.applied); continue; }
    await sleep(250);
    const b = await captureSignature(win, sleep, rect);
    if (shot === c.name) {
      fs.writeFileSync(path.join(shotDir, `lighting-${c.name}-b.png`),
                       (await win.webContents.capturePage(rect)).toPNG());
    }

    const d = compare(a, b);
    check(`${c.name} — ${c.why}`, d.material > 0,
          `nothing moved beyond the noise floor (${d.differing}/128 differ, worst ${d.worst}, ` +
          `needs > ${NOISE}) — the feature is not reaching the pixels`);
    console.log(`      ${c.name}: ${d.differing}/128 differ, ${d.material} beyond the noise floor, ` +
                `worst delta ${d.worst}, crop ${rect.width}x${rect.height} at ${rect.x},${rect.y}`);

    // Restore what the fixture authored, so cases cannot leak into each other. Read back rather than
    // assumed: the lamp's intensity is a migrated legacy value in the megalumens, not something a
    // driver should be writing a guess for.
    if (c.teardown) await js(c.teardown);
    for (const name of new Set([c.a.light, c.b.light].filter(Boolean))) {
      const original = originals[name];
      if (original) await js(`window.__setLight(${JSON.stringify(name)}, ${JSON.stringify(original)})`);
    }
  }

  const failed = results.filter((x) => !x).length;
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  app.exit(failed ? 1 : 0);
});
