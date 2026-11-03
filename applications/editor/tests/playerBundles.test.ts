import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'fs';
import path from 'path';

// The published player is built once per physics backend (vite.player.config.ts): game.js for cannon games,
// without Rapier's ~4 MB of embedded WASM, and game-rapier.js with it. public/player/ is git-ignored and
// written by `npm run build:player`, so a checkout that has not built it has nothing to check.

const PLAYER = path.resolve(__dirname, '../public/player');
const cannon = path.join(PLAYER, 'game.js'), rapier = path.join(PLAYER, 'game-rapier.js');
/** The prefix of Rapier's WASM export names: property names, which minification keeps. */
const RAPIER_MARK = 'rawrigidbodyset_';

describe.skipIf(!existsSync(cannon) || !existsSync(rapier))('the published players', () => {
    it('leave Rapier out of the cannon player, and put it in the Rapier one', () => {
        expect(readFileSync(cannon, 'utf8').includes(RAPIER_MARK)).toBe(false);
        expect(readFileSync(rapier, 'utf8').includes(RAPIER_MARK)).toBe(true);
        // The difference is Rapier itself, embedded WASM and all.
        expect(statSync(rapier).size - statSync(cannon).size).toBeGreaterThan(3e6);
    });
});
