import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../src/cleo';   // registers 'cleo' and the script transpiler
import { Scene } from '../src/core/scene/scene';
import type { Node } from '../src/core/scene/nodes/node';
import { CleoEngine } from '../src/core/engine';
import { setGameHost, Game } from '../src/core/game';
import { registerTemplates, clearTemplates } from '../src/core/scene/templates';
import {
    SaveGame, setSaveStore, createMemorySaveStore, createTextSaveStore, parseRuntimeScene, resetSaveSession,
    validateSaveDocument, isValidSlot, migrateSaveDocument, SAVE_FORMAT_VERSION, type SaveDocument, type SaveStore,
} from '../src/core/save';

// The save runtime end to end, headless: a tiny "game" whose host builds every visit from a fresh copy of the
// authored JSON through parseRuntimeScene, as the player and the editor's play mode do.

const node = (name: string, extra: any = {}, children: any[] = []) =>
    ({ id: name, name, type: 'node', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children, ...extra });

/** A script whose fields are `@save`d (the editor's build lists them as `saveFields`). */
const scripted = (name: string, source: string, saveFields: string[], extra: any = {}) =>
    node(name, { script: source, saveFields, ...extra });

const LEVER = `
    import { Node } from 'cleo'
    export default class Lever extends Node {
      public pulled = false
      public pulls = 0
      public restoredWith: unknown = 'never'
      onRestore(data) { this.restoredWith = data }
      onStart() { if (!this.wasRestored) this.pulls = 0 }
    }
`;

/** A game of `scenes` (id -> root JSON), with a fake engine and host. */
function makeGame(scenes: Record<string, any>) {
    const engine: any = { scene: null, timeSinceStart: 0 };
    (CleoEngine as any)._instance = engine;
    let current = '';
    const names = () => Object.keys(scenes);
    const enter = (id: string): Scene => {
        const scene = new Scene();
        parseRuntimeScene(scene, { scene: structuredClone(scenes[id]), textures: [] }, id, true);
        engine.scene?.dispose();
        engine.scene = scene;
        current = id;
        scene.start();
        return scene;
    };
    setGameHost({
        loadScene: (nameOrId: string) => { enter(names().find(n => n === nameOrId || scenes[n].name === nameOrId)!); },
        currentSceneName: () => scenes[current]?.name ?? current,
        sceneNames: () => names().map(n => scenes[n].name ?? n),
    });
    return {
        enter,
        engine,
        get scene(): Scene { return engine.scene; },
        find: (name: string) => (engine.scene as Scene).findNode(name) as any,
    };
}

let store: SaveStore;

beforeEach(() => {
    resetSaveSession();
    store = createMemorySaveStore();
    setSaveStore(store, { gameVersion: 1 });
});

afterEach(() => {
    setGameHost(null);
    setSaveStore(null);
    clearTemplates();
    (CleoEngine as any)._instance = null;
});

describe('a game that saves nothing', () => {
    it('builds every scene exactly as authored', async () => {
        const authored = node('root', {}, [node('Crate', { position: [1, 2, 3] })]);
        const game = makeGame({ A: authored });
        game.enter('A');
        game.find('Crate').setPosition([9, 9, 9]);
        await Game.loadScene('A');
        expect(Array.from(game.find('Crate').position)).toEqual([1, 2, 3]);
    });
});

