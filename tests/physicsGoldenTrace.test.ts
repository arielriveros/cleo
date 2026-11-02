import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { runScenario, scenarioPhysics } from './helpers/physicsScenario';

// The inline physics step, pinned bit for bit on a mixed scene (tests/helpers/physicsScenario.ts). Recorded
// before the step moved behind the PhysicsBackend seam, so the refactor — and anything later — cannot
// quietly change what the simulation does. If a change to the physics is MEANT to change the trace,
// delete the fixture and re-run to record the new one, and say why in the commit.

const FIXTURE = join(__dirname, 'fixtures', 'physicsGoldenTrace.json');

describe('the inline physics step', () => {
    it('matches the recorded trace exactly', () => {
        const trace = runScenario(scenarioPhysics());
        if (!existsSync(FIXTURE)) {
            mkdirSync(join(__dirname, 'fixtures'), { recursive: true });
            writeFileSync(FIXTURE, JSON.stringify(trace));
            throw new Error('Recorded a new golden trace; re-run to check against it.');
        }
        const golden = JSON.parse(readFileSync(FIXTURE, 'utf8'));
        expect(trace.triggers).toEqual(golden.triggers);
        expect(trace.collides).toEqual(golden.collides);
        expect(trace.grounded).toEqual(golden.grounded);
        expect(trace.frozen).toEqual(golden.frozen);
        expect(trace.states.length).toBe(golden.states.length);
        for (let i = 0; i < trace.states.length; i++) expect(trace.states[i], `frame ${i * 10}`).toEqual(golden.states[i]);
    });

    it('exercises what it claims to: an enter and exit, a collision, grounding, a freeze and a thaw', () => {
        const trace = runScenario(scenarioPhysics());
        expect(trace.triggers).toEqual(['Zone enter Hero', 'Zone exit Hero']);
        expect(trace.collides.length).toBeGreaterThan(0);
        expect(trace.grounded.slice(30).filter(Boolean).length).toBeGreaterThan(200);
        expect(trace.frozen.slice(0, 140).every(Boolean)).toBe(true);
        expect(trace.frozen.slice(160, 230).some(f => !f)).toBe(true);
    });
});
