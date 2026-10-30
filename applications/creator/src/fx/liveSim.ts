// FX Creator's live preview: one simulation that never stops, stepping in real time from the volume
// node's onUpdate and writing the engine's FluidVolumeNode every simulated frame. A parameter change
// reaches the next step -- the uniforms are packed per step -- so nothing has to be re-simulated to see
// it. Only the grid size and the seed start the simulation over.
//
// Two engines, one controller:
//   GPU  the compute solver (fluidGpu.ts) steps inside onUpdate, which runs before the renderer opens
//        its frame encoder, and packs the volume texture on the GPU. No readback in the frame.
//   CPU  the reference solver in a worker (fluidWorker.ts). The main thread only uploads finished
//        frames; while one is being uploaded the worker is already computing the next.
//
// Either way the node double-buffers: each new frame goes into the volume `swap()` hands back, and the
// renderer blends from the previous frame by `node.blend`, so playback is smooth even when the
// simulation runs slower than the display.
//
// The preview stage (fxScene.ts) reaches the solver here: the placed bodies as a solid mask, the wind in
// voxel units. Neither is ever part of a bake.

import type { FluidVolumeNode } from 'cleo';
import type { Texture } from 'cleo/graphics/texture';
import { fluidDims, type FluidDims, type SceneWind } from './fluidCpu';
import { gpuBackend } from './fluidGpu';
import type { FluidBackend } from './generateFx';
import { normaliseFx, type FxParams, type FxPreviewQuality } from './fxParams';
import type { FxScene } from './fxScene';
import { voxelizeBodies } from './obstacles';
import { bakeFireLut, FIRE_OPACITY } from './volumeRender';
import { absorptionScale, detailBlend, shadowArea, SHADOW_RES } from './realism';
import { lightVector } from './volumeRender';
import { Texture as EngineTexture } from 'cleo/graphics/texture';
import { device } from 'cleo/graphics/rhi/deviceHandle';
import type { FluidWorkerIn, FluidWorkerOut } from './fluidWorker';

/** Sim frames one render frame may run at most; any debt beyond it is dropped, not repaid. */
export const MAX_FRAMES_PER_TICK = 2;

/**
 * The fixed-step clock: add real time, take whole simulation frames, carry the remainder. A slow
 * setting slows the effect down rather than piling up work the next frame would then also miss.
 */
export function takeFrames(accumulator: number, dt: number, frameTime: number, max = MAX_FRAMES_PER_TICK): { frames: number; accumulator: number } {
  const ft = Math.max(1e-4, frameTime);
  let acc = accumulator + Math.max(0, dt);
  let frames = Math.floor(acc / ft);
  acc -= frames * ft;
  if (frames > max) { frames = max; acc = 0; }
  return { frames, accumulator: acc };
}

/**
 * What the preview quality trades. Solver: the share of the authored pressure iterations (the preview
 * always uses the warm-started red-black SOR, which needs far fewer). Render: march step (voxels), trace
 * resolution and the light grid's update rate.
 */
export const QUALITY: Record<FxPreviewQuality, { pressure: number; step: number; resolution: number; lightEvery: number }> = {
  low: { pressure: 0.3, step: 1.4, resolution: 0.5, lightEvery: 2 },
  medium: { pressure: 0.45, step: 1, resolution: 0.75, lightEvery: 1 },
  high: { pressure: 0.75, step: 0.6, resolution: 1, lightEvery: 1 },
};

/** The authored parameters, adjusted for the live preview's quality. Bakes never see this. */
export function previewParams(p: FxParams): FxParams {
  const q = QUALITY[p.previewQuality] ?? QUALITY.medium;
  return { ...p, pressureSolver: 'sor', pressureIterations: Math.max(4, Math.round(p.pressureIterations * q.pressure)) };
}

/** The default voxel size, metres: a 48-voxel domain is 4.8 m across. The region's own is `voxelSize`. */
export const VOXEL_SIZE = 0.1;

