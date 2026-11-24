import { describe, it, expect } from 'vitest';
import { vec3 } from 'gl-matrix';
import './helpers/features';
import { Node } from '../src/core/scene/nodes/node';
import { LodGroupNode } from '../src/core/scene/nodes/lodGroupNode';

// A shader sweep (Renderer.prepareShaders) draws every level of an LOD group in one frame, so each level's
// materials are built before the camera first comes near or goes far. After that frame the group shows its
// active level again -- or nothing, while it is distance-culled.

function group(): { lod: LodGroupNode; levels: Node[] } {
    const lod = new LodGroupNode('lod');
    lod.distances = [0, 10, 20];
    const levels = [new Node('LOD0'), new Node('LOD1'), new Node('LOD2')];
    for (const level of levels) lod.addChild(level);
    return { lod, levels };
}

const shown = (levels: Node[]) => levels.map(l => l.visible);

describe('an LOD group in a shader sweep', () => {
    it('shows every level for the frame, then its active one again', () => {
        const { lod, levels } = group();
        lod.updateLod(vec3.fromValues(0, 0, 30));
        expect(shown(levels)).toEqual([false, false, true]);
        lod.showAllLevels(true);
        expect(shown(levels)).toEqual([true, true, true]);
        lod.showAllLevels(false);
        expect(shown(levels)).toEqual([false, false, true]);
    });

    it('goes back to showing nothing when it was distance-culled', () => {
        const { lod, levels } = group();
        lod.cullDistance = 25;
        lod.updateLod(vec3.fromValues(0, 0, 40));
        expect(shown(levels)).toEqual([false, false, false]);
        lod.showAllLevels(true);
        expect(shown(levels)).toEqual([true, true, true]);
        lod.showAllLevels(false);
        expect(shown(levels)).toEqual([false, false, false]);
    });
});
