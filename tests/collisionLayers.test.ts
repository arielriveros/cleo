import { describe, it, expect } from 'vitest';
import {
    ALL_LAYERS, BUILT_IN_LAYERS, DEFAULT_CAMERA_BLOCKED_BY, DEFAULT_LAYER_NAMES, LAYER, LAYER_COUNT, isAllLayers,
    layerBit, layerByName, layerLabel, layerLabelsOf, layersCollide, normalizeLayerNames, singleLayerOf, storedMask,
} from '../src/physics/collisionLayers';
import {
    colliderAskedSeeThrough, legacyColliderLayer, legacyFoliageCollisionLayer, legacyRigLayers, migrateCameraLayersTree,
} from '../src/core/scene/nodes/cameraLayersLegacy';

describe('collision layers', () => {
    it('has sixteen, the engine naming the first four', () => {
        expect(LAYER_COUNT).toBe(16);
        expect(DEFAULT_LAYER_NAMES).toHaveLength(16);
        expect(DEFAULT_LAYER_NAMES.slice(0, BUILT_IN_LAYERS)).toEqual(['Default', 'Ragdoll', 'See Through', 'No Camera']);
        expect([LAYER.DEFAULT, LAYER.RAGDOLL, LAYER.SEE_THROUGH, LAYER.NO_CAMERA]).toEqual([1, 2, 4, 8]);
    });

    it('reads a stored name table tolerantly, the engine four fixed', () => {
        const names = normalizeLayerNames(['x', 'y', 'z', 'w', '  Stair   Steps ', 7, 'a'.repeat(50)]);
        expect(names).toHaveLength(16);
        expect(names.slice(0, 4)).toEqual(['Default', 'Ragdoll', 'See Through', 'No Camera']);
        expect(names[4]).toBe('Stair Steps');
        expect(names[5]).toBe('');
        expect(names[6]).toHaveLength(32);
        expect(normalizeLayerNames(null)).toEqual([...DEFAULT_LAYER_NAMES]);
    });

    it('labels unnamed layers by number, and finds layers by either', () => {
        const names = normalizeLayerNames(['', '', '', '', 'Character', '', 'Stair Ramp']);
        expect(layerLabel(names, 0)).toBe('Default');
        expect(layerLabel(names, 4)).toBe('Character');
        expect(layerLabel(names, 5)).toBe('Layer 6');
        expect(layerByName(names, 'character')).toBe(16);
        expect(layerByName(names, 'Stair Ramp')).toBe(64);
        expect(layerByName(names, 'Layer 6')).toBe(32);
        expect(layerByName(names, 'No Camera')).toBe(LAYER.NO_CAMERA);
        expect(layerByName(names, 'Nowhere')).toBe(0);
        expect(layerLabelsOf(names, LAYER.DEFAULT | 16)).toEqual(['Default', 'Character']);
    });

    it('tells one layer from several, and every layer from some', () => {
        expect(singleLayerOf(1)).toBe(0);
        expect(singleLayerOf(1 << 15)).toBe(15);
        expect(singleLayerOf(3)).toBeNull();
        expect(singleLayerOf(0)).toBeNull();
        expect(singleLayerOf(-1)).toBeNull();
        expect(layerBit(4)).toBe(16);
        expect(layerBit(16)).toBe(0);
        expect(isAllLayers(ALL_LAYERS)).toBe(true);
        expect(isAllLayers(0xffff)).toBe(true);
        expect(isAllLayers(DEFAULT_CAMERA_BLOCKED_BY)).toBe(false);
        expect(storedMask(0xffff)).toBe(-1);
        expect(storedMask(DEFAULT_CAMERA_BLOCKED_BY)).toBe(0xffff & ~12);
    });

    it('collides two bodies only when each mask holds the other layer', () => {
        expect(layersCollide(1, -1, 1, -1)).toBe(true);
        // A stair ramp only characters collide with: the character does, a prop does not.
        expect(layersCollide(64, 16, 16, -1)).toBe(true);
        expect(layersCollide(64, 16, 1, -1)).toBe(false);
    });
});

