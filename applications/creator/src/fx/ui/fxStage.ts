import {
  DecalNode, DirectionalLight, Geometry, LIGHT_UNIT, LightNode, Material, Model, ModelNode, Node, PointLight, Shape, TextureManager,
  SkyAtmosphereNode, SkyLightNode, WindNode, type CleoEngine, type Scene,
} from 'cleo';
import { quat, vec3 } from 'gl-matrix';
import type { FxParams } from '../fxParams';
import { kelvinToRgb, type FxBody, type FxScene } from '../fxScene';
import type { FireLight } from '../liveSim';
import type { FloorDecal } from '../liveLiquid';
import { aimSun } from './fxPreview';
import { StageFloor } from '../../app/floor/stageFloor';

// The FX Creator's preview stage, built from an FxScene: the sun and its colour, ambient, an optional
// physical sky, exposure, the grid and a ground plane, a WindNode, a point light that follows the fire,
// and the placed bodies -- real engine models with static physics bodies. Every node here is owned by
// the stage and removed by `dispose()`.

const PREFIX = 'FX stage · ';
const BODY_COLOR: [number, number, number] = [0.55, 0.56, 0.6];
const EMITTER_COLOR: [number, number, number] = [1, 0.55, 0.15];
const REGION_COLOR: [number, number, number] = [0.3, 0.9, 0.9];
/** The region's box while it is selected (its face handles are out): brighter, so it reads as the one edited. */
const REGION_SELECTED_COLOR: [number, number, number] = [0.85, 1, 1];

/** One arrow of the emitter's aim: where it starts, the unit direction it points, its length. */
export interface AimArrow { from: [number, number, number]; dir: [number, number, number]; length: number }

interface BodyEntry { body: FxBody; node: ModelNode; key: string }

/** What changes a body's mesh and collider (as opposed to only its transform). */
const shapeKey = (b: FxBody) => `${b.kind}:${b.size.map(v => v.toFixed(3)).join(',')}`;

export class FxStage {
  private bodies = new Map<string, BodyEntry>();
  private floor: StageFloor | null = null;
  /** The simulation region's wireframe box. */
  private region: ModelNode | null = null;
  /**
   * The region's handle: an unscaled node at its centre, which its move gizmo and face handles drive
   * (the wireframe is scaled to the region, and the volume node follows the liquid, not the region).
   */
  private regionAnchor: Node | null = null;
  private wind: WindNode | null = null;
  private sky: SkyAtmosphereNode | null = null;
  private skyLight: SkyLightNode | null = null;
  private fire: LightNode | null = null;
  /**
   * The emitter's marker: a see-through sphere the gizmo moves. Ordinary transparent scene content rather
   * than editor chrome, so it is drawn over the smoke at partial opacity instead of hiding the flame.
   */
  private emitter: ModelNode | null = null;
  /** The aim's arrows (a shaft and a head each): where a liquid is thrown. */
  private arrows: { shaft: ModelNode; head: ModelNode }[] = [];
  private regionSelected = false;
  /** The effect's ground shadow: a decal darkening the floor through the shadow texture. */
  private shadow: DecalNode | null = null;
  private shadowTextureId: string | null = null;
  /** The texture registered under `shadowTextureId`: a rebuilt simulation brings a new one (the old is freed). */
  private shadowTexture: import('cleo/graphics/texture').Texture | null = null;
  /** A liquid's film on the floor: a decal drawing its colour, normal and ORM maps. */
  private film: DecalNode | null = null;
  private filmTextureIds: string[] = [];
  private filmTextures: unknown[] = [];
  private flicker = 1;
  private scene: FxScene | null = null;

  /** What the stage changes on the shared engine, put back by `dispose()` for the other tools. */
  private readonly saved: {
    sunIntensity: number | null; sunColor: vec3 | null; sunRotation: vec3 | null;
    ambient: vec3; autoExposure: boolean; exposure: number;
  };

