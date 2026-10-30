import {
  DecalNode, DirectionalLight, Geometry, LIGHT_UNIT, LightNode, Material, Model, ModelNode, PointLight, Shape, TextureManager,
  SkyAtmosphereNode, SkyLightNode, WindNode, type CleoEngine, type Scene,
} from 'cleo';
import { vec3 } from 'gl-matrix';
import type { FxParams } from '../fxParams';
import { kelvinToRgb, type FxBody, type FxScene } from '../fxScene';
import type { FireLight } from '../liveSim';
import { aimSun } from './fxPreview';

// The FX Creator's preview stage, built from an FxScene: the sun and its colour, ambient, an optional
// physical sky, exposure, the grid and a ground plane, a WindNode, a point light that follows the fire,
// and the placed bodies -- real engine models with static physics bodies. Every node here is owned by
// the stage and removed by `dispose()`.

const PREFIX = 'FX stage · ';
const BODY_COLOR: [number, number, number] = [0.55, 0.56, 0.6];

interface BodyEntry { body: FxBody; node: ModelNode; key: string }

/** What changes a body's mesh and collider (as opposed to only its transform). */
const shapeKey = (b: FxBody) => `${b.kind}:${b.size.map(v => v.toFixed(3)).join(',')}`;

export class FxStage {
  private bodies = new Map<string, BodyEntry>();
  private ground: ModelNode | null = null;
  private wind: WindNode | null = null;
  private sky: SkyAtmosphereNode | null = null;
  private skyLight: SkyLightNode | null = null;
  private fire: LightNode | null = null;
  /**
   * The emitter's marker: a see-through sphere the gizmo moves. Ordinary transparent scene content rather
   * than editor chrome, so it is drawn over the smoke at partial opacity instead of hiding the flame.
   */
  private emitter: ModelNode | null = null;
  /** The effect's ground shadow: a decal darkening the floor through the shadow texture. */
  private shadow: DecalNode | null = null;
  private shadowTextureId: string | null = null;
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
    if (scene.groundPlane && !this.ground) {
      this.ground = new ModelNode(PREFIX + 'ground', new Model(Geometry.Plane(60, 60), Material.PBR({ baseColor: [0.32, 0.31, 0.29], roughness: 0.95 })));
      world.addNode(this.ground);
    } else if (!scene.groundPlane && this.ground) {
      world.removeNode(this.ground);
      this.ground = null;
    }

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
      entry.node.visible = b.visible;
      // A static body follows its node, so moving the node moves the collider too.
      entry.node.setPosition([...b.position]).setRotation([b.pitch, b.yaw, 0]);
    }
  }

  /** Show (or hide) the emitter marker at a world position with a world radius. */
  showEmitter(position: [number, number, number] | null, radius: number): void {
    if (!position) {
      if (this.emitter) { this.world.removeNode(this.emitter); this.emitter = null; }
      return;
    }
    if (!this.emitter) {
      this.emitter = new ModelNode(PREFIX + 'emitter', new Model(Geometry.Sphere(16, 1), Material.Basic({ color: [1, 0.55, 0.15], opacity: 0.25 }, { transparent: true })));
      this.world.addNode(this.emitter);
    }
    this.emitter.setPosition(position).setScale([radius, radius, radius]);
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
    if (!this.shadow || !this.shadowTextureId) {
      this.shadowTextureId ??= TextureManager.Instance.addTexture(texture, 'fx.groundShadow');
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
    for (const n of [this.ground, this.wind, this.sky, this.skyLight, this.fire, this.emitter, this.shadow]) if (n) world.removeNode(n);
    this.ground = this.wind = this.sky = this.skyLight = this.fire = this.emitter = this.shadow = null;
    if (this.shadowTextureId) { TextureManager.Instance.removeTexture(this.shadowTextureId); this.shadowTextureId = null; }
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
