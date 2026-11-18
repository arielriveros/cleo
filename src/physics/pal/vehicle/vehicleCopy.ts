import type { BodyHandle, Out } from '../types';
import type { NormalizedVehicle, VehicleHandle, VehicleInput, VehicleRecord } from './vehicleDesc';
import { VH_WHEELS, vehicleStateSize } from './vehicleState';

// Vehicles in the physics worker's copy of a world (pal/replication.ts), the same on every backend. A
// vehicle is copied as what it was built from (its normalised description, its chassis by slot), like a
// joint; each frame every vehicle's driver input goes along with the step, and each step's vehicle states
// come back with the bodies and are kept by the main thread's world, which readVehicle then answers from.

/** What a backend world offers for its vehicles to be copied. */
export interface CopiedVehicles {
    vehicleRecords(): IterableIterator<[number, VehicleRecord]>;
    /** The input last set on a vehicle. */
    vehicleInputOf(v: VehicleHandle): VehicleInput;
    createVehicleFromRecord(chassis: BodyHandle, vehicle: NormalizedVehicle): VehicleHandle;
    destroyVehicle(v: VehicleHandle): void;
    setVehicleInput(v: VehicleHandle, input: VehicleInput): void;
    readVehicle(v: VehicleHandle, out: Out): void;
    /** A state a step elsewhere reached (the worker's): what readVehicle answers until the next. */
    landVehicle(v: VehicleHandle, state: ArrayLike<number>, at: number): void;
}

/** How a backend world keeps one of its vehicles. */
export interface VehicleEntry<V> {
    vehicle: V;
    chassis: BodyHandle;
    /** The input last set (what a copy is sent each frame). */
    input: VehicleInput;
    /** The state a copy's step last landed (see landVehicle), until the world steps itself. */
    landed: number[] | null;
}

/** Keep a landed state: `size` numbers of `state` from `at`, the first VH_WHEELS-led header included. */
export function landState(entry: VehicleEntry<unknown>, state: ArrayLike<number>, at: number): void {
    const size = vehicleStateSize(state[at + VH_WHEELS]);
    const kept = entry.landed ?? (entry.landed = []);
    kept.length = size;
    for (let i = 0; i < size; i++) kept[i] = state[at + i];
}

/** A kept state into `out`. */
export function copyState(state: readonly number[], out: Out): void {
    for (let i = 0; i < state.length; i++) out[i] = state[i];
}

/** A frame's vehicle changes, in a mirror's diff. */
export interface VehicleChanges {
    removes: number[];
    adds: { id: number; chassis: number; vehicle: NormalizedVehicle }[];
    /** Every vehicle's input: [id, forward, right, brake, handBrake] per vehicle. */
    inputs: Float64Array;
}

const INPUT_ROW = 5;

/** The main thread's end. */
export class VehicleMirror {
    private readonly _sent = new Set<number>();

    constructor(private readonly _world: CopiedVehicles, private readonly _slotOf: (h: BodyHandle) => number | undefined) {}

    /** After the bodies are diffed: a chassis is sent before the vehicle on it. */
    public diff(): VehicleChanges | undefined {
        const live = new Set<number>(), adds: VehicleChanges['adds'] = [], inputs: number[] = [];
        for (const [id, record] of this._world.vehicleRecords()) {
            const slot = this._slotOf(record.chassis);
            if (slot === undefined) continue;
            live.add(id);
            if (!this._sent.has(id)) { this._sent.add(id); adds.push({ id, chassis: slot, vehicle: record.vehicle }); }
            const input = this._world.vehicleInputOf(id as VehicleHandle);
            inputs.push(id, input.forward, input.right, input.brake, input.handBrake);
        }
        const removes: number[] = [];
        for (const id of [...this._sent]) if (!live.has(id)) { removes.push(id); this._sent.delete(id); }
        if (live.size === 0 && removes.length === 0) return undefined;
        return { removes, adds, inputs: Float64Array.from(inputs) };
    }

    /** A step's vehicle rows (VehicleReplica.report) into the world's vehicles. */
    public apply(rows: Float64Array | undefined): void {
        if (!rows) return;
        for (let o = 0; o < rows.length;) {
            const id = rows[o], size = rows[o + 1];
            if (this._sent.has(id)) {
                try { this._world.landVehicle(id as VehicleHandle, rows, o + 2); } catch { /* removed since the step was posted */ }
            }
            o += 2 + size;
        }
    }

    public clear(): void { this._sent.clear(); }
}

/** The worker's end. */
export class VehicleReplica {
    private readonly _handles = new Map<number, VehicleHandle>();
    private _row: number[] = [];

    constructor(private readonly _world: CopiedVehicles, private readonly _handleOf: (slot: number) => BodyHandle | undefined) {}

    /** After the bodies are received. */
    public receive(changes: VehicleChanges | undefined): void {
        if (!changes) return;
        for (const id of changes.removes) {
            const h = this._handles.get(id);
            if (h !== undefined) { this._world.destroyVehicle(h); this._handles.delete(id); }
        }
        for (const add of changes.adds) {
            const chassis = this._handleOf(add.chassis);
            if (chassis !== undefined) this._handles.set(add.id, this._world.createVehicleFromRecord(chassis, add.vehicle));
        }
        const inputs = changes.inputs;
        for (let o = 0; o < inputs.length; o += INPUT_ROW) {
            const h = this._handles.get(inputs[o]);
            if (h !== undefined) this._world.setVehicleInput(h, { forward: inputs[o + 1], right: inputs[o + 2], brake: inputs[o + 3], handBrake: inputs[o + 4] });
        }
    }

    /** Every vehicle's state: [id, size, ...state] per vehicle. Undefined with none. */
    public report(): Float64Array | undefined {
        if (this._handles.size === 0) return undefined;
        const out = this._row;
        out.length = 0;
        const scratch: number[] = [];
        for (const [id, h] of this._handles) {
            try {
                scratch.length = 0;
                scratch[VH_WHEELS] = 0;
                this._world.readVehicle(h, scratch);
                const size = vehicleStateSize(scratch[VH_WHEELS]);
                out.push(id, size);
                for (let i = 0; i < size; i++) out.push(scratch[i] ?? 0);
            } catch {
                // Its chassis went with a body removal: the main thread's remove follows.
                this._handles.delete(id);
            }
        }
        return Float64Array.from(out);
    }

    public clear(): void { this._handles.clear(); }
}
