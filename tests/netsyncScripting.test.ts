import { describe, expect, it } from 'vitest';
import { NETCALL_ORIGINAL, applyScriptDecorators, netcall, scriptMembersOf, synced } from '../src/core/scripting/decorators';
import { Game } from '../src/core/game';
import type { SceneNet } from '../src/core/net/sceneNet';

describe('NetSync script decorators', () => {
    it('@synced records the field, bare or with an onChange', () => {
        class Door { open = false; locked = false; swing() {} }
        applyScriptDecorators(Door, [
            [[synced], 'field', 'open', 0],
            [[synced({ onChange: 'swing' })], 'field', 'locked', 0],
        ]);
        expect(scriptMembersOf(Door)).toEqual(expect.arrayContaining([
            { kind: 'synced', field: 'open' },
            { kind: 'synced', field: 'locked', onChange: 'swing' },
        ]));
    });

    it('@netcall records its routing and wraps the method, which simply runs offline', () => {
        class Gun { shots = 0; scene: { net: SceneNet | null } | null = null; fire(n: number) { this.shots += n; return 'bang'; } }
        applyScriptDecorators(Gun, [[[netcall({ to: 'host', anyone: true })], 'method', 'fire', 0]]);
        expect(scriptMembersOf(Gun)).toEqual([{ kind: 'netcall', method: 'fire', to: 'host', reliable: true, anyone: true }]);
        const gun = new Gun();
        expect((gun.fire as any)[NETCALL_ORIGINAL]).toBeTypeOf('function');
        expect(gun.fire(2)).toBe('bang'); // no scene.net: offline, it just runs
        expect(gun.shots).toBe(2);
    });

    it('@netcall hands the call to the scene’s network when there is one', () => {
        class Gun { shots = 0; scene: { net: SceneNet | null } | null = null; fire(n: number) { this.shots += n; } }
        applyScriptDecorators(Gun, [[[netcall({ to: 'all', reliable: false })], 'method', 'fire', 0]]);
        const routed: unknown[] = [];
        const gun = new Gun();
        gun.scene = { net: { role: 'peer', peerId: 3, caller: 0, ownerOf: () => 0, emit: () => {},
            call: (node, method, original, args, options) => { routed.push([node, method, args, options]); return 'sent'; } } };
        expect(gun.fire(5)).toBe('sent');
        expect(gun.shots).toBe(0);
        expect(routed).toEqual([[gun, 'fire', [5], { to: 'all', reliable: false, anyone: false }]]);
    });

    it('@netcall refuses a target it does not know', () => {
        expect(() => netcall({ to: 'everyone' as any })).toThrow(/to: 'host' \| 'all' \| 'owner'/);
    });
});

describe('Game.random', () => {
    it('replays the same numbers from the same seed', () => {
        Game.seedRandom(42);
        const first = [Game.random(), Game.random(), Game.random()];
        Game.seedRandom(42);
        expect([Game.random(), Game.random(), Game.random()]).toEqual(first);
        for (const v of first) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
    });
});
