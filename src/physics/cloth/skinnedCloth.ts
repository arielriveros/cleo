import { mat3, mat4, vec3 } from "gl-matrix";
import type { AnimatedModel } from "../../animation/animatedModel";
import type { ModelNode } from "../../core/scene/nodes/modelNode";
import { BodyColliders } from "./bodyColliders";
import type { SkinnedClothData } from "./skinnedClothData";
import { XpbdCloth, windGust, type ClothCapsule } from "./xpbdCloth";

/** Fixed simulation rate, as ClothNode's. */
const STEP = 1 / 60;
const MAX_STEPS = 3;
/** Wind strength 1 as air speed, m/s (ClothNode's figure). */
const WIND_SPEED = 7;
/** Below this weight a vertex is sewn on: pinned to its skinned position. */
const SEWN = 0.03;

/**
 * Cloth that is part of a skinned mesh — a tabard, a skirt, a loincloth — simulated in place
 * (phase 2 of physics/cloth/README.md).
 *
 * The listed vertices (`AnimatedModel.skinnedCloth`) are welded into particles (a UV seam splits one
 * point into several vertices; they must move as one) and simulated with XPBD over the mesh's own
 * triangles. Each frame every particle is driven to where the SKIN puts it and allowed `weight ×
 * maxDistance` metres of slack (a max-distance constraint); weight ~0 is sewn on. The body's ragdoll
 * capsules keep it outside the legs.
 *
 * Drawing needs no new shader: the GPU still skins every vertex, so each simulated vertex is written back
 * as the BIND-space position that its own blended bone matrix carries to where the simulation put it
 * (`inverse(Σ wᵢ·boneᵢ)`), and only that range of the vertex buffer is re-uploaded. Shadows, the depth
 * prepass and selection all see the cloth for free. Motion vectors still come from the bones alone, so a
 * fast swing smears slightly under TAA (README, known gaps).
 */
export class SkinnedCloth {
    private readonly _node: ModelNode;
    private readonly _data: SkinnedClothData;
    private readonly _model: AnimatedModel;
    /** Written-back vertex (the listed ones, then their unlisted twins) -> particle. */
    private _particleOf: Int32Array;
    /** Per particle: bind position, weight, and the skin weights of a representative vertex. */
    private readonly _bind: Float32Array;
    private readonly _weights: Float32Array;
    private readonly _joints: Uint16Array;
    private readonly _jointWeights: Float32Array;
    private readonly _triangles: Uint32Array;
    private readonly _first: number;
    private readonly _last: number;
    private readonly _body: BodyColliders | null;
    private _sim: XpbdCloth | null = null;
    private _targets = new Float32Array(0);
    private _radii = new Float32Array(0);
    private _upload: Float32Array | null = null;
    private _bindUpload: Float32Array | null = null;
    private _stride = 0;
    private _normalOffset = -1;
    private _accumulator = 0;
    private _time = 0;
    private readonly _capsules: ClothCapsule[] = [];
    /** Per particle, bind space: the way OUT of what it hangs on (the backstop's direction). */
    private readonly _outBind: Float32Array;
    /** The same, this frame, world space. */
    private _outWorld = new Float32Array(0);
    /** Per particle: how far it may sink behind its target (bind metres; Infinity = no backstop). */
    private readonly _backBind: Float32Array;

