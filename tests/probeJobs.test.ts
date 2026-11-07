import { describe, expect, it } from 'vitest';
import { vec3 } from 'gl-matrix';
import { LightProbeNode } from '../src/core/scene/nodes/lightProbeNode';
import { nextProbeJob, probeJobSteps } from '../src/graphics/render/probeJobs';
import type { Texture } from '../src/graphics/texture';

const fakeCube = () => ({ delete() {} }) as unknown as Texture;
const place = (p: LightProbeNode, x: number) => { p.setPosition(vec3.fromValues(x, 0, 0)); p.updateTransforms(); return p; };
const baked = (name: string, x: number, options: ConstructorParameters<typeof LightProbeNode>[1] = {}) => {
    const p = place(new LightProbeNode(name, options), x);
    p.setBakedMaps(fakeCube());
    p.reflectionLayer = 0;
    p.takeBakeRequests();
    p.markBaked(0);
    return p;
};

describe('a probe job, step by step (probeJobSteps)', () => {
    it('captures, shadows, relights, then filters in three steps, the last swapping the new maps in', () => {
        expect(probeJobSteps('bake').map(s => s.kind)).toEqual(['gbuffer', 'shadow', 'relight', 'filter', 'filter', 'filter']);
        const steps = probeJobSteps('bake');
        const filters = steps.filter(s => s.kind === 'filter') as { mips: readonly number[]; finish: boolean }[];
        expect(filters.flatMap(f => f.mips)).toEqual([0, 1, 2, 3, 4]);
        expect(filters.map(f => f.finish)).toEqual([false, false, true]);
    });

    it('relights without capturing, and filters alone after the atlas regrows', () => {
        expect(probeJobSteps('relight').map(s => s.kind)).toEqual(['shadow', 'relight', 'filter', 'filter', 'filter']);
        expect(probeJobSteps('filter').map(s => s.kind)).toEqual(['filter', 'filter', 'filter']);
    });
});

describe('which probe goes next (nextProbeJob)', () => {
    const cam = [0, 0, 0];
    const yes = () => true;

    it('bakes a never-baked probe first, then refilters, then a bake asked for, then a relight, then realtime', () => {
        const fresh = place(new LightProbeNode('fresh'), 100);
        const lost = baked('lost', 80); lost.reflectionLayer = -1;
        const asked = baked('asked', 60); asked.bake();
        const relit = baked('relit', 1); relit.relight();
        const live = baked('live', 2, { mode: 'realtime', updateFrequency: 0 });
        const all = [live, relit, asked, lost, fresh];
        expect(nextProbeJob(all, cam, 1000, yes)).toEqual({ probe: fresh, kind: 'bake' });
        fresh.setBakedMaps(fakeCube()); fresh.reflectionLayer = 1; fresh.takeBakeRequests();
        expect(nextProbeJob(all, cam, 1000, yes)).toEqual({ probe: lost, kind: 'filter' });
        lost.reflectionLayer = 2;
        expect(nextProbeJob(all, cam, 1000, yes)).toEqual({ probe: asked, kind: 'bake' });
        asked.takeBakeRequests();
        expect(nextProbeJob(all, cam, 1000, yes)).toEqual({ probe: relit, kind: 'relight' });
        relit.takeBakeRequests();
        expect(nextProbeJob(all, cam, 1000, yes)).toEqual({ probe: live, kind: 'bake' });
    });

    it('bakes a probe asked to relight that has no captured scene', () => {
        const p = baked('no gbuffer', 0);
        p.relight();
        expect(nextProbeJob([p], cam, 0, () => false)).toEqual({ probe: p, kind: 'bake' });
    });

    it('takes the nearest within a tier, and nothing when nothing is due', () => {
        const near = baked('near', 5), far = baked('far', 50);
        near.relight(); far.relight();
        expect(nextProbeJob([far, near], cam, 0, yes)?.probe).toBe(near);
        near.takeBakeRequests(); far.takeBakeRequests();
        expect(nextProbeJob([far, near], cam, 0, yes)).toBe(null);
        const slow = baked('slow', 0, { mode: 'realtime', updateFrequency: 5 });
        slow.markBaked(1000);
        expect(nextProbeJob([slow], cam, 2000, yes)).toBe(null);
        expect(nextProbeJob([slow], cam, 6500, yes)).toEqual({ probe: slow, kind: 'bake' });
    });

    it('queues a request made while a job runs: the flags are taken when it starts', () => {
        const p = baked('busy', 0);
        p.bake();
        p.takeBakeRequests();           // the job starts
        expect(p.needsBake).toBe(false);
        p.relight();                    // asked again mid-job
        expect(nextProbeJob([p], cam, 0, yes)).toEqual({ probe: p, kind: 'relight' });
    });
});
