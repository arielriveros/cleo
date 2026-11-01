import {
  DirectionalLight, Geometry, Loader, Material, Model, ModelNode, Node,
  type AnimatedModel, type CleoEngine, type LightNode, type Scene,
} from 'cleo';
import { mat4, quat, vec3 } from 'gl-matrix';
import { aimSun } from '../../fx/ui/fxPreview';
import { bakePose, type BakedClip } from '../bakeMotion';
import type { MotionPose } from '../motionDoc';
import { buildRig, type MotionRig, type SkinLike } from '../motionRig';
import { parseRigged, type RiggedPart } from '../../core/riggedImport';
import type { Animation, Skin } from 'cleo/animation/animatedModel';

// The Motion Creator's preview stage: the character on a floor under the sun, playing whatever the panels
// last baked -- the whole motion, or one pose held while it is being edited. The clip goes through the
// engine's own animator, the same path the editor and a published game play it with.
//
// Every frame (its own rAF) it also carries the character's unskinned parts with the bones they hang
// from, and draws the skeleton -- joints and bones over everything, the selected bone highlighted --
// through the renderer's skeleton overlay, the one the editor uses.

const PREFIX = 'Motion stage · ';
const CLIP = 'motion';

/** The default subject: the editor's mannequin (Mixamo naming, the rig the Valley characters retarget from). */
export const MANNEQUIN_URL = '/assets/mannequin.gltf';

export interface MotionStageSettings {
  grid: boolean;
  ground: boolean;
  /** Draw the skeleton over the character (and pick its joints). */
  skeleton: boolean;
  /** Dragging a joint bends the chain above it, lengths kept; off: the joint follows exactly, bones stretch. */
  keepLengths: boolean;
  /** Bones above a dragged joint that bend; 0: the joint's default (two for a hand, a foot, the head). */
  chain: number;
  sunYaw: number;
  sunElevation: number;
}

export const DEFAULT_MOTION_STAGE: MotionStageSettings = { grid: true, ground: true, skeleton: true, keepLengths: true, chain: 0, sunYaw: 35, sunElevation: 40 };

export class MotionStage {
  private ground: ModelNode | null = null;
  private root: Node | null = null;
  private models: { node: ModelNode; model: AnimatedModel }[] = [];
  /** Unskinned parts under a bone: the joint they follow and their offset from it at rest. */
  private attached: { node: ModelNode; joint: number; offset: mat4 }[] = [];
  private skeleton = true;
  private selectedBone: string | null = null;
  private hoverBone: string | null = null;
  /** The character's display scale: 0.01 for a model authored in centimetres, else 1 (see `load`). */
  public displayScale = 1;
  private raf = 0;
  private readonly machined = new WeakSet<object>();
  /** The skin as the engine holds it, for the export's source skeleton. */
  public skin: SkinLike | null = null;
  public rig: MotionRig | null = null;
  /** The character's extent at rest, in the scene (after the display scale): for framing. */
  public bounds: { size: [number, number, number]; floor: [number, number, number] } | null = null;
  private readonly saved: { sunIntensity: number | null; sunRotation: vec3 | null; ambient: vec3; animations: boolean };

  constructor(private engine: CleoEngine, private world: Scene, private sun: LightNode | null) {
    const light = sun?.light as DirectionalLight | undefined;
    this.saved = { sunIntensity: light ? light.intensity : null, sunRotation: sun ? vec3.clone(sun.rotation) : null, ambient: vec3.clone(world.ambientLight),
                   animations: world.animationsEnabled !== false };
    // The Creator's scene is an authoring scene, which holds skinned meshes still; this stage plays them.
    world.animationsEnabled = true;
    const frame = () => { this.tick(); this.raf = requestAnimationFrame(frame); };
    this.raf = requestAnimationFrame(frame);
  }

  apply(s: MotionStageSettings): void {
    if (this.sun) {
      aimSun(this.sun, { lightYaw: s.sunYaw, lightElevation: s.sunElevation });
      (this.sun.light as DirectionalLight).intensity = 60000;
    }
    this.world.ambientLight = vec3.fromValues(8000, 8000, 8000);
    this.engine.renderer.setGridVisible(s.grid);
    this.skeleton = s.skeleton !== false;
    if (s.ground && !this.ground) {
      this.ground = new ModelNode(PREFIX + 'ground', new Model(Geometry.Plane(30, 30), Material.PBR({ baseColor: [0.32, 0.31, 0.29], roughness: 0.95 })));
      this.world.addNode(this.ground);
    } else if (!s.ground && this.ground) {
      this.world.removeNode(this.ground);
      this.ground = null;
    }
  }