describe('scene memory', () => {
    const world = () => ({
        A: node('root', { name: 'root' }, [
            node('Crate', { saved: true, position: [0, 1, 0] }),
            scripted('Lever', LEVER, ['pulled']),
            node('Coin', { saved: true }),
            node('Coin', { saved: true, id: 'coin2' }),
            node('Gate', { saved: true }),
        ]),
        B: node('root', { id: 'rootB' }, [node('Elsewhere')]),
    });

    it('brings a Saved node back where it was left, with its rotation exact', async () => {
        const game = makeGame(world());
        game.enter('A');
        const crate = game.find('Crate') as Node;
        crate.setPosition([5, 1, -2]);
        crate.setQuaternion([0, Math.SQRT1_2, 0, Math.SQRT1_2] as any);
        await Game.loadScene('B');
        await Game.loadScene('A');
        const back = game.find('Crate') as Node;
        expect(Array.from(back.position)).toEqual([5, 1, -2]);
        expect(back.quaternion[1]).toBeCloseTo(Math.SQRT1_2, 6);
        expect(back.wasRestored).toBe(true);
    });

    it('brings @save fields back before any handler runs, and calls onRestore', async () => {
        const game = makeGame(world());
        game.enter('A');
        game.find('Lever').pulled = true;
        game.find('Lever').pulls = 5;   // not @save: authored again
        await Game.loadScene('B');
        await Game.loadScene('A');
        const lever = game.find('Lever');
        expect(lever.pulled).toBe(true);
        expect(lever.pulls).toBe(0);
        expect(lever.wasRestored).toBe(true);
        expect(lever.restoredWith).toBeUndefined();   // onRestore ran, with no onSave data
    });

    it('keeps a removed node removed across several visits, and its namesake where it was', async () => {
        const game = makeGame(world());
        game.enter('A');
        const coins = game.scene.getNodesByName('Coin');
        coins[0].remove({ immediate: true });
        coins[1].setPosition([7, 0, 0]);
        await Game.loadScene('B');
        await Game.loadScene('A');
        let left = game.scene.getNodesByName('Coin');
        expect(left.length).toBe(1);
        expect(left[0].id).toBe('coin2');
        expect(Array.from(left[0].position)).toEqual([7, 0, 0]);
        await Game.loadScene('B');
        await Game.loadScene('A');
        left = game.scene.getNodesByName('Coin');
        expect(left.length).toBe(1);
        expect(Array.from(left[0].position)).toEqual([7, 0, 0]);
    });

    it('never builds a removed node, so none of its handlers run', async () => {
        let constructs = 0;
        (globalThis as any).__constructed = () => { constructs++; };
        try {
            const scenes = {
                A: node('root', {}, [scripted('Pickup', `
                    import { Node } from 'cleo'
                    export default class P extends Node { public taken = false; onConstruct() { globalThis.__constructed() } }
                `, ['taken'])]),
                B: node('root'),
            };
            const game = makeGame(scenes);
            game.enter('A');
            expect(constructs).toBe(1);
            game.find('Pickup').remove({ immediate: true });
            await Game.loadScene('B');
            await Game.loadScene('A');
            expect(constructs).toBe(1);
            expect(game.find('Pickup')).toBeUndefined();
        } finally { delete (globalThis as any).__constructed; }
    });

    it('remembers dormancy at the boundary, so a later spawn still wakes the children', async () => {
        const scenes = {
            A: node('root', {}, [node('Group', { saved: true }, [node('Child', { saved: true })])]),
            B: node('root'),
        };
        const game = makeGame(scenes);
        game.enter('A');
        game.find('Group').despawn({ immediate: true });
        await Game.loadScene('B');
        await Game.loadScene('A');
        expect(game.find('Group').spawned).toBe(false);
        expect(game.find('Child').spawned).toBe(false);
        game.find('Group').spawn();
        expect(game.find('Child').spawned).toBe(true);
    });

    it('keeps a node spawned that was authored asleep', async () => {
        const scenes = { A: node('root', {}, [node('Door', { saved: true, spawnOnStart: false })]), B: node('root') };
        const game = makeGame(scenes);
        game.enter('A');
        expect(game.find('Door').spawned).toBe(false);
        game.find('Door').spawn();
        await Game.loadScene('B');
        await Game.loadScene('A');
        expect(game.find('Door').spawned).toBe(true);
    });

    it('keeps node variables of a Saved node, but not the editor bookkeeping', async () => {
        const scenes = { A: node('root', {}, [node('Chest', { saved: true, variables: { __scriptId: { type: 'string', value: 'x' } } })]), B: node('root') };
        const game = makeGame(scenes);
        game.enter('A');
        game.find('Chest').setVariable('gold', 30, 'number');
        await Game.loadScene('B');
        await Game.loadScene('A');
        expect(game.find('Chest').getVariable('gold')).toBe(30);
        expect(game.find('Chest').getVariable('__scriptId')).toBe('x');
    });

    it('finds a node by its path when its id changed between builds', async () => {
        const scenes: Record<string, any> = { A: node('root', {}, [node('Hall', {}, [node('Crate', { saved: true, id: 'old-id' })])]), B: node('root') };
        const game = makeGame(scenes);
        game.enter('A');
        game.find('Crate').setPosition([3, 0, 0]);
        await Game.loadScene('B');
        scenes.A = node('root', {}, [node('Hall', {}, [node('Crate', { saved: true, id: 'new-id' })])]);
        await Game.loadScene('A');
        expect(game.find('Crate').id).toBe('new-id');
        expect(Array.from(game.find('Crate').position)).toEqual([3, 0, 0]);
    });

    it('restores a reference to another node', async () => {
        const scenes = {
            A: node('root', {}, [
                node('Target'),
                scripted('Pointer', `
                    import { Node } from 'cleo'
                    export default class P extends Node { public target = null; public list = [] }
                `, ['target', 'list']),
            ]),
            B: node('root'),
        };
        const game = makeGame(scenes);
        game.enter('A');
        game.find('Pointer').target = game.find('Target');
        game.find('Pointer').list = [1, game.find('Target')];
        await Game.loadScene('B');
        await Game.loadScene('A');
        expect(game.find('Pointer').target).toBe(game.find('Target'));
        expect(game.find('Pointer').list[1]).toBe(game.find('Target'));
    });

    it('skips what a save cannot hold, keeping the rest', async () => {
        const scenes = {
            A: node('root', {}, [scripted('Bag', `
                import { Node } from 'cleo'
                export default class B extends Node { public items = []; public lookup = null; public v = null }
            `, ['items', 'lookup', 'v'])]),
            B: node('root'),
        };
        const game = makeGame(scenes);
        game.enter('A');
        const bag = game.find('Bag');
        bag.items = ['sword', { kind: 'potion', n: 2 }];
        bag.lookup = new Map([['a', 1]]);
        bag.v = new Float32Array([1, 2, 3]);
        await Game.loadScene('B');
        await Game.loadScene('A');
        const back = game.find('Bag');
        expect(back.items).toEqual(['sword', { kind: 'potion', n: 2 }]);
        expect(back.lookup).toBeNull();   // left out: the authored default stands
        expect(back.v).toBeInstanceOf(Float32Array);
        expect(Array.from(back.v)).toEqual([1, 2, 3]);
    });

    it("passes onSave's data to onRestore, and contains a throwing onSave", async () => {
        const scenes = {
            A: node('root', {}, [
                node('Timer', { script: `
                    import { Node } from 'cleo'
                    export default class T extends Node {
                      public left = 10; public got: any = null
                      onSave() { return { left: this.left } }
                      onRestore(data) { this.got = data }
                    }
                ` }),
                node('Bad', { script: `
                    import { Node } from 'cleo'
                    export default class T extends Node { onSave() { throw new Error('nope') } }
                ` }),
            ]),
            B: node('root'),
        };
        const game = makeGame(scenes);
        game.enter('A');
        game.find('Timer').left = 4;
        await Game.loadScene('B');
        await Game.loadScene('A');
        expect(game.find('Timer').got).toEqual({ left: 4 });
    });
});

