import { Body, Constraint, Shape } from 'cannon-es';
import type { BodyHandle } from '../types';
import type { ReplicaFloater, WorldReplica } from '../replication';
import { CannonWorld } from './cannonWorld';
import {
    BODY_ROW, STATE_STRIDE, applyConfig, decodeConstraint, decodeShape, writeState, type CannonChanges, type ShapeRef,
} from './replicaCodec';

// The physics worker's copy of the cannon world (see pal/replication.ts): a world built exactly like the main
// thread's (worldConfig.ts), with every body, shape and constraint rebuilt from the mirror's changes
// (mirror.ts) so that it steps bit for bit like the original would.

type ReplicaBody = Body & { __slot?: number; __mainId?: number; __character?: boolean };

export class CannonReplica implements WorldReplica {
    public readonly world = new CannonWorld([0, -9.81, 0]);
    private readonly _bodies: (ReplicaBody | undefined)[] = [];
    private readonly _constraints = new Map<number, Constraint>();
    private readonly _shapes = new Map<number, Shape>();
    private readonly _floater: ReplicaFloater = { mass: 0, isTrigger: false, collisionResponse: true, character: false };

    public receive(changes: unknown): void {
        const { ops, writes, writeCount } = changes as CannonChanges;
        const world = this.world;
        for (const op of ops) {
            switch (op.op) {
                case 'removeConstraint': {
                    const c = this._constraints.get(op.id);
                    if (c) { world.raw.removeConstraint(c); this._constraints.delete(op.id); }
                    break;
                }
                case 'removeBody': {
                    const b = this._bodies[op.slot];
                    if (b) { world.destroyBody(b.id as BodyHandle); this._bodies[op.slot] = undefined; }
                    break;
                }
                case 'addBody': {
                    const b: ReplicaBody = new Body({ mass: op.config.mass });
                    b.__slot = op.slot;
                    applyConfig(b, op.config, this._shapeOf, this._materialOf);
                    writeState(b, op.state, 0, -1);
                    this._bodies[op.slot] = b;
                    world.raw.addBody(b);
                    if (op.config.wantsCollide) world.setReportContacts(b.id as BodyHandle, true);
                    break;
                }
                case 'config': {
                    const b = this._bodyOf(op.slot);
                    applyConfig(b, op.config, this._shapeOf, this._materialOf);
                    if (op.config.wantsCollide) world.setReportContacts(b.id as BodyHandle, true);
                    break;
                }
                case 'addConstraint': {
                    const c = decodeConstraint(op.def, this._bodyOf);
                    this._constraints.set(op.id, c);
                    world.raw.addConstraint(c);
                    break;
                }
            }
        }
        for (let i = 0; i < writeCount; i++) {
            const at = i * (STATE_STRIDE + 2);
            const b = this._bodies[writes[at]];
            if (b) writeState(b, writes, at + 2, writes[at + 1]);
        }
    }

    public slotOf(h: BodyHandle): number | undefined {
        return (this.world.bodyOf(h) as ReplicaBody | undefined)?.__slot;
    }

    public floater(h: BodyHandle): ReplicaFloater | undefined {
        const body = this.world.bodyOf(h) as ReplicaBody | undefined;
        if (!body || body.type !== Body.DYNAMIC) return undefined;
        const f = this._floater;
        f.mass = body.mass;
        f.isTrigger = body.isTrigger;
        f.collisionResponse = body.collisionResponse;
        f.character = !!body.__character;
        return f;
    }

    public report(take: (bytes: number) => ArrayBuffer): { bodies: Float64Array; bodyCount: number } {
        const all = this.world.raw.bodies;
        let dynamic = 0;
        for (const b of all) if (b.type !== Body.STATIC) dynamic++;
        const bodies = new Float64Array(take(dynamic * BODY_ROW * 8), 0, dynamic * BODY_ROW);
        let k = 0;
        for (const b of all as ReplicaBody[]) {
            if (b.type === Body.STATIC) continue;
            const p = b.position, q = b.quaternion, v = b.velocity, w = b.angularVelocity;
            bodies[k] = b.__slot!;
            bodies[k + 1] = p.x; bodies[k + 2] = p.y; bodies[k + 3] = p.z;
            bodies[k + 4] = q.x; bodies[k + 5] = q.y; bodies[k + 6] = q.z; bodies[k + 7] = q.w;
            bodies[k + 8] = v.x; bodies[k + 9] = v.y; bodies[k + 10] = v.z;
            bodies[k + 11] = w.x; bodies[k + 12] = w.y; bodies[k + 13] = w.z;
            bodies[k + 14] = b.sleepState;
            k += BODY_ROW;
        }
        return { bodies, bodyCount: dynamic };
    }

    public clear(): void {
        this.world.clear();
        this._bodies.length = 0;
        this._constraints.clear();
        this._shapes.clear();
    }

    private _shapeOf = (ref: ShapeRef): Shape => {
        let shape = this._shapes.get(ref.id);
        if (!shape) {
            if (!ref.def) throw new Error(`physics worker: shape ${ref.id} arrived without its definition`);
            shape = decodeShape(ref.def);
            (shape as Shape & { __mainId?: number }).__mainId = ref.id;
            this._shapes.set(ref.id, shape);
        }
        return shape;
    };

    private _materialOf = (key: string | null) => this.world.materials.forKey(key);

    private _bodyOf = (slot: number): Body => {
        const b = this._bodies[slot];
        if (!b) throw new Error(`physics worker: no body in slot ${slot}`);
        return b;
    };
}
