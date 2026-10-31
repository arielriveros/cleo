import {
  DirectionalLight, FoliageLayer, Geometry, GLTFLoader, LandscapeNode, Loader, LodGroupNode, Material, Model, ModelNode, Node,
  SkyAtmosphereNode, SkyLightNode, Terrain, TextureManager, WindNode, type CleoEngine, type LightNode, type Scene,
} from 'cleo';
import { vec3 } from 'gl-matrix';
import { aimSun } from '../../fx/ui/fxPreview';
import type { FoliageBuild } from '../foliageClient';

// The Foliage Creator's preview stage: a ground, the sun, an optional physical sky, a wind, and the
// generated asset -- shown one of two ways:
//
//   foliage  (Wind on) as instances of a terrain foliage layer, the path a game draws a foliage rule
//            with, so the asset sways with the stage's WindNode exactly as it will in a level. The layer
//            lives on a tiny hidden host terrain: its ground never draws and casts nothing, but the
//            landscape node itself stays visible, which is what admits its foliage.
//   nodes    (Wind off, or wireframe, which the instanced path does not draw) as a real LodGroupNode per
//            copy -- one child per level, switched by the renderer exactly as in a game, but still.
//
// The asset arrives as the very .glb files the export writes and is loaded through the engine's own glTF
// importer, so the preview is the import: cutout, double-siding, translucency and wind settings included.
// Every node and texture here is owned by the stage and removed by `dispose()`, which also puts the
// shared engine's sun, ambient and exposure back for the other tools.

const PREFIX = 'Foliage stage · ';

export type LodView = 'auto' | 0 | 1 | 2;

export interface StageSettings {
  grid: boolean;
  ground: boolean;
  sky: boolean;
  /** Grass only: a patch of clumps instead of one. */
  patch: boolean;
  wireframe: boolean;
  sunYaw: number;
  sunElevation: number;
  sunLux: number;
  ambientLux: number;
  /** A WindNode on the stage; the asset is then drawn as terrain foliage, which is what sways. */
  wind: boolean;
  /** The WIND_PRESETS entry last picked (the fields below are what it set, then any edits). */
  windPreset: string;
  /** Degrees counter-clockwise from +X. */
  windDirection: number;
  windStrength: number;
  windGustScale: number;
  windGustSpeed: number;
}

export const DEFAULT_STAGE: StageSettings = {
  grid: true, ground: true, sky: true, patch: true, wireframe: false,
  sunYaw: 35, sunElevation: 40, sunLux: 60000, ambientLux: 6000,
  wind: true, windPreset: 'breezy', windDirection: 30, windStrength: 1, windGustScale: 18, windGustSpeed: 4,
};

/**
 * The host terrain sits at the stage's origin: a 2 m patch whose chunks never draw and cast nothing. Not
 * moved far away: a landscape a kilometre down stretches the scene's bounds, which the shadow cascades
 * and exposure fit to, and the stage went white.
 */
const HOST_DEPTH = 0;

export class FoliageStage {
  private ground: ModelNode | null = null;
  private sky: SkyAtmosphereNode | null = null;
  private skyLight: SkyLightNode | null = null;
  private root: Node | null = null;
  private groups: LodGroupNode[] = [];
  private wind: WindNode | null = null;
  private host: LandscapeNode | null = null;
  private layer: FoliageLayer | null = null;
  /** What `show` loaded, kept so the stage can present it again in the other mode. */
  private levels: { name: string; model: Model }[][] = [];
  private copies: [number, number, number][] = [];
  private assetName = '';
  private windOn = false;
  private materials: Material[] = [];
  private textureIds: string[] = [];
  private distances: number[] = [0];
  private cull = 0;
  private lod: LodView = 'auto';
  private wireframe = false;
  /** Bumped per show(): an older load that finishes late is dropped. */
  private generation = 0;

  private readonly saved: { sunIntensity: number | null; sunRotation: vec3 | null; ambient: vec3; autoExposure: boolean; exposure: number };

  constructor(private engine: CleoEngine, private world: Scene, private sun: LightNode | null) {
    const light = sun?.light as DirectionalLight | undefined;
    this.saved = {
      sunIntensity: light ? light.intensity : null,
      sunRotation: sun ? vec3.clone(sun.rotation) : null,
      ambient: vec3.clone(world.ambientLight),
      autoExposure: engine.renderer.autoExposureEnabled,
      exposure: engine.renderer.exposure,
    };
    engine.renderer.autoExposureEnabled = true;
  }