  constructor(private engine: CleoEngine, private world: Scene, private sun: LightNode | null) {
    const light = sun?.light as DirectionalLight | undefined;
    this.saved = {
      sunIntensity: light ? light.intensity : null,
      sunColor: light ? vec3.clone(light.color) : null,
      sunRotation: sun ? vec3.clone(sun.rotation) : null,
      ambient: vec3.clone(world.ambientLight),
      autoExposure: engine.renderer.autoExposureEnabled,
      exposure: engine.renderer.exposure,
    };
  }

  /** Bring the stage in line with `scene` (and, for the sun, the effect's own light). */
  apply(scene: FxScene, params: FxParams): void {
    this.scene = scene;
    const r = this.engine.renderer;
    const world = this.world;

    // --- Sun & sky ---
    if (this.sun) {
      aimSun(this.sun, params);
      const light = this.sun.light as DirectionalLight;
      light.intensity = Math.max(0, scene.sunLux);
      const c = kelvinToRgb(scene.sunKelvin);
      light.color = vec3.fromValues(c[0], c[1], c[2]);
    }
    world.ambientLight = vec3.fromValues(scene.ambientLux, scene.ambientLux, scene.ambientLux);
    if (scene.sky && !this.sky) {
      this.sky = new SkyAtmosphereNode(PREFIX + 'sky', { useSceneSun: true });
      this.skyLight = new SkyLightNode(PREFIX + 'sky light', {});
      world.addNode(this.sky);
      world.addNode(this.skyLight);
    } else if (!scene.sky && this.sky) {
      world.removeNode(this.sky);
      if (this.skyLight) world.removeNode(this.skyLight);
      this.sky = null;
      this.skyLight = null;
    }
    r.autoExposureEnabled = scene.autoExposure;
    if (!scene.autoExposure) r.ev100 = scene.ev100;

    // --- Ground ---
    r.setGridVisible(scene.grid);
    this.floor ??= new StageFloor(world, { color: [0.32, 0.31, 0.29], size: 60, name: PREFIX + 'ground' });
    this.floor.configure({ set: scene.floorSet, tile: scene.floorTile, wetness: 0, snow: 0 });
    this.floor.show(scene.groundPlane);

    // --- Wind ---
    if (scene.wind && !this.wind) {
      this.wind = new WindNode(PREFIX + 'wind');
      world.addNode(this.wind);
    } else if (!scene.wind && this.wind) {
      world.removeNode(this.wind);
      this.wind = null;
    }
    if (this.wind) {
      this.wind.direction = scene.windDirection;
      this.wind.strength = scene.windStrength;
      this.wind.gustScale = scene.windGustScale;
      this.wind.gustSpeed = scene.windGustSpeed;
    }

    // --- Fire light ---
    if (scene.fireLight && !this.fire) {
      this.fire = new LightNode(PREFIX + 'fire light', new PointLight({ unit: LIGHT_UNIT, intensity: 0, range: 12, color: vec3.fromValues(1, 0.55, 0.2) }));
      world.addNode(this.fire);
    } else if (!scene.fireLight && this.fire) {
      world.removeNode(this.fire);
      this.fire = null;
    }

    // --- Bodies ---
    const wanted = new Set(scene.bodies.map(b => b.id));
    for (const [id, entry] of this.bodies) {
      if (!wanted.has(id)) { world.removeNode(entry.node); this.bodies.delete(id); }
    }
    for (const b of scene.bodies) {
      let entry = this.bodies.get(b.id);
      const key = shapeKey(b);
      if (entry && entry.key !== key) { world.removeNode(entry.node); this.bodies.delete(b.id); entry = undefined; }
      if (!entry) {
        entry = { body: b, node: makeBody(b), key };
        world.addNode(entry.node);
        this.bodies.set(b.id, entry);
      }
      entry.body = b;
      entry.node.visible = b.visible && scene.showHelpers !== false;
      // A static body follows its node, so moving the node moves the collider too.
      entry.node.setPosition([...b.position]).setRotation([b.pitch, b.yaw, 0]);
    }
  }

