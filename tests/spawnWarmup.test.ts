import { describe, it, expect, afterEach, vi } from 'vitest';
import { vec3 } from 'gl-matrix';
import './helpers/features';
import { Scene } from '../src/core/scene/scene';
import { Node } from '../src/core/scene/nodes/node';
import { Camera } from '../src/core/camera';
import { CameraNode } from '../src/core/scene/nodes/cameraNode';
import { ParticleSystemNode } from '../src/core/scene/nodes/particleSystemNode';
import { LightNode } from '../src/core/scene/nodes/lightNode';
import { PointLight } from '../src/graphics/lighting';
import { defaultParticleSystem, makeModule } from '../src/particles/particleSystemAsset';
import { authoring, engineEventBus } from '../src/core/eventBus';
import { setScriptProvider } from '../src/core/scripting/scriptRuntime';
import { registerTemplates, registeredTemplates, clearTemplates } from '../src/core/scene/templates';
import { isSpawnWarmupCopy } from '../src/core/scene/editorNodes';
import {
    mountSpawnWarmup, particleCopiesOf, precompileTemplateScripts, warmCopyJson, SPAWN_WARMUP_HOLDER,
} from '../src/core/scene/spawnWarmup';

// What a scene can spawn is drawn with it while its shaders are prepared (Renderer.prepareShaders): the Sandbox's
// first shot froze the game for seconds, its muzzle flash's particles and its bullet hole's decal compiling the frame
// they first appeared. The copies must draw and do nothing else: no script, no physics, no camera or sound of their
// own, nothing started, nothing saved, gone after.

afterEach(() => {
    authoring.enabled = false;
    setScriptProvider(null);
    clearTemplates();
    vi.restoreAllMocks();
});

const oneShot = () => {
    const system = defaultParticleSystem();
    const e = system.emitters[0];
    e.looping = false;
    e.duration = 0.2;
    e.spawn = [makeModule('spawnRate')];
    e.spawn[0].params.rate = 50;
    return system;
};

/** A muzzle flash as a template carries it: a scripted root, a particle system, a light, a sound and a collider. */
async function muzzleFlash(): Promise<any> {
    const flash = await new ParticleSystemNode('Flash', { system: oneShot() }).serialize();
    const light = await new LightNode('Light', new PointLight({ diffuse: [1, 1, 1] })).serialize();
    return {
        id: 'root-1', name: 'Muzzle Flash', type: 'node', position: [3, 4, 5],
        script: 'export default class { onStart() { throw new Error("ran") } }', scriptPath: 'Scripts/ShotFx.ts',
        scriptVars: { lifetime: 0.7 }, __sourceId: 'root-1', saved: true,
        children: [
            flash,
            light,
            { id: 'sound-1', name: 'Bang', type: 'sound', sound: {} },
            { id: 'col-1', name: 'Hit box', type: 'collider', collider: { shapes: [] }, children: [
                { id: 'hole-1', name: 'Hole', type: 'decal', decal: {} },
            ] },
            { id: 'ui-1', name: 'Hud', type: 'uiRoot', children: [] },
            { id: 'cam-1', name: 'Cam', type: 'camera', camera: {} },
        ],
    };
}

const ids = (json: any, out: string[] = []): string[] => { out.push(json.id); for (const c of json.children ?? []) ids(c, out); return out; };
const find = (json: any, name: string): any => json.name === name ? json : (json.children ?? []).map((c: any) => find(c, name)).find(Boolean);

describe('warmCopyJson', () => {
    it('keeps what draws and makes the rest plain, with no script, save data or ids of the template', async () => {
        const source = await muzzleFlash();
        const copy = warmCopyJson(source);
        expect(copy.position).toEqual([0, 0, 0]);
        expect(copy.script).toBeUndefined();
        expect(copy.scriptPath).toBeUndefined();
        expect(copy.scriptVars).toBeUndefined();
        expect(copy.__sourceId).toBeUndefined();
        expect(copy.saved).toBeUndefined();
        // Fresh ids: a published game's script provider is keyed by the template's.
        expect(ids(copy).some(id => ids(source).includes(id))).toBe(false);
        expect(find(copy, 'Flash').type).toBe('particleSystem');
        expect(find(copy, 'Light').type).toBe('light');
        // A sound, a collider and a camera do more than draw: plain nodes, their children kept.
        expect(find(copy, 'Bang').type).toBe('node');
        expect(find(copy, 'Cam').type).toBe('node');
        expect(find(copy, 'Hit box').type).toBe('node');
        expect(find(copy, 'Hit box').collider).toBeUndefined();
        expect(find(copy, 'Hole').type).toBe('decal');
        // UI draws in the page, not the scene.
        expect(find(copy, 'Hud')).toBeUndefined();
        // The template itself is untouched.
        expect(source.script).toBeDefined();
        expect(source.position).toEqual([3, 4, 5]);
    });

    it('drops a UI subtree whole and anything that is not a node', () => {
        expect(warmCopyJson({ id: 'u', name: 'Menu', type: 'uiRoot' })).toBeNull();
        expect(warmCopyJson(null)).toBeNull();
    });
});

