import { describe, it, expect } from 'vitest';
import '../src/cleo';   // the full engine: its node classes' declarations (src/properties) are registered
import { Node } from '../src/core/scene/nodes/node';
import { LightNode } from '../src/core/scene/nodes/lightNode';
import { ControllerNode } from '../src/core/scene/nodes/controllerNode';
import { Camera2DNode } from '../src/core/scene/nodes/camera2DNode';
import { PointLight } from '../src/graphics/lighting';
import { keyableProperties } from '../src/sequencer/keyable';
import { declarationsOf, shownProperties } from '../src/properties/declare';

// What the Sequencer keys on a node reads the node's declared inspector rows (src/properties): their names and
// types, and the rows a walk of the node's own properties cannot reach.

describe('declared rows in the keyable list', () => {
    it('names and types a row the walk finds: a light colour is a colour', () => {
        const light = new LightNode('lamp', new PointLight({}));
        const color = keyableProperties(light).find(p => p.path === 'light.color');
        expect(color?.type).toEqual({ kind: 'color' });
        expect(color?.label).toBe('Light › Emission › Color');
        expect(keyableProperties(light).find(p => p.path === 'position')?.label).toBe('Transform › Position');
    });

    it('adds a declared row two levels down that the walk misses', () => {
        const controller = new ControllerNode('ai');
        const speed = keyableProperties(controller).find(p => p.path === 'steering.maxSpeed');
        expect(speed).toMatchObject({ valueType: 'number', value: controller.steering.maxSpeed, label: 'Controller › Steering › Max speed' });
    });

    it('leaves out the rows read through a getter of their own, and the read-only ones', () => {
        const controller = new ControllerNode('ai');
        const paths = keyableProperties(controller).map(p => p.path);
        expect(paths).not.toContain('possessedId');
        expect(paths).not.toContain('worldPosition');
    });
});

describe('a node\'s declarations', () => {
    it('come nearest class first: a light\'s card, then every node\'s Transform', () => {
        const light = new LightNode('lamp', new PointLight({}));
        expect(declarationsOf(light).map(d => d.title)).toEqual(['Light', 'Transform']);
        expect(declarationsOf(new Node('plain')).map(d => d.title)).toEqual(['Transform']);
    });

    it('leave out the card of a class a declaration replaces: a Camera 2D is no Camera', () => {
        expect(declarationsOf(new Camera2DNode('cam')).map(d => d.title)).toEqual(['Camera 2D', 'Transform']);
    });

    it('show only the rows their `when` allows', () => {
        const controller = new ControllerNode('ai');
        const shown = () => shownProperties(controller).map(r => r.prop.key);
        expect(shown()).toContain('moveAction');
        expect(shown()).not.toContain('goal');
        controller.controlSource = 'ai';
        expect(shown()).toContain('goal');
        expect(shown()).not.toContain('moveAction');
    });
});
