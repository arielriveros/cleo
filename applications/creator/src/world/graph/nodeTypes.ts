// What a World graph node type declares: its ports, its parameters (as the app-kit ParamForm draws
// them), its defaults, and how it evaluates on the CPU. Types with a GPU kernel name its family; the
// realtime preview (gpuExecutor.ts) runs those per frame and these CPU functions are their reference.

import type { GenericParamSpec } from '@cleo/app-kit/params/ParamField';
import type { GenerateContext } from '../../core/generator';
import type { PipeMasks, WorldFrame } from '../erosion';
import type { PipeErosionGpu } from '../generateWorld';
import type { PaintMaskMeta, PaintPixels } from '../paint';
import type { Field, GraphNode, PortType } from './graphDoc';

export interface PortSpec {
  id: string;
  label: string;
  type: PortType;
  /** May stay unconnected (a missing required height reads as flat ground at 0). */
  optional?: boolean;
}

export type NodeCategory = 'shape' | 'landform' | 'combine' | 'mask' | 'erosion' | 'paint' | 'output';

export const CATEGORY_LABELS: Record<NodeCategory, string> = {
  shape: 'Shapes', landform: 'Landforms', combine: 'Combine', mask: 'Masks', erosion: 'Erosion', paint: 'Paint', output: 'Output',
};

/** What evaluating needs beyond the node's inputs. */
export interface EvalEnv {
  frame: WorldFrame;
  /** The world seed. */
  seed: number;
  paint: PaintPixels;
  paintMeta: readonly PaintMaskMeta[];
  ctx: GenerateContext;
  pipeGpu?: PipeErosionGpu | null;
}

export interface NodeResult {
  outputs: Record<string, Field>;
  /** A simulation's change, for the surfaces' Deposits / Wear / Talus: its input and output heights. */
  history?: { kind: 'hydraulic' | 'thermal'; before: Float32Array; after: Float32Array };
  pipe?: PipeMasks;
  pipeBackend?: 'gpu' | 'cpu';
  /** The erosion filter's ridge map (0..1) and change (m), for the surfaces' Ridges and Gullies. */
  filter?: { ridges: Float32Array; delta: Float32Array };
}

/** The GPU kernel families (shaders/world*.wgsl). */
export type GpuKind = 'shape' | 'combine' | 'filter';

export type NodeParams = Record<string, unknown>;

export interface NodeType {
  type: string;
  label: string;
  category: NodeCategory;
  /** One line for the add menu and the canvas tooltip. */
  description: string;
  /** app-kit icon name. */
  icon: string;
  inputs: PortSpec[];
  outputs: PortSpec[];
  schema: GenericParamSpec[];
  defaults(): NodeParams;
  evaluate(inputs: Record<string, Field | undefined>, params: NodeParams, env: EvalEnv, node: GraphNode): NodeResult | Promise<NodeResult>;
  /** Has a GPU kernel and depends only on its inputs at the same sample (plus central differences). */
  gpu?: GpuKind;
  /**
   * Cheap and input-free: the main thread can evaluate it itself (a paint mask while it is painted), so
   * it can root a realtime region without a round trip to the worker.
   */
  mainThread?: boolean;
  /** A simulation: the realtime preview may bypass it (shown with a "pending" badge) until it settles. */
  sim?: boolean;
  /** Whether output `port`'s gradient is exact, given which inputs' are (for the GPU's flags). */
  exact?(params: NodeParams, inputs: Record<string, boolean>, port: string): boolean;
  /** The input a disabled node passes through (default: its first height input). */
  passthrough?: string;
  /** Not deletable, not duplicable (the Output). */
  singleton?: boolean;
  /** Schema keys the inspector folds under Advanced. */
  advanced?: readonly string[];
  /** Named parameter sets the inspector offers. */
  presets?: readonly { id: string; label: string; description?: string; params: NodeParams }[];
}

/** The Output node's one input (and its pass-through output). */
export const OUTPUT_PORT = 'height';

/** A grid of zeros, the reading of an unconnected required height. */
export const zeroField = (n: number): Field => ({ h: new Float32Array(n), gx: null, gy: null });

/** A field with no gradient (anything a modifier wrote). */
export const plain = (h: Float32Array): Field => ({ h, gx: null, gy: null });

export const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
export const str = <T extends string>(v: unknown, fallback: T): T => (typeof v === 'string' ? (v as T) : fallback);

/** Spec helpers. */
export const fspec = (key: string, label: string, min: number, max: number, step: number, hint?: string, unit?: string): GenericParamSpec =>
  ({ key, label, kind: 'float', min, max, step, hint, unit });
export const ispec = (key: string, label: string, min: number, max: number, hint?: string): GenericParamSpec =>
  ({ key, label, kind: 'int', min, max, hint });
export const espec = (key: string, label: string, options: { value: string; label: string }[], hint?: string): GenericParamSpec =>
  ({ key, label, kind: 'enum', options, hint });
