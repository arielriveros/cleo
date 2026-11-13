import { describe, it, expect } from 'vitest';
import { Scene } from '../src/core/scene/scene';
import { Node } from '../src/core/scene/nodes/node';
import { LightNode } from '../src/core/scene/nodes/lightNode';
import { CameraNode } from '../src/core/scene/nodes/cameraNode';
import { Camera } from '../src/core/camera';
import { PointLight } from '../src/graphics/lighting';
import { SequenceNode } from '../src/core/scene/nodes/sequenceNode';
import { parseSequence } from '../src/sequencer/parse';
import { keyableProperties, sameKeyValue } from '../src/sequencer/keyable';
import type { SequenceData } from '../src/sequencer/types';

// What Sequencer mode's auto-key rests on in the engine: a slot bound by the sequence itself (`nodeId`), property
// tracks that move a node's world matrix the frame they write it and when they put it back, `visible` keyed and
// restored exactly, and the list of what can be keyed on a node.

function sequence(partial: Partial<SequenceData>): SequenceData {
    return parseSequence({ version: 1, name: 'Test', duration: 4, fps: 30, clock: 'game', loop: false,
                           slots: [], tracks: [], markers: [], ...partial });
}

const positionTrack = (slot: string) => ({
    id: 'p', type: 'property', slot, path: 'position', valueType: 'vector',
    sections: [{ id: 's', start: 0, end: 2, curve: { keys: [{ t: 0, v: [0, 0, 0] }, { t: 2, v: [0, 2, 1] }] } }],
});

describe('slot bindings', () => {
    it('keeps a slot\'s nodeId through the parse, and through node.sequence =', () => {
        const seq = sequence({ slots: [{ id: 'cube', name: 'Cube', nodeId: 'n-1', path: 'Cube' }] });
        expect(seq.slots[0].nodeId).toBe('n-1');
        const node = new SequenceNode('Seq');
        node.sequence = seq;
        expect(node.sequence.slots[0].nodeId).toBe('n-1');
        expect(JSON.parse(JSON.stringify(node.sequence)).slots[0]).toEqual({ id: 'cube', name: 'Cube', nodeId: 'n-1', path: 'Cube' });
    });

    it('resolves: the node\'s binding, then the slot\'s nodeId, then its path', () => {
        const scene = new Scene();
        const byPath = new Node('Cube'), byId = new Node('Other'), byBinding = new Node('Bound');
        for (const n of [byPath, byId, byBinding]) scene.addNode(n);
        const seq = new SequenceNode('Seq', { sequence: sequence({ slots: [{ id: 'cube', name: 'Cube', nodeId: byId.id, path: 'Cube' }] }) });
        scene.addNode(seq);
        expect(seq.resolveSlot('cube')).toBe(byId);
        seq.bind('cube', byBinding);
        expect(seq.resolveSlot('cube')).toBe(byBinding);
        seq.bind('cube', null);
        seq.sequence = sequence({ slots: [{ id: 'cube', name: 'Cube', nodeId: 'gone', path: 'Cube' }] });
        expect(seq.resolveSlot('cube')).toBe(byPath);
    });

    it('serializes and parses the asset link', () => {
        const scene = new Scene();
        const seq = new SequenceNode('Seq', { sequenceId: 'asset-1' });
        scene.addNode(seq);
        expect(seq.sequenceId).toBe('asset-1');
        const json = JSON.parse(JSON.stringify((seq as any)._serializePayload()));
        expect(json.sequenceId).toBe('asset-1');
        const holder = new Node('holder');
        SequenceNode.parse(holder, { ...json, id: 'x', name: 'Seq', type: 'sequence' });
        expect((holder.children[0] as SequenceNode).sequenceId).toBe('asset-1');
        seq.sequenceId = null;
        expect('sequenceId' in (seq as any)._serializePayload()).toBe(false);
    });
});

describe('property tracks on a node\'s transform', () => {
    it('refresh the world matrix the frame they write, and when they put it back', () => {
        const scene = new Scene();
        const parent = new Node('Parent');
        parent.setPosition([10, 0, 0]);
        const cube = new Node('Cube');
        parent.addChild(cube);
        scene.addNode(parent);
        const seq = new SequenceNode('Seq', { sequence: sequence({ slots: [{ id: 'cube', name: 'Cube', nodeId: cube.id }], tracks: [positionTrack('cube')] as any }) });
        scene.addNode(seq);
        scene.update(0, 0, false);
        seq.seek(2);
        expect(Array.from(cube.worldPosition)).toEqual([10, 2, 1]);
        seq.seek(1);
        expect(cube.worldPosition[1]).toBeCloseTo(1, 5);
        seq.stop();
        expect(Array.from(cube.position)).toEqual([0, 0, 0]);
        expect(Array.from(cube.worldPosition)).toEqual([10, 0, 0]);
    });
});

