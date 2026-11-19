import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { mergeStaticColliders, sameHit, staticRayHits } from '../tools/exampleKit/mergeColliders';

// The 3D examples keep their static scenery in one Collider per way of colliding, `Static Collision`, with the
// meshes under it (tools/exampleKit/mergeStaticColliders.ts). Merging must build the world it replaces: every
// shape baked to exactly what the old collider handed the physics backend.

const box = (w: number, h: number, d: number, offset = [0, 0, 0], rotation = [0, 0, 0]) => ({ type: 'box', width: w, height: h, depth: d, offset, rotation });
const node = (name: string, extra: any = {}, children: any[] = []) => ({
    type: 'node', id: name, name, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], variables: {}, spawnOnStart: true, children, ...extra,
});
const collider = (name: string, shapes: any[], extra: any = {}, children: any[] = []) =>
    node(name, { type: 'collider', collider: { mass: 0, shapes }, ...extra }, children);

/** A scene with every case the bake must get right: rotation, non-uniform scale, a moved parent, each shape. */
function scene() {
    return node('root', {}, [
        node('Props', { position: [3, 0, -2], rotation: [0, 30, 0], scale: [2, 2, 2] }, [
            collider('Crate Collider', [box(1, 1, 1, [0, 0.5, 0])], { position: [1, 0, 1], rotation: [0, 45, 0] }, [node('Crate')]),
            collider('Beam Collider', [box(4, 0.3, 0.3, [0, 2, 0], [0, 0, 20])], { scale: [1, 0.5, 3], position: [-2, 0, 0] }, [node('Beam')]),
            collider('Post Collider', [{ type: 'cylinder', radius: 0.2, height: 2, numSegments: 12, offset: [0, 1, 0], rotation: [0, 0, 0] }], { position: [0, 0, 3], scale: [1, 2, 0.5] }),
            collider('Rock Collider', [{ type: 'sphere', radius: 0.6, offset: [0, 0.6, 0], rotation: [0, 0, 0] }], { position: [2, 0, -3] }),
            collider('Hull Collider', [{ type: 'convex', vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], faces: [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]], offset: [0, 0, 0], rotation: [0, 0, 0] }], { position: [-3, 0, -3], rotation: [10, 0, 0] }),
        ]),
        collider('Floor', [box(40, 1, 40, [0, -0.5, 0])]),
        // Stay as they are: a scripted one, one with a trigger, a template instance, and a wall with a gameplay tag.
        collider('Lever', [box(1, 1, 1)], { position: [8, 0, 0], variables: { __scriptId: { type: 'string', value: 'lever' } } }),
        collider('Shrine', [box(1, 1, 1)], { position: [-8, 0, 0] }, [node('Zone', { type: 'trigger' })]),
        collider('Barrel Collider', [box(1, 1, 1)], { position: [0, 0, 8], variables: { __templateId: { type: 'string', value: 'barrel' } } }),
        collider('Wall', [box(10, 3, 0.2, [0, 1.5, 0])], { position: [0, 0, -9], variables: { blocksSwings: { type: 'boolean', value: true } } }),
    ]);
}

