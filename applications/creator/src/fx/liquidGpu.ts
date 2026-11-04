// FX Creator's liquid solver on the GPU, for the live preview: liquidCpu.ts's steps as WebGPU compute
// kernels on the engine's RHI device, the particles never leaving it -- the splat writes the preview
// volume's storage texture directly. Only when `device.capabilities.hasCompute`; otherwise (WebGL2, the
// GPU switched off, or an effect too small to gain -- liveLiquid.ts GPU_MIN_PARTICLES) the preview runs
// liquidCpu.ts in a worker. Bakes always use the CPU solver: they take seconds, and they must come out
// the same on every machine.
//
// One encoder per simulated frame, one compute pass, every substep in it:
//   forces (+ births, count) -> scan -> fill (into bucket order) -> viscosity (+ advance) ->
//   [density -> relax] x passes -> collide -> scatter (back to the slots, + the table cleared)
// The particles keep fixed slots across substeps and frames; within a substep they are worked on in
// bucket order, so neighbouring threads search the same cells from the same memory -- the neighbour
// steps wait on loads far more than they compute. A frame's releases (liquidCpu.ts `LiquidSource`, so
// the same drops as the CPU's) are uploaded before the frame, each tagged with its substep; the forces
// step wakes them on time. The relaxation and viscosity are GATHERED (Jacobi) where the CPU applies them
// pair by pair in place (Gauss-Seidel): the same liquid, not the same drops bit for bit.
//
// What lands on the floor comes back as deposit records (x, z, vx, vz), read back as often as the preview
// can (they pile up between reads), for the CPU film (liquidFilm.ts) -- the floor decal is the film's,
// whichever solver ran.

import { device } from 'cleo/graphics/rhi/deviceHandle';
import { BufferUsage, ShaderStage } from 'cleo/graphics/rhi/types';
import type { BindGroup, Buffer, ComputePipeline } from 'cleo/graphics/rhi/resources';
import type { Texture as EngineTexture } from 'cleo/graphics/texture';
import ForcesProgram from './shaders/fxLiquidForces.wgsl';
import ScanProgram from './shaders/fxLiquidScan.wgsl';
import FillProgram from './shaders/fxLiquidFill.wgsl';
import ViscosityProgram from './shaders/fxLiquidViscosity.wgsl';
import DensityProgram from './shaders/fxLiquidDensity.wgsl';
import RelaxProgram from './shaders/fxLiquidRelax.wgsl';
import CollideProgram from './shaders/fxLiquidCollide.wgsl';
import ScatterProgram from './shaders/fxLiquidScatter.wgsl';
import SplatProgram from './shaders/fxLiquidSplat.wgsl';
import BoundsProgram from './shaders/fxLiquidBounds.wgsl';
import OccupancyProgram from './shaders/fxLiquidOccupancy.wgsl';
import LightProgram from './shaders/fxLiquidLight.wgsl';
import PackProgram from './shaders/fxLiquidPack.wgsl';
import type { FluidDims } from './fluidCpu';
import { particleCount, type FxParams } from './fxParams';
import type { FxBody } from './fxScene';
import {
  COHESION, KERNEL_RATIO, LiquidSource, MAX_BOUNCES, NEAR_Q, NEAR_STIFFNESS, STICK_SPEED, STIFFNESS, latticeDensity, liquidSubstep,
  referenceStep, type LiquidWind, type ReleaseBatch,
} from './liquidCpu';
import { FOAM_FROM, FOAM_SPAN, LIQUID_ISO, liquidSigma, splatRadius, type Bounds } from './liquidRender';
import { lightVector } from './volumeRender';

type Program = typeof ForcesProgram;

/** Deposit records one read-back can hand back; any past this are dropped (and counted). */
const DEPOSITS = 32768;
/** Bodies the preview can collide with: fxLiquidCollide.wgsl's `bodies` holds 3 vec4s each. */
const MAX_BODIES = 16;
const UNIFORM_BYTES = 13 * 16;
/** fxLiquidCommon.wgsl `BOUNDS_BIAS`: the drops' box comes back in cells, biased to stay unsigned. */
const BOUNDS_BIAS = 32768;
/** counters: deposits, substep, live, binned; the drops' low cell (xyz, -), their high cell (xyz, -). */
const COUNTER_BYTES = 12 * 4;
/** The box's reset: nothing yet (low above high). */
const BOUNDS_RESET = new Uint32Array([0xffffffff, 0xffffffff, 0xffffffff, 0, 0, 0, 0, 0]);
const BODY_KIND: Record<FxBody['kind'], number> = { sphere: 0, capsule: 1, box: 2, wall: 2 };

