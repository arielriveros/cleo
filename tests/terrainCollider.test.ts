import { describe, expect, it, beforeAll } from 'vitest';
import { setGLContext } from '../src/graphics/glContext';
import { WebGL2Device } from '../src/graphics/rhi/webgl2/webgl2Device';
import { setDevice } from '../src/graphics/rhi/deviceHandle';
import { Terrain } from '../src/terrain/terrain';
import { PhysicsSystem } from '../src/physics/physicsSystem';
import { PhysicsBody } from '../src/physics/physicsBody';
import { TEST_PHYSICS } from './helpers/testPhysics';

// A landscape's collider is the physics layer's heightfield (samples from its corner, i along +X, j along
// -Z), however the backend lays one out. Bodies dropped on a slope rising along X and a slope rising along Z
// must come to rest on the surface the terrain draws (heightAt) — a field laid out a turn wrong, or mirrored,
// would put them on the wrong height everywhere but the middle.

beforeAll(() => {
    let n = 0;
    const constants: Record<string, number> = {
        UNSIGNED_SHORT: 0x1403, UNSIGNED_INT: 0x1405, ARRAY_BUFFER: 0x8892,
        ELEMENT_ARRAY_BUFFER: 0x8893, STATIC_DRAW: 0x88e4, FLOAT: 0x1406, TRIANGLES: 0x0004,
    };
    const objects = new Set(['createVertexArray', 'createBuffer', 'createTexture']);
    const gl = new Proxy({}, {
        get: (_t, key: string) => (key in constants ? constants[key] : objects.has(key) ? () => ({ id: ++n }) : () => undefined),
    });
    setGLContext(gl as any);
    setDevice(new WebGL2Device(gl as unknown as WebGL2RenderingContext));
});

function landscape(slope: (col: number, row: number) => number) {
    const terrain = new Terrain({ size: 32, resolution: 17 });
    const R = 17, heights = new Float32Array(R * R);
    for (let r = 0; r < R; r++) for (let c = 0; c < R; c++) heights[r * R + c] = slope(c, r);
    terrain.setHeights(heights);
    const origin: [number, number, number] = [10, 1, -5];
    terrain.setOrigin(origin);
    const p = new PhysicsSystem({ gravity: [0, -9.82, 0], backend: TEST_PHYSICS });
    p.initialize();
    (p as any)._scene = { nodes: [], landscapes: [], tilemaps: [], activeCamera: null };
    terrain.ensureRegistered(p);
    return { terrain, p, origin };
}

describe('the terrain collider', () => {
    for (const [name, slope] of [
        ['rising along X', (c: number) => c * 0.25],
        ['rising along Z', (_c: number, r: number) => r * 0.25],
    ] as const) {
        it(`holds a ball on the drawn surface (${name})`, () => {
            const { terrain, p, origin } = landscape(slope);
            const balls = [[-8, -6], [6, 7], [0, 0]].map(([x, z]) => {
                const b = new PhysicsBody({ mass: 1, position: [origin[0] + x, origin[1] + 12, origin[2] + z], linearFactor: [0, 1, 0], angularFactor: [0, 0, 0] });
                b.addCollider({ shape: { kind: 'sphere', radius: 0.4 } });
                p.addBody(b);
                return { b, x, z };
            });
            for (let i = 0; i < 180; i++) p.update(1 / 60);
            for (const { b, x, z } of balls) {
                const surface = origin[1] + terrain.heightAt(x, z);
                expect(b.position.y - 0.4, `at ${x}, ${z}`).toBeGreaterThan(surface - 0.1);
                expect(b.position.y - 0.4, `at ${x}, ${z}`).toBeLessThan(surface + 0.15);
            }
        });
    }
});
