import { quat, vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";
import { finiteOr } from "../../math";

/**
 * One wheel of a {@link VehicleNode}: where it sits, how it springs, grips, steers and brakes. Not a body:
 * each physics step the vehicle finds the ground under it and pushes the chassis there (a virtual wheel,
 * as every engine with vehicles does it). Put the wheel's mesh under it; while the game runs the node turns
 * with the wheel's spin and steering and rides up and down its suspension, carrying the mesh.
 *
 * Place it at the wheel's centre with the suspension fully EXTENDED (the wheel hanging free): it is
 * pushed up from there as the vehicle settles on its springs.
 */
export class WheelNode extends Node {
    /** Metres. */
    public radius: number = 0.35;
    public width: number = 0.25;
    /**
     * How far the wheel travels up from where it is placed before the suspension bottoms out, metres. The
     * spring is attached `suspensionLength` above the wheel's centre and pushes nothing at full extension.
     */
    public suspensionTravel: number = 0.3;
    /** From the attachment to the wheel's centre at full extension, metres. At least the travel. */
    public suspensionLength: number = 0.5;
    /** The spring's natural frequency, Hz: 1–2 a road car, 2–3 a sports car, 3+ a kart. */
    public suspensionFrequency: number = 1.5;
    /** 0 bouncy .. 1 critically damped. */
    public suspensionDamping: number = 0.5;
    /** Steering lock, DEGREES: 0 for a wheel that does not steer. */
    public steerAngle: number = 0;
    /** Whether the engine turns it. */
    public driven: boolean = false;
    /** N·m at full brake. */
    public brakeTorque: number = 1500;
    /** N·m at full hand brake: 0 for a wheel the hand brake does not hold. */
    public handBrakeTorque: number = 0;
    /** Scales the tyre's friction curves: 1 a road tyre on tarmac, below 1 worn or on a slippery surface. */
    public grip: number = 1;

    // ---- runtime (never serialized) ----

    /** The authored local pose, captured when the vehicle is built: what the wheel moves from. */
    private _restPosition: vec3 | null = null;
    private readonly _restQuaternion = quat.create();
    /** The parent's rotation relative to the chassis, at build. */
    private readonly _parentInChassis = quat.create();
    private static readonly _q = quat.create();
    private static readonly _q2 = quat.create();
    private static readonly _v = vec3.create();

    constructor(name: string, id: string = uuidv4()) {
        super(name, 'wheel', id);
    }

    /** @internal VehicleNode: remember the authored pose before moving it, and the parent's turn in the chassis. */
    public _captureRest(parentInChassis: quat): void {
        if (!this._restPosition) {
            this._restPosition = vec3.clone(this.position);
            quat.copy(this._restQuaternion, this.quaternion);
        }
        quat.copy(this._parentInChassis, parentInChassis);
    }

    /** @internal The authored pose, as captured (the node's own until it is). */
    public get _restLocalPosition(): vec3 { return this._restPosition ?? this.position; }

    /**
     * @internal VehicleNode, each frame: put the node where the wheel is. Directions are the chassis's:
     * `down` the suspension's, `up` and `axle` the steering and rolling axes, `drop` metres below the authored
     * place (negative when compressed), `steer` and `spin` radians.
     */
    public _pose(down: ArrayLike<number>, up: ArrayLike<number>, axle: ArrayLike<number>, drop: number, steer: number, spin: number): void {
        const rest = this._restPosition;
        if (!rest) return;
        const inv = quat.invert(WheelNode._q2, this._parentInChassis);
        // The drop along the suspension, in the parent's frame.
        const d = vec3.transformQuat(WheelNode._v, [down[0] * drop, down[1] * drop, down[2] * drop], inv);
        this.setPosition(vec3.add(d, rest, d));
        // In the chassis's frame: steer about up, after the spin about the axle, after the authored turn.
        const q = WheelNode._q;
        quat.multiply(q, this._parentInChassis, this._restQuaternion);
        const spinQ = quat.setAxisAngle(quat.create(), axle as vec3, spin);
        quat.multiply(q, spinQ, q);
        const steerQ = quat.setAxisAngle(quat.create(), up as vec3, steer);
        quat.multiply(q, steerQ, q);
        this.setQuaternion(quat.multiply(q, inv, q));
    }

    protected _serializePayload(): any {
        return {
            radius: this.radius, width: this.width,
            suspensionTravel: this.suspensionTravel, suspensionLength: this.suspensionLength,
            suspensionFrequency: this.suspensionFrequency, suspensionDamping: this.suspensionDamping,
            steerAngle: this.steerAngle, driven: this.driven,
            brakeTorque: this.brakeTorque, handBrakeTorque: this.handBrakeTorque, grip: this.grip,
        };
    }

    /** Read a wheel's settings from JSON onto `node`, each falling back to what it has. */
    public static readSettings(node: WheelNode, json: any): void {
        const positive = (v: unknown, fallback: number) => (typeof v === 'number' && v > 0 ? v : fallback);
        const nonNegative = (v: unknown, fallback: number) => (typeof v === 'number' && v >= 0 ? v : fallback);
        node.radius = positive(json.radius, node.radius);
        node.width = positive(json.width, node.width);
        node.suspensionTravel = nonNegative(json.suspensionTravel, node.suspensionTravel);
        node.suspensionLength = Math.max(node.suspensionTravel, positive(json.suspensionLength, node.suspensionLength));
        node.suspensionFrequency = positive(json.suspensionFrequency, node.suspensionFrequency);
        node.suspensionDamping = nonNegative(json.suspensionDamping, node.suspensionDamping);
        node.steerAngle = Math.min(89, nonNegative(json.steerAngle, node.steerAngle));
        if (typeof json.driven === 'boolean') node.driven = json.driven;
        node.brakeTorque = nonNegative(json.brakeTorque, node.brakeTorque);
        node.handBrakeTorque = nonNegative(json.handBrakeTorque, node.handBrakeTorque);
        node.grip = finiteOr(json.grip, node.grip) > 0 ? finiteOr(json.grip, node.grip) : node.grip;
    }

    public static parse(parent: Node, json: any): void {
        const node = new WheelNode(json.name, json.id);
        WheelNode.readSettings(node, json);
        Node.finishParse(node, parent, json);
    }
}