describe('mountSpawnWarmup', () => {
    it('mounts on a scene not started yet without starting anything, and takes it all away', async () => {
        const scene = new Scene();
        const asked: string[] = [];
        setScriptProvider(id => { asked.push(id); return undefined; });
        const source = await muzzleFlash();
        const warm = mountSpawnWarmup(scene, [source]);
        expect(warm.count).toBe(1);
        const holder = scene.root.children.find(c => c.name === SPAWN_WARMUP_HOLDER)!;
        expect(holder).toBeDefined();
        expect(holder.isEditorOwned).toBe(true);
        // Never the template's ids: nothing a published game shipped attaches.
        expect(asked.some(id => ids(source).includes(id))).toBe(false);
        expect([...scene.particleSystems].length).toBe(1);
        expect([...scene.decals].length).toBe(1);
        const all: Node[] = [];
        const walk = (n: Node) => { all.push(n); n.children.forEach(walk); };
        walk(holder);
        expect(all.every(n => !n.hasStarted)).toBe(true);
        expect(all.every(n => n === holder || isSpawnWarmupCopy(n))).toBe(true);

        warm.dispose();
        warm.dispose();
        expect(scene.root.children.includes(holder)).toBe(false);
        expect([...scene.particleSystems].length).toBe(0);
        expect([...scene.decals].length).toBe(0);
    });

    it('is an owned change in an authoring scene: nothing to save, nothing to undo', async () => {
        const scene = new Scene();
        authoring.enabled = true;
        // Read during the dispatch: the stamps are lazy. The copies are built detached (no scene yet), which the
        // editor never records; what reaches THIS scene must be owned.
        const events: { owned: boolean; scene: unknown }[] = [];
        const listener = (e: any) => events.push({ owned: !!e?.editorOwned, scene: e?.scene });
        engineEventBus.on('SCENE_CHANGED', listener);
        try {
            const warm = mountSpawnWarmup(scene, [await muzzleFlash()]);
            warm.dispose();
        } finally { engineEventBus.off('SCENE_CHANGED', listener); }
        const inScene = events.filter(e => e.scene === scene);
        expect(inScene.length).toBeGreaterThan(0);
        expect(inScene.every(e => e.owned)).toBe(true);
    });

    it('puts the copies in front of the camera', async () => {
        const scene = new Scene();
        const cam = new CameraNode('cam', new Camera({ type: 'perspective' }));
        cam.camera.position = vec3.fromValues(10, 2, 0);
        cam.camera.eye = vec3.fromValues(10, 2, -5); // looking down -Z
        scene.addNode(cam);
        const warm = mountSpawnWarmup(scene, [await muzzleFlash()]);
        const holder = scene.root.children.find(c => c.name === SPAWN_WARMUP_HOLDER)!;
        expect([...holder.position].map(v => +v.toFixed(3))).toEqual([10, 2, -4]);
        warm.dispose();
    });

    it('steps its particle systems with the editor preview off, without their update or scripts', async () => {
        const scene = new Scene();
        authoring.enabled = true;
        scene.particlePreview = false;
        const warm = mountSpawnWarmup(scene, [await muzzleFlash()]);
        const ps = [...scene.particleSystems][0];
        const update = vi.spyOn(ps, 'update');
        expect(ps.runtime.hasPendingWork).toBe(false);
        warm.beforeFrame(1 / 60);
        expect(ps.previewSuppressed).toBe(false);
        expect(ps.runtime.hasPendingWork).toBe(true);
        expect(update).not.toHaveBeenCalled();
        warm.dispose();
    });

    it('logs and leaves out a subtree that will not parse, and mounts nothing for none', () => {
        const scene = new Scene();
        expect(mountSpawnWarmup(scene, []).count).toBe(0);
        expect(scene.root.children.some(c => c.name === SPAWN_WARMUP_HOLDER)).toBe(false);
    });
});

describe('what a scene can spawn', () => {
    it('lists every registered template, two of one name included', () => {
        registerTemplates([
            { id: 'a', name: 'Spark', node: { id: 'n1', name: 'Spark', type: 'node' } },
            { id: 'b', name: 'Spark', node: { id: 'n2', name: 'Spark', type: 'node' } },
        ]);
        expect(registeredTemplates().map(t => t.id)).toEqual(['a', 'b']);
    });

    it('copies the scene’s own particle systems that are not running, without their children', async () => {
        const scene = new Scene();
        const idle = new ParticleSystemNode('Dust', { system: oneShot() });
        idle.addChild(new Node('child'));
        const playing = new ParticleSystemNode('Torch', { system: oneShot() });
        scene.addNode(idle);
        scene.addNode(playing);
        playing.play();
        const idleOnly = await particleCopiesOf(scene, true) as any[];
        expect(idleOnly.map(j => j.name)).toEqual(['Dust']);
        expect(idleOnly[0].children).toEqual([]);
        expect((await particleCopiesOf(scene, false)).length).toBe(2);
    });

    it('compiles template scripts without running them', () => {
        const n = precompileTemplateScripts([{
            id: 'r', type: 'node', script: 'export default class { onStart() { throw new Error("ran") } }',
            children: [{ id: 'c', type: 'node', script: '' }],
        }]);
        expect(n).toBe(1);
    });
});