/** The stage's wind in the solver's units (voxels of `voxelSize`), or null when it is off. */
export function sceneWindOf(scene: FxScene, voxelSize = VOXEL_SIZE): SceneWind | null {
  if (!scene.wind || scene.windStrength <= 0) return null;
  // WindNode's convention: degrees counter-clockwise from +X seen from above, so +90 blows toward -Z.
  const a = (scene.windDirection * Math.PI) / 180;
  const speed = scene.windStrength / voxelSize;
  return {
    vx: Math.cos(a) * speed, vz: -Math.sin(a) * speed,
    gustiness: Math.min(1, Math.max(0, scene.windGustiness)),
    gustScale: scene.windGustScale / voxelSize, gustSpeed: scene.windGustSpeed / voxelSize,
  };
}

/** The region's low corner in the stage, metres: its floor centre (`regionOffset`) less half its width and depth. */
export function regionOrigin(dims: FluidDims, voxelSize: number, offset: readonly [number, number, number]): [number, number, number] {
  return [offset[0] - dims.nx * voxelSize / 2, offset[1], offset[2] - dims.nz * voxelSize / 2];
}

const srgbToLinear = (c: number) => Math.pow(Math.min(1, Math.max(0, c)), 2.2);

export interface LiveStats {
  /** Solver milliseconds for the last simulated frame (CPU: as the worker measured it). */
  simMs: number;
  /** Simulated seconds since the last restart. */
  simTime: number;
  backend: 'gpu' | 'cpu';
  dims: FluidDims;
}

/** Where the fire is and how much of it: world position and 0..1 strength. */
export interface FireLight { position: [number, number, number]; strength: number }

export class LiveFx {
  private params: FxParams;
  private dims: FluidDims;
  private gpu: FluidBackend | null = null;
  private worker: Worker | null = null;
  private workerBusy = false;
  private workerDebt = 0;
  private spare: ArrayBuffer | null = null;
  private accumulator = 0;
  private simTime = 0;
  private simMs = 0;
  private lutFor: unknown = null;
  private lutKey = '';
  private disposed = false;
  private scene: FxScene | null = null;
  private solid: Uint8Array | null = null;
  private wind: SceneWind | null = null;
  private packs = 0;
  private fireInFlight = false;
  /** When the worker's last frame landed, and how far apart its frames come: the CPU blend's clock. */
  private lastArrival = 0;
  private arrivalGap = 1 / 24;
  /** False holds the simulation where it is (the last frame stays on screen). */
  playing = true;
  /** Simulation speed relative to real time. */
  speed = 1;
  /** Use temporal reconstruction in the renderer (cheaper rays, accumulated over frames). */
  temporal = true;
  /** Called after each simulated frame lands in the volume. */
  onStats: ((s: LiveStats) => void) | null = null;
  /** The latest fire light, or null before the first. */
  fireLight: FireLight | null = null;
  /** The ground-shadow texture (RGBA8, darkening in alpha), written every simulated frame. */
  shadowTexture: EngineTexture | null = null;

  constructor(private node: FluidVolumeNode, private useGpu: boolean, params: FxParams) {
    this.params = normaliseFx(params);
    this.dims = fluidDims(this.params);
    this.build();
    this.applyLook();
  }

  get backend(): 'gpu' | 'cpu' { return this.gpu ? 'gpu' : 'cpu'; }

  /**
   * New parameters. The grid size and seed restart the simulation; everything else applies to the next
   * step (solver) or the next draw (look).
   */
  setParams(raw: FxParams): void {
    const p = normaliseFx(raw);
    const dims = fluidDims(p);
    const restart = dims.nx !== this.dims.nx || dims.ny !== this.dims.ny || dims.nz !== this.dims.nz || p.seed !== this.params.seed
      || p.voxelSize !== this.params.voxelSize;
    this.params = p;
    if (restart) { this.dims = dims; this.build(); }
    else this.worker?.postMessage({ type: 'params', params: this.simParams() } satisfies FluidWorkerIn);
    this.applyLook();
    this.node.markInteracting();
  }

