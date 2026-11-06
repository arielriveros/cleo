// The World Creator's preview stage: the landscape, textured with the engine's own splat stack exactly as
// an imported one is (one TerrainMaterial, a paint-only slot per surface, the masks written from the
// rules), the water over it, the sun and an optional sky. Generated PBR materials show the surfaces;
// they and the water are preview only, never exported.
//
// Every node and texture is owned by the stage and released by `dispose()`, which also puts the shared
// engine's sun, ambient and grid back for the other tools. A landscape that is replaced is disposed, not
// just detached: a terrain holds its mask and surface arrays on the GPU.

import {
  CustomMaterial, defaultBlendRule, Geometry, LandscapeNode, Material, Model, ModelNode, setTerrainSurfaceFrom, SkyAtmosphereNode,
  SkyLightNode, Terrain, TerrainMaterial, Texture, TextureManager,
  type CameraNode, type CleoEngine, type DirectionalLight, type LightNode, type Scene, type TerrainMaterialSlot,
} from 'cleo';
import { vec3 } from 'gl-matrix';
import { ensureWgslTranslator } from '@cleo/app-kit/engine/wgslTranslator';
import { aimSun } from '../../fx/ui/fxPreview';
import { encodePngRgba8 } from '../../core/png';
import { requestSurface } from '../../surfaces/surfaceClient';
import type { SurfaceKind } from '../../surfaces/kinds';
import { sampleBilinear } from '../features';
import type { PreviewResult } from '../worldWorker';
import { PREVIEW_QUALITY, type PreviewQuality, type WorldDoc } from '../worldDoc';
import type { SurfaceLayer } from '../surfaces/surfaceDoc';
import type { WaterLook } from '../water/waterLook';
import { buildWaterMesh } from '../water/waterMesh';
import { waterNormalMap } from '../water/waterNormals';
import { WATER_SOURCE, WATER_UNIFORMS } from '../water/waterShader';

const PREFIX = '__creator_world_';
/** Generated surface textures, texels per side. */
const SURFACE_TEXTURE_SIZE = 512;
/** Shore distances the water's height texture can tell apart, m. */
const SHORE_RANGE = 120;

export interface WorldStageSettings {
  grid: boolean;
  water: boolean;
  sky: boolean;
  sunYaw: number;
  sunElevation: number;
}

export const DEFAULT_WORLD_STAGE: WorldStageSettings = { grid: false, water: true, sky: true, sunYaw: 35, sunElevation: 38 };

/** Daylight in real units (the engine's lights are photometric), with auto exposure as the camera. */
const SUN_LUX = 60000;
const AMBIENT_LUX = 6000;

interface SurfaceTextures { albedo: string; normal: string; orm: string; height: string }

export class WorldStage {
  private landscape: LandscapeNode | null = null;
  private builtFor = { size: 0, quality: '' as PreviewQuality | '' };
  private water: ModelNode | null = null;
  private waterMaterial: CustomMaterial | null = null;
  private waterGeometryKey = '';
  private heightTextureId: string | null = null;
  private normalTextureId: string | null = null;
  private sky: SkyAtmosphereNode | null = null;
  private skyLight: SkyLightNode | null = null;
  /** Texture ids per generated kind (kept for the session: the kinds are few and switching back is instant). */
  private kinds = new Map<SurfaceKind, Promise<SurfaceTextures>>();
  private textureIds: string[] = [];
  private materialKey = '';
  private lastResult: PreviewResult | null = null;
  private lastDoc: WorldDoc | null = null;
  private generation = 0;
  private settings: WorldStageSettings = { ...DEFAULT_WORLD_STAGE };
  private disposed = false;
  /** On WebGPU the water's GLSL needs naga before its first draw (a first draw without it is never retried). */
  private translator: 'idle' | 'loading' | 'ready' = 'idle';
  private readonly saved: { sunIntensity: number | null; sunRotation: vec3 | null; ambient: vec3; grid: boolean; autoExposure: boolean; exposure: number };

  constructor(private engine: CleoEngine, private scene: Scene, private sun: LightNode | null) {
    const light = sun?.light as DirectionalLight | undefined;
    this.saved = {
      sunIntensity: light ? light.intensity : null,
      sunRotation: sun ? vec3.clone(sun.rotation) : null,
      ambient: vec3.clone(scene.ambientLight),
      grid: engine.renderer.gridVisible,
      autoExposure: engine.renderer.autoExposureEnabled,
      exposure: engine.renderer.exposure,
    };
    engine.renderer.autoExposureEnabled = true;
    scene.ambientLight = vec3.fromValues(AMBIENT_LUX, AMBIENT_LUX, AMBIENT_LUX);
    if (light) light.intensity = SUN_LUX;
  }