function pipeline(program: Program, label: string): ComputePipeline {
  const module = device.createShaderModule({ label, stage: ShaderStage.COMPUTE, source: program.wgsl, entryPoints: program.entryPoints, resources: program.resources });
  return device.createComputePipeline({ label, compute: module });
}

const nextPow2 = (v: number) => { let n = 1; while (n < v) n <<= 1; return n; };

/**
 * The floor deposits since the last read: (x, z, vx, vz) per record, region metres; the live count; and
 * the box the drops were in over the frames since (region metres, whole cells), null with none.
 */
export interface LiquidDeposits { records: Float32Array; count: number; dropped: number; live: number; bounds: Bounds | null }

export class LiquidGpu {
  readonly capacity: number;
  private readonly tableSize: number;
  private readonly owned: { destroy(): void }[] = [];
  private readonly uniforms: Buffer;
  // Slot order: what persists from substep to substep.
  private readonly pos: Buffer;
  private readonly vel: Buffer;
  private readonly ids: Buffer;
  // Bucket order, rebuilt every substep: as binned (then final), predicted (ping-pong), velocity, cell.
  private readonly posS: Buffer;
  private readonly predicted: [Buffer, Buffer];
  private readonly velS: Buffer;
  private readonly velPredicted: Buffer;
  private readonly cellS: Buffer;
  private readonly cellCount: Buffer;
  private readonly cellStart: Buffer;
  private readonly cellFill: Buffer;
  private readonly sorted: Buffer;
  private readonly pressure: Buffer;
  private readonly bodies: Buffer;
  private readonly deposits: Buffer;
  private readonly counters: Buffer;
  private readonly dens: Buffer;
  private readonly light: Buffer;
  private readonly brickMax: Buffer;
  private readonly pipes: Record<string, ComputePipeline>;
  private readonly groups: Record<string, BindGroup>;
  private readonly packGroups = new Map<EngineTexture, BindGroup>();
  private readonly occupancyGroups = new Map<EngineTexture, BindGroup>();
  private readonly source: LiquidSource;
  private bodyCount = 0;
  private origin: [number, number, number] = [0, 0, 0];
  private wind: LiquidWind | null = null;
  /** The splat's window: its low corner (region metres) and voxel size. */
  private windowOrigin: [number, number, number] = [0, 0, 0];
  private voxelSize: number;
  /** The neighbour cell the drops' box comes back in, metres. */
  private readonly cell: number;
  /** Simulated seconds so far. */
  time = 0;
  /** The particle volume, m^3: a deposit's worth. */
  readonly particleVolume: number;

