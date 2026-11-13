import { describe, it, expect } from 'vitest';
import { Scene, CharacterBody2DNode, Body2DNode, Area2DNode } from 'cleo';
import {
    DEBUG_CATEGORIES, debugCategoryApplies, defaultDebugVisibility, effectiveDebugVisibility,
} from '../src/features/DebugVisibilityContext';
import type { DebugCategory, DebugVisibility } from '../src/features/DebugVisibilityContext';
import { overlayDimensionOf } from '../src/utils/sceneDimension';
import { box2DCategory } from '../src/utils/editorHelpers';

// The viewport's eye menu offers the rows that mean something for the scene on screen. A 2D scene drawn by
// the flat 2D frame has no skeletons, animation blends, navmeshes, foliage, GI probes or wind; everything
// else (collision, triggers, icons, bounds, particles, game UI, the grid) is shared.

const THREE_D_ONLY: DebugCategory[] = ['skeleton', 'animation', 'navMesh', 'foliageColliders', 'giProbes', 'windField'];
const allOn = (): DebugVisibility => {
    const v = defaultDebugVisibility();
    for (const key of Object.keys(v) as DebugCategory[]) v[key] = { editor: true, runtime: true };
    return v;
};

describe('debug overlay rows by dimension', () => {
    it('leaves exactly the 3D-only rows out of a flat 2D scene, and keeps every row in 3D', () => {
        const in2D = DEBUG_CATEGORIES.filter(c => debugCategoryApplies(c.key, '2D')).map(c => c.key);
        const in3D = DEBUG_CATEGORIES.filter(c => debugCategoryApplies(c.key, '3D')).map(c => c.key);
        expect(in3D).toEqual(DEBUG_CATEGORIES.map(c => c.key));
        expect(DEBUG_CATEGORIES.map(c => c.key).filter(k => !in2D.includes(k)).sort()).toEqual([...THREE_D_ONLY].sort());
        expect(in2D).toEqual(['colliders', 'triggers', 'icons', 'boundingBoxes', 'particles', 'gameUi', 'grid']);
    });

    it('turns the rows that do not apply off in both channels, without touching the stored switches', () => {
        const stored = allOn();
        const in2D = effectiveDebugVisibility(stored, '2D');
        for (const key of THREE_D_ONLY) expect(in2D[key], key).toEqual({ editor: false, runtime: false });
        for (const key of ['colliders', 'triggers', 'icons', 'grid'] as DebugCategory[]) expect(in2D[key], key).toEqual({ editor: true, runtime: true });
        expect(stored.giProbes).toEqual({ editor: true, runtime: true });
        // In 3D, and in 2D when nothing 3D-only is on, the stored object itself.
        expect(effectiveDebugVisibility(stored, '3D')).toBe(stored);
        const defaults = defaultDebugVisibility();
        defaults.foliageColliders = { editor: false, runtime: false };
        expect(effectiveDebugVisibility(defaults, '2D')).toBe(defaults);
    });

    it('calls a scene 2D only when it is 2D and drawn by the flat frame', () => {
        expect(overlayDimensionOf({ dimension: '2D' }, { pipeline2D: 'flat' })).toBe('2D');
        expect(overlayDimensionOf({ dimension: '2D' }, null)).toBe('2D');
        // 2.5D: the Full 3D pipeline draws models, skeletons and GI under a 2D scene.
        expect(overlayDimensionOf({ dimension: '2D' }, { pipeline2D: 'full' })).toBe('3D');
        expect(overlayDimensionOf({ dimension: '3D' }, { pipeline2D: 'flat' })).toBe('3D');
        // A staging or template scene is 3D by default; no scene shows every row.
        expect(overlayDimensionOf(new Scene(), null)).toBe('3D');
        expect(overlayDimensionOf(null, null)).toBe('3D');
    });
});

// The reconcile that builds the boxes makes GPU line buffers, so it cannot run here; it draws a 2D body's
// box when `show(box2DCategory(node))` holds, and this pins which row that is.
describe('2D physics boxes in the eye menu', () => {
    it('files bodies and colliders under Collision wireframes, areas under Trigger volumes', () => {
        const body = new CharacterBody2DNode('Hero');
        const wall = new Body2DNode('Ledge', [2, 0.5]);
        const area = new Area2DNode('Pickup', [1, 1]);
        expect([box2DCategory(body), box2DCategory(wall), box2DCategory(area)]).toEqual(['colliders', 'colliders', 'triggers']);
    });
});
