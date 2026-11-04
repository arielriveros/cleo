// The FX Creator's live preview of a LIQUID, drawn by the engine's FluidVolumeNode with its `liquid`
// shading, the floor film as three textures the stage lays on its ground as a decal. A one-shot (a splash,
// a burst, a pour) plays out, holds a moment, and replays; a pour that never stops just runs.
//
// Two solvers. On a compute device with the GPU switch on, an effect of GPU_MIN_PARTICLES drops or more
// is stepped by liquidGpu.ts, which splats straight into the node's storage volume; only the floor
// deposits come back, for the film, which a worker (liquidWorker.ts, film only) runs. Otherwise the whole
// solver runs in that worker on the CPU (liquidCpu.ts) and each finished frame is uploaded.
//
// The same face as LiveFx (liveSim.ts) where the workspace uses one: tick, setParams, setScene, restart,
// playing / speed, stats.

import type { FluidVolumeNode } from 'cleo';
import { Texture as EngineTexture } from 'cleo/graphics/texture';
import { device } from 'cleo/graphics/rhi/deviceHandle';
import { fluidDims, type FluidDims } from './fluidCpu';
import { normaliseFx, particleCount, type FxParams, type FxPreviewQuality } from './fxParams';
import type { FxScene } from './fxScene';
import { LiquidCpu } from './liquidCpu';
import { LiquidGpu } from './liquidGpu';
import { sourceCenter } from './liquidCpu';
import { LIQUID_ISO, liquidSigma, previewWindow, splatRadius, type Bounds, type LiquidWindow } from './liquidRender';
import { MAX_FRAMES_PER_TICK, QUALITY, takeFrames, type FireLight, type LiveStats } from './liveSim';
import type { LiquidFilmFrame, LiquidWorkerIn, LiquidWorkerOut } from './liquidWorker';

/** The preview grid's voxels against the droplet, by quality: the splat and upload are the cost. */
const PREVIEW_VOXEL: Record<FxPreviewQuality, number> = { low: 2, medium: 1.4, high: 1 };
/** Most voxels the preview grid may hold whatever the quality. */
const PREVIEW_MAX_VOXELS = 700_000;
/** Seconds a finished one-shot holds before it replays. */
const REPLAY_PAUSE = 0.8;
/** A change that starts the liquid over waits for the edit to settle (a slider, a gizmo drag). */
const RESTART_DEBOUNCE_MS = 300;
/**
 * Fewer drops than this run on the CPU even with the GPU on: the GPU pays a fixed cost per substep (ten
 * dispatches, whatever they hold), which for a few hundred drops is more than the CPU's whole step.
 */
export const GPU_MIN_PARTICLES = 600;

/** What a change of these parameters needs: a new release from t = 0. Anything else applies live. */
const RESTART_KEYS: readonly (keyof FxParams)[] = [
  'regionSize', 'voxelSize', 'seed', 'sourceShape', 'sourceRadius', 'emitterPosition', 'sourceVolume', 'sourceMode',
  'jetDuration', 'sourceSpeed', 'sourceYaw', 'sourcePitch', 'sourceSpread', 'sourceBreakup', 'ringCore', 'dropletSize', 'floorMode', 'previewQuality',
];

/** The film decal the stage draws: three textures and where they lie. */
export interface FloorDecal {
  color: EngineTexture;
  normal: EngineTexture;
  orm: EngineTexture;
  /** World centre of the rectangle of floor where the liquid lies, and its x and z size, metres. */
  center: [number, number, number];
  size: [number, number];
  /** The decal's albedo share (DecalNode.albedoOpacity). */
  albedoOpacity: number;
}

const srgbToLinear = (c: number) => Math.pow(Math.min(1, Math.max(0, c)), 2.2);
const restartKeyOf = (p: FxParams) => JSON.stringify(RESTART_KEYS.map(k => p[k]));
/** What the liquid meets on the stage: a change replays a one-shot so it splashes against it. */
const bodiesKeyOf = (s: FxScene) => JSON.stringify([s.regionOffset ?? [0, 0, 0], s.bodies.filter(b => b.visible).map(b => [b.kind, b.position, b.yaw, b.pitch, b.size])]);

