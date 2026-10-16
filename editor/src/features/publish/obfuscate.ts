// Script obfuscation for publish. Free of any `cleo` import so it can run inside the project worker.

// transformObjectKeys/renameGlobals must stay OFF: the returned { onStart, onUpdate, ... } keys are read
// by the engine when it binds a factory, and `window.CLEO_GAME_SCRIPTS` / `window.CLEO_GAME_MODULES` must keep their names
// (player/index.tsx). No debugProtection/selfDefending — they reintroduce the Function constructor.
//
// Only the transforms that cost nothing per frame: renamed identifiers and strings moved into a shuffled
// array. Game scripts run every frame, and the heavy set (control-flow flattening, dead-code injection,
// split strings, numbers as expressions, base64 string array) made Hollow Keep's script update ~20%
// slower — its string decoder was the single hottest JS function in the published game, ~1.4 ms a frame.
// Measured against the same scripts unobfuscated, this set is indistinguishable.
const OBFUSCATOR_OPTIONS = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  identifierNamesGenerator: 'hexadecimal',
  numbersToExpressions: false,
  simplify: true,
  splitStrings: false,
  stringArray: true,
  stringArrayEncoding: [],
  stringArrayThreshold: 0.75,
  stringArrayCallsTransform: false,
  stringArrayWrappersCount: 0,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  transformObjectKeys: false,
  renameGlobals: false,
};

/**
 * Heavily obfuscate the generated game.scripts.js source. The obfuscator is lazy-loaded so it code-splits
 * out of the initial bundle. On failure returns the readable source and the reason as `warning` for the
 * caller to log — this module has no Logger, since it must stay engine-free to run in the worker.
 */
export async function obfuscateScripts(source: string): Promise<{ code: string; warning?: string }> {
  try {
    // The obfuscator's bundled Chance.js runs `chance = new Chance()` whenever `importScripts` exists, i.e.
    // in a worker. That is an undeclared assignment, which throws inside this strict ES module
    // ("chance is not defined"), unless the global already exists.
    if (!('chance' in globalThis)) (globalThis as any).chance = undefined;
    const mod: any = await import('javascript-obfuscator');
    const obfuscator = mod.default ?? mod;
    return { code: obfuscator.obfuscate(source, OBFUSCATOR_OPTIONS).getObfuscatedCode() + '\n' };
  } catch (e) {
    return { code: source, warning: `Script obfuscation failed, shipping un-obfuscated scripts: ${e}` };
  }
}
