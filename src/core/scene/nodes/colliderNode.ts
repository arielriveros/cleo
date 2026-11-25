import { v4 as uuidv4 } from 'uuid';
import { quat } from 'gl-matrix';
import { Node } from "./node";
import type { ColliderDesc } from "../../../physics/pal/types";
import type { Shape } from "../../../physics/shape";
import type { RigidBody } from "../../../physics/body";
import { parseSimulationMode } from "../../../physics/simulationRange";
import type { SimulationMode } from "../../../physics/simulationRange";
import { ALL_LAYERS, LAYER } from "../../../physics/collisionLayers";
import { legacyColliderLayer } from "./cameraLayersLegacy";

/**
 * One collider shape, in the Collider's (or Trigger's) local units: it scales with the node's world scale.
 * `offset` and `rotation` (Euler degrees) place it on the node.
 */
export interface ColliderShape {
    type: 'box' | 'sphere' | 'capsule' | 'cylinder' | 'plane' | 'convex';
    offset: number[];
    rotation: number[];
    width?: number; height?: number; depth?: number;
    radius?: number; numSegments?: number;
    quality?: string; vertices?: number[][]; faces?: number[][]; v?: number;
    /**
     * A convex hull's: the meshes the editor built it from, as paths of node names from the node ('Body', and
     * all under it). Authoring data; the physics reads only the vertices and faces.
     */
    sources?: string[];
    [key: string]: unknown;
}

export { ALL_LAYERS };

/**
 * A 3D collider: a rigid body, made of the shapes it lists, that the physics world simulates. Mass 0 makes
 * it static (a wall, the floor of a room, a prop that never moves); mass above 0 makes it fall, slide and
 * get pushed. Everything under it moves with it: a crate is a Collider with a box shape and the crate's
 * model as its child, and a Character stands in a Collider holding its capsule.
 *
 * Its `layer` is the collision layer it is on (one bit, collisionLayers.ts), its `mask` the layers it collides
 * with: two colliders collide when each one's mask holds the other's layer. Queries go by the layer too: a
 * camera rig's Blocked by and See through, a foot IK rig's trace layers, a raycast's `layerMask`. And what a
 * rig sees through is cut from the meshes this Collider holds. Its collisions reach `onCollision` on this node
 * itself.
 *
 * The body exists only while the scene runs (Play, a published game, a spawn): the editor's own scene
 * authors colliders and never simulates them. Read it as {@link body}.
 */
export class ColliderNode extends Node {
    public mass: number = 0;
    public linearDamping: number = 0.25;
    public angularDamping: number = 0.25;
    /** Per world axis: 1 free, 0 locked. */
    public linearConstraints: [number, number, number] = [1, 1, 1];
    public angularConstraints: [number, number, number] = [1, 1, 1];
    public friction: number = 0.3;
    public restitution: number = 0;
    /** Collide, push and be pushed. Off: still solid to rays and the camera, a ghost to the solver. */
    public simulatePhysics: boolean = true;
    /** Metres below its feet that still count as grounded (characters); 0 = contacts only. */
    public groundProbeDistance: number = 0;
    /** Seconds of smoothing on its measured motion; 0 = the engine default. */
    public motionSmoothing: number = 0;
    public simulationMode: SimulationMode = 'project';
    /** Metres from the camera past which a 'custom' collider freezes; 0 = unlimited. */
    public simulationRange: number = 0;
    /** Sleep once at rest, until hit, pushed or moved. */
    public canSleep: boolean = false;
    /** The collision layer it is on: one bit (layer 1, Default, is 1). */
    public layer: number = LAYER.DEFAULT;
    /** The layers it collides with (bits); -1 = all. */
    public mask: number = ALL_LAYERS;
    public shapes: ColliderShape[] = [];

    /**
     * Whether it falls and gets pushed (it has mass), as authored: the same answer while the scene is being
     * edited (no body) as while it runs. The live body is {@link body}.
     */
    public get isDynamic(): boolean { return this.mass > 0; }

    /**
     * Whether its body is in the physics world (Play only; never saved). Off takes the body out, keeping it
     * built: nothing collides with it, gravity leaves it be, and the node moves freely meanwhile, carried by a
     * parent it was moved under (a character in a car seat), a script or root motion. On puts the body back
     * where the node is now, at rest. A Character in it neither walks nor falls while it is off.
     */
    public get physicsEnabled(): boolean { return !this._bodySuspended; }
    public set physicsEnabled(on: boolean) {
        if (on === !this._bodySuspended) return;
        this._bodySuspended = !on;
        this._clearSimulatedPose();
        const physics = this._scene?.physics, body = this._body;
        // No body or no physics yet: the next physics step applies it.
        if (!physics || !body) return;
        if (!on) { physics.suspendBody(body); return; }
        // Where the node is NOW: world caches refresh only in the scene's transform pass, and a script may have
        // just moved or reparented it.
        this.updateTransforms(this._parent ? this._parent.worldTransform : null);
        physics.resumeBody(body, this.worldPosition, this.worldQuaternion);
    }

    constructor(name: string, id: string = uuidv4()) {
        super(name, 'collider', id);
        this.wantsPhysicsBuild = true;
    }