describe('a Saved Collider', () => {
    const box = { type: 'box', width: 1, height: 1, depth: 1, offset: [0, 0, 0], rotation: [0, 0, 0] };
    const scenes = () => ({
        A: node('root', {}, [{ ...node('Crate', { saved: true }), type: 'collider', collider: { mass: 2, shapes: [box] } }]),
        B: node('root'),
    });

    it('builds its body where it was saved, moving as it was', async () => {
        const game = makeGame(scenes());
        game.enter('A');
        const crate = game.find('Crate') as Node;
        crate.buildPhysics();
        crate.setPosition([3, 4, 5]);
        crate.ownBody!.velocity.set(1, 2, 3);
        await Game.loadScene('B');
        await Game.loadScene('A');
        const back = game.find('Crate') as Node;
        const body = back.ownBody!;
        expect(body).toBeTruthy();
        expect([body.position.x, body.position.y, body.position.z]).toEqual([3, 4, 5]);
        expect([body.velocity.x, body.velocity.y, body.velocity.z]).toEqual([1, 2, 3]);
    });
});

describe('Saved copies a script instantiated', () => {
    const scenes = () => ({ A: node('root', {}, [node('Spawner')]), B: node('root') });
    const template = node('Bloodstain', { saved: true }, [scripted('Souls', `
        import { Node } from 'cleo'
        export default class S extends Node { public amount = 0 }
    `, ['amount'])]);

    it('come back under the same id, where they were, with their inner state', async () => {
        registerTemplates([{ id: 'tpl-stain', name: 'Bloodstain', node: template }]);
        const game = makeGame(scenes());
        game.enter('A');
        const stain = game.scene.instantiate('Bloodstain', { position: [2, 0, 4] })!;
        (stain.children[0] as any).amount = 250;
        const id = stain.id;
        await Game.loadScene('B');
        await Game.loadScene('A');
        const back = game.scene.getNodeById(id)!;
        expect(back).toBeDefined();
        expect(Array.from(back.position)).toEqual([2, 0, 4]);
        expect((back.children[0] as any).amount).toBe(250);
        expect(back.wasRestored).toBe(true);
        // Still a Saved copy: a second round trip keeps it too.
        await Game.loadScene('B');
        await Game.loadScene('A');
        expect(game.scene.getNodeById(id)).toBeDefined();
    });

    it('are not made again once removed, and unsaved copies never are', async () => {
        registerTemplates([
            { id: 'tpl-stain', name: 'Bloodstain', node: template },
            { id: 'tpl-fx', name: 'Spark', node: node('Spark') },
        ]);
        const game = makeGame(scenes());
        game.enter('A');
        const stain = game.scene.instantiate('Bloodstain')!;
        game.scene.instantiate('Spark');
        const id = stain.id;
        stain.remove({ immediate: true });
        await Game.loadScene('B');
        await Game.loadScene('A');
        expect(game.scene.getNodeById(id)).toBeUndefined();
        expect(game.find('Spark')).toBeUndefined();
    });

    it('stay Saved when a script flagged them after making them', async () => {
        registerTemplates([{ id: 'tpl-fx', name: 'Drop', node: node('Drop') }]);
        const game = makeGame(scenes());
        game.enter('A');
        const drop = game.scene.instantiate('Drop')!;
        drop.saved = true;
        await Game.loadScene('B');
        await Game.loadScene('A');
        await Game.loadScene('B');
        await Game.loadScene('A');
        expect(game.scene.getNodeById(drop.id)?.saved).toBe(true);
    });
});

