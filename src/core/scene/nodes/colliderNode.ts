import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";
import { parseSimulationMode } from "../../../physics/simulationRange";
import type { SimulationMode } from "../../../physics/simulationRange";

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
    [key: string]: unknown;
}

/** Every bit set: collides with every layer. */
export const ALL_LAYERS = -1;

/**
 * A 3D collider: a rigid body, made of the shapes it lists, that the physics world simulates. Mass 0 makes
 * it static (a wall, the floor of a room, a prop that never moves); mass above 0 makes it fall, slide and
 * get pushed. Everything under it moves with it: a crate is a Collider with a box shape and the crate's
 * model as its child, and a Character stands in a Collider holding its capsule.
 *
 * Its `layer` is the collision layers it is in, its `mask` the layers it collides with: two colliders
 * collide when each one's mask holds a layer of the other. Its collisions reach `onCollision` on this
 * node itself.
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
    /** Block a camera rig's collision probe. */
    public cameraCollision: boolean = true;
    /** Metres below its feet that still count as grounded (characters); 0 = contacts only. */
    public groundProbeDistance: number = 0;
    /** Seconds of smoothing on its measured motion; 0 = the engine default. */
    public motionSmoothing: number = 0;
    public simulationMode: SimulationMode = 'project';
    /** Metres from the camera past which a 'custom' collider freezes; 0 = unlimited. */
    public simulationRange: number = 0;
    /** Sleep once at rest, until hit, pushed or moved. */
    public canSleep: boolean = false;
    /** The collision layers it is in (bits). */
    public layer: number = 1;
    /** The layers it collides with (bits); -1 = all. */
    public mask: number = ALL_LAYERS;
    public shapes: ColliderShape[] = [];

    /**
     * Whether it falls and gets pushed (it has mass), as authored: the same answer while the scene is being
     * edited (no body) as while it runs. The live body is {@link body}.
     */
    public get isDynamic(): boolean { return this.mass > 0; }

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
            cameraCollision: this.cameraCollision,
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
                cameraCollision: this.cameraCollision,
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
        node.cameraCollision = d.cameraCollision !== false;
        node.groundProbeDistance = Math.max(0, num(d.groundProbeDistance, 0));
        node.motionSmoothing = Math.max(0, num(d.motionSmoothing, 0));
        node.simulationMode = parseSimulationMode(d.simulationMode);
        node.simulationRange = Math.max(0, num(d.simulationRange, 0));
        node.canSleep = d.canSleep === true;
        node.layer = Math.trunc(num(d.layer, 1));
        node.mask = Math.trunc(num(d.mask, ALL_LAYERS));
        node.shapes = Array.isArray(d.shapes) ? structuredClone(d.shapes) : [];
    }

    public static parse(parent: Node, json: any) {
        const node = new ColliderNode(json.name, json.id);
        ColliderNode.readSettings(node, json.collider);
        Node.finishParse(node, parent, json);
    }
}