describe('merging static colliders', () => {
    it('builds the same world: every ray lands where it did', async () => {
        const root = scene();
        const before = await staticRayHits(root, undefined, 'cannon', 40);
        mergeStaticColliders(root, { scriptStrings: new Set(), idFor: k => k });
        const after = await staticRayHits(root, before.bounds, 'cannon', 40);
        expect(before.hits.filter(Boolean).length).toBeGreaterThan(100);
        const differ = before.hits.map((h, i) => [h, after.hits[i]]).filter(([a, b]) => !sameHit(a, b));
        expect(differ).toEqual([]);
    });

    it('keeps what must stay its own, and splits by gameplay tag', () => {
        const root = scene();
        const r = mergeStaticColliders(root, { scriptStrings: new Set(), idFor: k => k });
        const colliders = root.children.filter((c: any) => c.type === 'collider').map((c: any) => c.name).sort();
        expect(colliders).toEqual(['Barrel Collider', 'Lever', 'Shrine', 'Static Collision', 'Static Collision (blocksSwings)']);
        expect(r.merged).toBe(7);
        expect(r.kept.join('\n')).toMatch(/Lever: scripted/);
        expect(r.kept.join('\n')).toMatch(/Shrine: holds a Trigger/);
    });

    it('puts the meshes under the merged collider where they were, at their world transform', () => {
        const root = scene();
        mergeStaticColliders(root, { scriptStrings: new Set(), idFor: k => k });
        const merged = root.children.find((c: any) => c.name === 'Static Collision');
        const props = merged.children.find((c: any) => c.name === 'Props');
        expect(props.children.map((c: any) => c.name)).toEqual(['Crate', 'Beam']);   // wrappers give way to what they wrap
        expect(merged.position).toEqual([0, 0, 0]);
        // The emptied Props group is gone from the root; the moved crate keeps its id.
        expect(root.children.some((c: any) => c.name === 'Props')).toBe(false);
        expect(props.children[0].id).toBe('Crate');
        expect(props.children[0].scale.map((v: number) => Math.round(v * 1e5) / 1e5)).toEqual([2, 2, 2]);
    });

    it('turns a collider that is the thing itself into a plain node of its name, keeping its parts and its id', () => {
        const root = node('root', {}, [
            collider('Campfire', [box(1, 0.4, 1)], { position: [4, 0, 2], rotation: [0, 20, 0] }, [node('Model'), node('Fire')]),
        ]);
        mergeStaticColliders(root, { scriptStrings: new Set(), idFor: k => k });
        const merged = root.children.find((c: any) => c.name === 'Static Collision');
        const fire = merged.children.find((c: any) => c.name === 'Campfire');
        expect(fire).toMatchObject({ type: 'node', id: 'Campfire', position: [4, 0, 2], rotation: [0, 20, 0], scale: [1, 1, 1] });
        expect(fire.children.map((c: any) => c.name)).toEqual(['Model', 'Fire']);
        expect(fire.collider).toBeUndefined();
    });

    it('splits by collision layer, named by the layer, and reads the old see-through flag as its layer', () => {
        const names = ['', '', '', '', '', 'Stair Steps']
        const root = node('root', {}, [
            collider('Floor', [box(4, 1, 4)]),
            node('Steps Collider', { type: 'collider', collider: { mass: 0, layer: 32, shapes: [box(1, 0.2, 0.3)] } }),
            collider('Pillar', [box(1, 3, 1)], { cameraDither: true }),
        ]);
        mergeStaticColliders(root, { scriptStrings: new Set(), idFor: k => k, layerNames: names });
        const merged = Object.fromEntries(root.children.map((c: any) => [c.name, c.collider.layer]));
        expect(merged).toEqual({ 'Static Collision': 1, 'Static Collision (Stair Steps)': 32, 'Static Collision (See Through)': 4 });
        expect(root.children.every((c: any) => c.cameraDither === undefined)).toBe(true);
    });

    it('leaves a collider a script names by its name', () => {
        const root = scene();
        mergeStaticColliders(root, { scriptStrings: new Set(['Floor']), idFor: k => k });
        expect(root.children.some((c: any) => c.name === 'Floor')).toBe(true);
    });

    it('finds nothing to do the second time', () => {
        const root = scene();
        mergeStaticColliders(root, { scriptStrings: new Set(), idFor: k => k });
        expect(mergeStaticColliders(root, { scriptStrings: new Set(), idFor: k => k }).merged).toBe(0);
    });
});

const EXAMPLES = join(__dirname, '..', 'applications', 'editor', 'public', 'examples');
const THREE_D = ['dungeon', 'valley', 'firing-line', 'sandbox'].filter(n => existsSync(join(EXAMPLES, n, 'scenes')));

describe.each(THREE_D)('the %s example', (name) => {
    const scenes = readdirSync(join(EXAMPLES, name, 'scenes')).map(f => JSON.parse(readFileSync(join(EXAMPLES, name, 'scenes', f), 'utf8')));
    const scripts: any[] = JSON.parse(readFileSync(join(EXAMPLES, name, 'libraries', 'scripts.json'), 'utf8'));

    it('keeps its static scenery in Static Collision, at the origin, with nothing left to merge', () => {
        for (const scene of scenes) {
            const merged = scene.scene.children.filter((c: any) => c.type === 'collider' && /^Static Collision/.test(c.name));
            expect(merged.length, 'Static Collision colliders').toBeGreaterThan(0);
            for (const c of merged) {
                expect([c.position, c.rotation, c.scale]).toEqual([[0, 0, 0], [0, 0, 0], [1, 1, 1]]);
                expect(c.collider.mass).toBe(0);
            }
            const strings = new Set<string>();
            for (const s of scripts) for (const m of String(s.source).matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) strings.add(m[2]);
            expect(mergeStaticColliders(structuredClone(scene.scene), { scriptStrings: strings, idFor: k => k }).merged).toBe(0);
        }
    });
});