  constructor(p: FxParams, private readonly dims: FluidDims, voxelSize: number) {
    this.voxelSize = voxelSize;
    this.cell = p.dropletSize * KERNEL_RATIO;
    const total = particleCount(p);
    const continuous = p.sourceMode === 'jet' && !(p.jetDuration > 0);
    this.capacity = Math.max(64, continuous ? Math.min(60_000, total * 6) : total);
    this.tableSize = Math.min(1 << 18, nextPow2(Math.max(1024, this.capacity * 2)));
    this.source = new LiquidSource(p.dropletSize);
    this.particleVolume = Math.pow(p.dropletSize, 3);
    const C = this.capacity, T = this.tableSize;
    const cells = dims.nx * dims.ny * dims.nz;
    const lightCells = Math.ceil(dims.nx / 2) * Math.ceil(dims.ny / 2) * Math.ceil(dims.nz / 2);
    const bricks = Math.ceil(dims.nx / 8) * Math.ceil(dims.ny / 8) * Math.ceil(dims.nz / 8);
    const storage = (label: string, bytes: number, extra = 0): Buffer => {
      const b = device.createBuffer({ label, size: bytes, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST | extra });
      this.owned.push(b);
      device.writeBuffer(b, 0, new Uint8Array(bytes));
      return b;
    };
    this.uniforms = device.createBuffer({ label: 'liquid.uniforms', size: UNIFORM_BYTES, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    this.owned.push(this.uniforms);
    this.pos = storage('liquid.pos', C * 16);
    this.vel = storage('liquid.vel', C * 16);
    this.ids = storage('liquid.ids', C * 4);
    this.posS = storage('liquid.posS', C * 16);
    this.predicted = [storage('liquid.predictedB', C * 16), storage('liquid.predictedC', C * 16)];
    this.velS = storage('liquid.velS', C * 16);
    this.velPredicted = storage('liquid.velPredicted', C * 16);
    this.cellS = storage('liquid.cellS', C * 16);
    this.cellCount = storage('liquid.cellCount', T * 4);
    this.cellStart = storage('liquid.cellStart', (T + 1) * 4);
    this.cellFill = storage('liquid.cellFill', T * 4);
    this.sorted = storage('liquid.sorted', C * 4);
    this.pressure = storage('liquid.pressure', C * 8);
    // A uniform block (fxLiquidCollide.wgsl's ninth buffer would pass the 8 storage buffers a stage may bind).
    this.bodies = device.createBuffer({ label: 'liquid.bodies', size: MAX_BODIES * 3 * 16, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    this.owned.push(this.bodies);
    device.writeBuffer(this.bodies, 0, new Uint8Array(MAX_BODIES * 3 * 16));
    this.deposits = storage('liquid.deposits', DEPOSITS * 16, BufferUsage.COPY_SRC);
    this.counters = storage('liquid.counters', COUNTER_BYTES, BufferUsage.COPY_SRC);
    device.writeBuffer(this.counters, 16, BOUNDS_RESET);
    this.dens = storage('liquid.dens', cells * 8);
    this.light = storage('liquid.light', lightCells * 4);
    this.brickMax = storage('liquid.brickMax', bricks * 4);

    this.pipes = {
      forces: pipeline(ForcesProgram, 'liquid.forces'), scan: pipeline(ScanProgram, 'liquid.scan'),
      fill: pipeline(FillProgram, 'liquid.fill'), viscosity: pipeline(ViscosityProgram, 'liquid.viscosity'),
      density: pipeline(DensityProgram, 'liquid.density'), relax: pipeline(RelaxProgram, 'liquid.relax'),
      collide: pipeline(CollideProgram, 'liquid.collide'), scatter: pipeline(ScatterProgram, 'liquid.scatter'),
      splat: pipeline(SplatProgram, 'liquid.splat'), occupancy: pipeline(OccupancyProgram, 'liquid.occupancy'),
      light: pipeline(LightProgram, 'liquid.light'), pack: pipeline(PackProgram, 'liquid.pack'),
      bounds: pipeline(BoundsProgram, 'liquid.bounds'),
    };
    const group = (name: string, label: string, buffers: Buffer[]): BindGroup => device.createBindGroup({
      label, layout: this.pipes[name].bindGroupLayouts[0],
      entries: [{ binding: 0, buffer: this.uniforms }, ...buffers.map((buffer, i) => ({ binding: i + 1, buffer }))],
    });
    const [B, Cb] = this.predicted;
    const collide = (from: Buffer) => [from, this.velPredicted, this.sorted, this.ids, this.posS, this.velS, this.bodies, this.deposits, this.counters];
    this.groups = {
      forces: group('forces', 'liquid.forces', [this.pos, this.vel, this.cellCount, this.counters]),
      scan: group('scan', 'liquid.scan', [this.cellCount, this.cellStart, this.counters]),
      fill: group('fill', 'liquid.fill', [this.pos, this.vel, this.cellStart, this.cellFill, this.sorted, this.posS, this.velS, this.cellS]),
      viscosity: group('viscosity', 'liquid.viscosity', [this.posS, this.velS, this.cellS, this.cellStart, B, this.velPredicted]),
      densityB: group('density', 'liquid.density.B', [B, this.cellS, this.cellStart, this.pressure]),
      densityC: group('density', 'liquid.density.C', [Cb, this.cellS, this.cellStart, this.pressure]),
      relaxBC: group('relax', 'liquid.relax.BC', [B, this.cellS, this.cellStart, this.pressure, Cb]),
      relaxCB: group('relax', 'liquid.relax.CB', [Cb, this.cellS, this.cellStart, this.pressure, B]),
      collideB: group('collide', 'liquid.collide.B', collide(B)),
      collideC: group('collide', 'liquid.collide.C', collide(Cb)),
      scatter: group('scatter', 'liquid.scatter', [this.pos, this.vel, this.sorted, this.posS, this.velS, this.cellCount, this.cellFill, this.counters]),
      splat: group('splat', 'liquid.splat', [this.posS, this.velS, this.cellS, this.cellStart, this.dens]),
      light: group('light', 'liquid.light', [this.dens, this.brickMax, this.light]),
      bounds: group('bounds', 'liquid.bounds', [this.pos, this.counters]),
    };
  }

  /** Where the splat's window stands (its low corner, region metres) and its voxels: from the next step on. */
  setWindow(origin: readonly number[], voxelSize: number): void {
    this.windowOrigin = [origin[0], origin[1], origin[2]];
    this.voxelSize = voxelSize;
  }

  /** The stage's bodies (stage metres) and the region's low corner in the stage, for collisions. */
  setBodies(bodies: readonly FxBody[], origin: [number, number, number]): void {
    const live = bodies.filter(b => b.visible).slice(0, MAX_BODIES);
    const data = new Float32Array(MAX_BODIES * 12);
    live.forEach((b, i) => {
      data.set([BODY_KIND[b.kind] ?? 2, b.position[0], b.position[1], b.position[2],
                (b.yaw * Math.PI) / 180, (b.pitch * Math.PI) / 180, b.size[0], b.size[1],
                b.size[2], 1, 0, 0], i * 12);
    });
    device.writeBuffer(this.bodies, 0, new Uint8Array(data.buffer));
    this.bodyCount = live.length;
    this.origin = origin;
  }

  setWind(wind: LiquidWind | null): void { this.wind = wind; }

  private writeUniforms(p: FxParams, dt: number): void {
    const buf = new ArrayBuffer(UNIFORM_BYTES);
    const f = new Float32Array(buf), u = new Uint32Array(buf);
    const set = (row: number, a: number, b: number, c: number, d: number) => { f[row * 4] = a; f[row * 4 + 1] = b; f[row * 4 + 2] = c; f[row * 4 + 3] = d; };
    const h = p.dropletSize * KERNEL_RATIO;
    const r = dt / referenceStep(p);
    const tension = Math.max(0, Math.min(1, p.surfaceTension));
    u[0] = this.capacity; u[1] = this.tableSize - 1; u[2] = this.bodyCount; u[3] = p.seed >>> 0;
    set(1, dt, h, latticeDensity(), p.gravity);
    set(2, STIFFNESS * r * r, NEAR_STIFFNESS * r * r, tension * tension * COHESION, NEAR_Q);
    set(3, 120 * p.viscosity, 0.6 + 2 * p.viscosity, Math.min(1, Math.max(0, p.airDrag) * dt), p.dropletSize * 0.5);
    set(4, this.wind?.vx ?? 0, this.wind?.vz ?? 0, p.floorMode === 'solid' ? 0 : p.floorMode === 'absorb' ? 1 : 2, p.stickiness);
    set(5, p.regionSize[0], p.regionSize[1], p.regionSize[2], Math.max(0, Math.min(1, p.floorBounce)));
    set(6, 1 - Math.max(0, Math.min(1, p.floorFriction)), STICK_SPEED, MAX_BOUNCES, DEPOSITS);
    const R = splatRadius(p, this.voxelSize);
    u[28] = this.dims.nx; u[29] = this.dims.ny; u[30] = this.dims.nz; u[31] = Math.ceil((R + 0.4 * h) / h);
    set(8, this.voxelSize, R, LIQUID_ISO, FOAM_FROM);
    const L = lightVector(p);
    const sigma = liquidSigma(p);
    set(9, L[0], L[1], L[2], Math.max(0.15, ((sigma[0] + sigma[1] + sigma[2]) / 3) * this.voxelSize));
    u[40] = Math.ceil(this.dims.nx / 2); u[41] = Math.ceil(this.dims.ny / 2); u[42] = Math.ceil(this.dims.nz / 2); u[43] = 0;
    set(11, this.origin[0], this.origin[1], this.origin[2], FOAM_SPAN);
    set(12, this.windowOrigin[0], this.windowOrigin[1], this.windowOrigin[2], 0);
    device.writeBuffer(this.uniforms, 0, new Uint8Array(buf));
  }

  /**
   * Simulate `dt` seconds: upload this frame's releases, then every substep in one encoder. Its floor
   * deposits join those `readDeposits` returns next.
   */
  step(p: FxParams, dt: number): void {
    const sub = liquidSubstep(p, dt);
    const n = Math.max(1, Math.ceil(dt / sub - 1e-9));
    const sdt = dt / n;
    this.writeUniforms(p, sdt);
    // The substep counter back to 0; the deposits keep counting until they are read.
    device.writeBuffer(this.counters, 4, new Uint32Array(1));
    this.upload(p, n, sdt);
    const C = Math.ceil(this.capacity / 64);
    const encoder = device.createCommandEncoder('liquid.frame');
    const pass = encoder.beginComputePass('liquid.substeps');
    const run = (pipe: string, group: string, x: number) => { pass.setPipeline(this.pipes[pipe]); pass.setBindGroup(0, this.groups[group]); pass.dispatchWorkgroups(x, 1, 1); };
    const iterations = Math.max(1, Math.round(p.liquidIterations));
    // The table was emptied by the last scatter (or never filled).
    const scatter = Math.ceil(Math.max(this.capacity, this.tableSize) / 64);
    for (let s = 0; s < n; s++) {
      run('forces', 'forces', C);
      run('scan', 'scan', 1);
      run('fill', 'fill', C);
      run('viscosity', 'viscosity', C);
      let inB = true;
      for (let k = 0; k < iterations; k++) {
        run('density', inB ? 'densityB' : 'densityC', C);
        run('relax', inB ? 'relaxBC' : 'relaxCB', C);
        inB = !inB;
      }
      run('collide', inB ? 'collideB' : 'collideC', C);
      run('scatter', 'scatter', scatter);
    }
    // Where the drops ended the frame, for the preview's window.
    run('bounds', 'bounds', C);
    pass.end();
    encoder.finish();
    this.time += dt;
  }

  /**
   * The frame's releases (`n` substeps of `sdt`) into their slots, `id % capacity`, each tagged with the
   * substep it is due at. Ids run on from batch to batch, so the frame is one run of slots (two where it
   * wraps).
   */
  private upload(p: FxParams, n: number, sdt: number): void {
    const batches: { b: ReleaseBatch; s: number }[] = [];
    let count = 0;
    for (let s = 0; s < n; s++) {
      const b = this.source.take(p, this.time + s * sdt, sdt, this.capacity);
      if (b.count > 0) { batches.push({ b, s }); count += b.count; }
    }
    if (count === 0) return;
    const C = this.capacity;
    // A frame that releases more than the slots keeps its last `capacity` drops.
    const skip = Math.max(0, count - C);
    const pos = new Float32Array((count - skip) * 4), vel = new Float32Array((count - skip) * 4), ids = new Uint32Array(count - skip);
    let k = 0, seen = 0;
    for (const { b, s } of batches) {
      for (let q = 0; q < b.count; q++, seen++) {
        if (seen < skip) continue;
        pos[k * 4] = b.pos[q * 3]; pos[k * 4 + 1] = b.pos[q * 3 + 1]; pos[k * 4 + 2] = b.pos[q * 3 + 2]; pos[k * 4 + 3] = 2 + s;
        vel[k * 4] = b.vel[q * 3]; vel[k * 4 + 1] = b.vel[q * 3 + 1]; vel[k * 4 + 2] = b.vel[q * 3 + 2];
        ids[k] = b.ids[q];
        k++;
      }
    }
    for (let start = 0; start < k;) {
      const slot = ids[start] % C;
      const run = Math.min(k - start, C - slot);
      device.writeBuffer(this.pos, slot * 16, pos.subarray(start * 4, (start + run) * 4));
      device.writeBuffer(this.vel, slot * 16, vel.subarray(start * 4, (start + run) * 4));
      device.writeBuffer(this.ids, slot * 4, ids.subarray(start, start + run));
      start += run;
    }
  }

  /**
   * The floor deposits since the last read (with `records` false, only their count) and the live count
   * after the last step. The copies are queued now, so the deposits start counting again from here; the
   * promise resolves a frame or so later.
   */
  readDeposits(records = true): Promise<LiquidDeposits> {
    const counters = device.readBuffer(this.counters, 0, COUNTER_BYTES);
    const data = records ? device.readBuffer(this.deposits, 0, DEPOSITS * 16) : Promise.resolve(new ArrayBuffer(0));
    device.writeBuffer(this.counters, 0, new Uint32Array(1));
    device.writeBuffer(this.counters, 16, BOUNDS_RESET);
    const h = this.cell;
    return Promise.all([counters, data]).then(([c, d]) => {
      const head = new Uint32Array(c);
      const total = head[0];
      const count = records ? Math.min(total, DEPOSITS) : 0;
      const bounds: Bounds | null = head[4] > head[8] ? null : [
        (head[4] - BOUNDS_BIAS) * h, (head[5] - BOUNDS_BIAS) * h, (head[6] - BOUNDS_BIAS) * h,
        (head[8] - BOUNDS_BIAS + 1) * h, (head[9] - BOUNDS_BIAS + 1) * h, (head[10] - BOUNDS_BIAS + 1) * h,
      ];
      return { records: new Float32Array(d, 0, count * 4), count, dropped: total - count, live: head[2], bounds };
    });
  }

  /**
   * Splat the particles into the preview's volume texture (`volume`, rgba16float storage: density, foam,
   * light) and its occupancy bricks, all on the GPU.
   */
  pack(volume: EngineTexture, occupancy: EngineTexture | null): void {
    let packGroup = this.packGroups.get(volume);
    if (!packGroup) {
      if (this.packGroups.size >= 4) this.packGroups.clear();
      packGroup = device.createBindGroup({
        label: 'liquid.pack', layout: this.pipes.pack.bindGroupLayouts[0],
        entries: [
          { binding: 0, buffer: this.uniforms }, { binding: 1, buffer: this.dens }, { binding: 2, buffer: this.light },
          { binding: 3, storageTextureView: device.createWholeTextureView(volume.rhiTexture) },
        ],
      });
      this.packGroups.set(volume, packGroup);
    }
    let occGroup = occupancy ? this.occupancyGroups.get(occupancy) : undefined;
    if (occupancy && !occGroup) {
      this.occupancyGroups.clear();
      occGroup = device.createBindGroup({
        label: 'liquid.occupancy', layout: this.pipes.occupancy.bindGroupLayouts[0],
        entries: [
          { binding: 0, buffer: this.uniforms }, { binding: 1, buffer: this.dens },
          { binding: 2, storageTextureView: device.createWholeTextureView(occupancy.rhiTexture) }, { binding: 3, buffer: this.brickMax },
        ],
      });
      this.occupancyGroups.set(occupancy, occGroup);
    }
    const { nx, ny, nz } = this.dims;
    const wg = (v: number) => Math.ceil(v / 4);
    const encoder = device.createCommandEncoder('liquid.pack');
    const pass = encoder.beginComputePass('liquid.pack');
    pass.setPipeline(this.pipes.splat); pass.setBindGroup(0, this.groups.splat); pass.dispatchWorkgroups(wg(nx), wg(ny), wg(nz));
    if (occGroup) {
      pass.setPipeline(this.pipes.occupancy); pass.setBindGroup(0, occGroup);
      pass.dispatchWorkgroups(wg(Math.ceil(nx / 8)), wg(Math.ceil(ny / 8)), wg(Math.ceil(nz / 8)));
    }
    pass.setPipeline(this.pipes.light); pass.setBindGroup(0, this.groups.light);
    pass.dispatchWorkgroups(wg(Math.ceil(nx / 2)), wg(Math.ceil(ny / 2)), wg(Math.ceil(nz / 2)));
    pass.setPipeline(this.pipes.pack); pass.setBindGroup(0, packGroup); pass.dispatchWorkgroups(wg(nx), wg(ny), wg(nz));
    pass.end();
    encoder.finish();
  }

  dispose(): void {
    for (const r of this.owned) r.destroy();
  }
}
