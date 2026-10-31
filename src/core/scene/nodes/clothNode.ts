import { mat4, quat, vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Geometry } from "../../geometry";
import { Model } from "../../../graphics/model";
import { Material } from "../../../graphics/material";
import { ShaderManager } from "../../../graphics/systems/shaderManager";
import { geometryAttributesFor } from "../../../graphics/rhi/vertexLayouts";
import { AnimatedModel, type Skin } from "../../../animation/animatedModel";
import { humanoidSlotOf } from "../../../animation/boneNames";
import { BodyColliders } from "../../../physics/cloth/bodyColliders";
import { XpbdCloth, gridIndices, windGust, type ClothCapsule } from "../../../physics/cloth/xpbdCloth";
import { ModelNode } from "./modelNode";
import { Node } from "./node";

export type ClothPinEdge = 'top' | 'left' | 'none';

export interface ClothOptions {
    /** Panel size, metres. */
    width?: number;
    height?: number;
    /** Particles across and down (at least 2 each). */
    columns?: number;
    rows?: number;
    /** Which edge is held: the top (a cape, a banner), the left (a flag on its pole), or none. */
    pinEdge?: ClothPinEdge;
    /** 0..1: resistance to stretching. 1 = inextensible. */
    stiffness?: number;
    /** 0..1: resistance to bending. 0 = silk, 1 = canvas. */
    bend?: number;
    /** 0..1: how much of its velocity the cloth keeps each second. */
    damping?: number;
    /** Total mass, kg. */
    mass?: number;
    /** Distance kept from colliders, metres. */
    thickness?: number;
    /** Multiplier on the scene wind's push. 0 = ignores the wind. */
    windResponse?: number;
    /** Collide with the limbs of the character this cloth hangs from (its ragdoll capsules). */
    collideWithOwner?: boolean;
    /**
     * A bone of that character the held edge rides on — a humanoid slot (`chest`, `spine`, `neck`, ...)
     * or the bone's own name. Empty: the edge rides on this node.
     */
    bone?: string;
    enabled?: boolean;
}

