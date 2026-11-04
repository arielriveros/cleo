// The ground of a Creator's stage: a plane that is a plain colour, or one of the PBR sets the build carries
// (vite.floors.ts) tiled across it and, in the Foliage Creator, wetted and snowed on (floorComposite.ts,
// run in floorWorker.ts). Creator-only: the engine's WeatherNode reaches foliage, not plain materials.

import { Geometry, Material, Model, ModelNode, TextureManager, type Scene } from 'cleo';
import { floorsBase, loadFloorManifest, SNOW_SET_ID, type FloorSet } from './floorSets';
import type { FloorWorkerIn, FloorWorkerOut } from './floorWorker';

let manifest: Promise<FloorSet[]> | null = null;
/** The sets this build carries (empty without `build/terrain_textures`). */
export function floorManifest(): Promise<FloorSet[]> {
  return manifest ??= loadFloorManifest(floorsBase(import.meta.env.BASE_URL));
}

export interface FloorSettings {
  /** A set's id; '' for the plain colour. */
  set: string;
  /** Metres one repeat of the maps covers. */
  tile: number;
  wetness: number;
  snow: number;
}

export const DEFAULT_FLOOR: Pick<FloorSettings, 'set' | 'tile'> = { set: '', tile: 2 };

const DEBOUNCE_MS = 100;

export class StageFloor {
  private node: ModelNode | null = null;
  private visible = false;
  private settings: FloorSettings = { ...DEFAULT_FLOOR, wetness: 0, snow: 0 };
  /** The texture ids of the floor now shown (diff, nor, arm) and the weather they were composited for. */
  private ids: string[] = [];
  private shown = '';
  private worker: Worker | null = null;
  private request = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly scene: Scene, private readonly plain: { color: number[]; size: number; name: string }) {}

  /** The ground node, while it is shown. */
  get ground(): ModelNode | null { return this.node; }

  show(visible: boolean): void {
    if (visible === this.visible && (this.node !== null) === visible) return;
    this.visible = visible;
    this.rebuild();
  }

  configure(next: FloorSettings): void {
    const s = this.settings;
    const same = (a: number, b: number) => Math.abs(a - b) < 1e-6;
    const textureChange = next.set !== s.set || !same(next.wetness, s.wetness) || !same(next.snow, s.snow);
    const tileChange = !same(next.tile, s.tile);
    this.settings = { ...next };
    if (textureChange) this.schedule();
    else if (tileChange) this.rebuild();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.composite(); }, DEBOUNCE_MS);
  }

  private async composite(): Promise<void> {
    const s = this.settings;
    const sets = s.set ? await floorManifest() : [];
    const set = sets.find(x => x.id === s.set);
    if (this.disposed) return;
    if (!set) { this.swap([], ''); return; }
    this.worker ??= new Worker(new URL('./floorWorker.ts', import.meta.url), { type: 'module' });
    const id = ++this.request;
    const snowSet = s.snow > 0 ? sets.find(x => x.id === SNOW_SET_ID) ?? null : null;
    const key = `${s.set}:${s.wetness}:${s.snow}`;
    this.worker.onmessage = (e: MessageEvent<FloorWorkerOut>) => {
      const m = e.data;
      if (this.disposed || m.id !== this.request) return;
      if ('error' in m) { console.error('[Creator] floor failed', m.error); return; }
      const config = { wrapping: 'repeat' as const, mipMap: true };
      const make = (bytes: ArrayBuffer, label: string) =>
        TextureManager.Instance.addTextureFromBytes(new Uint8Array(bytes), 'image/png', config, `stage.floor.${label}.${id}`) ?? '';
      this.swap([make(m.diff, 'diff'), make(m.nor, 'nor'), make(m.arm, 'arm'), m.disp ? make(m.disp, 'disp') : ''], key);
    };
    const msg: FloorWorkerIn = { id, base: floorsBase(import.meta.env.BASE_URL), set, snowSet, weather: { wetness: s.wetness, snow: s.snow } };
    this.worker.postMessage(msg);
  }

  /** The floor's textures replaced: the old ones go. */
  private swap(ids: string[], key: string): void {
    for (const old of this.ids) if (old) TextureManager.Instance.removeTexture(old);
    this.ids = ids;
    this.shown = key;
    this.rebuild();
  }

  private rebuild(): void {
    if (this.node) { this.scene.removeNode(this.node); this.node = null; }
    if (!this.visible || this.disposed) return;
    const { color, size, name } = this.plain;
    const [diff, nor, arm, disp] = this.ids;
    const material = diff
      ? Material.PBR({
        baseColor: [1, 1, 1], metallic: 0, roughness: 1,
        textures: { baseColorTexture: diff, normalMap: nor, roughnessMap: arm, metallicMap: arm, occlusionMap: arm, ...(disp ? { displacementMap: disp } : {}) },
        // The maps are a non-repeating synthesis of two repeats of the set (floorSynth.ts).
        uvTiling: [size / (Math.max(0.1, this.settings.tile) * 2), size / (Math.max(0.1, this.settings.tile) * 2)],
        // Parallax occlusion: the set's height map as relief, a few centimetres in world units.
        ...(disp ? { displacementScale: 0.04, depthSpace: 'world' as const } : {}),
      })
      : Material.PBR({ baseColor: color, roughness: 0.95 });
    this.node = new ModelNode(name, new Model(Geometry.Plane(size, size), material));
    this.scene.addNode(this.node);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.worker?.terminate();
    this.worker = null;
    if (this.node) { this.scene.removeNode(this.node); this.node = null; }
    for (const id of this.ids) if (id) TextureManager.Instance.removeTexture(id);
    this.ids = [];
  }
}