  /** The stage settings (sun, sky, grid, water visibility). */
  apply(s: WorldStageSettings): void {
    this.settings = { ...s };
    if (this.sun) aimSun(this.sun, { lightYaw: s.sunYaw, lightElevation: s.sunElevation });
    this.engine.renderer.setGridVisible(s.grid);
    if (s.sky && !this.sky) {
      this.sky = new SkyAtmosphereNode(PREFIX + 'sky', { useSceneSun: true });
      this.skyLight = new SkyLightNode(PREFIX + 'sky light', {});
      this.scene.addNode(this.sky);
      this.scene.addNode(this.skyLight);
    } else if (!s.sky && this.sky) {
      this.scene.removeNode(this.sky);
      if (this.skyLight) this.scene.removeNode(this.skyLight);
      this.sky = this.skyLight = null;
    }
    if (this.water) this.water.visible = s.water;
  }

  /** Show a preview: heights, surfaces and water. Material work is asynchronous (textures generate in a worker). */
  show(result: PreviewResult, doc: WorldDoc): void {
    if (this.disposed) return;
    this.lastResult = result;
    this.lastDoc = doc;
    const quality = doc.preview.quality;
    const q = PREVIEW_QUALITY[quality];
    const { size, heightScale, resolution } = result.out.frame;
    if (!this.landscape || this.builtFor.size !== size || this.builtFor.quality !== quality || !this.scene.getNodesByName(PREFIX + 'landscape').length) {
      this.disposeLandscape();
      this.landscape = new LandscapeNode(PREFIX + 'landscape', new Terrain({ size, resolution: q.heights, chunkQuads: 32, maskResolution: q.masks }));
      this.scene.addNode(this.landscape);
      this.builtFor = { size, quality };
      this.materialKey = '';
    }
    const R = q.heights;
    const heights = new Float32Array(R * R);
    for (let r = 0; r < R; r++) for (let c = 0; c < R; c++)
      heights[r * R + c] = sampleBilinear(result.out.heights, resolution, c / (R - 1), r / (R - 1)) * heightScale;
    this.landscape.terrain.setHeights(heights);
    void this.updateMaterial(doc, result);
    this.updateWater(result, doc);
  }

  /** The look of the water changed (no new terrain). */
  setWaterLook(look: WaterLook): void {
    if (this.waterMaterial) writeLook(this.waterMaterial, look);
  }

  /** Re-apply the surfaces' preview materials (a tint or tiling edit), keeping the masks. */
  refreshMaterials(doc: WorldDoc): void {
    if (this.lastResult) { this.lastDoc = doc; void this.updateMaterial(doc, this.lastResult); }
  }

  get terrain(): Terrain | null { return this.landscape?.terrain ?? null; }

  private texturesFor(kind: SurfaceKind): Promise<SurfaceTextures> {
    let p = this.kinds.get(kind);
    if (!p) {
      p = requestSurface(kind, SURFACE_TEXTURE_SIZE, 1).then(png => {
        const add = (bytes: Uint8Array, role: string) => {
          const id = TextureManager.Instance.addTextureFromBytes(bytes, 'image/png', { wrapping: 'repeat', mipMap: true }, `${PREFIX}${kind}_${role}`)!;
          this.textureIds.push(id);
          return id;
        };
        return { albedo: add(png.albedo, 'albedo'), normal: add(png.normal, 'normal'), orm: add(png.orm, 'orm'), height: add(png.height, 'height') };
      });
      this.kinds.set(kind, p);
    }
    return p;
  }

