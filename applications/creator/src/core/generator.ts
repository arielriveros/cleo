// The contract every Cleo Creator generator meets (research doc, section 4 / B3 "Shared foundation"):
// one reflected parameter schema drives the UI, presets and seed variations, and generation is a
// deterministic function of (params, seed). A new generator -- trees, rocks, animation -- registers
// itself here and gets the parameter panel, presets bar and export plumbing for free.

import type { GenericParamSpec } from '@cleo/app-kit/params/ParamField';

/** One file a generator hands back for download. */
export interface ExportFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

/** Progress and cancellation, threaded through long generations so the UI can show a bar and stop one. */
export interface GenerateContext {
  /** 0..1, with an optional label for the phase. */
  progress(fraction: number, label?: string): void;
  /** True once the user cancelled; long loops check it between batches and bail out. */
  readonly cancelled: boolean;
}

export const SILENT_CONTEXT: GenerateContext = { progress() { /* no-op */ }, cancelled: false };

export interface Preset<P> {
  id: string;
  label: string;
  params: P;
}

export interface Generator<P, O> {
  id: string;
  label: string;
  schema: readonly GenericParamSpec[];
  presets: readonly Preset<P>[];
  generate(params: P, seed: number, ctx?: GenerateContext): Promise<O>;
  /** The files an output exports as. */
  exportFiles(output: O, params: P, seed: number): Promise<ExportFile[]>;
}

/** Yield to the browser so a long CPU generation keeps the UI (and its progress bar) alive. */
export function yieldToUi(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/** Thrown out of a generation the user cancelled, and swallowed by whoever started it. */
export class GenerationCancelled extends Error {
  constructor() { super('Generation cancelled'); }
}

/** A short stable hash of bytes (FNV-1a, 32-bit), for golden tests and for naming outputs. */
export function fnv1a(bytes: ArrayLike<number>): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i] & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** The JSON sidecar written beside every asset: enough to regenerate it bit-for-bit. */
export function sidecar(generator: string, params: unknown, seed: number, output: Record<string, unknown>): ExportFile {
  const json = JSON.stringify({ generator, creatorVersion: 1, seed, params, output }, null, 2);
  return { name: `${generator}.json`, mime: 'application/json', bytes: new TextEncoder().encode(json) };
}