  /** The preview stage: bodies become the solid mask, the wind a solver force. */
  setScene(scene: FxScene): void {
    this.scene = scene;
    this.placeNode();
    this.temporal = scene.temporal;
    this.applyStage();
    this.applyLook();
    this.node.markInteracting();
  }

  /** The parameters the live solver runs: the authored ones with the preview's quality trade. */
  private simParams(): FxParams {
    return previewParams(this.params);
  }

  /** Start over from an empty domain, keeping the parameters. */
  restart(): void { this.build(); }

  /** Advance by `dt` real seconds. Called from the volume node's onUpdate, once per engine frame. */
  tick(dt: number): void {
    if (this.disposed) return;
    const node = this.node;
    if (!this.playing || typeof document !== 'undefined' && document.hidden) {
      node.blend = 1;
      return;
    }
    const p = this.params;
    const step = takeFrames(this.accumulator, dt * this.speed, p.frameTime);
    this.accumulator = step.accumulator;
    if (this.gpu) node.blend = Math.min(1, this.accumulator / p.frameTime);
    else node.blend = Math.min(1, (performance.now() - this.lastArrival) / 1000 / Math.max(1e-3, this.arrivalGap));
    if (step.frames === 0) return;
    // A burst replays once it has had time to rise and fade, so an explosion can be watched again.
    if (p.emitDuration > 0 && this.simTime > p.emitDuration + 4) { this.build(); return; }

    if (this.gpu) {
      const sim = this.simParams();
      const sub = p.frameTime / Math.max(1, p.substeps);
      const start = performance.now();
      for (let f = 0; f < step.frames; f++) for (let s = 0; s < p.substeps; s++) this.gpu.step(sim, sub);
      // Into the other volume; the renderer blends from the one just shown. The light grid can lag a
      // frame at Low quality -- the sun's shadowing moves slowly.
      const volume = node.swap();
      const detail: [Texture, Texture] | null = node.detailA && node.detailB ? [node.detailA, node.detailB] : null;
      if (volume) this.gpu.packVolume?.(sim, volume, node.occupancy, detail);
      node.hasDetail = !!detail && (sim.detailStrength ?? 0) > 0;
      this.packs++;
      node.blend = 0;
      this.simMs = (performance.now() - start) / step.frames;
      this.simTime += step.frames * p.frameTime;
      node.time = this.simTime;
      node.detailBlend = detailBlend(this.simTime);
      this.pollFireLight();
      if (this.shadowTexture && this.gpu.groundShadow) {
        const a = shadowArea(this.dims, lightVector(sim));
        this.gpu.groundShadow(sim, this.shadowTexture, { ...a, res: SHADOW_RES });
      }
      this.report();
    } else {
      this.workerDebt = Math.min(MAX_FRAMES_PER_TICK, this.workerDebt + step.frames);
      this.pump();
    }
  }

  /**
   * Where the ground shadow lies, in world metres: the centre of its square of floor and its side. Null
   * before the first frame.
   */
  shadowPlacement(): { center: [number, number, number]; size: number } | null {
    if (!this.shadowTexture) return null;
    const v = this.params.voxelSize;
    const a = shadowArea(this.dims, lightVector(this.params));
    const o = regionOrigin(this.dims, v, this.scene?.regionOffset ?? [0, 0, 0]);
    return { center: [o[0] + (a.x0 + a.size / 2 + 0.5) * v, o[1], o[2] + (a.z0 + a.size / 2 + 0.5) * v], size: a.size * v };
  }

  dispose(): void {
    this.disposed = true;
    this.shadowTexture?.delete();
    this.shadowTexture = null;
    this.gpu?.dispose();
    this.gpu = null;
    this.worker?.terminate();
    this.worker = null;
  }