  /**
   * Load the character -- the mannequin, or an uploaded Character's files -- in place of the one shown, and
   * read its skeleton. Every part is shown: the skinned meshes, and the unskinned ones (eyes, hair, armour,
   * a held prop), which then follow the bone they hang from.
   */
  async load(source: string | File[] = MANNEQUIN_URL): Promise<MotionRig> {
    const loaded: RiggedPart[] = typeof source === 'string'
      ? await Loader.loadAnimatedModelsFromPath(source)
      : (await parseRigged(source)).models;
    if (this.root) this.world.removeNode(this.root);
    this.root = null;
    this.models = [];
    this.attached = [];
    const skin = (loaded.find(l => (l.model as AnimatedModel).skin)?.model as AnimatedModel | undefined)?.skin;
    if (!skin) throw new Error('The character has no skeleton');
    const root = new Node(PREFIX + 'character');
    for (const { name, model, transform, bone } of loaded) {
      const node = new ModelNode(name, model);
      if (transform) {
        node.setPosition(transform.translation as unknown as vec3);
        node.setQuaternion(transform.rotation as unknown as quat);
        node.setScale(transform.scale as unknown as vec3);
      }
      root.addChild(node);
      if ((model as AnimatedModel).skin) this.models.push({ node, model: model as AnimatedModel });
      const joint = bone ? jointOf(skin, bone.node, bone.name) : -1;
      if (bone && joint >= 0) this.attached.push({ node, joint, offset: mat4.clone(bone.offset as unknown as mat4) });
    }
    this.world.addNode(root);
    this.root = root;
    this.skin = skin as unknown as SkinLike;
    this.rig = buildRig(this.skin);
    // A model authored in centimetres (most Sketchfab and many Mixamo exports without an armature scale)
    // would stand a hundred metres tall here: shown at a hundredth. Display only -- poses, the bake and
    // the export stay in the model's own units.
    const lo = [0, 1, 2].map(k => Math.min(...this.rig!.restModel.pos.map(p => p[k])));
    const hi = [0, 1, 2].map(k => Math.max(...this.rig!.restModel.pos.map(p => p[k])));
    const unit = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) > 20 ? 0.01 : 1;
    root.setScale([unit, unit, unit]);
    this.displayScale = unit;
    // Joints stop at the wrists and the head's base: pad to the skin's likely extent.
    const pad = (k: number) => (hi[k] - lo[k]) * unit * 1.15 + 0.2;
    this.bounds = { size: [pad(0), pad(1), pad(2)], floor: [(lo[0] + hi[0]) / 2 * unit, lo[1] * unit, (lo[2] + hi[2]) / 2 * unit] };
    return this.rig;
  }

  /** Play a baked clip on every part of the character, from the start (or held at `time`). */
  show(clip: BakedClip, loop: boolean, time?: number): void {
    for (const { node, model } of this.models) {
      const animator = node.animator;
      if (!animator) continue;
      model.removeAnimation(CLIP);
      model.addAnimation({ ...(clip as any), name: CLIP });
      this.machine(animator);
      animator.playAnimationByName(CLIP, loop, false);
      if (time !== undefined) { animator.pause(); animator.seek(time); }
    }
  }

  /**
   * An animator with neither a state machine nor trigger mappings drops to the bind pose every frame; one
   * state playing the clip is what keeps it playing.
   */
  private machine(animator: NonNullable<ModelNode['animator']>): void {
    if (this.machined.has(animator)) return;
    animator.setStateMachine({ parameters: [], states: [{ name: CLIP, clipName: CLIP, loop: true, speed: 1 } as any], transitions: [], events: [] });
    this.machined.add(animator);
  }

  /** The clips the character's own file carries (not the preview's). */
  sourceAnimations(): Animation[] {
    return (this.models[0]?.model.animations ?? []).filter(a => a.name !== CLIP);
  }

  /** Play one of the file's own clips, looping (or held at `time`). */
  playSource(name: string, time?: number): void {
    for (const { node } of this.models) {
      const animator = node.animator;
      if (!animator) continue;
      this.machine(animator);
      animator.playAnimationByName(name, true, false);
      if (time !== undefined) { animator.pause(); animator.seek(time); }
    }
  }

  play(): void { for (const { node } of this.models) node.animator?.play(); }
  pause(): void { for (const { node } of this.models) node.animator?.pause(); }
  seek(t: number): void { for (const { node } of this.models) { node.animator?.pause(); node.animator?.seek(t); } }
  /** The clip's playhead, seconds. */
  time(): number { return this.models[0]?.node.animator?.currentTime ?? 0; }
  playing(): boolean { return !!this.models[0]?.node.animator?.isPlaying; }

  /** Hold a pose right now, without waiting for the panels' debounced rebake: what a viewport drag shows. */
  showPoseNow(rig: MotionRig, pose: MotionPose): void { this.show(bakePose(rig, pose), false, 0); }

  /** The bone drawn highlighted (the Pose tab's selection), by name. */
  setSelectedBone(name: string | null): void { this.selectedBone = name; }
  /** The bone under the cursor, drawn marked (null: none). */
  setHoverBone(name: string | null): void { this.hoverBone = name; }

  /** A model-space point (rig, poses, IK goals) in the scene, and back. The character root only scales. */
  worldOf(model: ArrayLike<number>): vec3 { const k = this.displayScale; return vec3.fromValues(model[0] * k, model[1] * k, model[2] * k); }
  modelOf(world: ArrayLike<number>): vec3 { const k = 1 / this.displayScale; return vec3.fromValues(world[0] * k, world[1] * k, world[2] * k); }
  /** The radius a joint is drawn at, at a scene point: what picking tests against. */
  jointRadius(world: vec3): number { return this.screenSize(world); }

  /** Per frame: carry the attached parts with their bones, draw the skeleton. */
  private tick(): void {
    const body = this.models[0];
    const animator = body?.node.animator;
    const skin = body?.model.skin as Skin | undefined;
    if (!body || !animator || !skin) { this.engine.renderer.setSkeletonOverlay(null); return; }
    // The skinned node sits at the character root's origin, so joint model matrices are in the root's space.
    for (const a of this.attached) {
      const jm = animator.getJointModelMatrix(a.joint);
      if (!jm) continue;
      const m = mat4.multiply(TMP_M, jm as mat4, a.offset);
      mat4.getTranslation(TMP_T, m); mat4.getScaling(TMP_S, m); mat4.getRotation(TMP_Q, m);
      quat.normalize(TMP_Q, TMP_Q);
      a.node.setPosition(TMP_T); a.node.setQuaternion(TMP_Q); a.node.setScale(TMP_S);
    }
    if (this.skeleton) this.drawSkeleton(body.node, animator, skin);
    else this.engine.renderer.setSkeletonOverlay(null);
  }

  private drawSkeleton(node: ModelNode, animator: NonNullable<ModelNode['animator']>, skin: Skin): void {
    const n = skin.joints.length;
    const nodeWorld = node.worldTransform as unknown as mat4;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const jm = animator.getJointModelMatrix(i);
      const w = jm ? mat4.multiply(TMP_M, nodeWorld, jm as mat4) : nodeWorld;
      pos[i * 3] = w[12]; pos[i * 3 + 1] = w[13]; pos[i * 3 + 2] = w[14];
    }
    const at = (i: number): vec3 => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
    const joints = new Float32Array(n * 16);
    let highlight: Float32Array | null = null;
    let hover: Float32Array | null = null;
    for (let i = 0; i < n; i++) {
      const s = this.screenSize(at(i));
      mat4.fromRotationTranslationScale(joints.subarray(i * 16, i * 16 + 16) as unknown as mat4, IDENT_Q, at(i), [s, s, s]);
      if (this.selectedBone && skin.nodeNames?.get(skin.joints[i].nodeIndex) === this.selectedBone) {
        highlight = new Float32Array(16);
        mat4.fromRotationTranslationScale(highlight as unknown as mat4, IDENT_Q, at(i), [s * 1.6, s * 1.6, s * 1.6]);
      }
      if (this.hoverBone && skin.nodeNames?.get(skin.joints[i].nodeIndex) === this.hoverBone) {
        hover = new Float32Array(16);
        mat4.fromRotationTranslationScale(hover as unknown as mat4, IDENT_Q, at(i), [s * 1.35, s * 1.35, s * 1.35]);
      }
    }
    const pairs = bonePairs(skin);
    const bones = new Float32Array(pairs.length * 16);
    const q = quat.create();
    pairs.forEach(([c, p], b) => {
      const d = vec3.sub(vec3.create(), at(p), at(c));
      const len = vec3.length(d);
      const out = bones.subarray(b * 16, b * 16 + 16) as unknown as mat4;
      if (len < 1e-5) { mat4.identity(out); out[0] = out[5] = out[10] = 0; return; }
      const s = this.screenSize(at(c));
      quat.rotationTo(q, [0, 1, 0], vec3.scale(d, d, 1 / len));
      mat4.fromRotationTranslationScale(out, q, vec3.lerp(vec3.create(), at(c), at(p), 0.5), [s * 0.35, len, s * 0.35]);
    });
    this.engine.renderer.setSkeletonOverlay({
      jointMatrices: joints, jointCount: n, jointColor: [0.25, 0.6, 1.0],
      boneMatrices: bones, boneCount: pairs.length, boneColor: [0.85, 0.85, 0.9],
      highlightMatrix: highlight, highlightColor: [1, 0.75, 0.2],
      markerMatrices: hover, markerCount: hover ? 1 : 0, markerColor: [1, 1, 1],
    });
  }

  /** A joint sphere's size at a point: a constant share of the view. */
  private screenSize(p: vec3): number {
    const cam = this.world.activeCamera?.camera;
    if (!cam) return 0.02;
    if (cam.type === 'orthographic') return Math.max((cam.top - cam.bottom) * 0.012, 1e-3);
    const c = cam.position;
    return Math.max(Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2]) * Math.tan((cam.fov * Math.PI / 180) / 2) * 0.012, 1e-3);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.engine.renderer.setSkeletonOverlay(null);
    for (const n of [this.ground, this.root]) if (n) this.world.removeNode(n);
    this.ground = this.root = null;
    this.models = [];
    this.attached = [];
    const light = this.sun?.light as DirectionalLight | undefined;
    if (light && this.saved.sunIntensity !== null) light.intensity = this.saved.sunIntensity;
    if (this.sun && this.saved.sunRotation) this.sun.setRotation(this.saved.sunRotation);
    this.world.ambientLight = this.saved.ambient;
    this.world.animationsEnabled = this.saved.animations;
    this.engine.renderer.setGridVisible(true);
  }
}

