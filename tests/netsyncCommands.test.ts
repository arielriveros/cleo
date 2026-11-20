import { describe, expect, it } from 'vitest';
import { createIntent } from '../src/core/control/intent';
import { CommandQueue, decodeCommands, encodeCommands, type Command } from '../src/netsync/sync/commands';

const cmd = (tick: number, edit: (i: ReturnType<typeof createIntent>) => void = () => {}): Command => {
    const intent = createIntent();
    edit(intent);
    return { tick, intent };
};

describe('NetSync commands', () => {
    it('round-trip through the wire with their movement, aim and requests', () => {
        const c = cmd(1234, (i) => {
            i.move[0] = 0.5; i.move[1] = -1;
            i.basisYaw = 190; i.aimYaw = -45.25; i.aimPitch = 30.5;
            i.sprint = true; i.speedScale = 0.75;
            i.requests.jump = 0.15;
        });
        const bytes = encodeCommands([c, cmd(1233)]);
        expect(bytes.length).toBeLessThan(50);
        const [back, older] = decodeCommands(bytes);
        expect(back.tick).toBe(1234);
        expect(older.tick).toBe(1233);
        expect(back.intent.move[0]).toBeCloseTo(0.5, 4);
        expect(back.intent.move[1]).toBeCloseTo(-1, 4);
        expect(back.intent.basisYaw).toBeCloseTo(-170, 2); // wrapped into ±180
        expect(back.intent.aimYaw).toBeCloseTo(-45.25, 2);
        expect(back.intent.aimPitch).toBeCloseTo(30.5, 2);
        expect(back.intent.sprint).toBe(true);
        expect(back.intent.crouch).toBe(false);
        expect(back.intent.speedScale).toBeCloseTo(0.75, 2);
        expect(back.intent.requests.jump).toBeCloseTo(0.15, 2);
        expect(back.intent.requests.primary).toBe(0);
    });

    it('apply each tick its own command, and wait for one meant for a later tick', () => {
        const q = new CommandQueue();
        q.add(cmd(10, (i) => { i.move[1] = 1; }));
        q.add(cmd(12, (i) => { i.move[1] = -1; }));
        expect(q.take(10)!.move[1]).toBe(1);
        expect(q.pending).toBe(1);
        // Tick 11 has none: the last command's movement carries on for a moment.
        expect(q.take(11)!.move[1]).toBe(1);
        expect(q.take(12)!.move[1]).toBe(-1);
    });

    it('stop the character when commands stop coming', () => {
        const q = new CommandQueue(3);
        q.add(cmd(1, (i) => { i.move[0] = 1; }));
        expect(q.take(1)).not.toBeNull();
        expect(q.take(4)!.move[0]).toBe(1);
        expect(q.take(5)).toBeNull();
    });

    it('apply a request once, even from a redundant copy', () => {
        const q = new CommandQueue();
        const jump = cmd(5, (i) => { i.requests.jump = 0.2; });
        q.add(jump);
        expect(q.take(5)!.requests.jump).toBeCloseTo(0.2);
        q.add(jump); // the same command again, in the next datagram
        expect(q.take(6)!.requests.jump).toBe(0);
    });

    it('never drop a jump whose command came after its tick was played', () => {
        const q = new CommandQueue();
        q.add(cmd(7, (i) => { i.move[1] = 1; }));
        expect(q.take(7)!.requests.jump).toBe(0);
        // Tick 6's datagram was lost; tick 8's carries it redundantly, after 7 was played.
        q.add(cmd(6, (i) => { i.requests.jump = 0.2; }));
        q.add(cmd(8, (i) => { i.move[1] = 1; }));
        const out = q.take(8)!;
        expect(out.requests.jump).toBeCloseTo(0.2);
        expect(out.move[1]).toBe(1);
    });

    it('raise the requests of every command consumed in one tick', () => {
        const q = new CommandQueue();
        q.add(cmd(3, (i) => { i.requests.primary = 0.1; }));
        q.add(cmd(4, (i) => { i.requests.jump = 0.2; i.move[0] = -1; }));
        const out = q.take(4)!;
        expect(out.requests.primary).toBeCloseTo(0.1);
        expect(out.requests.jump).toBeCloseTo(0.2);
        expect(out.move[0]).toBe(-1);
    });
});
