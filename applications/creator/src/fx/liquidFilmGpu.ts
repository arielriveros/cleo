// The live preview's floor film on the GPU: liquidFilm.ts and liquidRender.ts `filmMaps` as compute kernels, so a drop
// that lands stamps the film the same frame, the pool flows and soaks on the GPU, and the decal's three
// textures are written in place -- nothing read back, nothing uploaded. Owned by LiquidGpu, which runs it after
// each frame's substeps in the same compute pass.
//
// One fixed grid for the run: everywhere the liquid can reach on the floor (liquidCpu.ts `liquidDomain`, its
// `pool`), at the film's own cells -- never the region, which only frames the drops in flight, so the pool is
// not cut at its walls. Only an active window of it is stepped (it grows over the drops and the stamps). Per frame:
//   stamp (one thread per floor deposit, thickness into an atomic accumulator) -> resolve (accumulator into the
//   film, deposit count reset, the stamped cells into the window's extent) -> measure + total (the volume, the
//   thickest cell and from it the CPU's sweep count) -> the sweeps (zebra line Gauss-Seidel, backward Euler, in
//   place: four passes a sweep, up to MAX_SWEEPS) -> measure + total (the volume after) -> scale (the volume put
//   back, then the soak) -> extent -> maps (colour, normal, ORM into the textures).
// The edge holds and the bodies' solid mask (`pin`) are made when the film is built and when either changes.
//
// The CPU film's step (liquidFilm.ts `flow`) with the one change a GPU needs: its sweeps visit the cells in line
// order (rows, then columns) instead of one after another, so its pools come out like the bake's -- as many
// separate stains, about the same spread -- not bit for bit. tests/support/gpuFilmTwin.ts is this step in
// TypeScript, held to the CPU film. Bakes always use the CPU film.

import { device } from 'cleo/graphics/rhi/deviceHandle';
import { BufferUsage, ShaderStage } from 'cleo/graphics/rhi/types';
import type { BindGroup, Buffer, ComputePipeline } from 'cleo/graphics/rhi/resources';
import type { ComputePassEncoder } from 'cleo/graphics/rhi/device';
import { Texture as EngineTexture } from 'cleo/graphics/texture';
import PinProgram from './shaders/fxFilmPin.wgsl';
import StampProgram from './shaders/fxFilmStamp.wgsl';
import ResolveProgram from './shaders/fxFilmResolve.wgsl';
import MeasureProgram from './shaders/fxFilmMeasure.wgsl';
import TotalProgram from './shaders/fxFilmTotal.wgsl';
import SweepProgram from './shaders/fxFilmSweep.wgsl';
import ScaleProgram from './shaders/fxFilmScale.wgsl';
import MapsProgram from './shaders/fxFilmMaps.wgsl';
import ExtentProgram from './shaders/fxFilmExtent.wgsl';
import { packetVolume, type FxParams } from './fxParams';
import { FILM_DRY, FILM_REF, FLOW_RATE, MOBILITY_CAP, filmCell } from './liquidFilm';
import { GROUND_REF, STAIN_ROUGHNESS, STAIN_SHADE, WET_DARKENING, filmFrame, liquidSigma, previewAlbedoOpacity, type FilmFrame } from './liquidRender';
import type { LiquidDomain } from './liquidCpu';

type Program = typeof PinProgram;