  private async updateMaterial(doc: WorldDoc, result: PreviewResult): Promise<void> {
    const terrain = this.landscape?.terrain;
    if (!terrain) return;
    const gen = ++this.generation;
    const size = result.out.frame.size;
    const surfaces = doc.surfaces;
    const enabled = surfaces.map((s, i) => ({ s, i })).filter(({ s, i }) => i === 0 || s.enabled);
    const key = JSON.stringify([size, enabled.map(({ s }) => [s.id, s.name, s.preview])]);
    if (key !== this.materialKey) {
      const textures = await Promise.all(enabled.map(({ s }) => this.texturesFor(s.preview.kind)));
      if (gen !== this.generation || this.disposed || terrain !== this.landscape?.terrain) return;
      const materials = enabled.map(({ s }, k) => surfaceMaterial(s, textures[k]));
      const tm = TerrainMaterial.Create('pbr', { baseColor: [1, 1, 1], roughness: 1, metallic: 0 });
      setTerrainSurfaceFrom(tm, materials[0]);
      tm.tiling = size / Math.max(0.25, enabled[0].s.preview.tiling);
      tm.antiTiling = 0.5;
      tm.slots = enabled.slice(1).map(({ s }, k): TerrainMaterialSlot => ({
        // The slot id IS the surface id, so a re-assigned material keeps every mask channel.
        id: s.id, name: s.name, material: materials[k + 1], surfaceMaterialId: null,
        tiling: size / Math.max(0.25, s.preview.tiling),
        rule: { ...defaultBlendRule(), heightBlend: s.preview.heightBlend },
        allowFoliage: false, manual: true, antiTiling: 0.5,
      }));
      terrain.layerStack.setBase(tm, null);
      this.materialKey = key;
    }
    if (gen !== this.generation) return;
    // The masks: each surface's alpha plane into its slot's channel.
    const { alphas, size: M } = result.surfaces;
    for (const { s, i } of enabled) {
      if (i === 0) continue;
      const a = alphas[i];
      if (a) terrain.layerStack.writeChannel(s.id, a, M);
    }
  }

  private updateWater(result: PreviewResult, doc: WorldDoc): void {
    if (this.translator !== 'ready') {
      if (this.engine.renderer.backend !== 'webgpu') this.translator = 'ready';
      else {
        if (this.translator === 'idle') {
          this.translator = 'loading';
          void ensureWgslTranslator().then(() => {
            this.translator = 'ready';
            if (!this.disposed && this.lastResult && this.lastDoc) this.updateWater(this.lastResult, this.lastDoc);
          });
        }
        return;
      }
    }
    const water = result.fields.water;
    const size = result.out.frame.size;
    const key = `${size}:${water.resolution}:${hashLevels(water.level)}`;
    if (key !== this.waterGeometryKey) {
      this.waterGeometryKey = key;
      if (this.water) { this.scene.removeNode(this.water); this.water = null; }
      const mesh = buildWaterMesh(water, size);
      if (mesh) {
        const material = this.waterMaterial ?? this.makeWaterMaterial();
        const geometry = new Geometry(mesh.positions, mesh.normals, mesh.uvs, mesh.tangents, mesh.bitangents, mesh.indices, false);
        this.water = new ModelNode(PREFIX + 'water', new Model(geometry, material));
        this.water.visible = this.settings.water;
        this.scene.addNode(this.water);
      }
    }
    if (this.waterMaterial) {
      this.updateHeightTexture(result);
      writeLook(this.waterMaterial, doc.preview.water);
    }
  }

  private makeWaterMaterial(): CustomMaterial {
    const m = CustomMaterial.Create('pbr', 'forward', { transparent: true, side: 'double', castShadow: false, probeable: false });
    m.fragmentSource = WATER_SOURCE;
    m.uniforms = WATER_UNIFORMS.map(u => ({ ...u }));
    for (const u of m.uniforms) if (u.type !== 'sampler2D') m.properties.set(u.name, Array.isArray(u.value) ? [...u.value] : u.value);
    m.refreshType();
    if (!this.normalTextureId) {
      const id = `${PREFIX}water_normal`;
      void encodePngRgba8(256, 256, waterNormalMap(256, 1337)).then(png => {
        if (this.disposed) return;
        TextureManager.Instance.addTextureFromBytes(png, 'image/png', { wrapping: 'repeat', mipMap: true }, id);
      });
      this.normalTextureId = id;
      this.textureIds.push(id);
    }
    m.textures.set('normalMap', this.normalTextureId);
    this.waterMaterial = m;
    return m;
  }