/**
 * `data` (RGBA8, `width` x `height`, row 0 first) with its rows reversed. The film's maps put row 0 at
 * -Z, as an image file's top; a file is flipped as it uploads, so its top lands at v = 1, where a decal
 * reads -Z. A raw upload is not flipped, so the preview's own maps are reversed first -- or its stain
 * lands mirrored about the region's middle.
 */
export function flipRows(data: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(data.length);
  const row = width * 4;
  for (let y = 0; y < height; y++) out.set(data.subarray(y * row, (y + 1) * row), (height - 1 - y) * row);
  return out;
}

/**
 * The preview grid for `p`: voxels from the droplets (by quality), so its detail is theirs whatever the
 * region. The whole region when it fits in PREVIEW_MAX_VOXELS of them; otherwise `windowed`: that many
 * voxels, in the region's proportions, kept over the drops as they move (`previewWindow`) and coarser
 * only while they spread past it.
 */
export function liquidPreviewGrid(p: FxParams): { dims: FluidDims; voxelSize: number; windowed: boolean } {
  const v = p.dropletSize * (PREVIEW_VOXEL[p.previewQuality] ?? 1.4);
  const r = p.regionSize;
  const count = (r[0] / v) * (r[1] / v) * (r[2] / v);
  if (count <= PREVIEW_MAX_VOXELS) return { dims: fluidDims({ regionSize: r, voxelSize: v }), voxelSize: v, windowed: false };
  const s = Math.cbrt(PREVIEW_MAX_VOXELS / count);
  const n = r.map(x => Math.max(16, Math.floor((x / v) * s)));
  return { dims: { nx: n[0], ny: n[1], nz: n[2] }, voxelSize: v, windowed: true };
}

/** Where the drops start, region metres: the source, before anything has been released. */
function sourceBounds(p: FxParams): Bounds {
  const c = sourceCenter(p);
  const r = Math.max(p.sourceRadius ?? 0, p.dropletSize) + p.dropletSize * 2;
  return [c.x - r, c.y - r, c.z - r, c.x + r, c.y + r, c.z + r];
}

/** Seconds a one-shot takes to play out before it replays; Infinity for a pour that never stops. */
export function liquidReplayTime(p: FxParams): number {
  const release = LiquidCpu.releaseTime(p);
  if (!isFinite(release)) return Infinity;
  const settle = p.floorMode === 'solid' && p.bakeDecal ? p.decalSettle : 0;
  return Math.max(release, (p.warmup + p.frames) * p.frameTime) + settle + REPLAY_PAUSE;
}