const TMP_M = mat4.create(), TMP_T = vec3.create(), TMP_Q = quat.create(), TMP_S = vec3.create();
const IDENT_Q = quat.create();

/** The skin's joint for a node: by index, else by name (a pivot collapse can renumber nodes). -1: none. */
function jointOf(skin: Skin, node: number, name?: string): number {
  const byIndex = skin.joints.findIndex(j => j.nodeIndex === node);
  if (byIndex >= 0 || !name) return byIndex;
  return skin.joints.findIndex(j => skin.nodeNames?.get(j.nodeIndex) === name);
}

const pairCache = new WeakMap<Skin, [number, number][]>();
/** Each joint with the nearest joint above it (non-joint ancestors skipped). */
function bonePairs(skin: Skin): [number, number][] {
  const cached = pairCache.get(skin);
  if (cached) return cached;
  const jointOfNode = new Map(skin.joints.map((j, i) => [j.nodeIndex, i]));
  const pairs: [number, number][] = [];
  skin.joints.forEach((j, i) => {
    let p = j.parentIndex ?? skin.nodeParents?.get(j.nodeIndex);
    for (let guard = 0; p !== undefined && guard < 256; guard++) {
      const pj = jointOfNode.get(p);
      if (pj !== undefined) { pairs.push([i, pj]); break; }
      p = skin.nodeParents?.get(p);
    }
  });
  pairCache.set(skin, pairs);
  return pairs;
}
