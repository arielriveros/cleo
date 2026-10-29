import { describe, it, expect, beforeEach } from 'vitest';
import {
  alertDialog, cancelAllDialogs, confirmDialog, getSnapshot, promptDialog, resolveDialog, subscribe,
} from '../src/features/dialogs/dialogStore';

// The dialog service replaced window.alert/confirm/prompt, which the desktop shell cannot rely on. Every
// caller now holds a promise instead of a blocking return value, so the invariants that matter are about
// promises never being lost or crossed:
//
//   1. every parked request settles exactly once, with ITS OWN answer   (queue, not replace)
//   2. only the request on screen can be answered                        (no stale click answers the next one)
//   3. the snapshot is reference-stable across an unrelated publish      (useSyncExternalStore loops otherwise)
//
// A dropped promise here is an await that never returns — a delete that silently never happens, an
// asset explorer wedged behind `deleteConfirmRef`. That is why (1) is worth a test rather than a comment.

beforeEach(() => { cancelAllDialogs(); });

describe('dialogStore', () => {
  it('puts a confirm on screen and resolves it true', async () => {
    const answer = confirmDialog({ title: 'Delete?' });
    expect(getSnapshot()?.kind).toBe('confirm');
    expect(getSnapshot()?.options.title).toBe('Delete?');

    resolveDialog(getSnapshot()!.id, true);
    expect(await answer).toBe(true);
    expect(getSnapshot(), 'the queue empties once answered').toBeNull();
  });

  it('resolves a confirm false on cancel', async () => {
    const answer = confirmDialog({ title: 'Delete?' });
    resolveDialog(getSnapshot()!.id, false);
    expect(await answer).toBe(false);
  });

  it('resolves a prompt to its value, and to null on cancel', async () => {
    const typed = promptDialog({ title: 'Name', defaultValue: 'Untitled' });
    resolveDialog(getSnapshot()!.id, true, 'Rock');
    expect(await typed).toBe('Rock');

    const cancelled = promptDialog({ title: 'Name' });
    resolveDialog(getSnapshot()!.id, false);
    expect(await cancelled).toBeNull();
  });

  it('resolves a confirmed prompt with no value to the empty string, not undefined', () => {
    const typed = promptDialog({ title: 'Name' });
    resolveDialog(getSnapshot()!.id, true);
    return expect(typed).resolves.toBe('');
  });

  it('resolves an alert either way — it has nothing to report but "seen"', async () => {
    const seen = alertDialog({ title: 'Heads up' });
    resolveDialog(getSnapshot()!.id, true);
    expect(await seen).toBeUndefined();
  });

  // Invariant 1. Replacing rather than queueing would have to settle the displaced promise as `false`,
  // reporting "the user said no" for what was really an interruption.
  it('queues overlapping requests and gives each its own answer', async () => {
    const first = confirmDialog({ title: 'First' });
    const second = confirmDialog({ title: 'Second' });

    expect(getSnapshot()?.options.title, 'the first stays on screen').toBe('First');
    resolveDialog(getSnapshot()!.id, true);

    expect(getSnapshot()?.options.title, 'answering reveals the next').toBe('Second');
    resolveDialog(getSnapshot()!.id, false);

    expect(await first).toBe(true);
    expect(await second).toBe(false);
  });

  // Invariant 2.
  it('ignores an answer aimed at anything but the request on screen', async () => {
    const first = confirmDialog({ title: 'First' });
    const second = confirmDialog({ title: 'Second' });
    const headId = getSnapshot()!.id;

    resolveDialog('dlg-does-not-exist', true);
    expect(getSnapshot()!.id, 'an unknown id changes nothing').toBe(headId);

    // The queued second request is not on screen, so it cannot be answered out of turn.
    resolveDialog(`${headId}-not-the-head`, true);
    expect(getSnapshot()!.id).toBe(headId);

    resolveDialog(headId, true);
    resolveDialog(getSnapshot()!.id, true);
    expect(await Promise.all([first, second])).toEqual([true, true]);
  });

  // Invariant 3: the trap progressStore's header calls out by name.
  it('keeps the snapshot reference stable across an unrelated publish', async () => {
    const answer = confirmDialog({ title: 'First' });
    const before = getSnapshot();
    confirmDialog({ title: 'Second' }); // publishes, but the head is unchanged
    expect(getSnapshot(), 'same object, or useSyncExternalStore spins').toBe(before);

    resolveDialog(getSnapshot()!.id, true);
    await answer;
    cancelAllDialogs();
  });

  it('settles every parked promise when the queue is cancelled', async () => {
    const first = confirmDialog({ title: 'First' });
    const second = promptDialog({ title: 'Second' });
    cancelAllDialogs();

    expect(getSnapshot()).toBeNull();
    expect(await first).toBe(false);
    expect(await second).toBeNull();
  });

  it('stops notifying an unsubscribed listener', () => {
    let calls = 0;
    const unsubscribe = subscribe(() => { calls++; });
    confirmDialog({ title: 'First' });
    expect(calls).toBe(1);

    unsubscribe();
    confirmDialog({ title: 'Second' });
    expect(calls).toBe(1);
  });
});