    constructor(node: ModelNode, data: SkinnedClothData) {
        this._node = node;
        this._data = data;
        this._model = node.model as AnimatedModel;
        const g = this._model.geometry;
        const P = g.positions;
        const JI = this._model.jointIndices, JW = this._model.jointWeights;
        const vertexCount = g.vertexCount;
        const listed = data.vertices.filter(v => v < vertexCount);

        // Weld by bind position.
        const key = (v: number) => `${Math.round(P[v * 3] * 1e4)},${Math.round(P[v * 3 + 1] * 1e4)},${Math.round(P[v * 3 + 2] * 1e4)}`;
        const byKey = new Map<string, number>();
        const particleOfVertex = new Map<number, number>();
        const rep: number[] = [], weight: number[] = [], back: number[] = [];
        const backOf = (i: number) => data.backstops?.[i] ?? data.backstop ?? Infinity;
        data.vertices.forEach((v, i) => {
            if (v >= vertexCount) return;
            const k = key(v);
            let p = byKey.get(k);
            if (p === undefined) { p = rep.length; byKey.set(k, p); rep.push(v); weight.push(data.weights[i]); back.push(backOf(i)); }
            else { weight[p] = Math.max(weight[p], data.weights[i]); back[p] = Math.min(back[p], backOf(i)); }
            particleOfVertex.set(v, p);
        });
        this._backBind = Float32Array.from(back);
        this._particleOf = Int32Array.from(listed, v => particleOfVertex.get(v)!);
        const n = rep.length;
        this._bind = new Float32Array(n * 3);
        this._weights = Float32Array.from(weight);
        this._joints = new Uint16Array(n * 4);
        this._jointWeights = new Float32Array(n * 4);
        rep.forEach((v, p) => {
            this._bind.set(P.subarray(v * 3, v * 3 + 3), p * 3);
            this._skinWeights(v, this._joints, this._jointWeights, p * 4, JI, JW);
        });

        // The mesh's triangles among the listed vertices, as particles.
        const tris: number[] = [];
        const I = g.indices;
        for (let t = 0; t + 2 < I.length; t += 3) {
            const a = particleOfVertex.get(I[t]), b = particleOfVertex.get(I[t + 1]), c = particleOfVertex.get(I[t + 2]);
            if (a === undefined || b === undefined || c === undefined || a === b || b === c || a === c) continue;
            tris.push(a, b, c);
        }
        this._triangles = Uint32Array.from(tris);
        // Unlisted vertices at a particle's position (a seam into another material, a duplicate the
        // painter missed) move with it: left skinned, each would open a crack — a spike — as it swings.
        const twins: number[] = [], twinParticles: number[] = [];
        for (let v = 0; v < vertexCount; v++) {
            if (particleOfVertex.has(v)) continue;
            const p = byKey.get(key(v));
            if (p !== undefined) { twins.push(v); twinParticles.push(p); }
        }
        const written = listed.concat(twins);
        this._particleOf = Int32Array.from([...this._particleOf, ...twinParticles]);
        this._first = written.length ? Math.min(...written) : 0;
        this._last = written.length ? Math.max(...written) : -1;
        this._listed = written;
        const skin = this._model.skin;
        this._body = skin && !data.colliders?.length ? new BodyColliders(skin) : null;
        this._outBind = this._outwardDirections(n);
    }

    private readonly _listed: number[];

    /** Particles after welding, for the report and the tests. */
    public get particleCount(): number { return this._bind.length / 3; }
    /** The simulated world positions, or null while not running. */
    public get positions(): Float32Array | null { return this._sim?.positions ?? null; }

    /**
     * Advance by `delta` (called by the scene after animation). `playing` false puts the mesh back on
     * its skin and drops the simulation.
     */
    public step(delta: number, playing: boolean): void {
        const node = this._node;
        const animator = node.animator;
        if (!playing || !animator || this.particleCount < 3) { this._stop(); return; }
        if (!node.initialized || node.vertexAttributes.length === 0) return;
        const bones = animator.getFinalBoneMatrices();
        const world = node.worldTransform;
        if (!this._sim) this._start(world, bones);
        const sim = this._sim!;

        this._time += delta;
        this._accumulator = Math.min(this._accumulator + delta, STEP * MAX_STEPS);
        const steps = Math.floor(this._accumulator / STEP);
        if (steps === 0) return;
        this._accumulator -= steps * STEP;

        this._skinParticles(world, bones, this._targets);
        for (let p = 0; p < this.particleCount; p++)
            if (sim.invMass[p] === 0) sim.setPin(p, this._targets[p * 3], this._targets[p * 3 + 1], this._targets[p * 3 + 2]);
        sim.colliders = this._poseColliders(world, bones);
        this._updateWind(sim);
        for (let s = 0; s < steps; s++) sim.step(STEP);
        this._writeBack(world, bones);
    }