  /**
   * Show (or hide) the emitter marker at a world position with a world radius. `rotation` turns it: a
   * liquid's marker carries its aim, which the rotate gizmo turns (see FxGizmos `quatFromAim`).
   */
  showEmitter(position: [number, number, number] | null, radius: number, rotation?: quat): void {
    if (!position) {
      if (this.emitter) { this.world.removeNode(this.emitter); this.emitter = null; }
      return;
    }
    if (!this.emitter) {
      this.emitter = new ModelNode(PREFIX + 'emitter', new Model(Geometry.Sphere(16, 1), Material.Basic({ color: EMITTER_COLOR, opacity: 0.25 }, { transparent: true })));
      this.world.addNode(this.emitter);
    }
    this.emitter.setPosition(position).setScale([radius, radius, radius]);
    this.emitter.setQuaternion(rotation ?? quat.create());
  }

  /** Draw the aim: an arrow per entry (one along a liquid's aim; one per side of a crown), or none. */
  showAim(arrows: readonly AimArrow[]): void {
    while (this.arrows.length > arrows.length) {
      const a = this.arrows.pop()!;
      this.world.removeNode(a.shaft);
      this.world.removeNode(a.head);
    }
    while (this.arrows.length < arrows.length) {
      const material = () => Material.Basic({ color: EMITTER_COLOR, opacity: 0.85 }, { transparent: true, castShadow: false });
      const a = {
        shaft: new ModelNode(PREFIX + 'aim', new Model(Geometry.Cylinder(10, 1, 1), material())),
        head: new ModelNode(PREFIX + 'aim head', new Model(Geometry.Cone(14, 0.5, 1), material())),
      };
      this.world.addNode(a.shaft);
      this.world.addNode(a.head);
      this.arrows.push(a);
    }
    arrows.forEach((arrow, i) => {
      const { shaft, head } = this.arrows[i];
      // The geometry stands along +Y: turn it onto the arrow's direction.
      const q = quat.rotationTo(quat.create(), [0, 1, 0], arrow.dir);
      const L = arrow.length, headLength = L * 0.3, shaftLength = L - headLength;
      const along = (t: number): [number, number, number] => [arrow.from[0] + arrow.dir[0] * t, arrow.from[1] + arrow.dir[1] * t, arrow.from[2] + arrow.dir[2] * t];
      shaft.setPosition(along(shaftLength / 2)).setQuaternion(q).setScale([L * 0.025, shaftLength, L * 0.025]);
      head.setPosition(along(shaftLength + headLength / 2)).setQuaternion(q).setScale([L * 0.16, headLength, L * 0.16]);
    });
  }

  /**
   * Draw the region's wireframe box (`origin` its min corner, `size` its extent, metres), or hide it.
   * `selected` draws it brighter: its face handles are out.
   */
  showRegion(origin: [number, number, number] | null, size: [number, number, number], selected = false): void {
    if (!origin) {
      if (this.region) { this.world.removeNode(this.region); this.region = null; }
      return;
    }
    this.placeRegionAnchor(origin, size);
    if (this.region && selected !== this.regionSelected) { this.world.removeNode(this.region); this.region = null; }
    if (!this.region) {
      const model = new Model(Geometry.Cube(1, 1, 1, true), Material.Basic({ color: selected ? REGION_SELECTED_COLOR : REGION_COLOR }, { wireframe: true, castShadow: false }));
      this.region = new ModelNode(PREFIX + 'region', model);
      this.world.addNode(this.region);
      this.regionSelected = selected;
    }
    this.region.setPosition([origin[0] + size[0] / 2, origin[1] + size[1] / 2, origin[2] + size[2] / 2]).setScale([...size]);
  }

