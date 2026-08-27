// The renderer configurations both signature harnesses drive, and the loop that captures them.
//
// Extracted from passCheck.js so a second driver can run the same list against a second BACKEND.
// `passCheck.js` compares one backend against a recorded baseline; `backendDiff.js` compares the two
// backends against each other, config by config. Sharing the list is the point: a configuration that
// only one of them exercises is a configuration whose cross-backend behaviour nobody is watching.

/**
 * Applied wholesale before every configuration, so one cannot leak into the next.
 *
 * Note there is no `bloomEnabled` on the renderer: the quality preset folds it into the intensity, so
 * bloom is off exactly when `bloomIntensity` is 0. Asking for a key the renderer does not have is
 * caught by the `every setting exists` check rather than silently doing nothing.
 */
const DEFAULTS = {
  // Debug channels blit an internal buffer instead of the composited image; the grid is editor chrome.
  // Reset here so one configuration cannot leak into the next.
  debugView: 'final', gridVisible: false,
  bloomIntensity: 0, bloomThreshold: 1,
  ssaoEnabled: false, ssaoRadius: 0.5, ssaoPower: 1.0, motionBlurEnabled: false,
  chromaticAberrationStrength: 0, shadowsEnabled: true, renderScale: 1, exposure: 2,
};

/**
 * The baselined set. `passBaseline.json` has an entry for every `exact` one of these, so adding to
 * this list means re-recording — see EXTRA_CHANNELS below for where new coverage goes instead.
 */
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
  // Debug channels and the grid: four more programs (debugView, shadowDebug, overdraw, grid) that no
  // scene content is needed to reach — they are renderer state, so they cost nothing but a config each.
  { name: 'debugAlbedo', patch: { debugView: 'albedo' } },
  { name: 'debugNormal', patch: { debugView: 'normal' } },
  // 'shadow' is the one channel drawn by the shadowDebug program rather than debugView.
  { name: 'debugShadow', patch: { debugView: 'shadow' } },
  // Overdraw re-rasterizes the scene additively into its own target, so unlike the other channels it
  // costs an extra pass — and it is the only view of how many times each pixel was shaded.
  { name: 'debugOverdraw', patch: { debugView: 'overdraw' } },
  { name: 'grid', patch: { gridVisible: true } },
  // Sky-atmosphere features. Gated on the sky NODE rather than the renderer, so they take `sky`
  // patches: distance fog (skyFog) and raymarched light shafts (volumetricGodRays).
  { name: 'skyFog', patch: {}, sky: { fogEnabled: true, fogDensity: 0.02, fogStart: 2, fogMaxOpacity: 0.9 } },
  // Exposure and density well above their defaults (0.3 / 0.9) ON PURPOSE. The gate below asserts that
  // a pass visibly changes the frame, and god rays are additive light: at default strength they scatter
  // 23 of the 128 signature values by no more than 4, which is under the noise floor, so the gate would
  // be watching a pass it cannot see. That went unnoticed while the sky carried a black band at the
  // horizon for the shafts to stand against — the moment the band was fixed the gate went vacuous.
  // Turned up, the shafts are measurable against a lit sky, which is the case worth gating.
  { name: 'godRays', patch: {}, sky: { godRaysEnabled: true, godRayDensity: 2.4, godRayExposure: 1.2 } },
  // Deliberately excludes SSAO so this one CAN be exact: it exists to prove stacked passes compose,
  // and bloom + chromatic aberration are both deterministic.
  { name: 'combined', patch: { bloomIntensity: 2, bloomThreshold: 0.4, chromaticAberrationStrength: 2, renderScale: 0.75 } },
];

/**
 * The `DebugView` channels the baselined set does not reach.
 *
 * Kept SEPARATE rather than folded into CONFIGS, because every name in CONFIGS needs an entry in the
 * committed `passBaseline.json` and adding thirteen would mean re-recording it — which is exactly what
 * a baseline must not be casually asked to do. The cross-backend driver has no such file: it compares
 * two live runs, so it can afford the coverage for free.
 *
 * They earn their place there. `renderer.ts` declares seventeen channels and the baselined set walks
 * four; each of the rest isolates ONE stage of the frame, which is the difference between "the WebGPU
 * picture is two percent off" and "the metallic channel disagrees and nothing else does".
 */
const EXTRA_CHANNELS = [
  { name: 'debugMetallic', patch: { debugView: 'metallic' } },
  { name: 'debugRoughness', patch: { debugView: 'roughness' } },
  { name: 'debugEmissive', patch: { debugView: 'emissive' } },
  { name: 'debugAO', patch: { debugView: 'ao' } },
  { name: 'debugDepth', patch: { debugView: 'depth' } },
  { name: 'debugCascades', patch: { debugView: 'cascades' } },
  { name: 'debugMask', patch: { debugView: 'mask' } },
  // The raw scene buffer, before any post. Splits "the lighting is wrong" from "the tonemap is wrong",
  // which `base` alone cannot.
  { name: 'debugScene', patch: { debugView: 'scene' } },
  // Bloom's own channels, which need bloom actually on to show anything.
  { name: 'debugBloom', patch: { debugView: 'bloom', bloomIntensity: 2, bloomThreshold: 0.4 } },
  { name: 'debugBloomMask', patch: { debugView: 'bloomMask' } },
  // SSAO's own channel. Non-exact for the same reason `ssao` is — the kernel comes from Math.random at
  // renderer construction, so no two renderers agree, let alone two backends.
  { name: 'debugSSAO', patch: { debugView: 'ssao', ssaoEnabled: true, ssaoRadius: 2.0, ssaoPower: 4.0 },
    exact: false },
  // Velocity needs the camera moving or it is a flat zero on both backends.
  { name: 'debugVelocity', patch: { debugView: 'velocity' }, motion: 6.0, exact: false },
];

/**
 * Apply every configuration in turn and capture a signature for each.
 *
 * Returns `{ signatures, stats, missing }` — `missing` names any (config, setting) pair the renderer
 * did not accept, which is how a renamed property shows up as a failure rather than as a silently
 * unchanged frame.
 */
async function captureConfigs(configs, ctx) {
  const { js, capture, sleep, onShot } = ctx;
  const signatures = {};
  const stats = {};
  const missing = [];

  for (const cfg of configs) {
    const settings = { ...DEFAULTS, ...cfg.patch };
    const applied = await js(`JSON.stringify(window.__setRender(${JSON.stringify(settings)}))`).then(JSON.parse);
    const ignored = Object.keys(settings).filter(k => !applied.includes(k));
    if (ignored.length) missing.push({ name: cfg.name, ignored });

    await js('window.__stopMotion()');
    // Sky features are node state, so they must be reset between configurations like the renderer ones.
    await js(`JSON.stringify(window.__setSky(${JSON.stringify({ fogEnabled: false, godRaysEnabled: false, ...(cfg.sky || {}) })}))`);
    await sleep(400);
    if (cfg.motion) { await js(`window.__startMotion(${cfg.motion})`); await sleep(400); }
    else await sleep(400);
    signatures[cfg.name] = await capture();
    if (onShot) await onShot(cfg.name);
    stats[cfg.name] = await js('JSON.stringify(window.__renderStats())').then(JSON.parse);
    await js('window.__stopMotion()');
  }

  return { signatures, stats, missing };
}

module.exports = { DEFAULTS, CONFIGS, EXTRA_CHANNELS, captureConfigs };