    private _start(world: mat4, bones: mat4[]): void {
        const n = this.particleCount;
        // Rest lengths from the BIND shape (carried to the world by the node's own transform), so the
        // cloth keeps its sewn proportions whatever pose play starts in; then it starts where the skin is.
        const rest = new Float32Array(n * 3);
        const p = vec3.create();
        for (let i = 0; i < n; i++) {
            vec3.transformMat4(p, [this._bind[i * 3], this._bind[i * 3 + 1], this._bind[i * 3 + 2]], world);
            rest.set(p, i * 3);
        }
        const pinned = Array.from(this._weights, w => w < SEWN);
        const d = this._data;
        this._sim = new XpbdCloth({ positions: rest, pinned, mass: d.mass ?? 1.5, triangles: this._triangles, tethers: false }, {
            stretchCompliance: (1 - (d.stiffness ?? 1)) * 1e-3,
            bendCompliance: (1 - (d.bend ?? 0.3)) * 0.5 + 1e-4,
            damping: 0.05 + (d.damping ?? 0.6) * 0.9,
            thickness: d.thickness ?? 0.03,
            gravity: [0, -9.81 * Math.max(0, d.gravityScale ?? 1), 0],
            // Fewer than a panel's ten: the max-distance constraint already holds it near the skin, and a
            // character's cloth is hundreds of particles against a dozen body capsules every substep.
            substeps: Math.min(30, Math.max(1, Math.round(d.substeps ?? 6))),
        });
        this._targets = new Float32Array(n * 3);
        this._radii = new Float32Array(n);
        const scale = Math.hypot(world[0], world[1], world[2]);
        for (let i = 0; i < n; i++) this._radii[i] = this._weights[i] * d.maxDistance * (scale || 1);
        this._skinParticles(world, bones, this._targets);
        this._sim.reset(this._targets);
        this._sim.setTargets(this._targets, this._radii);
        this._outWorld = new Float32Array(n * 3);
        const hasBackstop = this._data.backstop !== undefined || !!this._data.backstops;
        this._sim.setBackstop(hasBackstop ? this._outWorld : null, hasBackstop ? this._backBind.map(b => b * (scale || 1)) : null);
        this._accumulator = 0;
        this._prepareUpload();
    }

    /** Back on the skin: the bind vertices re-uploaded, the simulation dropped. */
    private _stop(): void {
        if (!this._sim) return;
        this._sim = null;
        if (this._bindUpload && this._node.initialized)
            this._model.mesh.updateVertexRange(this._first, this._stride, this._bindUpload);
    }

    /** The interleaved copy of the listed range, to edit and re-upload (and the bind original, to restore). */
    private _prepareUpload(): void {
        const g = this._model.geometry;
        const attrs = [...this._node.vertexAttributes];
        const full = g.getData(attrs);
        this._stride = full.length / g.vertexCount;
        this._normalOffset = attrs.includes('normal') && g.normals.length > 0 ? 3 : -1;
        this._bindUpload = full.slice(this._first * this._stride, (this._last + 1) * this._stride);
        this._upload = this._bindUpload.slice();
    }