  /** The terrain under the water, for its depth: height in R/G (16 bits), signed shore distance in B. */
  private updateHeightTexture(result: PreviewResult): void {
    const f = result.fields;
    const R = f.resolution;
    let lo = Infinity, hi = -Infinity;
    for (const v of f.heightM) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const span = hi - lo || 1;
    const data = new Uint8Array(R * R * 4);
    for (let i = 0; i < R * R; i++) {
      const v = Math.round(((f.heightM[i] - lo) / span) * 65535);
      data[i * 4] = v >> 8;
      data[i * 4 + 1] = v & 255;
      data[i * 4 + 2] = Math.round((0.5 + 0.5 * Math.max(-1, Math.min(1, f.shoreDistance[i] / SHORE_RANGE))) * 255);
      data[i * 4 + 3] = 255;
    }
    // A fresh texture each time (the grid size can change); no mips -- the shader decodes exact texels.
    if (this.heightTextureId) TextureManager.Instance.removeTexture(this.heightTextureId);
    const t = new Texture({ mipMap: false, wrapping: 'clamp' });
    t.createFromData(data, R, R, 'clamp');
    const id = `${PREFIX}water_ground_${++heightCounter}`;
    TextureManager.Instance.addTexture(t, id);
    this.heightTextureId = id;
    const m = this.waterMaterial!;
    m.textures.set('terrainHeight', id);
    // Vertex-aligned samples: the texture's edge texel centres sit half a texel inside the map.
    m.properties.set('terrainSize', f.size * R / (R - 1));
    m.properties.set('terrainMin', lo);
    m.properties.set('terrainMax', hi);
    m.properties.set('shoreRange', SHORE_RANGE);
  }

  private disposeLandscape(): void {
    if (!this.landscape) return;
    this.scene.removeNode(this.landscape);
    this.landscape.terrain.dispose();
    this.landscape = null;
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.disposeLandscape();
    for (const n of [this.water, this.sky, this.skyLight]) if (n) this.scene.removeNode(n);
    this.water = this.sky = this.skyLight = null;
    for (const id of this.textureIds) TextureManager.Instance.removeTexture(id);
    if (this.heightTextureId) TextureManager.Instance.removeTexture(this.heightTextureId);
    this.textureIds = [];
    this.kinds.clear();
    const s = this.saved;
    const light = this.sun?.light as DirectionalLight | undefined;
    if (light && s.sunIntensity !== null) light.intensity = s.sunIntensity;
    if (this.sun && s.sunRotation) this.sun.setRotation(s.sunRotation);
    this.scene.ambientLight = s.ambient;
    const r = this.engine.renderer;
    r.setGridVisible(s.grid);
    r.autoExposureEnabled = s.autoExposure;
    if (!s.autoExposure) r.exposure = s.exposure;
  }
}

let heightCounter = 0;

/** A surface's preview material: the generated maps, tinted. Each slot gets its own instance. */
function surfaceMaterial(s: SurfaceLayer, t: SurfaceTextures): Material {
  return Material.PBR({
    baseColor: [...s.preview.tint], metallic: 0, roughness: 1,
    textures: { baseColorTexture: t.albedo, normalMap: t.normal, roughnessMap: t.orm, metallicMap: t.orm, occlusionMap: t.orm, displacementMap: t.height },
  });
}

function writeLook(m: CustomMaterial, look: WaterLook): void {
  const yaw = (look.windDirection * Math.PI) / 180;
  m.properties.set('shallowColor', [...look.shallowColor]);
  m.properties.set('deepColor', [...look.deepColor]);
  m.properties.set('absorption', [...look.absorption]);
  m.properties.set('clarity', look.clarity);
  m.properties.set('waveScale', look.waveScale);
  m.properties.set('waveStrength', look.waveStrength);
  // Compass degrees (0 north = -Z, 90 east = +X) to an xz direction.
  m.properties.set('windDir', [Math.sin(yaw), -Math.cos(yaw)]);
  m.properties.set('windSpeed', look.windSpeed);
  m.properties.set('foam', look.foam);
  m.properties.set('roughness', look.roughness);
  m.properties.set('skyHorizon', [...look.skyHorizon]);
  m.properties.set('skyZenith', [...look.skyZenith]);
}

function hashLevels(level: Float32Array): string {
  let h = 0x811c9dc5;
  const view = new Uint32Array(level.buffer, level.byteOffset, level.length);
  for (let i = 0; i < view.length; i += 7) { h ^= view[i]; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

/** Park the camera where the whole map is in view. */
export function frameWorld(camera: CameraNode, size: number, heightScale: number): void {
  camera.setPosition([0, Math.max(heightScale * 1.5, size * 0.45), size * 0.75]).setRotation([32, 180, 0]);
}
