import { describe, it, expect, afterEach } from 'vitest';
import { Game, setGameHost } from '../src/core/game';
import type { GameHost } from '../src/core/game';

// Game.loadScene is the one door a script has to another scene. It must throw SYNCHRONOUSLY with no
// host (scripts guard it with try/catch outside play), resolve only once the host has finished, and
// relay the host's stages to anyone listening.

afterEach(() => setGameHost(null));

describe('Game.loadScene', () => {
    it('throws at the call when no game is running', () => {
        setGameHost(null);
        expect(() => Game.loadScene('Dungeon')).toThrow(/only available while the game is running/);
    });

    it('relays the host progress and resolves after the host does', async () => {
        const seen: [number, string][] = [];
        let finished = false;
        const host: GameHost = {
            async loadScene(_name, options) {
                options?.onProgress?.(0.3, 'Reading');
                await Promise.resolve();
                options?.onProgress?.(0.8, 'Building');
                finished = true;
            },
            currentSceneName: () => 'Valley',
            sceneNames: () => ['Valley', 'Dungeon'],
        };
        setGameHost(host);
        const off = Game.onLoadProgress((f, stage) => seen.push([f, stage]));
        await Game.loadScene('Dungeon');
        off();
        expect(finished).toBe(true);
        expect(seen.map(([f]) => f)).toEqual([0, 0.3, 0.8, 1]);
        expect(seen[1][1]).toBe('Reading');
    });

    it('still works with a host written before progress existed', async () => {
        let loaded = '';
        setGameHost({ loadScene: (n: string) => { loaded = n; }, currentSceneName: () => '', sceneNames: () => [] });
        await Game.loadScene('Dungeon');
        expect(loaded).toBe('Dungeon');
    });
});
