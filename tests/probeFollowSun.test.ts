import { describe, it, expect } from 'vitest';
import { LightProbeNode } from '../src/core/scene/nodes/lightProbeNode';
import { Node } from '../src/core/scene/nodes/node';
import { probesToRelightForSun } from '../src/graphics/render/probeJobs';

// Light probes that follow the sun (`relightDegrees`): once the scene's sun has turned that far since a probe
// was last lit, the probe relights itself, whatever turned the sun — a sequence keying it, a script. This is
// what the Valley's time-of-day script used to do by hand.

const probe = (relightDegrees: number, baked = true) => ({ relightDegrees, hasBakedMaps: baked });
const dir = (deg: number): [number, number, number] => [Math.sin(deg * Math.PI / 180), -Math.cos(deg * Math.PI / 180), 0];

describe('probesToRelightForSun', () => {
    it('relights a probe once the sun has turned past its degrees, and measures again from there', () => {
        const p = probe(4);
        const lit = new WeakMap();
        expect(probesToRelightForSun([p], dir(0), lit)).toEqual([]);      // first sight: only records
        expect(probesToRelightForSun([p], dir(3), lit)).toEqual([]);
        expect(probesToRelightForSun([p], dir(4.5), lit)).toEqual([p]);
        expect(probesToRelightForSun([p], dir(7), lit)).toEqual([]);      // 2.5° since the relight
        expect(probesToRelightForSun([p], dir(9), lit)).toEqual([p]);
    });

    it('leaves alone probes that do not follow the sun, unbaked probes, and a scene with no sun', () => {
        const off = probe(0), unbaked = probe(4, false);
        const lit = new WeakMap();
        probesToRelightForSun([off, unbaked], dir(0), lit);
        expect(probesToRelightForSun([off, unbaked], dir(30), lit)).toEqual([]);
        expect(probesToRelightForSun([probe(4)], null, lit)).toEqual([]);
    });
});

describe('LightProbeNode.relightDegrees', () => {
    it('round-trips, and is left out when off', () => {
        const node = new LightProbeNode('Probe', { relightDegrees: 4 });
        expect(node.relightDegrees).toBe(4);
        const json = JSON.parse(JSON.stringify((node as any)._serializePayload()));
        expect(json.relightDegrees).toBe(4);
        const holder = new Node('holder');
        LightProbeNode.parse(holder, { ...json, id: 'p', name: 'Probe', type: 'lightProbe' });
        expect((holder.children[0] as LightProbeNode).relightDegrees).toBe(4);
        node.relightDegrees = -3;
        expect(node.relightDegrees).toBe(0);
        expect('relightDegrees' in (node as any)._serializePayload()).toBe(false);
    });
});