  private build(): void {
    const { nx, ny, nz } = this.dims;
    this.gpu?.dispose();
    this.gpu = null;
    this.accumulator = 0;
    this.simTime = 0;
    this.workerDebt = 0;
    this.node.allocate(nx, ny, nz, { storage: this.useGpu });
    if (!this.shadowTexture) {
      // Compute-written on the GPU path, uploaded from the worker on the CPU one.
      const storage = this.useGpu && !!device?.capabilities?.hasCompute;
      this.shadowTexture = new EngineTexture({
        mipMap: false, wrapping: 'clamp', format: 'rgba8unorm',
        ...(storage ? { storage: true, size: { width: SHADOW_RES, height: SHADOW_RES } } : { loadOnly: true }),
      });
      if (!storage) this.shadowTexture.create(null, SHADOW_RES, SHADOW_RES);
    }
    // `allocate` drops the storage request on a device without compute; the solver follows it.
    if (this.node.storage) {
      this.worker?.terminate();
      this.worker = null;
      this.gpu = gpuBackend(this.dims);
    } else {
      this.startWorker();
    }
    this.placeNode();
    // Empty volumes until the first frame lands, rather than whatever the last grid held.
    if (!this.node.storage) {
      const empty = new Float32Array(nx * ny * nz * 4);
      this.node.upload(empty);
      this.node.swap();
      this.node.upload(empty);
    }
    this.applyStage();
  }

  /** Size and stand the node on the region: the grid at the voxel size, its floor at `regionOffset`. */
  private placeNode(): void {
    const { nx, ny, nz } = this.dims;
    const v = this.params.voxelSize;
    const o = this.scene?.regionOffset ?? [0, 0, 0];
    this.node.size = [nx * v, ny * v, nz * v];
    this.node.setPosition([o[0], o[1] + ny * v / 2, o[2]]);
  }

  /** Push the stage's solid mask and wind into whichever solver runs. */
  private applyStage(): void {
    const scene = this.scene;
    const v = this.params.voxelSize;
    this.solid = scene ? voxelizeBodies(scene.bodies, this.dims, v, regionOrigin(this.dims, v, scene.regionOffset ?? [0, 0, 0])) : null;
    this.wind = scene ? sceneWindOf(scene, v) : null;
    this.gpu?.setSolid?.(this.solid);
    this.gpu?.setSceneWind?.(this.wind);
    this.worker?.postMessage({ type: 'solid', mask: this.solid } satisfies FluidWorkerIn);
    this.worker?.postMessage({ type: 'wind', wind: this.wind } satisfies FluidWorkerIn);
  }

