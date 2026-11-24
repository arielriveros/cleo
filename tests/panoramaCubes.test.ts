import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PanoramaCubes, panoramaFaceSize, PANORAMA_MAX_FACE } from '../src/graphics/render/panoramaCubes';
import { TextureManager } from '../src/graphics/systems/textureManager';
import type { Texture } from '../src/graphics/texture';

// The cache behind a custom material's cubemap uniform: what it bakes, when it bakes again, and what it
// hands a draw. The GPU half (SkyPasses.bakePanoramaCube) and the cube's allocation are stand-ins.

type Fake = Texture & { deleted?: boolean };

const image = (width: number, height: number, target = 'texture2D'): Fake =>
    ({ width, height, config: { target } }) as unknown as Fake;

let library: Map<string, Fake>;
let baked: { source: Texture; size: number }[];
let made: Fake[];

function cache(): PanoramaCubes {
    return new PanoramaCubes(
        (source, _target, size) => { baked.push({ source, size }); },
        (size) => {
            const cube = { width: size, height: size, config: { target: 'cubemap' }, delete() { (cube as Fake).deleted = true; } } as unknown as Fake;
            made.push(cube);
            return cube;
        });
}

beforeEach(() => {
    library = new Map();
    baked = [];
    made = [];
    vi.spyOn(TextureManager.Instance, 'getTexture').mockImplementation((id: string) => library.get(id));
});
afterEach(() => { vi.restoreAllMocks(); });

describe('panoramaFaceSize', () => {
    it('is a quarter of the width, to the next power of two, between 32 and the cap', () => {
        expect(panoramaFaceSize(2048)).toBe(512);
        expect(panoramaFaceSize(4096)).toBe(1024);
        expect(panoramaFaceSize(2000)).toBe(512);
        expect(panoramaFaceSize(64)).toBe(32);
        expect(panoramaFaceSize(16384)).toBe(PANORAMA_MAX_FACE);
    });
});

describe('PanoramaCubes', () => {
    it('waits for a texture that is missing or still decoding, then bakes it once', () => {
        const panoramas = cache();
        panoramas.ensure('sky', 1);
        expect(baked).toHaveLength(0);
        library.set('sky', image(0, 0));
        panoramas.ensure('sky', 2);
        expect(baked).toHaveLength(0);
        expect(panoramas.cube('sky')).toBeNull();

        const sky = image(2048, 1024);
        library.set('sky', sky);
        panoramas.ensure('sky', 3);
        panoramas.ensure('sky', 4);
        panoramas.ensure('sky', 5);
        expect(baked).toEqual([{ source: sky, size: 512 }]);
        expect(panoramas.cube('sky')).toBe(made[0]);
    });

    it('bakes again when the image behind the id is replaced or resized, freeing the old cube', () => {
        const panoramas = cache();
        library.set('sky', image(2048, 1024));
        panoramas.ensure('sky', 1);

        // A re-import registers a new texture under the same id: the draw stops binding the stale cube at once.
        const reimported = image(4096, 2048);
        library.set('sky', reimported);
        expect(panoramas.cube('sky')).toBeNull();
        panoramas.ensure('sky', 2);
        expect(baked.map(b => b.size)).toEqual([512, 1024]);
        expect(made[0].deleted).toBe(true);
        expect(panoramas.cube('sky')).toBe(made[1]);

        // The same texture object given new pixels of another size.
        (reimported as any).width = 1024; (reimported as any).height = 512;
        panoramas.ensure('sky', 3);
        expect(baked.map(b => b.size)).toEqual([512, 1024, 256]);
        expect(panoramas.textures).toEqual([made[2]]);
    });

    it('binds a cubemap as it is, and never wraps a volume or an array', () => {
        const panoramas = cache();
        const cube = image(256, 256, 'cubemap');
        library.set('cube', cube);
        library.set('volume', image(64, 64, 'texture3D'));
        panoramas.ensure('cube', 1);
        panoramas.ensure('volume', 1);
        expect(baked).toHaveLength(0);
        expect(panoramas.cube('cube')).toBe(cube);
        expect(panoramas.cube('volume')).toBeNull();
        // Not this cache's to free, nor to count.
        expect(panoramas.textures).toEqual([]);
        panoramas.clear();
        expect((cube as Fake).deleted).toBeUndefined();
    });

    it('never bakes from the draw-time lookup', () => {
        const panoramas = cache();
        library.set('sky', image(2048, 1024));
        expect(panoramas.cube('sky')).toBeNull();
        expect(baked).toHaveLength(0);
    });

    it('frees a cube nobody has asked for in a sweep interval', () => {
        const panoramas = cache();
        library.set('sky', image(2048, 1024));
        library.set('dusk', image(2048, 1024));
        panoramas.ensure('sky', 1);
        panoramas.ensure('dusk', 1);
        const interval = PanoramaCubes.SWEEP_INTERVAL;
        panoramas.ensure('sky', interval);
        panoramas.sweep(interval + 1);
        expect(panoramas.cube('sky')).toBe(made[0]);
        expect(panoramas.cube('dusk')).toBeNull();
        expect(made[1].deleted).toBe(true);
        expect(made[0].deleted).toBeUndefined();
    });
});
