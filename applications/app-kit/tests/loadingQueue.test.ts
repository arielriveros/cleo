import { describe, it, expect } from 'vitest';
import { queueSlots, slotOpacity } from '../src/feedback/loadQueue';
import type { LoadStepState, LoadStepStatus } from '../src/feedback/loadingStore';

// The loading screen shows a load's steps as a queue: finished steps slide up out of it, the running ones
// sit at the focus with their percentage, the pending ones wait below. What can go wrong is the ORDER: a
// step that finishes out of order must move up past the ones still running, and a failure must not scroll
// away under the steps that finish after it.

let clock = 0;
const step = (id: string, status: LoadStepStatus, at: { start?: number; end?: number } = {}): LoadStepState => ({
  id, label: id, weight: 1, status, done: 0, total: 0, detail: '',
  startedAt: at.start ?? (status === 'pending' ? null : ++clock),
  endedAt: at.end ?? (status === 'done' || status === 'failed' || status === 'skipped' ? ++clock : null),
});

const order = (steps: LoadStepState[]) => queueSlots(steps).map(e => `${e.step.id}@${e.slot}`);

describe('the loading queue', () => {
  it('puts finished steps above the focus, then the running ones, then the pending ones', () => {
    const steps = [step('device', 'done'), step('shaders', 'running'), step('textures', 'pending'), step('scene', 'pending')];
    expect(order(steps)).toEqual(['device@-1', 'shaders@0', 'textures@1', 'scene@2']);
  });

  it('moves a step that finishes out of order up past the ones still running', () => {
    const steps = [
      step('textures', 'running', { start: 1 }),
      step('libraries', 'running', { start: 2 }),
      step('models', 'done', { start: 3, end: 4 }),
      step('scene', 'pending'),
    ];
    expect(order(steps)).toEqual(['models@-1', 'textures@0', 'libraries@1', 'scene@2']);
  });

  it('keeps the oldest finished step at the top and a failure next to the focus', () => {
    const steps = [
      step('a', 'failed', { start: 1, end: 2 }),
      step('b', 'done', { start: 3, end: 4 }),
      step('c', 'done', { start: 5, end: 6 }),
      step('d', 'running', { start: 7 }),
    ];
    expect(order(steps)).toEqual(['b@-3', 'c@-2', 'a@-1', 'd@0']);
  });

  it('orders the running steps by when they started, the pending ones as declared', () => {
    const steps = [
      step('late', 'running', { start: 9 }), step('early', 'running', { start: 1 }),
      step('second', 'pending'), step('first', 'pending'),
    ];
    expect(order(steps)).toEqual(['early@0', 'late@1', 'second@2', 'first@3']);
  });

  it('files the steps carried over from before a reload, all done, in the history', () => {
    const steps = [step('prior:write', 'done'), step('prior:project', 'done'), step('device', 'pending')];
    expect(order(steps)).toEqual(['prior:write@-2', 'prior:project@-1', 'device@0']);
  });
});

describe('row opacity', () => {
  const at = (steps: LoadStepState[], id: string) => slotOpacity(queueSlots(steps).find(e => e.step.id === id)!);

  it('fades finished steps as they move up, and drops them past the second row', () => {
    const steps = [step('a', 'done'), step('b', 'done'), step('c', 'done'), step('d', 'running')];
    expect([at(steps, 'c'), at(steps, 'b'), at(steps, 'a')]).toEqual([0.45, 0.2, 0]);
  });

  it('shows the running steps in full and the pending ones fainter the further they wait', () => {
    const steps = [step('r1', 'running'), step('r2', 'running'), step('p1', 'pending'), step('p2', 'pending'),
      ...Array.from({ length: 6 }, (_, i) => step(`p${i + 3}`, 'pending'))];
    expect([at(steps, 'r1'), at(steps, 'r2')]).toEqual([1, 1]);
    expect(at(steps, 'p1')).toBeCloseTo(0.7);
    expect(at(steps, 'p2')).toBeCloseTo(0.6);
    expect(at(steps, 'p8')).toBeCloseTo(0.3);
  });

  it('keeps a failure in full wherever it sits', () => {
    const steps = [step('x', 'failed'), step('y', 'pending')];
    expect(at(steps, 'x')).toBe(1);
  });
});