describe('autoplay', () => {
    it('never plays in a scene with its runtime rules off (an editor\'s), loading or not', () => {
        const run = (rules: boolean) => {
            const scene = new Scene();
            scene.spawnRulesEnabled = rules;
            const seq = new SequenceNode('Day', { sequence: sequence({ loop: true }), autoplay: true });
            scene.addNode(seq);
            scene.start();
            scene.update(1 / 60, 0, false);
            return seq.isPlaying;
        };
        expect(run(true)).toBe(true);
        expect(run(false)).toBe(false);
    });
});

describe('visibility keys', () => {
    it('read the authored flag, and restore every descendant\'s own flag', () => {
        const scene = new Scene();
        const group = new Node('Group');
        const shown = new Node('Shown'), hidden = new Node('Hidden');
        group.addChild(shown);
        group.addChild(hidden);
        scene.addNode(group);
        hidden.visible = false;
        const seq = new SequenceNode('Seq', { sequence: sequence({
            slots: [{ id: 'g', name: 'Group', nodeId: group.id }],
            tracks: [{ id: 'v', type: 'property', slot: 'g', path: 'visible', valueType: 'bool',
                       sections: [{ id: 's', start: 0, end: 2, curve: { keys: [{ t: 0, v: true }, { t: 1, v: false }] } }] }] as any,
        }) });
        scene.addNode(seq);
        seq.seek(1.5);
        expect(group.authoredVisible).toBe(false);
        expect(shown.authoredVisible).toBe(false);
        seq.stop();
        expect(group.authoredVisible).toBe(true);
        expect(shown.authoredVisible).toBe(true);
        expect(hidden.authoredVisible).toBe(false);
    });
});

describe('keyableProperties', () => {
    const find = (props: ReturnType<typeof keyableProperties>, path: string) => props.find(p => p.path === path);

    it('lists the transform, visibility, a light\'s and a camera\'s fields, script fields and variables', () => {
        const light = new LightNode('Lamp', new PointLight({ diffuse: [1, 0.5, 0.25] }));
        light.setPosition([1, 2, 3]);
        (light as any).flickerSpeed = 3;          // a class script's field lives on the node
        light.setVariable('mood', 0.5, 'number' as any);
        const props = keyableProperties(light);
        expect(props.slice(0, 4).map(p => p.path)).toEqual(['position', 'rotation', 'scale', 'visible']);
        expect(find(props, 'position')).toEqual({ path: 'position', valueType: 'vector', value: [1, 2, 3] });
        expect(find(props, 'visible')?.valueType).toBe('bool');
        expect(find(props, 'light.intensity')?.valueType).toBe('number');
        expect(find(props, 'flickerSpeed')).toEqual({ path: 'flickerSpeed', valueType: 'number', value: 3 });
        expect(find(props, 'variables.mood.value')).toEqual({ path: 'variables.mood.value', valueType: 'number', value: 0.5 });

        const cam = keyableProperties(new CameraNode('Cam', new Camera({})));
        expect(find(cam, 'camera.fov')?.valueType).toBe('number');
    });

    it('lists a model\'s material properties under the path the Valley\'s pond key uses', () => {
        const fake = { model: { materials: [{ properties: new Map<string, unknown>([['waveStrength', 0.32], ['tint', [1, 0, 0]], ['map', 'tex-1']]) },
                                            { properties: new Map<string, unknown>([['roughness', 0.5]]) }] } };
        const props = keyableProperties(fake);
        expect(find(props, 'model.material.properties.waveStrength')?.value).toBe(0.32);
        expect(find(props, 'model.material.properties.tint')?.valueType).toBe('vector');
        expect(find(props, 'model.material.properties.map')).toBeUndefined();
        expect(find(props, 'model.materials.1.properties.roughness')?.value).toBe(0.5);
    });

    it('leaves out identity, links, internals and the sequence\'s own data', () => {
        const node = new SequenceNode('Seq', { sequenceId: 'a' });
        (node as any).materialId = 'm';
        (node as any)._hidden = 1;
        const paths = keyableProperties(node).map(p => p.path);
        for (const p of ['name', 'id', 'nodeType', 'sequence', 'bindings', 'sequenceId', 'previewCuts', 'materialId', '_hidden'])
            expect(paths).not.toContain(p);
        expect(paths.every(p => !p.split('.').some(s => s.startsWith('_')))).toBe(true);
    });

    it('compares values the way a key does', () => {
        expect(sameKeyValue([1, 2, 3], [1, 2, 3 + 1e-9])).toBe(true);
        expect(sameKeyValue([1, 2], [1, 2, 3])).toBe(false);
        expect(sameKeyValue(0.5, 0.5000001)).toBe(true);
        expect(sameKeyValue(true, false)).toBe(false);
    });
});
