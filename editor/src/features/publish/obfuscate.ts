// Script obfuscation for publish. Split out of extractScripts.ts so it stays free of any `cleo` import:
// this module runs inside the project worker (extractScripts cannot — it needs the engine's
// buildFactoryBody), and obfuscation is by far the most expensive step of a publish.

// Aggressive-but-eval-free obfuscation. transformObjectKeys/renameGlobals are OFF on purpose so the
// public interface survives: the returned { onStart, onUpdate, ... } keys are read by the player's
// attachScripts.ts, and `window.CLEO_GAME_SCRIPTS` must keep its name. No debugProtection/selfDefending
// so we never reintroduce the Function constructor / eval.
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
 * Heavily obfuscate the generated game.scripts.js source. The obfuscator is lazy-loaded so it
 * code-splits out of the initial bundle. If obfuscation fails for any reason we fall back to the
 * readable source rather than block a publish, and hand the reason back as a `warning` for the caller
 * to log (this module has no Logger — it must stay engine-free to run in the worker).
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