describe('SaveGame', () => {
    const scenes = () => ({
        A: node('root', {}, [node('Crate', { saved: true }), scripted('Lever', LEVER, ['pulled'])]),
        B: node('root', {}, [node('Box', { saved: true })]),
    });

    it('keeps globals as copies, across scene loads', async () => {
        makeGame(scenes()).enter('A');
        const bag = ['sword'];
        SaveGame.set('bag', bag);
        bag.push('shield');
        expect(SaveGame.get('bag')).toEqual(['sword']);
        await Game.loadScene('B');
        expect(SaveGame.get('bag')).toEqual(['sword']);
        expect(SaveGame.get('missing', 7)).toBe(7);
        SaveGame.set('bag', undefined);
        expect(SaveGame.has('bag')).toBe(false);
    });

    it('refuses a global it could not keep', () => {
        expect(() => SaveGame.set('fn', () => 1)).toThrow(/cannot be saved/);
        expect(() => SaveGame.set('map', new Map())).toThrow(/cannot be saved/);
    });

    it('saves and loads: the scene it was made in comes back as it was, and the one left is not recorded', async () => {
        const game = makeGame(scenes());
        game.enter('A');
        game.find('Crate').setPosition([1, 1, 1]);
        game.find('Lever').pulled = true;
        SaveGame.set('souls', 100);
        const info = await SaveGame.save('slot1', { label: 'Shrine' });
        expect(info.slot).toBe('slot1');
        expect(info.label).toBe('Shrine');

        // Play on: change everything, then go elsewhere and change that too.
        game.find('Crate').setPosition([9, 9, 9]);
        game.find('Lever').pulled = false;
        SaveGame.set('souls', 0);
        await Game.loadScene('B');
        game.find('Box').setPosition([4, 4, 4]);

        await SaveGame.load('slot1');
        expect(Game.sceneName).toBe('root');
        expect(Array.from(game.find('Crate').position)).toEqual([1, 1, 1]);
        expect(game.find('Lever').pulled).toBe(true);
        expect(SaveGame.get('souls')).toBe(100);
        expect(SaveGame.loadedFrom).toBe('slot1');

        // B was never visited before the save: back in it, it is as authored.
        await Game.loadScene('B');
        expect(Array.from(game.find('Box').position)).toEqual([0, 0, 0]);
    });

    it('lists slots newest first, and knows which exist', async () => {
        makeGame(scenes()).enter('A');
        await SaveGame.save('one');
        await new Promise(r => setTimeout(r, 5));
        await SaveGame.save('two');
        expect((await SaveGame.list()).map(s => s.slot)).toEqual(['two', 'one']);
        expect((await SaveGame.mostRecent())?.slot).toBe('two');
        expect(await SaveGame.exists('one')).toBe(true);
        await SaveGame.delete('one');
        expect(await SaveGame.exists('one')).toBe(false);
    });

    it('throws on an empty slot, a bad slot name, and without a store', async () => {
        makeGame(scenes()).enter('A');
        await expect(SaveGame.load('nothing')).rejects.toThrow(/no save in slot/);
        await expect(SaveGame.save('../escape')).rejects.toThrow(/cannot name a slot/);
        setSaveStore(null);
        expect(SaveGame.available).toBe(false);
        await expect(SaveGame.save()).rejects.toThrow(/only available while the game runs/);
    });

    it('starts over with newGame', async () => {
        const game = makeGame(scenes());
        game.enter('A');
        SaveGame.set('souls', 5);
        game.find('Crate').setPosition([3, 3, 3]);
        await Game.loadScene('B');
        SaveGame.newGame();
        await Game.loadScene('A');
        expect(SaveGame.has('souls')).toBe(false);
        expect(Array.from(game.find('Crate').position)).toEqual([0, 0, 0]);
    });

    it('runs migrations on older saves', async () => {
        makeGame(scenes()).enter('A');
        SaveGame.set('coins', 12);
        await SaveGame.save('old');
        setSaveStore(store, { gameVersion: 2 });
        SaveGame.onMigrate((doc, from) => { if (from < 2) doc.globals.gold = doc.globals.coins; });
        await SaveGame.load('old');
        expect(SaveGame.get('gold')).toBe(12);
    });

    it('writes a document anyone can read back', async () => {
        makeGame(scenes()).enter('A');
        await SaveGame.save('auto');
        const doc = (await store.read('auto'))!;
        expect(doc.format).toBe('cleo-save');
        expect(doc.formatVersion).toBe(SAVE_FORMAT_VERSION);
        expect(doc.gameVersion).toBe(1);
        expect(doc.scene.id).toBe('A');
        expect(Object.keys(doc.scenes)).toEqual(['A']);
        expect(validateSaveDocument(JSON.parse(JSON.stringify(doc)))).toBeTruthy();
    });
});