/** Most sweeps a step (liquidFilm.ts SWEEPS): the GPU encodes this many, and those past the step's own count do nothing. */
export const MAX_SWEEPS = 24;
/** Passes a sweep: even rows, odd rows, even columns, odd columns (fxFilmSweep.wgsl). */
const PASSES = 4;
/** The step's controls at the start of a frame (fxFilmTotal.wgsl `ctl`): stage 0, no sweeps, no thickest cell, an empty wet box. */
const CTL_RESET = new Uint32Array([0, 0, 0, 0, 0, 0xffffffff, 0xffffffff, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
/** The most cells a side the film's frame holds: past it, the cells are coarser by a whole factor. */
export const FILM_MAX_SIDE = 2048;
/** Cells the active window keeps around the liquid: more than the flow or a drop in flight can cover before the host sees them. */
export const WINDOW_MARGIN = 64;
/** Bytes of the film's uniform block: ten vec4s (fxFilmCommon.wgsl `FilmUniforms`). */
export const FILM_UNIFORM_BYTES = 10 * 16;

const lin = (c: number) => Math.pow(Math.min(1, Math.max(0, c)), 2.2);

/** What a frame's film uniforms are made from besides the parameters. */
export interface FilmFrameInputs {
  frame: FilmFrame;
  /** The step, seconds. */
  dt: number;
  /** Id of the frame's first deposit (it seeds the satellites' hashes). */
  firstId: number;
  bodyCount: number;
  /** The region's low corner in the stage (bodies are in stage metres). */
  origin: readonly number[];
  /** The active window: low cell (x, z), size in cells. */
  window: readonly [number, number, number, number];
}

/**
 * The film's uniform block (fxFilmCommon.wgsl `FilmUniforms`), ten rows: grid (cols, rows, seed, first deposit
 * id), geometry (x0, z0, cell, one drop's volume), floor (centre x, z, body count, edge hold), flow (k, reference
 * mobility, cap, soak share), the film constants, more constants (darkening, ground, edge noise, relief), the
 * absorption and metallic, the colour and roughness, the albedo share with the region's corner, and the active window.
 */
export function filmUniformData(p: FxParams, o: FilmFrameInputs): ArrayBuffer {
  const buf = new ArrayBuffer(FILM_UNIFORM_BYTES);
  const f = new Float32Array(buf), u = new Uint32Array(buf);
  const set = (row: number, a: number, b: number, c: number, d: number) => { f[row * 4] = a; f[row * 4 + 1] = b; f[row * 4 + 2] = c; f[row * 4 + 3] = d; };
  const { frame } = o;
  u[0] = frame.cols; u[1] = frame.rows; u[2] = p.seed >>> 0; u[3] = o.firstId >>> 0;
  set(1, frame.x0, frame.z0, frame.cell, packetVolume(p));
  set(2, p.regionSize[0] / 2, p.regionSize[2] / 2, o.bodyCount, Math.max(0, p.pinning) / 1000);
  const dRef = Math.max(0, p.flow) * FLOW_RATE;
  set(3, o.dt / (frame.cell * frame.cell), dRef, dRef * MOBILITY_CAP, p.soak > 0 ? 1 - Math.exp(-p.soak * o.dt) : 0);
  set(4, FILM_DRY, FILM_REF, STAIN_SHADE, STAIN_ROUGHNESS);
  set(5, WET_DARKENING, GROUND_REF, Math.max(0, Math.min(1, p.edgeNoise)), Math.max(0, p.decalNormalStrength) * 4);
  const sigma = liquidSigma(p);
  set(6, sigma[0], sigma[1], sigma[2], p.liquidMetallic ?? 0);
  set(7, lin(p.liquidColor[0]), lin(p.liquidColor[1]), lin(p.liquidColor[2]), p.liquidRoughness);
  set(8, previewAlbedoOpacity(p), o.origin[0], o.origin[1], o.origin[2]);
  for (let i = 0; i < 4; i++) u[36 + i] = o.window[i] >>> 0;
  return buf;
}

function pipeline(program: Program, label: string): ComputePipeline {
  const module = device.createShaderModule({ label, stage: ShaderStage.COMPUTE, source: program.wgsl, entryPoints: program.entryPoints, resources: program.resources });
  return device.createComputePipeline({ label, compute: module });
}

type Entry = { buffer: Buffer } | { storageTextureView: ReturnType<typeof device.createWholeTextureView> };

export class LiquidFilmGpu {
  readonly frame: FilmFrame;
  /** The decal's textures: base colour with coverage, tangent-space normal, ORM. */
  readonly color: EngineTexture;
  readonly normal: EngineTexture;
  readonly orm: EngineTexture;
  /** Where the frame lies, metres from the centre of the region's floor: its centre and its size (x, z). */
  readonly center: [number, number];
  readonly size: [number, number];
  /** True once a frame has been drawn into the textures. */
  drawn = false;
  private readonly owned: { destroy(): void }[] = [];
  private readonly uniforms: Buffer;
  private readonly pipes: Record<string, ComputePipeline>;
  private readonly groups: Record<string, BindGroup>;
  /** One bind group per sweep pass, each with its pass number (fxFilmSweep.wgsl `pass_u`). */
  private readonly sweepGroups: BindGroup[] = [];
  private readonly a: Buffer;
  private readonly stain: Buffer;
  private readonly ctl: Buffer;
  private readonly cells: number;
  private bodyCount = 0;
  private origin: [number, number, number] = [0, 0, 0];
  private pinFor = '';
  private dirtyPin = true;
  private frames = 0;
  private readonly ext: Buffer;
  /** The active window, cells [x0, z0, x1, z1) of the frame; empty until the first drops are seen. */
  private win: [number, number, number, number];
  private windowed = false;
  private extentInFlight = false;
  /** Freed: a read-back still in flight from before a restart must not touch its buffers. */
  private disposed = false;
  /** The floor's centre in the region, metres (the deposits' frame is the region's corner). */
  private readonly floorCentre: [number, number];

  constructor(p: FxParams, domain: LiquidDomain, bodies: Buffer, deposits: Buffer, counters: Buffer) {
    this.frame = filmFrame(domain.pool, filmCell(p), FILM_MAX_SIDE);
    const { cols, rows, x0, z0, cell } = this.frame;
    this.cells = cols * rows;
    this.size = [cols * cell, rows * cell];
    this.center = [x0 + this.size[0] / 2, z0 + this.size[1] / 2];
    const storage = (label: string, bytes: number): Buffer => {
      const b = device.createBuffer({ label, size: bytes, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST | BufferUsage.COPY_SRC });
      this.owned.push(b);
      return b;
    };
    const uniform = (label: string, bytes: number): Buffer => {
      const b = device.createBuffer({ label, size: bytes, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      this.owned.push(b);
      return b;
    };
    const n = this.cells * 4;
    this.uniforms = uniform('film.uniforms', FILM_UNIFORM_BYTES);
    this.win = [0, 0, 0, 0];
    this.floorCentre = [p.regionSize[0] / 2, p.regionSize[2] / 2];
    this.ext = storage('film.extent', 16);
    this.resetExtent();
    this.a = storage('film.h', n);
    // The thickness the step started from, the workgroups' partial sums and the step's controls (fxFilmTotal.wgsl).
    const old = storage('film.h.old', n);
    const partials = storage('film.partials', Math.max(4, Math.ceil(cols / 8) * Math.ceil(rows / 8) * 4));
    this.ctl = storage('film.ctl', 64);
    this.stain = storage('film.stain', n);
    const acc = storage('film.acc', n), pin = storage('film.pin', n), solid = storage('film.solid', n);
    const texture = () => new EngineTexture({ mipMap: false, wrapping: 'clamp', format: 'rgba8unorm', storage: true, size: { width: cols, height: rows } });
    this.color = texture(); this.normal = texture(); this.orm = texture();

    this.pipes = {
      pin: pipeline(PinProgram, 'film.pin'), stamp: pipeline(StampProgram, 'film.stamp'), resolve: pipeline(ResolveProgram, 'film.resolve'),
      measure: pipeline(MeasureProgram, 'film.measure'), total: pipeline(TotalProgram, 'film.total'), sweep: pipeline(SweepProgram, 'film.sweep'),
      scale: pipeline(ScaleProgram, 'film.scale'), maps: pipeline(MapsProgram, 'film.maps'), extent: pipeline(ExtentProgram, 'film.extent'),
    };
    const group = (name: string, label: string, entries: Entry[], first = 1): BindGroup => device.createBindGroup({
      label, layout: this.pipes[name].bindGroupLayouts[0],
      entries: [{ binding: 0, buffer: this.uniforms }, ...entries.map((e, i) => ({ binding: i + first, ...e }))],
    });
    const view = (t: EngineTexture) => ({ storageTextureView: device.createWholeTextureView(t.rhiTexture) });
    this.groups = {
      pin: group('pin', 'film.pin', [{ buffer: bodies }, { buffer: pin }, { buffer: solid }]),
      stamp: group('stamp', 'film.stamp', [{ buffer: deposits }, { buffer: counters }, { buffer: acc }]),
      resolve: group('resolve', 'film.resolve', [{ buffer: this.a }, { buffer: acc }, { buffer: counters }, { buffer: this.ext }]),
      measure: group('measure', 'film.measure', [{ buffer: this.a }, { buffer: this.stain }, { buffer: old }, { buffer: partials }, { buffer: this.ctl }]),
      total: group('total', 'film.total', [{ buffer: partials }, { buffer: this.ctl }]),
      scale: group('scale', 'film.scale', [{ buffer: this.a }, { buffer: this.stain }, { buffer: this.ctl }]),
      maps: group('maps', 'film.maps', [{ buffer: this.a }, { buffer: this.stain }, view(this.color), view(this.normal), view(this.orm)]),
      extent: group('extent', 'film.extent', [{ buffer: this.a }, { buffer: this.ext }]),
    };
    // A pass's number in a uniform of its own: the passes run back to back in one compute pass, so a value
    // written between them would not be seen in order.
    for (let k = 0; k < MAX_SWEEPS * PASSES; k++) {
      const pass = uniform(`film.sweep.${k}`, 16);
      device.writeBuffer(pass, 0, new Uint32Array([k, 0, 0, 0]));
      this.sweepGroups.push(group('sweep', `film.sweep.${k}`, [{ buffer: pass }, { buffer: old }, { buffer: this.a }, { buffer: pin }, { buffer: solid }, { buffer: this.ctl }]));
    }
  }

  /** The bodies the film walls off (their buffer is LiquidGpu's, already written) and the region's corner in the stage. */
  setBodies(count: number, origin: readonly number[]): void {
    this.bodyCount = count;
    this.origin = [origin[0], origin[1], origin[2]];
    this.dirtyPin = true;
  }

  /**
   * Append this frame's film passes to the open compute pass, after the particles' substeps: `dt` seconds of
   * flow, the soak, and (when `draw`, the tick's last frame) the maps. `firstId` numbers the frame's first deposit.
   */
  encode(pass: ComputePassEncoder, p: FxParams, dt: number, draw = true): void {
    const { cols, rows } = this.frame;
    const inputs: FilmFrameInputs = { frame: this.frame, dt, firstId: this.frames * 32768, bodyCount: this.bodyCount, origin: this.origin, window: [this.win[0], this.win[1], this.win[2] - this.win[0], this.win[3] - this.win[1]] };
    this.frames++;
    device.writeBuffer(this.uniforms, 0, new Uint8Array(filmUniformData(p, inputs)));
    // The step's controls start over: stage 0, no sweeps yet, no thickest cell, an empty wet box.
    device.writeBuffer(this.ctl, 0, CTL_RESET);
    const key = `${p.pinning}:${p.edgeNoise}:${p.seed}`;
    if (key !== this.pinFor) { this.pinFor = key; this.dirtyPin = true; }
    const wg = (v: number) => Math.ceil(v / 8);
    const run = (pipe: string, group: BindGroup, x: number, y = 1) => { pass.setPipeline(this.pipes[pipe]); pass.setBindGroup(0, group); pass.dispatchWorkgroups(x, y, 1); };
    const g = this.groups;
    if (this.dirtyPin) { run('pin', g.pin, wg(cols), wg(rows)); this.dirtyPin = false; }
    run('stamp', g.stamp, Math.ceil(32768 / 64));
    run('resolve', g.resolve, wg(cols), wg(rows));
    // The flow, the soak, the maps and the extent visit only the active window (the rest is dry floor).
    const w = this.win[2] - this.win[0], h = this.win[3] - this.win[1];
    if (w <= 0 || h <= 0) return;
    const ww = wg(w), wh = wg(h);
    run('measure', g.measure, ww, wh);
    run('total', g.total, 1);
    // A thread a line: the window's rows, then its columns.
    const lines = Math.ceil(Math.max(w, h) / 64);
    for (let k = 0; k < MAX_SWEEPS * PASSES; k++) run('sweep', this.sweepGroups[k], lines);
    run('measure', g.measure, ww, wh);
    run('total', g.total, 1);
    run('scale', g.scale, ww, wh);
    run('extent', g.extent, ww, wh);
    // Only the last frame of a tick is ever shown: the maps are drawn once for it.
    if (draw) { run('maps', g.maps, ww, wh); this.drawn = true; }
  }

  private resetExtent(): void {
    device.writeBuffer(this.ext, 0, new Uint32Array([0xffffffff, 0xffffffff, 0, 0]));
  }

  /** Grow the window over `box` (cells of the frame; low corner inclusive, high exclusive), a margin about it. */
  private grow(x0: number, z0: number, x1: number, z1: number): void {
    const { cols, rows } = this.frame;
    const lo = (v: number, max: number) => Math.min(max, Math.max(0, Math.floor(v) - WINDOW_MARGIN));
    const hi = (v: number, max: number) => Math.min(max, Math.max(0, Math.ceil(v) + WINDOW_MARGIN));
    const w = this.windowed ? this.win : [cols, rows, 0, 0];
    this.win = [Math.min(w[0], lo(x0, cols)), Math.min(w[1], lo(z0, rows)), Math.max(w[2], hi(x1, cols)), Math.max(w[3], hi(z1, rows))];
    this.windowed = true;
  }

  /**
   * The drops' box (region metres: x low, y low, z low, x high, ...) from the solver's read-back, and the wet
   * cells' box from the film's own: the window only grows, over both, so a pool that has spread is still
   * stepped. The extent also holds every cell a drop was stamped into (fxFilmResolve.wgsl), so liquid landing
   * anywhere in the frame is found. Until the first box arrives the window is empty.
   */
  observe(bounds: readonly number[] | null): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const { x0, z0, cell } = this.frame;
    if (bounds) {
      // Region metres from the region's corner; the frame is measured from the floor's centre.
      const fx = this.floorCentre[0] + x0, fz = this.floorCentre[1] + z0;
      this.grow((bounds[0] - fx) / cell, (bounds[2] - fz) / cell, (bounds[3] - fx) / cell, (bounds[5] - fz) / cell);
    }
    if (this.extentInFlight) return Promise.resolve();
    this.extentInFlight = true;
    const read = device.readBuffer(this.ext, 0, 16);
    this.resetExtent();
    return read.then(b => {
      if (this.disposed) return;
      const e = new Uint32Array(b);
      if (e[0] <= e[2] && e[1] <= e[3]) this.grow(e[0], e[1], e[2] + 1, e[3] + 1);
    }).finally(() => { this.extentInFlight = false; });
  }

  /** The liquid on the floor, wet and soaked, m^3 -- a read-back for checks (it is what the film must hold). */
  async readVolume(): Promise<number> {
    const [h, s] = await Promise.all([device.readBuffer(this.a, 0, this.cells * 4), device.readBuffer(this.stain, 0, this.cells * 4)]);
    const hf = new Float32Array(h), sf = new Float32Array(s);
    let sum = 0;
    for (let i = 0; i < this.cells; i++) sum += hf[i] + sf[i];
    return sum * this.frame.cell * this.frame.cell;
  }

  dispose(): void {
    this.disposed = true;
    for (const r of this.owned) r.destroy();
    this.color.delete(); this.normal.delete(); this.orm.delete();
  }
}