  private startWorker(): void {
    if (!this.worker) {
      this.worker = new Worker(new URL('./fluidWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<FluidWorkerOut>) => this.onWorkerFrame(e.data);
      this.worker.onerror = e => console.error('[FX Creator] solver worker failed', e.message);
    }
    this.workerBusy = false;
    this.spare = null;
    this.worker.postMessage({ type: 'reset', dims: this.dims, params: this.simParams() } satisfies FluidWorkerIn);
  }

  /** Ask the worker for the frames owed, if it is idle. */
  private pump(): void {
    if (!this.worker || this.workerBusy || this.workerDebt <= 0) return;
    const frames = this.workerDebt;
    this.workerDebt = 0;
    this.workerBusy = true;
    const buffer = this.spare;
    this.spare = null;
    this.worker.postMessage({ type: 'advance', frames, buffer } satisfies FluidWorkerIn, buffer ? [buffer] : []);
    this.simTime += frames * this.params.frameTime;
  }

  private onWorkerFrame(msg: FluidWorkerOut): void {
    this.workerBusy = false;
    if (this.disposed) return;
    const { nx, ny, nz } = this.dims;
    const floats = nx * ny * nz * 4;
    // A frame from before a reset (another grid) is dropped; its buffer is not reused either.
    if (msg.buffer.byteLength >= floats * 4 && this.node.resolution[0] === nx && this.node.resolution[1] === ny && this.node.resolution[2] === nz) {
      this.node.swap();
      this.node.upload(new Float32Array(msg.buffer, 0, floats));
      const now = performance.now();
      if (this.lastArrival > 0) this.arrivalGap = 0.7 * this.arrivalGap + 0.3 * Math.min(2, (now - this.lastArrival) / 1000);
      this.lastArrival = now;
      this.node.blend = 0;
      this.node.time = msg.time;
      if (msg.detail) { this.node.uploadDetail(msg.detail[0], msg.detail[1]); this.node.detailBlend = detailBlend(msg.time); }
      if (this.shadowTexture && msg.shadow) device.writeTexture(this.shadowTexture.rhiTexture, msg.shadow, SHADOW_RES, SHADOW_RES);
      else this.node.hasDetail = false;
      this.spare = msg.buffer;
      this.simMs = msg.ms;
      this.setFireLight(msg.fire);
      this.report();
    }
    this.pump();
  }

  /** GPU: read the reduced fire light back every few packs, never more than one read in flight. */
  private pollFireLight(): void {
    const gpu = this.gpu;
    if (!gpu?.fireLight || this.fireInFlight || this.packs % 4 !== 0) return;
    this.fireInFlight = true;
    gpu.fireLight().then(f => { if (!this.disposed && this.gpu === gpu) this.setFireLight(f); })
      .catch(() => { /* a lost read is just one stale light */ })
      .finally(() => { this.fireInFlight = false; });
  }

  private setFireLight(f: [number, number, number, number]): void {
    const { nx, ny, nz } = this.dims;
    const v = this.params.voxelSize;
    const o = regionOrigin(this.dims, v, this.scene?.regionOffset ?? [0, 0, 0]);
    this.fireLight = {
      position: [o[0] + (f[0] * (nx - 1) + 0.5) * v, o[1] + (f[1] * (ny - 1) + 0.5) * v, o[2] + (f[2] * (nz - 1) + 0.5) * v],
      strength: f[3],
    };
  }

  private report(): void {
    this.onStats?.({ simMs: this.simMs, simTime: this.simTime, backend: this.backend, dims: this.dims });
  }

  /** The draw-time parameters: straight onto the node, no simulation involved. */
  private applyLook(): void {
    const p = this.params;
    const n = this.node;
    const q = QUALITY[p.previewQuality] ?? QUALITY.medium;
    // Picker colours are display (sRGB) values; the renderer shades in linear light.
    n.smokeColor = [srgbToLinear(p.smokeColor[0]), srgbToLinear(p.smokeColor[1]), srgbToLinear(p.smokeColor[2])];
    n.absorption = p.absorption;
    n.emission = p.emission;
    n.emissionRange = p.emissionRange;
    n.ignition = p.ignition;
    n.ambient = p.ambient;
    n.anisotropy = p.anisotropy;
    n.scatterOctaves = p.scatterOctaves;
    n.fireGlow = p.fireGlow;
    n.detailStrength = p.detailStrength;
    n.detailScale = p.detailScale;
    n.albedo = p.albedo ?? 1;
    n.powder = p.powder ?? 0;
    n.skyOcclusion = p.skyOcclusion ?? 0;
    n.fireIntensity = p.fireIntensity ?? 1;
    n.fireOpacity = p.fireOpacity ?? FIRE_OPACITY;
    n.absorptionScale = absorptionScale(p.absorptionColor);
    n.sootMask = p.fireSootMask ?? 0;
    n.blueCore = p.blueCore ?? 0;
    const bc = p.blueCoreColor ?? [0.3, 0.45, 1, 1];
    n.blueCoreColor = [srgbToLinear(bc[0]), srgbToLinear(bc[1]), srgbToLinear(bc[2])];
    n.sharpen = p.sharpen ?? 0;
    n.smoothSampling = !!p.smoothSampling;
    n.stepScale = q.step;
    n.resolutionScale = q.resolution;
    n.temporal = this.temporal;
    const lutKey = `${p.fireColorMode}:${p.blackbodyMin}:${p.blackbodyMax}`;
    if (this.lutFor !== p.fireGradient || this.lutKey !== lutKey) {
      const lut = bakeFireLut(p);
      for (let i = 0; i < lut.length; i++) if (i % 4 !== 3) lut[i] = srgbToLinear(lut[i]);
      n.setFireGradient(lut);
      this.lutFor = p.fireGradient;
      this.lutKey = lutKey;
    }
  }

  /** Re-apply the draw-time settings (after `temporal` changes). */
  refreshLook(): void { this.applyLook(); }
}
