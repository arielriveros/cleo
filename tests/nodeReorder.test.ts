import { describe, it, expect } from 'vitest';
import { CleoEngine } from '../src/core/engine';
import { Node } from '../src/core/scene/nodes/node';

/**
 * `addChild(node, index)` and the structural event it reports.
 *
 * The index half of the payload used to be hard-coded to `length - 1`, which was invisible while nothing
 * in the UI could insert at a position. Dropping a row *between* two siblings in the scene tree does, and
 * `HistoryContext` replays a move by re-running `addChild(node, next.index)` — so a wrong index there turns
 * every redo of a re-order into an append.
 */
function capture(run: () => void): any[] {
    const events: any[] = [];
    const listener = (e: any) => events.push(e);
    CleoEngine.eventEmitter.on('SCENE_CHANGED', listener);
    try { run(); } finally { CleoEngine.eventEmitter.off('SCENE_CHANGED', listener); }
    return events;
}

const structural = (events: any[], prop: string) => events.filter(e => e?.kind === 'structure' && e?.prop === prop);

describe('Node.addChild with an index', () => {
    it('inserts at the index rather than appending', () => {
        const parent = new Node('parent');
        const a = new Node('a'), b = new Node('b'), c = new Node('c');
        parent.addChild(a);
        parent.addChild(c);
        parent.addChild(b, 1);
        expect(parent.children.map(n => n.name)).toEqual(['a', 'b', 'c']);
    });

    it('reports the slot it landed in, not the end of the list', () => {
        const parent = new Node('parent');
        parent.addChild(new Node('a'));
        parent.addChild(new Node('c'));

        const events = capture(() => parent.addChild(new Node('b'), 1));
        const added = structural(events, 'add');
        expect(added).toHaveLength(1);
        expect(added[0].next).toEqual({ parentId: parent.id, index: 1 });
    });

    it('re-orders a node among its own siblings and reports both ends of the move', () => {
        const parent = new Node('parent');
        const a = new Node('a'), b = new Node('b'), c = new Node('c');
        parent.addChild(a); parent.addChild(b); parent.addChild(c);

        // What the scene tree does when 'c' is dropped in front of 'b': addChild detaches first, so the
        // caller passes the post-removal slot.
        const events = capture(() => parent.addChild(c, 1));
        expect(parent.children.map(n => n.name)).toEqual(['a', 'c', 'b']);

        const moved = structural(events, 'reparent');
        expect(moved).toHaveLength(1);
        expect(moved[0].prev).toEqual({ parentId: parent.id, index: 2 });
        expect(moved[0].next).toEqual({ parentId: parent.id, index: 1 });
        // The detach half is flagged so a recorder doesn't count the move twice.
        expect(structural(events, 'reparent-detach')).toHaveLength(1);
    });

    it('still appends when the index is omitted or out of range', () => {
        const parent = new Node('parent');
        parent.addChild(new Node('a'));
        parent.addChild(new Node('b'), 99);
        parent.addChild(new Node('c'), -1);
        expect(parent.children.map(n => n.name)).toEqual(['a', 'b', 'c']);
    });
});
