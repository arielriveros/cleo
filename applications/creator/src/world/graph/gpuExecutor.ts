// The realtime region (realtime.ts) on the GPU: one fixed compute kernel per node kind (worldShape,
// worldCombine, worldFilter), dispatched in the plan's order into storage buffers, the Output's heights
// read back. Loading a plan allocates the buffers and bind groups once; each frame of a drag only
// rewrites the uniforms (and a painted mask) and dispatches again. Never compiles a shader per graph.
//
// Fields are 3N floats (heights, d/du, d/dv). Whether a field's gradient is exact is tracked here, as the
// CPU tracks it by the gradient planes being present, and passed to each kernel as a flag.

import { device } from 'cleo/graphics/rhi/deviceHandle';
import { BufferUsage, ShaderStage } from 'cleo/graphics/rhi/types';
import type { BindGroup, Buffer, ComputePipeline } from 'cleo/graphics/rhi/resources';
import ShapeProgram from '../shaders/worldShape.wgsl';
import CombineProgram from '../shaders/worldCombine.wgsl';
import FilterProgram from '../shaders/worldFilter.wgsl';
import type { WorldFrame } from '../erosion';
import { filterSeed } from '../erosionFilter';
import type { PaintMaskMeta, PaintPixels } from '../paint';
import type { Field, WorldGraph } from './graphDoc';
import { nodeType } from './nodeRegistry';
import { combineOpIndex } from './nodes/combine';
import { filterParams } from './nodes/erosionNodes';
import { paintFields } from './nodes/paintOutput';
import { shapeUniform } from './nodes/shapes';
import { num, OUTPUT_PORT } from './nodeTypes';
import type { InputRef, PlanStep, RealtimePlan } from './realtime';

type Program = typeof ShapeProgram;

export const gpuRealtimeAvailable = (): boolean => !!device?.capabilities?.hasCompute;

const FIELD_USAGE = BufferUsage.STORAGE | BufferUsage.COPY_DST | BufferUsage.COPY_SRC;

interface StepGpu {
  step: PlanStep;
  uniforms: Buffer | null;
  group: BindGroup | null;
  pipeline: ComputePipeline | null;
}

export interface RealtimeEnv {
  frame: WorldFrame;
  seed: number;
  paint: PaintPixels;
  paintMeta: readonly PaintMaskMeta[];
}

export class RealtimeGpu {
  private pipelines: Partial<Record<'shape' | 'combine' | 'filter', ComputePipeline>> = {};
  private owned: Buffer[] = [];
  private buffers = new Map<string, Buffer>();
  private sourceExact = new Map<string, boolean>();
  private steps: StepGpu[] = [];
  private zero: Buffer | null = null;
  private res = 0;
  private plan: RealtimePlan | null = null;

  /** The plan currently loaded (its sourcesKey says whether new sources are needed). */
  get loaded(): RealtimePlan | null { return this.plan; }

  /** Allocate `plan`'s buffers at `res`², upload its sources, build its bind groups. */
  load(plan: RealtimePlan, sources: Record<string, Field>, res: number, graph: WorldGraph): void {
    this.release();
    const types = new Map(graph.nodes.map(n => [n.id, n.type]));
    this.res = res;
    const N = res * res;
    const bytes = N * 3 * 4;
    const field = (label: string, init?: Field): Buffer => {
      const b = device.createBuffer({ label, size: bytes, usage: FIELD_USAGE });
      this.owned.push(b);
      const data = new Float32Array(N * 3);
      if (init) {
        data.set(init.h.subarray(0, N), 0);
        if (init.gx) data.set(init.gx.subarray(0, N), N);
        if (init.gy) data.set(init.gy.subarray(0, N), 2 * N);
      }
      device.writeBuffer(b, 0, data);
      return b;
    };
    this.zero = field('world.rt.zero');
    for (const [id, f] of Object.entries(sources)) {
      this.buffers.set(id, field(`world.rt.src.${id}`, f));
      this.sourceExact.set(id, !!(f.gx && f.gy));
    }
    // Outputs first (a step's buffers must exist before a later step binds them), aliases resolved in order.
    for (const step of plan.steps) {
      const key = (port: string) => `${step.node}:${port}`;
      switch (step.kind) {
        case 'shape': case 'combine': this.buffers.set(key('height'), field(`world.rt.${key('height')}`)); break;
        case 'filter':
          for (const p of ['height', 'ridges', 'gullies']) this.buffers.set(key(p), field(`world.rt.${key(p)}`));
          break;
        case 'paint':
          for (const p of ['mask', 'height']) this.buffers.set(key(p), field(`world.rt.${key(p)}`));
          break;
        case 'output': this.buffers.set(key(OUTPUT_PORT), this.resolve(step.inputs[OUTPUT_PORT])); break;
        case 'bypass': {
          const t = nodeType(types.get(step.node) ?? '');
          const src = this.resolve(Object.values(step.inputs)[0] ?? null);
          for (const o of t?.outputs ?? [{ id: 'height' }]) this.buffers.set(key(o.id), src);
          break;
        }
      }
    }
    this.steps = plan.steps.map(step => this.buildStep(step));
    this.plan = plan;
  }

