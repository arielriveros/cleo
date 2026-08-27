// Script obfuscation for publish. Free of any `cleo` import so it can run inside the project worker.

// transformObjectKeys/renameGlobals must stay OFF: the returned { onStart, onUpdate, ... } keys are read
// by the engine when it binds a factory, and `window.CLEO_GAME_SCRIPTS` must keep its name
// (player/index.tsx). No debugProtection/selfDefending — they reintroduce the Function constructor.
const OBFUSCATOR_OPTIONS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.4,
  identifierNamesGenerator: 'hexadecimal',
  numbersToExpressions: true,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 6,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 1,
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
    const mod: any = await import('javascript-obfuscator');
    const obfuscator = mod.default ?? mod;
    return { code: obfuscator.obfuscate(source, OBFUSCATOR_OPTIONS).getObfuscatedCode() + '\n' };
  } catch (e) {
    return { code: source, warning: `Script obfuscation failed, shipping un-obfuscated scripts: ${e}` };
  }
}