  /**
   * Lay the effect's shadow on the floor: a decal over `placement` drawing `texture` (darkening in alpha)
   * into the floor's albedo, or nothing when the scene turns it off.
   */
  updateShadow(texture: import('cleo/graphics/texture').Texture | null, placement: { center: [number, number, number]; size: number } | null): void {
    const scene = this.scene;
    if (!scene?.effectShadow || !texture || !placement) {
      if (this.shadow) { this.world.removeNode(this.shadow); this.shadow = null; }
      return;
    }
    if (!this.shadow || !this.shadowTextureId || texture !== this.shadowTexture) {
      // A new simulation (a restart, the GPU switch) frees its old shadow texture: the decal must not keep
      // drawing it, or every frame's submit fails on a destroyed texture.
      if (this.shadow) { this.world.removeNode(this.shadow); this.shadow = null; }
      if (this.shadowTextureId) TextureManager.Instance.removeTexture(this.shadowTextureId);
      this.shadowTextureId = TextureManager.Instance.addTexture(texture, 'fx.groundShadow');
      this.shadowTexture = texture;
      this.shadow = new DecalNode(PREFIX + 'shadow', {
        size: [1, 1, 1],
        material: Material.PBR({ baseColor: [0, 0, 0], roughness: 1, textures: { baseColorTexture: this.shadowTextureId } }),
        affects: { albedo: true, normal: false, surface: false, emissive: false },
      });
      this.world.addNode(this.shadow);
    }
    this.shadow.size = [placement.size, 1, placement.size];
    this.shadow.opacity = Math.min(1, Math.max(0, scene.effectShadowStrength));
    this.shadow.setPosition([placement.center[0], placement.center[1], placement.center[2]]);
  }

  /**
   * Lay a liquid's film on the floor: a decal over its square drawing the film's maps (the same ones a
   * bake writes for the floor decal), or nothing.
   */
  updateFloorDecal(film: FloorDecal | null): void {
    if (!film) {
      if (this.film) { this.world.removeNode(this.film); this.film = null; }
      for (const id of this.filmTextureIds) TextureManager.Instance.removeTexture(id);
      this.filmTextureIds = [];
      this.filmTextures = [];
      return;
    }
    const textures = [film.color, film.normal, film.orm];
    if (!this.film || textures.some((t, i) => t !== this.filmTextures[i])) {
      if (this.film) this.world.removeNode(this.film);
      for (const id of this.filmTextureIds) TextureManager.Instance.removeTexture(id);
      this.filmTextureIds = textures.map((t, i) => TextureManager.Instance.addTexture(t, `fx.film.${i}`));
      this.filmTextures = textures;
      const [color, normal, orm] = this.filmTextureIds;
      this.film = new DecalNode(PREFIX + 'liquid film', {
        size: [1, 1, 1],
        material: Material.PBR({ baseColor: [1, 1, 1], roughness: 1, metallic: 0,
          textures: { baseColorTexture: color, normalMap: normal, roughnessMap: orm, metallicMap: orm, occlusionMap: orm } }),
        affects: { albedo: true, normal: true, surface: true, emissive: false },
        angleFade: 0.3, depthFade: 0.1,
      });
      this.world.addNode(this.film);
    }
    this.film.size = [film.size[0], 0.4, film.size[1]];
    this.film.albedoOpacity = film.albedoOpacity;
    this.film.setPosition([film.center[0], film.center[1], film.center[2]]);
  }

  /** Stand the region's handle at the centre of the region (`origin` its low corner, `size` its extent). */
  placeRegionAnchor(origin: readonly number[], size: readonly number[]): void {
    if (!this.regionAnchor) {
      this.regionAnchor = new Node(PREFIX + 'region handle');
      this.world.addNode(this.regionAnchor);
    }
    this.regionAnchor.setPosition([origin[0] + size[0] / 2, origin[1] + size[1] / 2, origin[2] + size[2] / 2]);
  }
  get regionNode(): Node | null { return this.regionAnchor; }