    /** Where the skin puts every particle this frame (and its outward direction), world space. */
    private _skinParticles(world: mat4, bones: mat4[], out: Float32Array): void {
        const m = SkinnedCloth._m, p = SkinnedCloth._p, d = SkinnedCloth._q, ob = this._outBind, ow = this._outWorld;
        const dirs = ow.length === out.length;
        for (let i = 0; i < this.particleCount; i++) {
            this._blend(m, bones, this._joints, this._jointWeights, i * 4);
            mat4.multiply(m, world, m);
            vec3.transformMat4(p, [this._bind[i * 3], this._bind[i * 3 + 1], this._bind[i * 3 + 2]], m);
            out[i * 3] = p[0]; out[i * 3 + 1] = p[1]; out[i * 3 + 2] = p[2];
            if (!dirs) continue;
            // A direction: rotation (and scale) only, renormalised.
            const x = ob[i * 3], y = ob[i * 3 + 1], z = ob[i * 3 + 2];
            d[0] = m[0] * x + m[4] * y + m[8] * z; d[1] = m[1] * x + m[5] * y + m[9] * z; d[2] = m[2] * x + m[6] * y + m[10] * z;
            const l = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]) || 1;
            ow[i * 3] = d[0] / l; ow[i * 3 + 1] = d[1] / l; ow[i * 3 + 2] = d[2] / l;
        }
    }

    /**
     * The colliders this frame: the data's fitted capsules carried by their joints, else the ragdoll's.
     */
    private _poseColliders(world: mat4, bones: mat4[]): ClothCapsule[] {
        const fitted = this._data.colliders;
        if (!fitted?.length) return this._body?.valid ? this._body.pose(world, bones, this._capsules) : [];
        const out = this._capsules;
        out.length = 0;
        const m = SkinnedCloth._m, a = SkinnedCloth._p, b = SkinnedCloth._q;
        for (const c of fitted) {
            const bone = bones[c.joint];
            if (!bone) continue;
            mat4.multiply(m, world, bone);
            vec3.transformMat4(a, c.a, m);
            vec3.transformMat4(b, c.b, m);
            out.push({ a: [a[0], a[1], a[2]], b: [b[0], b[1], b[2]], radius: c.radius * Math.sqrt(m[0] * m[0] + m[1] * m[1] + m[2] * m[2]) });
        }
        return out;
    }

    /**
     * Per particle, bind space: the unit direction away from what it hangs on — radially out of its dominant
     * joint's bone (else away from the nearest fitted collider). More reliable than the authored normal, which faces
     * inward on the inside of a layered or double-sided piece.
     */
    private _outwardDirections(n: number): Float32Array {
        const out = new Float32Array(n * 3);
        const fitted = this._data.colliders ?? [];
        const skin = this._model.skin;
        // Each joint's bind position, and the axis of its bone: toward its most vertical child joint (a
        // hip's spine rather than its legs), else from its parent.
        const pos = (skin?.joints ?? []).map(j => {
            const inv = mat4.invert(mat4.create(), j.inverseBindMatrix as mat4);
            return inv ? vec3.fromValues(inv[12], inv[13], inv[14]) : null;
        });
        const axisOf = (j: number): vec3 | null => {
            const joints = skin!.joints, here = pos[j];
            if (!here) return null;
            let best: vec3 | null = null, bestUp = -1;
            joints.forEach((c, k) => {
                if (c.parentIndex !== joints[j].nodeIndex || !pos[k]) return;
                const d = vec3.sub(vec3.create(), pos[k]!, here);
                const l = vec3.length(d);
                if (l < 1e-6) return;
                const up = Math.abs(d[1]) / l;
                if (up > bestUp) { bestUp = up; best = vec3.scale(d, d, 1 / l); }
            });
            if (best) return best;
            const parent = joints.findIndex(p => p.nodeIndex === joints[j].parentIndex);
            if (parent >= 0 && pos[parent]) {
                const d = vec3.sub(vec3.create(), here, pos[parent]!);
                const l = vec3.length(d);
                if (l > 1e-6) return vec3.scale(d, d, 1 / l);
            }
            return null;
        };
        const axes = new Map<number, vec3 | null>();
        const q = vec3.create();
        for (let i = 0; i < n; i++) {
            const px = this._bind[i * 3], py = this._bind[i * 3 + 1], pz = this._bind[i * 3 + 2];
            vec3.set(q, px, py - 1, pz);   // nothing better: straight up out of the ground
            let k = 0;
            for (let e = 1; e < 4; e++) if (this._jointWeights[i * 4 + e] > this._jointWeights[i * 4 + k]) k = e;
            const j = this._joints[i * 4 + k];
            if (skin && pos[j]) {
                // Radially out of the bone's LINE (not its segment: a skirt hangs below its hip joint, and its
                // way out is still away from the body's axis, not down).
                if (!axes.has(j)) axes.set(j, axisOf(j));
                const ax = axes.get(j), o = pos[j]!;
                if (ax) {
                    const t = (px - o[0]) * ax[0] + (py - o[1]) * ax[1] + (pz - o[2]) * ax[2];
                    vec3.set(q, o[0] + ax[0] * t, o[1] + ax[1] * t, o[2] + ax[2] * t);
                } else vec3.copy(q, o);
            } else {
                let best = Infinity;
                for (const c of fitted) {
                    const ax = c.b[0] - c.a[0], ay = c.b[1] - c.a[1], az = c.b[2] - c.a[2];
                    const len2 = ax * ax + ay * ay + az * az;
                    let t = len2 > 1e-12 ? ((px - c.a[0]) * ax + (py - c.a[1]) * ay + (pz - c.a[2]) * az) / len2 : 0;
                    t = Math.min(1, Math.max(0, t));
                    const cx = c.a[0] + ax * t, cy = c.a[1] + ay * t, cz = c.a[2] + az * t;
                    const d = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2 + (pz - cz) ** 2) - c.radius;
                    if (d < best) { best = d; vec3.set(q, cx, cy, cz); }
                }
            }
            let dx = px - q[0], dy = py - q[1], dz = pz - q[2];
            const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (l < 1e-9) { dx = 0; dy = 1; dz = 0; } else { dx /= l; dy /= l; dz /= l; }
            out[i * 3] = dx; out[i * 3 + 1] = dy; out[i * 3 + 2] = dz;
        }
        return out;
    }

    /**
     * Each listed vertex's simulated position (and normal) as the bind-space values its own bone blend
     * carries there, into the upload copy; then that range goes to the GPU.
     */
    private _writeBack(world: mat4, bones: mat4[]): void {
        const sim = this._sim!, up = this._upload!, bind = this._bindUpload!;
        const JI = this._model.jointIndices, JW = this._model.jointWeights;
        const toModel = mat4.invert(SkinnedCloth._inv, world);
        if (!toModel) return;
        const toModelN = mat3.fromMat4(SkinnedCloth._n3a, toModel);
        const m = SkinnedCloth._m, mInv = SkinnedCloth._mi, nInv = SkinnedCloth._n3b;
        const p = SkinnedCloth._p, n = SkinnedCloth._q;
        const joints = SkinnedCloth._j, weights = SkinnedCloth._w;
        for (let k = 0; k < this._listed.length; k++) {
            const v = this._listed[k], i = this._particleOf[k];
            this._skinWeights(v, joints, weights, 0, JI, JW);
            this._blend(m, bones, joints, weights, 0);
            if (!mat4.invert(mInv, m)) continue;
            const o = (v - this._first) * this._stride;
            vec3.set(p, sim.positions[i * 3], sim.positions[i * 3 + 1], sim.positions[i * 3 + 2]);
            vec3.transformMat4(p, p, toModel);
            vec3.transformMat4(p, p, mInv);
            up[o] = p[0]; up[o + 1] = p[1]; up[o + 2] = p[2];
            if (this._normalOffset >= 0) {
                vec3.set(n, sim.normals[i * 3], sim.normals[i * 3 + 1], sim.normals[i * 3 + 2]);
                vec3.transformMat3(n, n, toModelN);
                vec3.transformMat3(n, n, mat3.fromMat4(nInv, mInv));
                vec3.normalize(n, n);
                // The simulation's normals follow its own winding; keep each vertex facing the way it was authored.
                const no = o + this._normalOffset;
                if (n[0] * bind[no] + n[1] * bind[no + 1] + n[2] * bind[no + 2] < 0) vec3.negate(n, n);
                up[no] = n[0]; up[no + 1] = n[1]; up[no + 2] = n[2];
            }
        }
        this._model.mesh.updateVertexRange(this._first, this._stride, up);
    }

    private _updateWind(sim: XpbdCloth): void {
        const wind = this._node.scene?.wind;
        const response = this._data.windResponse ?? 1;
        if (!wind || response <= 0) { sim.wind[0] = sim.wind[1] = sim.wind[2] = 0; return; }
        const [dx, dz] = wind.directionXZ;
        const at = this._node.worldPosition;
        const gust = windGust(at[0], at[2], this._time, dx, dz, wind.gustScale, wind.gustSpeed);
        const speed = wind.strength * WIND_SPEED * (0.35 + 0.65 * gust) * response;
        sim.wind[0] = dx * speed; sim.wind[1] = 0; sim.wind[2] = dz * speed;
    }

    /** A vertex's four joints and normalised weights, as AnimatedModel uploads them. */
    private _skinWeights(v: number, joints: Uint16Array, weights: Float32Array, at: number,
                         JI: Float32Array | null, JW: Float32Array | null): void {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
            joints[at + k] = JI ? JI[v * 4 + k] : 0;
            weights[at + k] = JW ? JW[v * 4 + k] : (k === 0 ? 1 : 0);
            sum += weights[at + k];
        }
        if (sum > 0) for (let k = 0; k < 4; k++) weights[at + k] /= sum;
        else { weights[at] = 1; weights[at + 1] = weights[at + 2] = weights[at + 3] = 0; }
    }

    /** `out = Σ wₖ · bones[jₖ]` — the matrix the vertex shader skins with. */
    private _blend(out: mat4, bones: mat4[], joints: Uint16Array, weights: Float32Array, at: number): mat4 {
        for (let e = 0; e < 16; e++) out[e] = 0;
        for (let k = 0; k < 4; k++) {
            const w = weights[at + k];
            if (w === 0) continue;
            const b = bones[joints[at + k]];
            if (!b) continue;
            for (let e = 0; e < 16; e++) out[e] += b[e] * w;
        }
        return out;
    }

    private static readonly _m = mat4.create();
    private static readonly _mi = mat4.create();
    private static readonly _inv = mat4.create();
    private static readonly _n3a = mat3.create();
    private static readonly _n3b = mat3.create();
    private static readonly _p = vec3.create();
    private static readonly _q = vec3.create();
    private static readonly _j = new Uint16Array(4);
    private static readonly _w = new Float32Array(4);
}