describe('camera layers from the old camera channels', () => {
    it('reads a collider that asked for the hole, itself or by a mesh in it, onto See Through', () => {
        expect(legacyColliderLayer({ cameraDither: true, collider: {} })).toBe(LAYER.SEE_THROUGH);
        const holding = { collider: {}, children: [{ type: 'model', children: [{ type: 'node', cameraDither: true }] }] };
        expect(colliderAskedSeeThrough(holding)).toBe(true);
        expect(legacyColliderLayer(holding)).toBe(LAYER.SEE_THROUGH);
        // Not across a nested body.
        const nested = { collider: {}, children: [{ type: 'collider', cameraDither: true, collider: {} }] };
        expect(colliderAskedSeeThrough(nested)).toBe(false);
        expect(colliderAskedSeeThrough({ collider: {}, children: [{ type: 'node', body: {}, cameraDither: true }] })).toBe(false);
    });

    it('reads one the camera passed onto No Camera, and keeps a layer of its own', () => {
        expect(legacyColliderLayer(null, { cameraCollision: false })).toBe(LAYER.NO_CAMERA);
        expect(legacyColliderLayer(null, { cameraCollision: false, layer: 256 })).toBe(256);
        expect(legacyColliderLayer({ cameraDither: true, collider: { layer: 512 } })).toBe(512);
        expect(legacyColliderLayer(null, {})).toBe(LAYER.DEFAULT);
    });

    it('reads a rig mode as layers, and keeps layers a rig already has', () => {
        expect(legacyRigLayers({ collisionMode: 'dither' })).toEqual({ blockedBy: DEFAULT_CAMERA_BLOCKED_BY, seeThrough: LAYER.SEE_THROUGH });
        expect(legacyRigLayers({ collisionMode: 'retract' })).toEqual({ blockedBy: ALL_LAYERS & ~LAYER.NO_CAMERA, seeThrough: 0 });
        expect(legacyRigLayers({ collisionLayers: 5, seeThroughLayers: 0, collisionMode: 'dither' })).toEqual({ blockedBy: 5, seeThrough: 0 });
    });

    it('reads a see-through foliage rule onto See Through only when it has collision', () => {
        expect(legacyFoliageCollisionLayer({ cameraDither: true, collision: { shape: 'cylinder' } })).toBe(LAYER.SEE_THROUGH);
        expect(legacyFoliageCollisionLayer({ cameraDither: true })).toBeUndefined();
        expect(legacyFoliageCollisionLayer({ collision: { shape: 'box', layer: 32 }, cameraDither: true })).toBe(32);
        expect(legacyFoliageCollisionLayer({ collision: { shape: 'box' } })).toBeUndefined();
    });

    it('converts a whole tree once, leaving the input untouched', () => {
        const tree = {
            type: 'node', name: 'root', children: [
                { type: 'collider', name: 'Pillars', cameraDither: true, collider: { layer: 1, cameraCollision: true }, children: [
                    { type: 'model', name: 'pillar', cameraDither: true, children: [] },
                ] },
                { type: 'collider', name: 'Crate', collider: { cameraCollision: false }, children: [] },
                { type: 'model', name: 'Loose', cameraDither: true, children: [] },
                { type: 'cameraRig', name: 'Rig', collisionMode: 'dither', children: [] },
            ],
        };
        const before = JSON.stringify(tree);
        const counts = { colliders: 0, rigs: 0, loose: 0 };
        const out = migrateCameraLayersTree(tree, counts);
        expect(JSON.stringify(tree)).toBe(before);
        expect(counts).toEqual({ colliders: 2, rigs: 1, loose: 1 });
        const [pillars, crate, loose, rig] = out.children;
        expect(pillars.collider).toEqual({ layer: LAYER.SEE_THROUGH });
        expect(pillars.cameraDither).toBeUndefined();
        expect(pillars.children[0].cameraDither).toBeUndefined();
        expect(crate.collider).toEqual({ layer: LAYER.NO_CAMERA });
        expect(loose.cameraDither).toBeUndefined();
        expect(rig.collisionMode).toBeUndefined();
        expect([rig.collisionLayers, rig.seeThroughLayers]).toEqual([DEFAULT_CAMERA_BLOCKED_BY, LAYER.SEE_THROUGH]);

        // Again: nothing left to do.
        const again = { colliders: 0, rigs: 0, loose: 0 };
        expect(migrateCameraLayersTree(out, again)).toEqual(out);
        expect(again).toEqual({ colliders: 0, rigs: 0, loose: 0 });
    });
});