const PIN_EDGES: readonly ClothPinEdge[] = ['top', 'left', 'none'];
const num = (x: unknown, fallback: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Fixed simulation rate: steps are deterministic, and a slow frame takes a few of them. */
const STEP = 1 / 60;
const MAX_STEPS = 3;
/** Wind strength 1 (the authored foliage lean) as air speed, m/s: a fresh breeze. */
const WIND_SPEED = 7;

/** Defaults: a cape-sized panel of medium wool. */
export const CLOTH_DEFAULTS: Required<ClothOptions> = {
    width: 0.9, height: 1.2, columns: 10, rows: 14, pinEdge: 'top',
    stiffness: 1, bend: 0.4, damping: 0.6, mass: 1.2, thickness: 0.04,
    windResponse: 1, collideWithOwner: true, bone: '', enabled: true,
};

/**
 * A rectangular cloth panel simulated on the CPU with XPBD (physics/cloth/xpbdCloth.ts): a cape on a
 * character, a banner on a pole, a flag. Drawn as an ordinary double-sided model whose vertices are
 * rewritten every frame — any PBR material works on it.
 *
 * The panel lies in the node's local XY plane, hanging down -Y, width along X: with the TOP edge held
 * its centre is the node's origin, with the LEFT edge held the edge runs down from the origin. The held
 * edge rides on the node — or, with `bone`, on that bone of the character it hangs from, carried rigidly
 * from where it was when the simulation started (so a cape follows the chest through a roll).
 *
 * Steps only while the scene plays (Play and Simulate); while authoring it shows its rest shape. It runs
 * after animation and the socket pass (Scene.update), so the held edge reads this frame's pose.
 */
export class ClothNode extends ModelNode {
    private _opts: Required<ClothOptions>;
    private _sim: XpbdCloth | null = null;
    private _attributes: string[] | null = null;
    /** Rest positions in local space, and which particles are held. */
    private _rest = new Float32Array(0);
    private _pinned: boolean[] = [];
    /** The held particles' anchors: in the bone's skinning frame when riding a bone, else local. */
    private _pinAnchors = new Float32Array(0);
    private _pinPrev = new Float32Array(0);
    private _pinNow = new Float32Array(0);
    private _owner: ModelNode | null | undefined = undefined;
    private _ownerBody: BodyColliders | null = null;
    private readonly _capsules: ClothCapsule[] = [];
    private _boneJoint = -1;
    private _accumulator = 0;
    private _time = 0;
    private _simulating = false;
    private _dirty = true;

    constructor(name: string, options: ClothOptions = {}, material: Material | null = null, id: string = uuidv4()) {
        const opts = ClothNode._sanitize(options);
        const mat = material ?? Material.PBR({ baseColor: [0.32, 0.07, 0.07], roughness: 0.9 }, { side: 'double' });
        super(name, new Model(ClothNode._restGeometry(opts), mat), id, 'cloth');
        this._opts = opts;
        this._buildRest();
    }

    private static _sanitize(o: ClothOptions): Required<ClothOptions> {
        const d = CLOTH_DEFAULTS;
        return {
            width: Math.max(0.05, num(o.width, d.width)),
            height: Math.max(0.05, num(o.height, d.height)),
            columns: Math.min(64, Math.max(2, Math.round(num(o.columns, d.columns)))),
            rows: Math.min(64, Math.max(2, Math.round(num(o.rows, d.rows)))),
            pinEdge: PIN_EDGES.includes(o.pinEdge as ClothPinEdge) ? o.pinEdge as ClothPinEdge : d.pinEdge,
            stiffness: clamp01(num(o.stiffness, d.stiffness)),
            bend: clamp01(num(o.bend, d.bend)),
            damping: clamp01(num(o.damping, d.damping)),
            mass: Math.max(0.01, num(o.mass, d.mass)),
            thickness: Math.max(0, num(o.thickness, d.thickness)),
            windResponse: Math.max(0, num(o.windResponse, d.windResponse)),
            collideWithOwner: o.collideWithOwner !== undefined ? !!o.collideWithOwner : d.collideWithOwner,
            bone: typeof o.bone === 'string' ? o.bone : d.bone,
            enabled: o.enabled !== false,
        };
    }

    /** Local rest position of particle (c, r). */
    private static _restAt(o: Required<ClothOptions>, c: number, r: number): [number, number, number] {
        const u = c / (o.columns - 1), v = r / (o.rows - 1);
        const x = o.pinEdge === 'left' ? u * o.width : (u - 0.5) * o.width;
        return [x, -v * o.height, 0];
    }

    private static _restGeometry(o: Required<ClothOptions>): Geometry {
        const n = o.columns * o.rows;
        const positions = new Float32Array(n * 3), normals = new Float32Array(n * 3), uvs = new Float32Array(n * 2);
        const tangents = new Float32Array(n * 3), bitangents = new Float32Array(n * 3);
        for (let r = 0; r < o.rows; r++) for (let c = 0; c < o.columns; c++) {
            const i = r * o.columns + c;
            positions.set(ClothNode._restAt(o, c, r), i * 3);
            normals.set([0, 0, 1], i * 3);
            uvs.set([c / (o.columns - 1), r / (o.rows - 1)], i * 2);
            tangents.set([1, 0, 0], i * 3);
            bitangents.set([0, -1, 0], i * 3);
        }
        return new Geometry(positions, normals, uvs, tangents, bitangents, gridIndices(o.columns, o.rows), false);
    }

    private _buildRest(): void {
        const o = this._opts;
        const n = o.columns * o.rows;
        this._rest = new Float32Array(n * 3);
        this._pinned = new Array(n).fill(false);
        for (let r = 0; r < o.rows; r++) for (let c = 0; c < o.columns; c++) {
            const i = r * o.columns + c;
            this._rest.set(ClothNode._restAt(o, c, r), i * 3);
            this._pinned[i] = o.pinEdge === 'top' ? r === 0 : o.pinEdge === 'left' ? c === 0 : false;
        }
        this._sim = null;
        this._simulating = false;
        this._dirty = true;
    }

    // --- options -------------------------------------------------------------------------------------

    public get options(): Readonly<Required<ClothOptions>> { return this._opts; }

    /**
     * Change any options. Size, resolution and the held edge rebuild the mesh and restart the
     * simulation; the rest apply to the running one.
     */
    public setOptions(patch: ClothOptions): void {
        const next = ClothNode._sanitize({ ...this._opts, ...patch });
        const reshape = next.width !== this._opts.width || next.height !== this._opts.height
            || next.columns !== this._opts.columns || next.rows !== this._opts.rows || next.pinEdge !== this._opts.pinEdge;
        const rebone = next.bone !== this._opts.bone;
        this._opts = next;
        if (reshape) {
            // A new vertex count: setGeometry makes `initialized` false, so the mesh is re-created.
            (this.model as Model).setGeometry(ClothNode._restGeometry(next));
            this._buildRest();
        } else if (rebone) {
            this._sim = null;
            this._simulating = false;
        } else if (this._sim) {
            this._sim.settings = { ...this._sim.settings, ...this._settings() };
            this._sim.refreshSettings();
        }
        this._notifyChange('component', 'cloth');
    }

    private _settings() {
        const o = this._opts;
        return {
            // Stiffness 1 is inextensible; 0 is about a percent of stretch under a cape's own weight.
            stretchCompliance: (1 - o.stiffness) * 1e-3,
            bendCompliance: (1 - o.bend) * 0.5 + 1e-4,
            damping: 0.05 + o.damping * 0.9,
            thickness: o.thickness,
        };
    }

    // --- lifecycle -----------------------------------------------------------------------------------

    public initializeModel(): void {
        super.initializeModel();
        const shader = ShaderManager.Instance.getShader(this.model.material.type);
        this._attributes = geometryAttributesFor(shader.attributes);
        this._dirty = true;
    }

    /**
     * Advance the cloth by this frame's `delta` (called by the scene after animation and sockets).
     * `playing` false shows the rest shape and drops any simulation.
     */
    public lateStep(delta: number, playing: boolean): void {
        if (!playing || !this._opts.enabled) {
            if (this._simulating || this._dirty) this._showRest();
            return;
        }
        if (!this._sim) this._start();
        const sim = this._sim!;
        this._time += delta;
        this._accumulator = Math.min(this._accumulator + delta, STEP * MAX_STEPS);
        const steps = Math.floor(this._accumulator / STEP);
        if (steps === 0) return;
        this._accumulator -= steps * STEP;

        // Where the held edge is now; each fixed step moves it a share of the way from last frame.
        this._pinPrev.set(this._pinNow);
        this._computePins(this._pinNow);
        this._updateColliders();
        this._updateWind();
        for (let s = 1; s <= steps; s++) {
            const t = s / steps;
            let k = 0;
            for (let i = 0; i < this._pinned.length; i++) {
                if (!this._pinned[i]) continue;
                const a = this._pinPrev, b = this._pinNow;
                sim.setPin(i, a[k] + (b[k] - a[k]) * t, a[k + 1] + (b[k + 1] - a[k + 1]) * t, a[k + 2] + (b[k + 2] - a[k + 2]) * t);
                k += 3;
            }
            sim.step(STEP);
        }
        this._writeMesh(sim.positions, sim.normals);
    }

    /** The world positions of every particle (the rest shape before the simulation starts). */
    public get particlePositions(): Float32Array | null { return this._sim?.positions ?? null; }

    private _start(): void {
        const o = this._opts;
        this._owner = undefined;
        this._resolveOwner();
        const world = this.worldTransform;
        const n = o.columns * o.rows;
        const start = new Float32Array(n * 3);
        const p = vec3.create();
        for (let i = 0; i < n; i++) {
            vec3.transformMat4(p, [this._rest[i * 3], this._rest[i * 3 + 1], this._rest[i * 3 + 2]], world);
            start.set(p, i * 3);
        }
        // Anchors: each held particle, in its bone's skinning frame (riding a bone) or local (riding this node).
        const held = this._pinned.filter(Boolean).length;
        this._pinAnchors = new Float32Array(held * 3);
        this._pinPrev = new Float32Array(held * 3);
        this._pinNow = new Float32Array(held * 3);
        const frame = this._boneFrame(mat4.create());
        const toAnchor = frame ? mat4.invert(mat4.create(), frame) : null;
        let k = 0;
        for (let i = 0; i < n; i++) {
            if (!this._pinned[i]) continue;
            if (toAnchor) vec3.transformMat4(p, [start[i * 3], start[i * 3 + 1], start[i * 3 + 2]], toAnchor);
            else vec3.set(p, this._rest[i * 3], this._rest[i * 3 + 1], this._rest[i * 3 + 2]);
            this._pinAnchors.set(p, k);
            this._pinNow.set(start.subarray(i * 3, i * 3 + 3), k);
            k += 3;
        }
        this._sim = XpbdCloth.grid(o.columns, o.rows, start, this._pinned, o.mass, this._settings());
        this._accumulator = 0;
        this._simulating = true;
    }

    private _showRest(): void {
        this._sim = null;
        this._simulating = false;
        const o = this._opts;
        const n = o.columns * o.rows;
        const normals = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) normals[i * 3 + 2] = 1;
        if (this._writeMesh(this._rest, normals, true)) this._dirty = false;
    }

    /** The held edge's anchors carried to world space, packed. */
    private _computePins(out: Float32Array): void {
        const frame = this._boneFrame(mat4.create()) ?? this.worldTransform;
        const p = vec3.create();
        for (let k = 0; k < this._pinAnchors.length; k += 3) {
            vec3.transformMat4(p, [this._pinAnchors[k], this._pinAnchors[k + 1], this._pinAnchors[k + 2]], frame);
            out[k] = p[0]; out[k + 1] = p[1]; out[k + 2] = p[2];
        }
    }

    // --- the character this hangs from ---------------------------------------------------------------

    /** The nearest skinned, animated model up the tree (or inside an ancestor that holds one). */
    private _resolveOwner(): ModelNode | null {
        if (this._owner !== undefined) return this._owner;
        let found: ModelNode | null = null;
        for (let a = this.parent; a && !found; a = a.parent) {
            const queue: Node[] = [a];
            while (queue.length && !found) {
                const n = queue.shift()!;
                if (n === this) continue;
                if (n instanceof ModelNode && !(n instanceof ClothNode) && n.animator
                    && n.model instanceof AnimatedModel && n.model.skin) found = n;
                else queue.push(...n.children);
            }
        }
        this._owner = found;
        this._ownerBody = null;
        this._boneJoint = -1;
        const skin = found ? (found.model as AnimatedModel).skin : null;
        if (skin) {
            this._ownerBody = new BodyColliders(skin);
            if (this._opts.bone) this._boneJoint = jointOf(skin, this._opts.bone);
        }
        return found;
    }

    /** The riding bone's skinning frame in world space (`ownerWorld * finalBoneMatrix`), or null. */
    private _boneFrame(out: mat4): mat4 | null {
        const owner = this._owner;
        if (!owner || this._boneJoint < 0 || !owner.animator) return null;
        const bone = owner.animator.getFinalBoneMatrices()[this._boneJoint];
        if (!bone) return null;
        return mat4.multiply(out, owner.worldTransform, bone);
    }

    private _updateColliders(): void {
        const sim = this._sim!;
        const owner = this._owner, body = this._ownerBody;
        if (!this._opts.collideWithOwner || !owner || !body || !owner.animator) { sim.colliders = []; return; }
        sim.colliders = body.pose(owner.worldTransform, owner.animator.getFinalBoneMatrices(), this._capsules);
    }

    private _updateWind(): void {
        const sim = this._sim!;
        const wind = this.scene?.wind;
        if (!wind || this._opts.windResponse <= 0) { sim.wind[0] = sim.wind[1] = sim.wind[2] = 0; return; }
        const [dx, dz] = wind.directionXZ;
        const p = this.worldPosition;
        const gust = windGust(p[0], p[2], this._time, dx, dz, wind.gustScale, wind.gustSpeed);
        const speed = wind.strength * WIND_SPEED * (0.35 + 0.65 * gust) * this._opts.windResponse;
        sim.wind[0] = dx * speed; sim.wind[1] = 0; sim.wind[2] = dz * speed;
    }

    // --- the mesh --------------------------------------------------------------------------------------

    /**
     * Write positions and normals (world space, or local with `local`) into the geometry and the vertex
     * buffer. False when the mesh is not on the GPU yet.
     */
    private _writeMesh(positions: Float32Array, normals: Float32Array, local = false): boolean {
        const geometry = this.model.geometry;
        const o = this._opts;
        const pos = geometry.positions, nrm = geometry.normals, tan = geometry.tangents, bit = geometry.bitangents;
        if (pos.length !== positions.length) return false;
        const inv = local ? null : mat4.invert(mat4.create(), this.worldTransform);
        const p = vec3.create(), nv = vec3.create();
        for (let i = 0; i < positions.length; i += 3) {
            vec3.set(p, positions[i], positions[i + 1], positions[i + 2]);
            vec3.set(nv, normals[i], normals[i + 1], normals[i + 2]);
            if (inv) {
                vec3.transformMat4(p, p, inv);
                // Rotation (and uniform scale) only: a normal does not translate.
                const x = nv[0], y = nv[1], z = nv[2];
                nv[0] = inv[0] * x + inv[4] * y + inv[8] * z;
                nv[1] = inv[1] * x + inv[5] * y + inv[9] * z;
                nv[2] = inv[2] * x + inv[6] * y + inv[10] * z;
                vec3.normalize(nv, nv);
            }
            pos[i] = p[0]; pos[i + 1] = p[1]; pos[i + 2] = p[2];
            nrm[i] = nv[0]; nrm[i + 1] = nv[1]; nrm[i + 2] = nv[2];
        }
        // Tangents along the panel's width (+u), bitangents completing the frame: what a normal map needs.
        for (let r = 0; r < o.rows; r++) for (let c = 0; c < o.columns; c++) {
            const i = (r * o.columns + c) * 3;
            const a = (r * o.columns + Math.max(0, c - 1)) * 3, b = (r * o.columns + Math.min(o.columns - 1, c + 1)) * 3;
            let tx = pos[b] - pos[a], ty = pos[b + 1] - pos[a + 1], tz = pos[b + 2] - pos[a + 2];
            const nx = nrm[i], ny = nrm[i + 1], nz = nrm[i + 2];
            const d = tx * nx + ty * ny + tz * nz;
            tx -= nx * d; ty -= ny * d; tz -= nz * d;
            const l = Math.hypot(tx, ty, tz) || 1;
            tan[i] = tx / l; tan[i + 1] = ty / l; tan[i + 2] = tz / l;
            bit[i] = ny * tan[i + 2] - nz * tan[i + 1];
            bit[i + 1] = nz * tan[i] - nx * tan[i + 2];
            bit[i + 2] = nx * tan[i + 1] - ny * tan[i];
        }
        geometry.invalidateBounds();
        this.invalidateWorldBounds();
        if (!this.initialized || !this._attributes) return false;
        this.model.mesh.updateVertexData(geometry.getData(this._attributes));
        return true;
    }

    // --- serialization -------------------------------------------------------------------------------

    protected _serializePayload(): any {
        return { cloth: { ...this._opts }, material: this.model.material.serialize() };
    }

    public static parse(parent: Node, json: any) {
        const material = json.material ? Material.parse(json.material) : null;
        const node = new ClothNode(json.name, json.cloth ?? {}, material, json.id);
        Node.finishParse(node, parent, json);
    }
}

/** The joint of `skin` whose bone is `bone` by name, or by humanoid slot (`chest`, `neck`, ...). -1: none. */
export function jointOf(skin: Skin, bone: string): number {
    const jointOfNode = new Map<number, number>();
    skin.joints.forEach((j, i) => jointOfNode.set(j.nodeIndex, i));
    let bySlot = -1;
    for (const [nodeIndex, name] of skin.nodeNames ?? []) {
        const joint = jointOfNode.get(nodeIndex);
        if (joint === undefined) continue;
        if (name === bone) return joint;
        if (bySlot < 0 && humanoidSlotOf(name) === bone) bySlot = joint;
    }
    return bySlot;
}
