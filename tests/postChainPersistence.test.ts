import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CameraNode, Camera, Node } from '../src/cleo';
import { resolvePostChain } from '../src/graphics/renderGraph/chain';
import type { PostChainEntry } from '../src/graphics/renderGraph/chain';

/**
 * A per-camera post chain has to survive a refresh, a publish and an export, and the way it fails is
 * silent — the same failure `renderSettingsPersistence` guards for the renderer's own settings. A
 * chain that is written and never read back, or read and never written, presents identically to the
 * user: "I reordered the passes, and it was gone after a refresh."
 *
 * The other half is the one that matters more, because it touches scenes nobody edited. A camera
 * nobody has reordered must serialize EXACTLY what it did before this field existed. If it does not,
 * every scene in a project shows up modified the first time it is opened, and the diff of a save is
 * unreadable ever after.
 *
 * `CameraNode.serialize()` is inherited and async (`Node.serialize`), so these await it.
 */

function makeCamera(): CameraNode {
    // A parent is required: `Node.finishParse` attaches through it, and `serialize` walks children.
    const root = new Node('root');
    const camera = new CameraNode('cam', new Camera({ type: 'perspective' }));
    root.addChild(camera);
    return camera;
}

async function roundTrip(camera: CameraNode): Promise<CameraNode> {
    const json = await camera.serialize();
    const root = new Node('root');
    CameraNode.parse(root, json);
    return root.children[0] as CameraNode;
}

describe('camera post chain persistence', () => {
    it('writes nothing for a camera nobody has touched', () => {
        // The property that keeps every existing scene byte-identical.
        const camera = makeCamera();
        expect(camera.postChain).toBeNull();
        return camera.serialize().then(json => {
            expect(json).not.toHaveProperty('postChain');
        });
    });

    it('writes nothing for a chain that only restates the default', async () => {
        // Setting the chain to what it already was is not an override, and storing one would make a
        // camera look reordered in the diff for no reason.
        const camera = makeCamera();
        camera.postChain = resolvePostChain(null, 0);
        const json = await camera.serialize();
        expect(json).not.toHaveProperty('postChain');
    });

    it('round-trips an authored order', async () => {
        const camera = makeCamera();
        const authored: PostChainEntry[] = [
            { effect: 'chromatic', enabled: true },
            { effect: 'bloom', enabled: false },
            { effect: 'godRays', enabled: true },
        ];
        camera.postChain = authored;

        const json = await camera.serialize();
        expect(json.postChain).toEqual(authored);
        expect((await roundTrip(camera)).postChain).toEqual(authored);
    });

    it('reads a scene with no postChain key back as null, not as an empty chain', async () => {
        // An empty array and null are different: null means "follow the default", and an empty array
        // would mean "run nothing", which would silently strip bloom from every pre-existing scene.
        const root = new Node('root');
        CameraNode.parse(root, {
            name: 'cam', id: 'a', type: 'camera', active: true, children: [],
            camera: { type: 'perspective', fov: 45, near: 0.1, far: 100 },
        });
        expect((root.children[0] as CameraNode).postChain).toBeNull();
    });

    it('keeps a stored entry naming a material the camera no longer has', async () => {
        // Stored AUTHORED, repaired at render time. Dropping it on load would make a material that is
        // temporarily unresolved — an asset still loading, a bundle mid-import — permanently lost from
        // the chain the moment the scene was saved again.
        const camera = makeCamera();
        camera.postChain = [{ effect: 'material:2', enabled: true }, { effect: 'bloom', enabled: true }];
        const restored = await roundTrip(camera);
        expect(restored.postChain?.map(e => e.effect)).toContain('material:2');
        // ...and it is the resolver, not the node, that declines to run it.
        expect(resolvePostChain(restored.postChain, 0).map(e => e.effect)).not.toContain('material:2');
    });

    it('normalizes a missing enabled flag to true on the way in', async () => {
        const root = new Node('root');
        CameraNode.parse(root, {
            name: 'cam', id: 'a', type: 'camera', active: true, children: [],
            camera: { type: 'perspective', fov: 45, near: 0.1, far: 100 },
            postChain: [{ effect: 'bloom' }, { effect: 'godRays', enabled: false }],
        });
        expect((root.children[0] as CameraNode).postChain).toEqual([
            { effect: 'bloom', enabled: true },
            { effect: 'godRays', enabled: false },
        ]);
    });

    it('ignores malformed entries rather than throwing on an old or corrupt blob', () => {
        const root = new Node('root');
        expect(() => CameraNode.parse(root, {
            name: 'cam', id: 'a', type: 'camera', active: true, children: [],
            camera: { type: 'perspective', fov: 45, near: 0.1, far: 100 },
            postChain: [null, 7, { enabled: true }, { effect: 'bloom', enabled: true }],
        })).not.toThrow();
        expect((root.children[0] as CameraNode).postChain)
            .toEqual([{ effect: 'bloom', enabled: true }]);
    });

    it('writes no focusTargetId for a camera pointed at nothing', async () => {
        // Same discipline as the chain itself: a camera nobody has aimed must serialize exactly what it
        // did before depth of field existed, or every scene in the project shows up dirty on open.
        const camera = makeCamera();
        expect(camera.focusTargetId).toBeNull();
        expect(await camera.serialize()).not.toHaveProperty('focusTargetId');
    });

    it('round-trips a focus target id', async () => {
        const camera = makeCamera();
        camera.focusTargetId = 'subject-node-id';
        expect((await camera.serialize()).focusTargetId).toBe('subject-node-id');
        expect((await roundTrip(camera)).focusTargetId).toBe('subject-node-id');
    });

    it('resolves a focus target to null when the node is not in the scene', () => {
        // Dangling is the ordinary case for a despawned target, not an error: the renderer holds the
        // last focus distance rather than racking the whole frame to the camera.
        const camera = makeCamera();
        camera.focusTargetId = 'nobody';
        expect(camera.focusTarget).toBeNull();
    });

    it('keeps the id and the node handle in step', () => {
        // The id is the truth and the handle is only a cache; assigning either has to invalidate the
        // other, or a stale handle outlives the id that named it.
        const camera = makeCamera();
        const target = new Node('subject');
        camera.parent!.addChild(target);

        camera.focusTarget = target;
        expect(camera.focusTargetId).toBe(target.id);

        camera.focusTargetId = null;
        expect(camera.focusTarget).toBeNull();

        camera.focusTarget = null;
        expect(camera.focusTargetId).toBeNull();
    });

    it('is listed in NODE_REF_KEYS, so a duplicated subtree repoints at its own copy', () => {
        // Without this, duplicating a camera together with its subject leaves the COPY focused on the
        // ORIGINAL subject — which looks correct until the original is moved or deleted.
        const source = readFileSync(join(__dirname, '..', 'src', 'core', 'scene', 'nodeJson.ts'), 'utf-8');
        const keys = source.match(/const NODE_REF_KEYS = \[([^\]]*)\]/)?.[1] ?? '';
        expect(keys).toContain("'focusTargetId'");
    });

    it('does not alias the caller’s array', async () => {
        // The editor rebuilds and reuses arrays as the user drags rows; holding the caller's would let
        // a later mutation change what the node reports without anything having been assigned.
        const camera = makeCamera();
        const authored: PostChainEntry[] = [{ effect: 'chromatic', enabled: true }];
        camera.postChain = authored;
        (authored as PostChainEntry[]).push({ effect: 'bloom', enabled: false });
        expect(camera.postChain).toHaveLength(1);
    });
});