  apply(s: StageSettings): void {
    const world = this.world;
    if (this.sun) {
      aimSun(this.sun, { lightYaw: s.sunYaw, lightElevation: s.sunElevation });
      (this.sun.light as DirectionalLight).intensity = Math.max(0, s.sunLux);
    }
    world.ambientLight = vec3.fromValues(s.ambientLux, s.ambientLux, s.ambientLux);
    this.engine.renderer.setGridVisible(s.grid);
    if (s.ground && !this.ground) {
      this.ground = new ModelNode(PREFIX + 'ground', new Model(Geometry.Plane(80, 80), Material.PBR({ baseColor: [0.2, 0.19, 0.15], roughness: 0.95 })));
      world.addNode(this.ground);
    } else if (!s.ground && this.ground) {
      world.removeNode(this.ground);
      this.ground = null;
    }
    if (s.sky && !this.sky) {
      this.sky = new SkyAtmosphereNode(PREFIX + 'sky', { useSceneSun: true });
      this.skyLight = new SkyLightNode(PREFIX + 'sky light', {});
      world.addNode(this.sky);
      world.addNode(this.skyLight);
    } else if (!s.sky && this.sky) {
      world.removeNode(this.sky);
      if (this.skyLight) world.removeNode(this.skyLight);
      this.sky = this.skyLight = null;
    }
    // --- Wind ---
    if (s.wind && !this.wind) {
      // Fades well past any framing of one plant (the default 40-70 m is a level's budget, not a stage's).
      this.wind = new WindNode(PREFIX + 'wind', { fadeStart: 150, fadeEnd: 250 });
      world.addNode(this.wind);
    } else if (!s.wind && this.wind) {
      world.removeNode(this.wind);
      this.wind = null;
    }
    if (this.wind) {
      this.wind.direction = s.windDirection;
      this.wind.strength = s.windStrength;
      this.wind.gustScale = s.windGustScale;
      this.wind.gustSpeed = s.windGustSpeed;
    }
    const before = this.mode();
    this.windOn = s.wind;
    this.wireframe = s.wireframe;
    if (this.mode() !== before) this.present();
    this.setWireframe(s.wireframe);
  }

  /** How the asset is drawn: as swaying foliage, or as still nodes (see the header). */
  mode(): 'foliage' | 'nodes' {
    return this.windOn && !this.wireframe ? 'foliage' : 'nodes';
  }

  /**
   * Replace the shown asset with `build`. Resolves once the new one is in the scene; a newer call
   * started meanwhile wins and this one's result is dropped.
   */
  async show(build: FoliageBuild, copies: [number, number, number][] = [[0, 0, 0]]): Promise<void> {
    const generation = ++this.generation;
    const loaded = await Promise.all(build.files.glbs.map((bytes, i) =>
      new GLTFLoader().parseDescriptorsFromFiles([new File([bytes as BlobPart], `level${i}.glb`)], false)));
    if (generation !== this.generation) return;

    // Level 0 owns the materials (and so the textures); lower levels re-use them by glTF material name
    // rather than uploading the same images again.
    const shared = new Map<string, Material>();
    const textureIds: string[] = [];
    const levels = loaded.map((parsed, li) => Loader.assembleGltfModels(parsed, []).map(({ name, model }, mi) => {
      const m = model as Model;
      const key = parsed.materials[parsed.meshes[mi].materialIndex]?.name ?? name;
      const existing = li > 0 ? shared.get(key) : undefined;
      if (existing) {
        for (const id of m.material.textures.values()) if (typeof id === 'string') TextureManager.Instance.removeTexture(id);
        m.material = existing;
      } else {
        shared.set(key, m.material);
        for (const id of m.material.textures.values()) if (typeof id === 'string') textureIds.push(id);
      }
      return { name, model: m };
    }));

    this.clear();
    this.materials = [...shared.values()];
    this.textureIds = textureIds;
    this.distances = build.summary.levels.map(l => l.distance);
    this.cull = build.summary.cullDistance;
    this.levels = levels;
    this.copies = copies;
    this.assetName = build.summary.name;
    this.present();
  }

  /** Put the loaded asset on the stage in the current mode, replacing whatever showed it before. */
  private present(): void {
    this.removePresentation();
    if (!this.levels.length) return;
    if (this.mode() === 'foliage') this.presentFoliage();
    else this.presentNodes();
    this.setWireframe(this.wireframe);
  }

  private presentNodes(): void {
    const levels = this.levels;
    const root = new Node(PREFIX + 'asset');
    this.copies.forEach((offset, ci) => {
      const group = new LodGroupNode(`${PREFIX}${this.assetName} ${ci}`);
      group.setPosition(offset);
      // Turn the copies so a patch does not read as a grid of one clump.
      if (ci > 0) group.setRotation([0, (ci * 137.5) % 360, 0]);
      levels.forEach((parts, li) => {
        const level = new Node(`LOD${li}`);
        for (const part of parts) level.addChild(new ModelNode(part.name, part.model));
        group.addChild(level);
      });
      root.addChild(group);
      this.groups.push(group);
    });
    this.root = root;
    this.world.addNode(root);
    this.setLod(this.lod);
  }