    /**
     * @internal Build the rigid body from the fields above, once: at parse into a running scene, or at the
     * first physics step for one made in code. Nothing in a scene that authors (spawn rules off).
     */
    public buildPhysics(): void {
        this.wantsPhysicsBuild = false;
        if (this._body) return;
        // A Character standing in it makes it a character's body: water leaves it be, the worker knows it.
        const character = this._children.some(c => c.nodeType === 'character');
        const body = this._createBody({
            mass: this.mass,
            linearDamping: this.linearDamping,
            angularDamping: this.angularDamping,
            linearConstraints: [...this.linearConstraints] as any,
            angularConstraints: [...this.angularConstraints] as any,
            friction: this.friction,
            restitution: this.restitution,
            simulatePhysics: this.simulatePhysics,
            groundProbeDistance: this.groundProbeDistance,
            motionSmoothing: this.motionSmoothing,
            simulationMode: this.simulationMode,
            simulationRange: this.simulationRange,
            canSleep: this.canSleep,
            group: this.layer,
            mask: this.mask,
            character,
        });
        Node.attachShapes(this, this.shapes, body);
        // AFTER every shape: the mass goes to the shapes' centre, not the node origin, or an offset shape
        // leaves the body rotating until it lines up with whatever it stands on.
        body.recenterMass();
    }

    /**
     * Rebuild the body's colliders from `shapes`, a copy of {@link shapes} with some of them changed, in one go;
     * `null` puts the authored {@link shapes} back. The authored list itself is left alone, so this is runtime
     * state: what a crouching Character does to its capsule. Nothing happens without a body.
     */
    public reshape(shapes: readonly ColliderShape[] | null): void {
        const body = this._body;
        if (!body) return;
        const colliders: ColliderDesc[] = [];
        // attachShapes' own conversion (world scale, euler degrees), collected instead of attached one by one.
        const sink = {
            attachShape(shape: Shape, offset: ArrayLike<number> = [0, 0, 0], orientation: ArrayLike<number> = [0, 0, 0]) {
                const q = quat.fromEuler(quat.create(), orientation[0], orientation[1], orientation[2]);
                colliders.push({ shape: shape.desc, offset: [offset[0], offset[1], offset[2]], rotation: [q[0], q[1], q[2], q[3]] });
                return sink;
            },
        };
        Node.attachShapes(this, shapes ?? this.shapes, sink as unknown as RigidBody);
        body.setColliders(colliders);
    }

    protected _afterParse(json: any): void {
        super._afterParse(json);
        // Built now in a scene that runs, so `body` is there for every onStart; never in one that authors.
        if (this.scene && this.scene.spawnRulesEnabled !== false) this.buildPhysics();
    }

    protected _serializePayload(): any {
        return {
            collider: {
                mass: this.mass,
                linearDamping: this.linearDamping,
                angularDamping: this.angularDamping,
                linearConstraints: [...this.linearConstraints],
                angularConstraints: [...this.angularConstraints],
                friction: this.friction,
                restitution: this.restitution,
                simulatePhysics: this.simulatePhysics,
                groundProbeDistance: this.groundProbeDistance,
                motionSmoothing: this.motionSmoothing,
                simulationMode: this.simulationMode,
                simulationRange: this.simulationRange,
                canSleep: this.canSleep,
                layer: this.layer,
                mask: this.mask,
                shapes: structuredClone(this.shapes),
            },
        };
    }

    /** The collider's settings from JSON (a Collider node's `collider` block, or a legacy `body`). */
    public static readSettings(node: ColliderNode, d: any): void {
        if (!d || typeof d !== 'object') return;
        const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
        const axes = (v: unknown): [number, number, number] =>
            Array.isArray(v) && v.length >= 3 ? [num(v[0], 1), num(v[1], 1), num(v[2], 1)] : [1, 1, 1];
        node.mass = Math.max(0, num(d.mass, 0));
        node.linearDamping = num(d.linearDamping, 0.25);
        node.angularDamping = num(d.angularDamping, 0.25);
        node.linearConstraints = axes(d.linearConstraints);
        node.angularConstraints = axes(d.angularConstraints);
        node.friction = num(d.friction, 0.3);
        node.restitution = num(d.restitution, 0);
        node.simulatePhysics = d.simulatePhysics !== false;
        node.groundProbeDistance = Math.max(0, num(d.groundProbeDistance, 0));
        node.motionSmoothing = Math.max(0, num(d.motionSmoothing, 0));
        node.simulationMode = parseSimulationMode(d.simulationMode);
        node.simulationRange = Math.max(0, num(d.simulationRange, 0));
        node.canSleep = d.canSleep === true;
        // A block saved with the old camera channel (`cameraCollision: false`) is on No Camera now.
        node.layer = legacyColliderLayer(null, d);
        node.mask = Math.trunc(num(d.mask, ALL_LAYERS));
        node.shapes = Array.isArray(d.shapes) ? structuredClone(d.shapes) : [];
    }

    public static parse(parent: Node, json: any) {
        const node = new ColliderNode(json.name, json.id);
        ColliderNode.readSettings(node, json.collider);
        // Saved when a node or a mesh in it asked for the camera's see-through hole: on See Through now.
        if (json.collider) node.layer = legacyColliderLayer(json);
        Node._colliderParseDepth++;
        try { Node.finishParse(node, parent, json); } finally { Node._colliderParseDepth--; }
    }
}
