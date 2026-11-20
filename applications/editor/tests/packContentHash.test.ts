import { describe, expect, it } from 'vitest';
import { contentHashOf, packGameBin } from '../src/features/publish/pack';
import { unpackGameBin } from '../src/player/unpack';

// A NetSync host and its players compare the game's fingerprint before a player may join (docs/design/
// netsync.md §6.1). It must tell any two builds apart — including an edit that changes bytes but not sizes, which
// the manifest's chunk offsets alone would not show.
const game = (pixel: number) => ({
    version: 2,
    entry: 'main',
    scenes: { main: { name: 'Main', scene: { name: 'root', children: [{ name: 'Crate', children: [] }] } } },
    textureBytes: [{ id: 'tex', bytes: new Uint8Array([1, 2, 3, pixel]), mime: 'image/png', config: {} }],
});

describe('a packed game’s content hash', () => {
    it('is in the manifest, the same for the same game', () => {
        const a = unpackGameBin(packGameBin(game(4)).buffer).manifest;
        const b = unpackGameBin(packGameBin(game(4)).buffer).manifest;
        expect(a.contentHash).toMatch(/^[0-9a-f]{16}$/);
        expect(a.contentHash).toBe(b.contentHash);
    });

    it('differs when one byte of a chunk changes, at the same size', () => {
        const a = unpackGameBin(packGameBin(game(4)).buffer).manifest;
        const b = unpackGameBin(packGameBin(game(5)).buffer).manifest;
        expect(a.textures![0].l).toBe(b.textures![0].l);
        expect(a.contentHash).not.toBe(b.contentHash);
    });

    it('differs when the scene changes', () => {
        const edited = game(4);
        edited.scenes.main.scene.children[0].name = 'Barrel';
        expect(unpackGameBin(packGameBin(edited).buffer).manifest.contentHash)
            .not.toBe(unpackGameBin(packGameBin(game(4)).buffer).manifest.contentHash);
    });

    it('counts where one part ends', () => {
        expect(contentHashOf(new Uint8Array([1, 2]), new Uint8Array([3]))).not.toBe(contentHashOf(new Uint8Array([1]), new Uint8Array([2, 3])));
    });
});