describe('save documents and slots', () => {
    it('refuses a document from a newer engine, or something else entirely', () => {
        expect(() => validateSaveDocument({ format: 'nope' })).toThrow(/Not a Cleo save/);
        expect(() => validateSaveDocument({ format: 'cleo-save', formatVersion: 99, scene: { id: 'a' } })).toThrow(/newer engine/);
    });

    it('reads a sparse document with defaults', () => {
        const doc = validateSaveDocument({ format: 'cleo-save', formatVersion: 1, scene: { id: 'a' } });
        expect(doc.globals).toEqual({});
        expect(doc.scenes).toEqual({});
        expect(doc.gameVersion).toBe(0);
    });

    it('leaves a newer game version alone when migrating', () => {
        const doc = validateSaveDocument({ format: 'cleo-save', formatVersion: 1, gameVersion: 5, scene: { id: 'a' } });
        let ran = false;
        migrateSaveDocument(doc, 3, [() => { ran = true; }]);
        expect(ran).toBe(false);
    });

    it('names slots like files on every platform', () => {
        for (const ok of ['auto', 'slot-1', 'quick_save', 'a.b', 'X']) expect(isValidSlot(ok)).toBe(true);
        for (const bad of ['', '.', '..', '.hidden', 'a/b', 'a\\b', 'CON', 'nul.txt', 'com1', 'x'.repeat(65), 'a b'])
            expect(isValidSlot(bad)).toBe(false);
    });

    it('a text store leaves out what it cannot read', async () => {
        const texts = new Map([['good', ''], ['broken', '{nope']]);
        const s = createTextSaveStore({
            kind: 'test',
            async list() { return [...texts.keys()].map(slot => ({ slot })); },
            async read(slot) { return texts.get(slot) ?? null; },
            async write(slot, text) { texts.set(slot, text); },
            async remove(slot) { texts.delete(slot); },
        });
        const doc: SaveDocument = validateSaveDocument({ format: 'cleo-save', formatVersion: 1, scene: { id: 'a', name: 'A' }, slot: 'good' });
        await s.write(doc);
        expect((await s.list()).map(i => i.slot)).toEqual(['good']);
        await expect(s.read('broken')).rejects.toThrow();
    });
});