  private resolve(ref: InputRef): Buffer {
    if (!ref) return this.zero!;
    const id = 'source' in ref ? ref.source : `${ref.step}:${ref.port}`;
    return this.buffers.get(id) ?? this.zero!;
  }

  private pipeline(kind: 'shape' | 'combine' | 'filter'): ComputePipeline {
    const make = (program: Program, label: string) => device.createComputePipeline({
      label,
      compute: device.createShaderModule({ label, stage: ShaderStage.COMPUTE, source: program.wgsl, entryPoints: program.entryPoints, resources: program.resources }),
    });
    return this.pipelines[kind] ??= kind === 'shape' ? make(ShapeProgram, 'world.rt.shape')
      : kind === 'combine' ? make(CombineProgram, 'world.rt.combine') : make(FilterProgram, 'world.rt.filter');
  }

  private buildStep(step: PlanStep): StepGpu {
    if (step.kind !== 'shape' && step.kind !== 'combine' && step.kind !== 'filter') return { step, uniforms: null, group: null, pipeline: null };
    const pipeline = this.pipeline(step.kind);
    const size = step.kind === 'shape' ? 96 : step.kind === 'combine' ? 32 : 112;
    const uniforms = device.createBuffer({ label: `world.rt.u.${step.node}`, size, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    this.owned.push(uniforms);
    const out = (p: string) => this.buffers.get(`${step.node}:${p}`)!;
    const ins = (p: string) => this.resolve(step.inputs[p] ?? null);
    const buffers = step.kind === 'shape' ? [out('height')]
      : step.kind === 'combine' ? [ins('a'), ins('b'), ins('mask'), out('height')]
      : [ins('height'), ins('strength'), ins('detail'), ins('fade'), out('height'), out('ridges'), out('gullies')];
    const group = device.createBindGroup({
      label: `world.rt.g.${step.node}`, layout: pipeline.bindGroupLayouts[0],
      entries: [{ binding: 0, buffer: uniforms }, ...buffers.map((buffer, i) => ({ binding: i + 1, buffer }))],
    });
    return { step, uniforms, group, pipeline };
  }

  /**
   * One frame: the region with `graph`'s current parameters (and the painted masks), the Output's heights
   * read back (normalised, res²).
   */
  async run(graph: WorldGraph, env: RealtimeEnv): Promise<Float32Array | null> {
    const plan = this.plan;
    if (!plan) return null;
    const res = this.res, N = res * res;
    const byId = new Map(graph.nodes.map(n => [n.id, n]));
    const exact = new Map<string, boolean>();
    const exactOf = (ref: InputRef | undefined): boolean | undefined => {
      if (!ref) return undefined;
      return 'source' in ref ? this.sourceExact.get(ref.source) ?? false : exact.get(`${ref.step}:${ref.port}`) ?? false;
    };
    const encoder = device.createCommandEncoder('world.rt');
    const groups = Math.ceil(res / 8);
    for (const s of this.steps) {
      const { step } = s;
      const node = byId.get(step.node);
      if (!node) continue;
      const t = nodeType(node.type);
      const params = { ...(t?.defaults() ?? {}), ...node.params };
      const key = (p: string) => `${step.node}:${p}`;
      switch (step.kind) {
        case 'shape': {
          const su = shapeUniform(node.type, params, env.seed);
          const buf = new ArrayBuffer(96);
          const u = new Uint32Array(buf), f = new Float32Array(buf);
          u[0] = res; u[1] = su.kind; u[2] = su.sub; u[3] = su.octaves; u[4] = su.seed >>> 0;
          for (let i = 0; i < 16; i++) f[8 + i] = su.f[i] ?? 0;
          device.writeBuffer(s.uniforms!, 0, new Uint8Array(buf));
          exact.set(key('height'), true);
          break;
        }
        case 'combine': {
          const buf = new ArrayBuffer(32);
          const u = new Uint32Array(buf), f = new Float32Array(buf);
          u[0] = res; u[1] = combineOpIndex(params.op); u[2] = step.inputs.mask ? 1 : 0;
          f[4] = num(params.strength, 1);
          device.writeBuffer(s.uniforms!, 0, new Uint8Array(buf));
          const inExact: Record<string, boolean> = {};
          for (const p of ['a', 'b', 'mask']) { const e = exactOf(step.inputs[p]); if (e !== undefined) inExact[p] = e; }
          exact.set(key('height'), t?.exact?.(params, inExact, 'height') ?? false);
          break;
        }
        case 'filter': {
          const p = filterParams(params);
          const buf = new ArrayBuffer(112);
          const u = new Uint32Array(buf), f = new Float32Array(buf);
          const flags = (exactOf(step.inputs.height) ? 1 : 0) | (step.inputs.strength ? 2 : 0) | (step.inputs.detail ? 4 : 0) | (step.inputs.fade ? 8 : 0);
          u[0] = res; u[1] = flags; u[2] = filterSeed(env.seed, p.seed) >>> 0; u[3] = p.octaves;
          const fl = [env.frame.size, env.frame.heightScale, p.spacing, p.depth, p.gullyWeight, p.detail, p.gain, p.lacunarity,
            p.peakRounding, p.valleyRounding, p.inputRounding, p.roundingFalloff, p.onsetInput, p.onsetOctave, p.onsetRidgeInput,
            p.onsetRidgeOctave, p.assumedSlope, p.straighten, p.cellScale, p.normalization, p.valleyLevel, p.peakLevel, p.heightBias, p.keepAltitude];
          fl.forEach((v, i) => { f[4 + i] = v; });
          device.writeBuffer(s.uniforms!, 0, new Uint8Array(buf));
          for (const o of ['height', 'ridges', 'gullies']) exact.set(key(o), false);
          break;
        }
        case 'paint': {
          const fields = paintFields(params, { ...env, frame: { ...env.frame, resolution: res } });
          const data = new Float32Array(N * 3);
          data.set(fields.mask.h);
          device.writeBuffer(this.buffers.get(key('mask'))!, 0, data);
          data.fill(0); data.set(fields.height.h);
          device.writeBuffer(this.buffers.get(key('height'))!, 0, data);
          exact.set(key('mask'), false); exact.set(key('height'), false);
          break;
        }
        case 'bypass': {
          const e = exactOf(Object.values(step.inputs)[0] ?? undefined) ?? true;
          for (const o of t?.outputs ?? []) exact.set(key(o.id), e);
          break;
        }
        case 'output': exact.set(key(OUTPUT_PORT), exactOf(step.inputs[OUTPUT_PORT]) ?? true); break;
      }
      if (s.pipeline && s.group) {
        const pass = encoder.beginComputePass(`world.rt.${step.kind}`);
        pass.setPipeline(s.pipeline);
        pass.setBindGroup(0, s.group);
        pass.dispatchWorkgroups(groups, groups, 1);
        pass.end();
      }
    }
    encoder.finish();
    const outStep = plan.steps.find(st => st.kind === 'output');
    const outBuf = outStep ? this.buffers.get(`${outStep.node}:${OUTPUT_PORT}`) : null;
    if (!outBuf) return null;
    const bytes = await device.readBuffer(outBuf, 0, N * 4);
    return new Float32Array(bytes);
  }

  private release(): void {
    for (const b of this.owned) b.destroy();
    this.owned = [];
    this.buffers.clear();
    this.sourceExact.clear();
    this.steps = [];
    this.zero = null;
    this.plan = null;
  }

  dispose(): void {
    this.release();
    this.pipelines = {};
  }
}
