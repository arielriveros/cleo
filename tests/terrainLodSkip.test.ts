import { describe, it, expect, vi } from 'vitest';
import { vec3 } from 'gl-matrix';
import { LandscapeNode } from '../src/core/scene/nodes/landscapeNode';
import type { TerrainLodSettings } from '../src/terrain/terrain';

/**
 * LandscapeNode.updateLod picks every chunk's detail level each frame. With nothing it reads changed — the
 * camera, the settings, the terrain's origin and heights — a chunk keeps the level it was given, so the
 * per-chunk `lodFor` is skipped. Anything new still gets a level: a chunk that just initialized, or whose
 * mesh lost its level (a re-created index buffer resets it to 0).
 */
function fakeMesh() {
    let lod = 0;
    return {
        setLodIndices: vi.fn(),
        get activeLod() { return lod; },
        set activeLod(v: number) { lod = v; },
    };
}

function landscape(chunkCount: number) {
    const chunks = Array.from({ length: chunkCount }, () => ({
        model: { mesh: fakeMesh() }, lod: 0, lodSteps: null as [number, number] | null, lodStamp: -1,
    }));
    const terrain = {
        chunks,
        origin: [0, 0, 0],
        heightsVersion: 1,
        lodFor: vi.fn(() => 1),
        buildLodIndices: vi.fn(() => [0, 1, 2]),
    };
    const nodes = chunks.map(() => ({ initialized: true }));
    const node = Object.create(LandscapeNode.prototype) as LandscapeNode;
    Object.assign(node, { _terrain: terrain, _chunkNodes: nodes, _lodInputs: new Float64Array(13), _lodStamp: 0 });
    return { node, terrain, chunks, nodes };
}

const settings: TerrainLodSettings = { enabled: true, distance1: 120, distance2: 300, step1: 2, step2: 4 };

describe('LandscapeNode.updateLod', () => {
    it('picks every level once, then skips while nothing it reads changes', () => {
        const { node, terrain, chunks } = landscape(4);
        const cam = vec3.fromValues(1, 2, 3);
        node.updateLod(cam, settings);
        expect(terrain.lodFor).toHaveBeenCalledTimes(4);
        expect(chunks.every(c => c.lod === 1 && c.model.mesh.activeLod === 1)).toBe(true);
        node.updateLod(vec3.clone(cam), { ...settings });
        node.updateLod(cam, settings);
        expect(terrain.lodFor).toHaveBeenCalledTimes(4);
    });

    it('picks again when the camera, a setting, the origin or the heights change', () => {
        const { node, terrain } = landscape(2);
        const cam = vec3.fromValues(1, 2, 3);
        node.updateLod(cam, settings);
        cam[0] += 0.001; node.updateLod(cam, settings);
        expect(terrain.lodFor).toHaveBeenCalledTimes(4);
        node.updateLod(cam, { ...settings, distance1: 121 });
        expect(terrain.lodFor).toHaveBeenCalledTimes(6);
        terrain.origin[1] = 5; node.updateLod(cam, { ...settings, distance1: 121 });
        expect(terrain.lodFor).toHaveBeenCalledTimes(8);
        terrain.heightsVersion++; node.updateLod(cam, { ...settings, distance1: 121 });
        expect(terrain.lodFor).toHaveBeenCalledTimes(10);
    });

    it('gives a level to a chunk that initializes later, or whose mesh lost its level', () => {
        const { node, terrain, chunks, nodes } = landscape(3);
        nodes[2].initialized = false;
        const cam = vec3.fromValues(0, 0, 0);
        node.updateLod(cam, settings);
        expect(terrain.lodFor).toHaveBeenCalledTimes(2);
        nodes[2].initialized = true;
        node.updateLod(cam, settings);
        expect(terrain.lodFor).toHaveBeenCalledTimes(3);
        chunks[0].model.mesh.activeLod = 0;       // e.g. Mesh.create replaced its index buffers
        node.updateLod(cam, settings);
        expect(terrain.lodFor).toHaveBeenCalledTimes(4);
        expect(chunks[0].model.mesh.activeLod).toBe(1);
    });

    it('turning LOD off puts every chunk on level 0 once', () => {
        const { node, chunks, terrain } = landscape(2);
        const cam = vec3.fromValues(0, 0, 0);
        node.updateLod(cam, settings);
        const off = { ...settings, enabled: false };
        node.updateLod(cam, off);
        expect(chunks.every(c => c.lod === 0 && c.model.mesh.activeLod === 0)).toBe(true);
        node.updateLod(cam, off);
        expect(terrain.lodFor).toHaveBeenCalledTimes(2);
    });
});