export class LiveLiquid {
  private params: FxParams;
  private dims: FluidDims;
  /** The droplets' voxel (the finest the window takes). */
  private voxelSize: number;
  /** The part of the region the volume covers: all of it, or (`windowed`) a window over the drops. */
  private window!: LiquidWindow;
  private windowed = false;
  /** The window moved or rescaled since the volume on show: no blend from one to the other. */
  private windowMoved = false;
  /** The GPU drops' last bounds read back, and the ones before (how fast they spread). */
  private gpuBounds: Bounds | null = null;
  private lastBounds: Bounds | null = null;
  /** The region's low corner the running simulation stands at (held while a gizmo drags the region). */
  private corner: [number, number, number] = [0, 0, 0];
  private worker: Worker | null = null;
  private workerBusy = false;
  private workerDebt = 0;
  private spare: ArrayBuffer | null = null;
  private accumulator = 0;
  private simTime = 0;
  private simMs = 0;
  private particles = 0;
  private disposed = false;
  private scene: FxScene | null = null;
  private key: string;
  private lastArrival = 0;
  private arrivalGap = 1 / 24;
  private filmTextures: { color: EngineTexture; normal: EngineTexture; orm: EngineTexture; cols: number; rows: number } | null = null;
  /** Where the film's maps lie: centre (metres from the centre of the region's floor, x and z) and size. */
  private filmPlace: { center: [number, number]; size: [number, number] } = { center: [0, 0], size: [1, 1] };
  private albedoOpacity = 1;
  private filmShown = false;
  /** Counts restarts; the worker tags its frames with it. */
  private generation = 0;
  /** The GPU solver, when it runs the particles. */
  private gpu: LiquidGpu | null = null;
  private readInFlight = false;
  /** Frames simulated since the deposits were last read: the film's to catch up on. */
  private filmFrames = 0;
  /**
   * The film worker is on a batch of deposits: what reads back meanwhile waits here, merged, so a film
   * slower than the GPU falls behind by one batch rather than by a queue that never drains.
   */
  private filmBusy = false;
  private filmPending: { records: Float32Array[]; count: number; frames: number } | null = null;
  /** The region the running simulation was built for (a resize waits for its restart). */
  private region: [number, number, number];
  private bodiesKey = '';
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartPending = false;
  /** A gizmo drag is under way: restarts and the node's placement wait for its end. */
  private dragging = false;
  playing = true;
  speed = 1;
  temporal = true;
  onStats: ((s: LiveStats) => void) | null = null;
  /** A liquid gives no light. */
  readonly fireLight: FireLight | null = null;
  readonly shadowTexture = null;

  constructor(private node: FluidVolumeNode, params: FxParams, private readonly useGpu = false) {
    this.params = normaliseFx(params);
    const g = liquidPreviewGrid(this.params);
    this.dims = g.dims;
    this.voxelSize = g.voxelSize;
    this.windowed = g.windowed;
    this.region = [...this.params.regionSize] as [number, number, number];
    this.key = restartKeyOf(this.params);
    this.build();
    this.applyLook();
  }

  get backend(): 'gpu' | 'cpu' { return this.gpu ? 'gpu' : 'cpu'; }

  /** Simulated seconds since the last (re)start. */
  get time(): number { return this.simTime; }
  /** Seconds one play-through takes before it replays; Infinity for a pour that never stops. */
  get cycleTime(): number { return liquidReplayTime(this.params); }

  /**
   * New parameters. Where the liquid comes from, how much and how fast start it over -- once the edit
   * settles, and never mid-drag; anything else applies at once.
   */
  setParams(raw: FxParams): void {
    const p = normaliseFx(raw);
    const key = restartKeyOf(p);
    this.params = p;
    if (key !== this.key) {
      this.key = key;
      this.scheduleRestart();
    } else {
      this.worker?.postMessage({ type: 'look', params: p } satisfies LiquidWorkerIn);
    }
    this.applyLook();
    this.node.markInteracting();
  }

  /** The stage. Its bodies reach the running liquid at once; a one-shot also replays to meet them. */
  setScene(scene: FxScene): void {
    this.scene = scene;
    this.temporal = scene.temporal;
    const bodies = bodiesKeyOf(scene);
    if (this.bodiesKey && bodies !== this.bodiesKey && isFinite(this.cycleTime)) this.scheduleRestart();
    this.bodiesKey = bodies;
    this.placeNode();
    this.applyStage();
    this.applyLook();
    this.node.markInteracting();
  }

  /** A gizmo drag starts or ends. Its end places the node and runs the restart it held back. */
  setDragging(active: boolean): void {
    this.dragging = active;
    if (active) return;
    this.placeNode();
    if (this.restartPending) this.scheduleRestart();
  }

  restart(): void { this.rebuild(); }

