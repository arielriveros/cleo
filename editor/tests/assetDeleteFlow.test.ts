import { describe, it, expect } from 'vitest';
import { inUseDialogOptions, planDelete } from '../src/features/assets/deleteFlow';
import type { VfsEntry, VfsIndex } from '../src/utils/vfs';

// The asset explorer's delete used to ask through window.confirm, which the SVAR interceptor could read
// synchronously to cancel the batch. The in-app dialog cannot be awaited there, so a delete that needs
// confirming is now CANCELLED and re-issued after the user answers — and the second pass carries
// `skipProvider`, which returns on the interceptor's first line and re-runs none of this filtering.
//
// That splits one decision across two passes, so what planDelete produces on pass one has to still hold
// on pass two. These pin that:
//
//   1. the plan only ever names top-most, resolvable ids (DataTree.remove dereferences anything else
//      blind, throws mid-batch, and leaves the tree half-mutated — see vfs.test.ts invariant 3)
//   2. planDelete is a fixed point: re-planning its own output changes nothing
//   3. the confirmation lists every in-use asset, not the first six the alert() string could fit

const entry = (path: string, over: Partial<VfsEntry> = {}): VfsEntry =>
  ({ path, kind: 'material', assetId: path, ...over });

const index = (folders: string[], entries: VfsEntry[]): VfsIndex =>
  ({ version: 1, folders, entries });

/** A tree with a folder of three materials and one loose material beside it. */
const vfs = index(
  ['/', '/Rocks'],
  [entry('/Rocks/Granite.mat'), entry('/Rocks/Basalt.mat'), entry('/Rocks/Slate.mat'), entry('/Loose.mat')],
);

const allResolve = () => true;
const noneReferenced = () => false;

describe('planDelete', () => {
  // Invariant 1.
  it('collapses a folder and its own contents to the folder alone', () => {
    const plan = planDelete(vfs, ['/Rocks', '/Rocks/Granite.mat'], allResolve, noneReferenced);
    expect(plan.ids, 'naming both would purge the subtree then dereference the child').toEqual(['/Rocks']);
  });

  it('drops ids the tree can no longer resolve', () => {
    const resolves = (id: string) => id !== '/Loose.mat';
    const plan = planDelete(vfs, ['/Rocks/Granite.mat', '/Loose.mat'], resolves, noneReferenced);
    expect(plan.ids).toEqual(['/Rocks/Granite.mat']);
  });

  it('yields an empty plan when nothing resolves', () => {
    const plan = planDelete(vfs, ['/Gone.mat'], () => false, noneReferenced);
    expect(plan.ids).toEqual([]);
    expect(plan.entries).toEqual([]);
    expect(plan.inUse).toEqual([]);
  });

  it('yields an empty plan for a non-array payload', () => {
    expect(planDelete(vfs, undefined, allResolve, noneReferenced).ids).toEqual([]);
  });

  it('covers the whole subtree of a deleted folder', () => {
    const plan = planDelete(vfs, ['/Rocks'], allResolve, noneReferenced);
    expect(plan.entries.map(e => e.path).sort())
      .toEqual(['/Rocks/Basalt.mat', '/Rocks/Granite.mat', '/Rocks/Slate.mat']);
  });

  it('reports exactly the referenced subset as in use', () => {
    const referenced = (e: VfsEntry) => e.path === '/Rocks/Basalt.mat';
    const plan = planDelete(vfs, ['/Rocks'], allResolve, referenced);
    expect(plan.inUse.map(e => e.path)).toEqual(['/Rocks/Basalt.mat']);
    expect(plan.entries.length, 'in-use is a subset, not a filter of the batch').toBe(3);
  });

  // Invariant 2 — the phase-one/phase-two contract, stated as a test.
  it('is a fixed point: re-planning its own ids changes nothing', () => {
    const first = planDelete(vfs, ['/Rocks', '/Rocks/Granite.mat', '/Loose.mat'], allResolve, noneReferenced);
    const second = planDelete(vfs, first.ids, allResolve, noneReferenced);
    expect(second.ids).toEqual(first.ids);
    expect(second.entries.map(e => e.path)).toEqual(first.entries.map(e => e.path));
  });
});

describe('inUseDialogOptions', () => {
  // Invariant 3.
  it('lists every in-use asset, with no truncation', () => {
    const inUse = Array.from({ length: 9 }, (_, i) => entry(`/Rocks/Rock${i}.mat`));
    const options = inUseDialogOptions(inUse, e => `${e.path} — used elsewhere`);

    expect(options.details, 'the alert() this replaced stopped at six').toHaveLength(9);
    expect(options.details![8]).toBe('/Rocks/Rock8.mat — used elsewhere');
    expect(options.title).toBe('9 of these assets are still in use');
    expect(options.tone).toBe('danger');
    expect(options.confirmLabel).toBe('Delete anyway');
  });

  it('reads as singular for one asset', () => {
    const options = inUseDialogOptions([entry('/Loose.mat')], e => e.path);
    expect(options.title).toBe('This asset is still in use');
    expect(options.message).toBe('Deleting it cannot be undone.');
  });
});