  /**
   * The asset as instances of one foliage layer on a hidden host terrain. The layer gets its own Model per
   * part (the same geometry and material): the foliage pass builds its own vertex arrays, so a Model is
   * never shared with a ModelNode.
   */
  private presentFoliage(): void {
    const terrain = new Terrain({ size: 2, resolution: 2, chunkQuads: 4 },
                                Material.Terrain({ baseColor: [0, 0, 0] } as any, { side: 'front', castShadow: false } as any));
    const host = new LandscapeNode(PREFIX + 'foliage host', terrain);
    host.setPosition([0, HOST_DEPTH, 0]);
    for (const chunk of host.chunkNodes) chunk.visible = false;
    this.host = host;
    this.world.addNode(host);
    this.buildLayer();
  }

  /** (Re)build the foliage layer for the current LOD view: a layer cannot swap its meshes in place. */
  private buildLayer(): void {
    const host = this.host;
    if (!host) return;
    if (this.layer) host.terrain.removeFoliageLayer(this.layer.key);
    const clone = (m: Model) => new Model(m.geometry, m.material);
    const all = this.levels.map((parts, i) => ({ models: parts.map(p => clone(p.model)), distance: this.distances[i] ?? 0 }));
    const forced = this.lod === 'auto' ? null : Math.min(this.lod, all.length - 1);
    const levels = forced === null ? all : [{ models: all[forced].models, distance: 0 }];
    const layer = FoliageLayer.Mesh(`${PREFIX}${this.assetName}`, levels[0].models[0], { minScale: 1, maxScale: 1 });
    layer.levels = levels;
    layer.cullDistance = forced === null ? this.cull : 0;
    layer.castShadows = true;
    this.copies.forEach((o, ci) => layer.pushInstance(o[0], o[1], o[2], ci > 0 ? ((ci * 137.5) % 360) * Math.PI / 180 : 0, 1));
    layer.commit();
    host.terrain.addFoliage(layer);
    this.layer = layer;
  }

  /** Show one level, or let distance pick (with the asset's own distances and cull). */
  setLod(lod: LodView): void {
    const changed = lod !== this.lod;
    this.lod = lod;
    if (this.host && changed) this.buildLayer();
    for (const g of this.groups) {
      if (lod === 'auto') {
        g.distances = [...this.distances];
        g.cullDistance = this.cull;
      } else {
        // Only the chosen level's threshold is reachable; every other one is out of range.
        g.distances = this.distances.map((_, i) => (i === lod ? 0 : 1e9));
        g.cullDistance = 0;
      }
    }
  }

  setWireframe(on: boolean): void {
    this.wireframe = on;
    for (const m of this.materials) m.config.wireframe = on;
  }

  /** The active level of the first copy, for the overlay. */
  activeLod(): { level: number; culled: boolean } | null {
    if (this.layer) {
      const cell = this.layer.cells[0];
      if (!cell) return null;
      const level = this.lod === 'auto' ? cell.lod : this.lod;
      return { level: Math.min(level, this.levels.length - 1), culled: !cell.visible };
    }
    const g = this.groups[0];
    return g ? { level: g.activeLod, culled: g.distanceCulled } : null;
  }

  /** Take the asset off the stage (either mode), keeping what was loaded. */
  private removePresentation(): void {
    if (this.root) this.world.removeNode(this.root);
    this.root = null;
    this.groups = [];
    if (this.host) {
      this.world.removeNode(this.host);
      // Disposes the layer too: its instance buffers and its own Models (never the shared materials).
      this.host.terrain.dispose();
    }
    this.host = null;
    this.layer = null;
  }

  private clear(): void {
    this.removePresentation();
    this.levels = [];
    for (const id of this.textureIds) TextureManager.Instance.removeTexture(id);
    this.textureIds = [];
    this.materials = [];
  }

  dispose(): void {
    this.generation++;
    this.clear();
    const world = this.world;
    for (const n of [this.ground, this.sky, this.skyLight, this.wind]) if (n) world.removeNode(n);
    this.ground = this.sky = this.skyLight = null;
    this.wind = null;
    const s = this.saved;
    const light = this.sun?.light as DirectionalLight | undefined;
    if (light && s.sunIntensity !== null) light.intensity = s.sunIntensity;
    if (this.sun && s.sunRotation) this.sun.setRotation(s.sunRotation);
    world.ambientLight = s.ambient;
    const r = this.engine.renderer;
    r.autoExposureEnabled = s.autoExposure;
    if (!s.autoExposure) r.exposure = s.exposure;
    r.setGridVisible(true);
  }
}

/** Clump positions for a grass patch: a jittered disc, `spacing` apart. */
export function patchOffsets(spacing: number, rings = 3): [number, number, number][] {
  const out: [number, number, number][] = [[0, 0, 0]];
  for (let y = -rings; y <= rings; y++) for (let x = -rings; x <= rings; x++) {
    if (x === 0 && y === 0) continue;
    if (x * x + y * y > rings * rings + 1) continue;
    const jx = Math.sin((x * 12.9898 + y * 78.233) * 43758.5453) % 1, jz = Math.sin((x * 39.3468 + y * 11.135) * 24634.6345) % 1;
    out.push([(x + jx * 0.35) * spacing, 0, (y + jz * 0.35) * spacing]);
  }
  return out;
}