  /** The node a selection's gizmo drives: a body's model, or the emitter marker. */
  bodyNode(id: string): ModelNode | null { return this.bodies.get(id)?.node ?? null; }
  get emitterNode(): ModelNode | null { return this.emitter; }
  /** Every pickable body model, for click-to-select. */
  bodyNodes(): { id: string; node: ModelNode }[] { return [...this.bodies.entries()].map(([id, e]) => ({ id, node: e.node })); }

  /** Follow the fire: the light sits at the flame's centre, as bright as the flame is big, flickering. */
  updateFire(fire: FireLight | null, params: FxParams): void {
    const node = this.fire;
    const scene = this.scene;
    if (!node || !scene) return;
    if (!fire) { (node.light as PointLight).intensity = 0; return; }
    // A smoothed random walk, so the flicker reads as fire rather than noise.
    this.flicker += (1 - scene.fireLightFlicker * Math.random() - this.flicker) * 0.35;
    node.setPosition([...fire.position]);
    const light = node.light as PointLight;
    light.intensity = scene.fireLightLumens * fire.strength * this.flicker;
    // Lit by the middle of the fire colour, not the white-hot core.
    const tint = params.fireColorMode === 'blackbody' ? kelvinToRgb((params.blackbodyMin + params.blackbodyMax) / 2) : [1, 0.55, 0.2];
    light.color = vec3.fromValues(tint[0], tint[1], tint[2]);
  }

  dispose(): void {
    const world = this.world;
    for (const entry of this.bodies.values()) world.removeNode(entry.node);
    this.bodies.clear();
    this.floor?.dispose();
    for (const n of [this.region, this.regionAnchor, this.wind, this.sky, this.skyLight, this.fire, this.emitter, this.shadow, this.film]) if (n) world.removeNode(n);
    this.regionAnchor = null;
    this.showAim([]);
    this.floor = null;
    this.region = this.wind = this.sky = this.skyLight = this.fire = this.emitter = this.shadow = this.film = null;
    if (this.shadowTextureId) { TextureManager.Instance.removeTexture(this.shadowTextureId); this.shadowTextureId = null; }
    this.shadowTexture = null;
    for (const id of this.filmTextureIds) TextureManager.Instance.removeTexture(id);
    this.filmTextureIds = [];
    this.filmTextures = [];
    const s = this.saved;
    const light = this.sun?.light as DirectionalLight | undefined;
    if (light && s.sunIntensity !== null) light.intensity = s.sunIntensity;
    if (light && s.sunColor) light.color = s.sunColor;
    if (this.sun && s.sunRotation) this.sun.setRotation(s.sunRotation);
    world.ambientLight = s.ambient;
    const r = this.engine.renderer;
    r.autoExposureEnabled = s.autoExposure;
    if (!s.autoExposure) r.exposure = s.exposure;
    r.setGridVisible(true);
  }
}

/** One placed body: the mesh, a matte material and a static collider the same shape. */
function makeBody(b: FxBody): ModelNode {
  const [sx, sy, sz] = b.size;
  let geometry: Geometry;
  switch (b.kind) {
    case 'sphere': geometry = Geometry.Sphere(32, sx / 2); break;
    case 'capsule': geometry = Geometry.Capsule(24, sx / 2, Math.max(0, sy - sx)); break;
    default: geometry = Geometry.Cube(sx, sy, sz);
  }
  const node = new ModelNode(PREFIX + b.kind, new Model(geometry, Material.PBR({ baseColor: BODY_COLOR, roughness: 0.7 })));
  node.setPosition([...b.position]).setRotation([b.pitch, b.yaw, 0]);
  const body = node.setBody(0);
  switch (b.kind) {
    case 'sphere': body.attachShape(Shape.Sphere(sx / 2)); break;
    case 'capsule':
      for (const part of Shape.Capsule(sx / 2, Math.max(0, sy - sx), 16)) body.attachShape(part.shape, part.offset);
      break;
    default: body.attachShape(Shape.Box(sx, sy, sz));
  }
  return node;
}