  private scheduleRestart(): void {
    this.restartPending = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.dragging) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.disposed && !this.dragging) this.rebuild();
    }, RESTART_DEBOUNCE_MS);
  }

  /** Start over on the current parameters' grid. */
  private rebuild(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.restartPending = false;
    const g = liquidPreviewGrid(this.params);
    this.dims = g.dims;
    this.voxelSize = g.voxelSize;
    this.windowed = g.windowed;
    this.region = [...this.params.regionSize] as [number, number, number];
    this.build();
  }

  tick(dt: number): void {
    if (this.disposed) return;
    const node = this.node;
    if (!this.playing || typeof document !== 'undefined' && document.hidden) { node.blend = 1; return; }
    const p = this.params;
    const step = takeFrames(this.accumulator, dt * this.speed, p.frameTime);
    this.accumulator = step.accumulator;
    const gpu = this.gpu;
    if (this.windowMoved) node.blend = 1;
    else if (gpu) node.blend = Math.min(1, this.accumulator / p.frameTime);
    else node.blend = Math.min(1, (performance.now() - this.lastArrival) / 1000 / Math.max(1e-3, this.arrivalGap));
    if (step.frames === 0) return;
    if (this.simTime > liquidReplayTime(p)) { this.rebuild(); return; }
    if (!gpu) {
      this.workerDebt = Math.min(MAX_FRAMES_PER_TICK, this.workerDebt + step.frames);
      this.pump();
      return;
    }
    const start = performance.now();
    // The window over the drops as last read back -- a frame or two old, so with room for how fast they spread.
    const moved = this.windowed && this.followDrops(this.gpuBounds, true);
    gpu.setWindow(this.window.origin, this.window.voxelSize);
    for (let f = 0; f < step.frames; f++) gpu.step(p, p.frameTime);
    // Into the other volume; the renderer blends from the one just shown (not across a window move).
    const volume = node.swap();
    if (volume) gpu.pack(volume, node.occupancy);
    this.windowMoved = moved;
    node.blend = moved ? 1 : 0;
    this.simMs = (performance.now() - start) / step.frames;
    this.simTime += step.frames * p.frameTime;
    this.filmFrames += step.frames;
    this.readBack(gpu);
    this.onStats?.({ simMs: this.simMs, simTime: this.simTime, backend: 'gpu', dims: this.dims, particles: this.particles });
  }

  /**
   * The GPU's floor deposits since the last read, on to the film worker with the frames it has to catch
   * up on, and the live count for the readout. One read in flight at a time; deposits pile up meanwhile.
   */
  private readBack(gpu: LiquidGpu): void {
    if (this.readInFlight) return;
    this.readInFlight = true;
    const film = this.params.floorMode === 'solid';
    const frames = this.filmFrames;
    this.filmFrames = 0;
    const generation = this.generation;
    gpu.readDeposits(film).then(d => {
      if (this.gpu !== gpu || generation !== this.generation || this.disposed) return;
      this.particles = d.live;
      if (d.bounds) { this.lastBounds = this.gpuBounds; this.gpuBounds = d.bounds; }
      if (film && this.worker) {
        const pending = this.filmPending ??= { records: [], count: 0, frames: 0 };
        pending.records.push(d.records.slice());
        pending.count += d.count;
        pending.frames += frames;
        this.pumpFilm();
      }
    }).catch(e => console.error('[FX Creator] liquid read-back failed', e))
      .finally(() => { if (this.gpu === gpu) this.readInFlight = false; });
  }

  /** The deposits read back since the film worker's last batch, on to it once it is free. */
  private pumpFilm(): void {
    const pending = this.filmPending;
    if (this.filmBusy || !pending || !this.worker) return;
    this.filmPending = null;
    const records = new Float32Array(pending.count * 4);
    let at = 0;
    for (const r of pending.records) { records.set(r.subarray(0, Math.min(r.length, records.length - at)), at); at += r.length; }
    this.filmBusy = true;
    this.worker.postMessage({ type: 'film', records, count: pending.count, frames: pending.frames } satisfies LiquidWorkerIn, [records.buffer]);
  }

  /** Placement of the ground shadow: a liquid casts none (the film decal is its floor mark). */
  shadowPlacement(): null { return null; }

  /** The floor film as a decal, once a frame of it has arrived; null for a floor that is not solid. */
  floorDecal(): FloorDecal | null {
    const t = this.filmTextures;
    if (!t || !this.filmShown || this.params.floorMode !== 'solid') return null;
    // Where the liquid lies, from the centre of the region's floor, which stands at the region's offset.
    const o = this.scene?.regionOffset ?? [0, 0, 0];
    const f = this.filmPlace;
    return {
      color: t.color, normal: t.normal, orm: t.orm, size: f.size, albedoOpacity: this.albedoOpacity,
      center: [o[0] + f.center[0], o[1], o[2] + f.center[1]],
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.gpu?.dispose();
    this.gpu = null;
    this.worker?.terminate();
    this.worker = null;
    const t = this.filmTextures;
    t?.color.delete(); t?.normal.delete(); t?.orm.delete();
    this.filmTextures = null;
  }

  private build(): void {
    const { nx, ny, nz } = this.dims;
    this.gpu?.dispose();
    this.gpu = null;
    this.readInFlight = false;
    this.filmFrames = 0;
    this.filmBusy = false;
    this.filmPending = null;
    this.particles = 0;
    this.accumulator = 0;
    this.simTime = 0;
    this.workerDebt = 0;
    this.filmShown = false;
    // A restart starts a clean floor: the next film frame makes (and clears) the decal's textures again.
    const old = this.filmTextures;
    old?.color.delete(); old?.normal.delete(); old?.orm.delete();
    this.filmTextures = null;
    this.gpuBounds = this.lastBounds = null;
    this.windowMoved = false;
    this.window = this.windowed
      ? previewWindow(sourceBounds(this.params), this.windowPad(this.voxelSize, null), this.dims, this.voxelSize, this.region, null)
      : { origin: [0, 0, 0], dims: this.dims, voxelSize: this.voxelSize };
    // `allocate` drops the storage request on a device without compute; the solver follows it.
    this.node.allocate(nx, ny, nz, { storage: this.useGpu && particleCount(this.params) >= GPU_MIN_PARTICLES });
    this.placeNode();
    if (this.node.storage) {
      this.gpu = new LiquidGpu(this.params, this.dims, this.voxelSize);
    } else {
      const empty = new Float32Array(nx * ny * nz * 4);
      this.node.upload(empty);
      this.node.swap();
      this.node.upload(empty);
    }
    if (!this.worker) {
      this.worker = new Worker(new URL('./liquidWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<LiquidWorkerOut>) => this.onWorkerFrame(e.data);
      this.worker.onerror = e => console.error('[FX Creator] liquid worker failed', e.message);
    }
    this.workerBusy = false;
    this.spare = null;
    this.generation++;
    if (this.gpu) this.worker.postMessage({ type: 'film-reset', params: this.params, generation: this.generation } satisfies LiquidWorkerIn);
    else this.worker.postMessage({ type: 'reset', params: this.params, dims: this.dims, voxelSize: this.voxelSize, window: this.window, windowed: this.windowed, generation: this.generation } satisfies LiquidWorkerIn);
    this.applyStage();
    this.applyLook();
  }

  /**
   * Around the drops: the splat's reach and two voxels; read back from the GPU, also twice how far their
   * box grew between the last two reads (the frames it is behind by).
   */
  private windowPad(v: number, grew: number | null): number {
    return splatRadius(this.params, v) + 2 * v + 2 * (grew ?? 0);
  }

  /** Keep the window over `bounds` (the GPU's: `lagging`). True when it moved or rescaled. */
  private followDrops(bounds: Bounds | null, lagging: boolean): boolean {
    if (!bounds) return false;
    const last = this.lastBounds;
    const grew = lagging && last ? Math.max(0, last[0] - bounds[0], last[1] - bounds[1], last[2] - bounds[2], bounds[3] - last[3], bounds[4] - last[4], bounds[5] - last[5]) : 0;
    return this.setWindow(previewWindow(bounds, this.windowPad(this.window.voxelSize, grew), this.dims, this.voxelSize, this.region, this.window));
  }

  /** A new window: the node moves and resizes to it, and the per-voxel look follows its voxels. */
  private setWindow(w: LiquidWindow): boolean {
    const was = this.window;
    if (w === was || (w.voxelSize === was.voxelSize && w.origin.every((c, a) => c === was.origin[a]))) return false;
    this.window = w;
    this.placeNode();
    if (w.voxelSize !== was.voxelSize) this.applyLook();
    return true;
  }

  /**
   * The region's low corner in the stage: the region stands centred on its offset, exactly the box the
   * stage draws and the bodies are placed against. Region space (the solver's) starts here.
   */
  private origin(): [number, number, number] {
    const o = this.scene?.regionOffset ?? [0, 0, 0];
    return [o[0] - this.region[0] / 2, o[1], o[2] - this.region[2] / 2];
  }

  /**
   * Stand the node over the window: its voxel (0, 0, 0) at the window's corner in the running region. A
   * region being dragged keeps the corner the simulation runs in until the restart.
   */
  private placeNode(): void {
    if (!this.dragging) this.corner = this.origin();
    const { nx, ny, nz } = this.dims;
    const w = this.window, v = w.voxelSize, o = this.corner;
    this.node.size = [nx * v, ny * v, nz * v];
    this.node.setPosition([o[0] + w.origin[0] + nx * v / 2, o[1] + w.origin[1] + ny * v / 2, o[2] + w.origin[2] + nz * v / 2]);
  }

  private applyStage(): void {
    const scene = this.scene;
    if (!this.worker || !scene) return;
    const origin = this.origin();
    let wind: { vx: number; vz: number } | null = null;
    if (scene.wind && scene.windStrength > 0) {
      // WindNode's convention: degrees counter-clockwise from +X seen from above.
      const a = (scene.windDirection * Math.PI) / 180;
      wind = { vx: Math.cos(a) * scene.windStrength, vz: -Math.sin(a) * scene.windStrength };
    }
    this.gpu?.setBodies(scene.bodies, origin);
    this.gpu?.setWind(wind);
    // The worker too, on the GPU path: its film keeps out from under the bodies.
    this.worker.postMessage({ type: 'bodies', bodies: scene.bodies, origin } satisfies LiquidWorkerIn);
    this.worker.postMessage({ type: 'wind', wind } satisfies LiquidWorkerIn);
  }

  private pump(): void {
    if (!this.worker || this.workerBusy || this.workerDebt <= 0) return;
    const frames = this.workerDebt;
    this.workerDebt = 0;
    this.workerBusy = true;
    const buffer = this.spare;
    this.spare = null;
    this.worker.postMessage({ type: 'advance', frames, buffer } satisfies LiquidWorkerIn, buffer ? [buffer] : []);
    this.simTime += frames * this.params.frameTime;
  }

  private onWorkerFrame(msg: LiquidWorkerOut): void {
    if (msg.type === 'film') {
      if (this.disposed || msg.generation !== this.generation) return;
      if (msg.film) this.uploadFilm(msg.film);
      this.filmBusy = false;
      this.pumpFilm();
      return;
    }
    this.workerBusy = false;
    if (this.disposed) return;
    const { nx, ny, nz } = this.dims;
    const floats = nx * ny * nz * 4;
    if (msg.generation === this.generation && msg.buffer.byteLength >= floats * 4 && this.node.resolution[0] === nx && this.node.resolution[1] === ny && this.node.resolution[2] === nz) {
      this.node.swap();
      this.node.upload(new Float32Array(msg.buffer, 0, floats));
      // Across a window move the two volumes cover different boxes: show the new one alone.
      this.windowMoved = this.setWindow(msg.window);
      const now = performance.now();
      if (this.lastArrival > 0) this.arrivalGap = 0.7 * this.arrivalGap + 0.3 * Math.min(2, (now - this.lastArrival) / 1000);
      this.lastArrival = now;
      this.node.blend = this.windowMoved ? 1 : 0;
      this.spare = msg.buffer;
      this.simMs = msg.ms;
      this.particles = msg.particles;
      if (msg.film) this.uploadFilm(msg.film);
      this.onStats?.({ simMs: this.simMs, simTime: this.simTime, backend: 'cpu', dims: this.dims, particles: this.particles });
    }
    this.pump();
  }

  private uploadFilm(film: LiquidFilmFrame): void {
    if (!device) return;
    const { cols, rows } = film;
    if (!this.filmTextures || this.filmTextures.cols !== cols || this.filmTextures.rows !== rows) {
      const t = this.filmTextures;
      t?.color.delete(); t?.normal.delete(); t?.orm.delete();
      const make = () => {
        const tex = new EngineTexture({ mipMap: false, wrapping: 'clamp', format: 'rgba8unorm', loadOnly: true });
        tex.create(null, cols, rows);
        return tex;
      };
      this.filmTextures = { color: make(), normal: make(), orm: make(), cols, rows };
      // Nothing yet: clear coverage, flat normals, the dry floor's ORM -- so the decal shows only what lands.
      const flat = new Uint8Array(cols * rows * 4), dry = new Uint8Array(cols * rows * 4);
      for (let i = 0; i < cols * rows; i++) { flat.set([128, 128, 255, 255], i * 4); dry.set([255, 230, 0, 255], i * 4); }
      device.writeTexture(this.filmTextures.color.rhiTexture, new Uint8Array(cols * rows * 4), cols, rows);
      device.writeTexture(this.filmTextures.normal.rhiTexture, flat, cols, rows);
      device.writeTexture(this.filmTextures.orm.rhiTexture, dry, cols, rows);
    }
    const t = this.filmTextures;
    // The changed rectangle, its rows reversed (the maps' row 0 is -z, an uploaded image's top is v = 1).
    const [x, z, w, h] = film.rect;
    const y = rows - z - h;
    device.writeTexture(t.color.rhiTexture, flipRows(film.color, w, h), w, h, 0, 0, x, y);
    device.writeTexture(t.normal.rhiTexture, flipRows(film.normal, w, h), w, h, 0, 0, x, y);
    device.writeTexture(t.orm.rhiTexture, flipRows(film.orm, w, h), w, h, 0, 0, x, y);
    this.filmPlace = { center: film.center, size: film.size };
    this.albedoOpacity = film.albedoOpacity;
    this.filmShown = true;
  }

  /** The draw-time parameters, onto the node. */
  private applyLook(): void {
    const p = this.params;
    const n = this.node;
    const q = QUALITY[p.previewQuality] ?? QUALITY.medium;
    n.shading = 'liquid';
    n.liquidIso = LIQUID_ISO;
    n.smokeColor = [srgbToLinear(p.liquidColor[0]), srgbToLinear(p.liquidColor[1]), srgbToLinear(p.liquidColor[2])];
    // Per-channel absorption per VOXEL of the preview grid (the window's, which may be coarser than the droplets').
    const sigma = liquidSigma(p);
    const v = this.window?.voxelSize ?? this.voxelSize;
    n.absorption = 1;
    n.absorptionScale = [sigma[0] * v, sigma[1] * v, sigma[2] * v];
    n.liquidRoughness = p.liquidRoughness;
    n.liquidMetallic = p.liquidMetallic;
    n.liquidSpecular = p.specular;
    n.liquidFoam = p.foam;
    n.ambient = p.ambient;
    // Foam lives in G: never read as fire by the occupancy or the gas path.
    n.ignition = 1e3;
    n.emission = 0;
    n.fireGlow = 0;
    n.smoothSampling = false;
    n.detailStrength = 0;
    n.stepScale = q.step;
    n.resolutionScale = q.resolution;
    n.temporal = this.temporal;
  }

  refreshLook(): void { this.applyLook(); }
}
