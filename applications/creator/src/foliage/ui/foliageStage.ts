import {
  DirectionalLight, Geometry, GLTFLoader, Loader, LodGroupNode, Material, Model, ModelNode, Node, SkyAtmosphereNode, SkyLightNode,
  TextureManager, type CleoEngine, type LightNode, type Scene,
} from 'cleo';
import { vec3 } from 'gl-matrix';
import { aimSun } from '../../fx/ui/fxPreview';
import type { FoliageBuild } from '../foliageClient';

// The Foliage Creator's preview stage: a ground, the sun, an optional physical sky, and the generated
// asset as a real LodGroupNode -- one child per level, switched by the renderer exactly as in a game.
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
}

export const DEFAULT_STAGE: StageSettings = {
  grid: true, ground: true, sky: true, patch: true, wireframe: false,
  sunYaw: 35, sunElevation: 40, sunLux: 60000, ambientLux: 6000,
};

export class FoliageStage {
  private ground: ModelNode | null = null;
  private sky: SkyAtmosphereNode | null = null;
  private skyLight: SkyLightNode | null = null;
  private root: Node | null = null;
  private groups: LodGroupNode[] = [];
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
    this.setWireframe(s.wireframe);
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
    const root = new Node(PREFIX + 'asset');
    copies.forEach((offset, ci) => {
      const group = new LodGroupNode(`${PREFIX}${build.summary.name} ${ci}`);
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
    this.setWireframe(this.wireframe);
  }

  /** Show one level, or let distance pick (with the asset's own distances and cull). */
  setLod(lod: LodView): void {
    this.lod = lod;
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
    const g = this.groups[0];
    return g ? { level: g.activeLod, culled: g.distanceCulled } : null;
  }

  private clear(): void {
    if (this.root) this.world.removeNode(this.root);
    this.root = null;
    this.groups = [];
    for (const id of this.textureIds) TextureManager.Instance.removeTexture(id);
    this.textureIds = [];
    this.materials = [];
  }

  dispose(): void {
    this.generation++;
    this.clear();
    const world = this.world;
    for (const n of [this.ground, this.sky, this.skyLight]) if (n) world.removeNode(n);
    this.ground = this.sky = this.skyLight = null;
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
