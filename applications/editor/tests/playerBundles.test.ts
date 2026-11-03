import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'fs';
import path from 'path';

// The published player is built once per physics backend (vite.player.config.ts): game.js for cannon games,
// without any WASM backend, game-rapier.js with Rapier's ~4 MB of embedded WASM, game-jolt.js with Jolt's
// ~3 MB. public/player/ is git-ignored and written by `npm run build:player`, so a checkout that has not
// built them has nothing to check.

const PLAYER = path.resolve(__dirname, '../public/player');
const players = { cannon: 'game.js', rapier: 'game-rapier.js', jolt: 'game-jolt.js' } as const;
const file = (name: keyof typeof players) => path.join(PLAYER, players[name]);
/** A name only each backend's bundle has: property names of its WASM bindings, which minification keeps. */
const MARKS = { rapier: 'rawrigidbodyset_', jolt: 'emscripten_bind_JoltInterface_' } as const;

describe.skipIf(!Object.keys(players).every(name => existsSync(file(name as keyof typeof players))))('the published players', () => {
    it('carry only their own backend', () => {
        const text = { cannon: readFileSync(file('cannon'), 'utf8'), rapier: readFileSync(file('rapier'), 'utf8'), jolt: readFileSync(file('jolt'), 'utf8') };
        for (const [player, source] of Object.entries(text))
            for (const [backend, mark] of Object.entries(MARKS))
                expect(source.includes(mark), `${players[player as keyof typeof players]} carries ${backend}`).toBe(player === backend);
    });

    it('are bigger than the cannon one by their backend, embedded WASM and all', () => {
        const cannon = statSync(file('cannon')).size;
        expect(statSync(file('rapier')).size - cannon).toBeGreaterThan(3e6);
        expect(statSync(file('jolt')).size - cannon).toBeGreaterThan(2e6);
    });
});
