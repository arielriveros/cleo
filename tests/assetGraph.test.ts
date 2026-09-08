import { describe, it, expect, beforeEach } from 'vitest';
import { AssetGraph, assetKey, engineEventBus } from '../src/cleo';
import type { AssetRef } from '../src/cleo';

// The reference graph is pure data — no GL, no DOM — so it is exercised directly.

const ref = (kind: string, id: string): AssetRef => ({ kind, id });
const K = assetKey;

/** texture:rock <- material:stone <- model:boulder <- scene:level1 */
function chain(g: AssetGraph): void {
    g.setEdges(ref('image', 'rock.png'), []);
    g.setEdges(ref('texture', 'rock'), [{ to: ref('image', 'rock.png'), field: 'source.imageId' }]);
    g.setEdges(ref('material', 'stone'), [{ to: ref('texture', 'rock'), field: 'textures.baseTexture' }]);
    g.setEdges(ref('model', 'boulder'), [{ to: ref('material', 'stone'), field: 'materialIds[0]' }]);
    g.setEdges(ref('scene', 'level1'), [{ to: ref('model', 'boulder'), field: 'refs.modelIds' }]);
}

describe('AssetGraph', () => {
    let g: AssetGraph;
    beforeEach(() => { g = new AssetGraph(); });

    describe('edges and the reverse index', () => {
        it('records outgoing edges with their field attribution', () => {
            g.setEdges(ref('material', 'stone'), [
                { to: ref('texture', 'rock'), field: 'textures.baseTexture' },
                { to: ref('texture', 'rockN'), field: 'textures.normalMap' },
            ]);
            expect(g.outgoing(K('material', 'stone'))).toEqual([
                { from: K('material', 'stone'), to: K('texture', 'rock'), field: 'textures.baseTexture' },
                { from: K('material', 'stone'), to: K('texture', 'rockN'), field: 'textures.normalMap' },
            ]);
        });

        it('builds the reverse index from the same edge objects', () => {
            chain(g);
            expect(g.incoming(K('texture', 'rock'))).toEqual([
                { from: K('material', 'stone'), to: K('texture', 'rock'), field: 'textures.baseTexture' },
            ]);
        });

        // The regression the "no incremental addEdge" rule exists for.
        it('drops a reference that a re-extract no longer reports', () => {
            g.setEdges(ref('material', 'stone'), [{ to: ref('texture', 'rock'), field: 'textures.baseTexture' }]);
            g.setEdges(ref('material', 'stone'), [{ to: ref('texture', 'sand'), field: 'textures.baseTexture' }]);

            expect(g.outgoing(K('material', 'stone')).map(e => e.to)).toEqual([K('texture', 'sand')]);
            expect(g.incoming(K('texture', 'rock'))).toEqual([]);
            expect(g.incoming(K('texture', 'sand'))).toHaveLength(1);
        });

        it('keeps one edge per (target, field) but two for the same target in two slots', () => {
            g.setEdges(ref('material', 'stone'), [
                { to: ref('texture', 'rock'), field: 'textures.baseTexture' },
                { to: ref('texture', 'rock'), field: 'textures.baseTexture' },
                { to: ref('texture', 'rock'), field: 'textures.emissiveMap' },
            ]);
            expect(g.outgoing(K('material', 'stone')).map(e => e.field))
                .toEqual(['textures.baseTexture', 'textures.emissiveMap']);
        });

        it('survives a self-edge being re-set', () => {
            g.setEdges(ref('template', 'crate'), [{ to: ref('template', 'crate'), field: '__templateId' }]);
            g.setEdges(ref('template', 'crate'), [{ to: ref('template', 'crate'), field: '__templateId' }]);
            expect(g.incoming(K('template', 'crate'))).toHaveLength(1);
        });

        it('ignores targets with no id', () => {
            g.setEdges(ref('material', 'stone'), [{ to: ref('texture', ''), field: 'textures.baseTexture' }]);
            expect(g.outgoing(K('material', 'stone'))).toEqual([]);
        });

        // An id may itself contain a colon: a texture id is a user-facing name.
        it('round-trips a ref whose id contains the key separator', () => {
            g.setEdges(ref('texture', 'rock:01'), []);
            expect(g.refOf(K('texture', 'rock:01'))).toEqual({ kind: 'texture', id: 'rock:01' });
        });
    });

    describe('traversal', () => {
        it('walks the whole dependency chain, nearest first', () => {
            chain(g);
            expect(g.dependencies(K('model', 'boulder'))).toEqual([
                K('material', 'stone'), K('texture', 'rock'), K('image', 'rock.png'),
            ]);
        });

        it('walks the whole dependent chain, nearest first', () => {
            chain(g);
            expect(g.dependents(K('image', 'rock.png'))).toEqual([
                K('texture', 'rock'), K('material', 'stone'), K('model', 'boulder'), K('scene', 'level1'),
            ]);
        });

        it('honours maxDepth', () => {
            chain(g);
            expect(g.dependents(K('image', 'rock.png'), 1)).toEqual([K('texture', 'rock')]);
            expect(g.dependents(K('image', 'rock.png'), 2)).toEqual([K('texture', 'rock'), K('material', 'stone')]);
            expect(g.dependents(K('image', 'rock.png'), 0)).toEqual([]);
        });

        it('excludes the start node', () => {
            chain(g);
            expect(g.dependents(K('texture', 'rock'))).not.toContain(K('texture', 'rock'));
        });

        // Without the visited set this hangs the editor rather than misreporting.
        it('terminates on a cycle', () => {
            g.setEdges(ref('a', '1'), [{ to: ref('b', '1'), field: 'f' }]);
            g.setEdges(ref('b', '1'), [{ to: ref('c', '1'), field: 'f' }]);
            g.setEdges(ref('c', '1'), [{ to: ref('a', '1'), field: 'f' }]);

            expect(g.dependencies(K('a', '1')).sort()).toEqual([K('b', '1'), K('c', '1')].sort());
            expect(g.dependents(K('a', '1')).sort()).toEqual([K('b', '1'), K('c', '1')].sort());
        });

        it('reports a diamond target once', () => {
            g.setEdges(ref('texture', 'rock'), []);
            g.setEdges(ref('material', 'a'), [{ to: ref('texture', 'rock'), field: 'textures.baseTexture' }]);
            g.setEdges(ref('material', 'b'), [{ to: ref('texture', 'rock'), field: 'textures.baseTexture' }]);
            g.setEdges(ref('model', 'm'), [
                { to: ref('material', 'a'), field: 'materialIds[0]' },
                { to: ref('material', 'b'), field: 'materialIds[1]' },
            ]);
            expect(g.dependents(K('texture', 'rock')).filter(k => k === K('model', 'm'))).toHaveLength(1);
        });
    });

    describe('revisions', () => {
        it('starts every asset at zero', () => {
            chain(g);
            expect(g.revisionOf(K('texture', 'rock'))).toBe(0);
        });

        it('bumps the origin and its whole dependent closure exactly once', () => {
            chain(g);
            const affected = g.touch(ref('image', 'rock.png'));

            expect(affected.map(r => `${r.kind}:${r.id}`)).toEqual([
                'image:rock.png', 'texture:rock', 'material:stone', 'model:boulder', 'scene:level1',
            ]);
            for (const key of ['image:rock.png', 'texture:rock', 'material:stone', 'model:boulder', 'scene:level1'])
                expect(g.revisionOf(key)).toBe(1);
        });

        it('leaves assets outside the closure alone', () => {
            chain(g);
            g.setEdges(ref('material', 'unrelated'), []);
            g.touch(ref('image', 'rock.png'));
            expect(g.revisionOf(K('material', 'unrelated'))).toBe(0);
        });

        it('does not bump dependencies — only dependents', () => {
            chain(g);
            g.touch(ref('material', 'stone'));
            expect(g.revisionOf(K('texture', 'rock'))).toBe(0);
            expect(g.revisionOf(K('model', 'boulder'))).toBe(1);
        });

        it('bumps a diamond dependent once, not once per path', () => {
            g.setEdges(ref('texture', 'rock'), []);
            g.setEdges(ref('material', 'a'), [{ to: ref('texture', 'rock'), field: 'f' }]);
            g.setEdges(ref('material', 'b'), [{ to: ref('texture', 'rock'), field: 'f' }]);
            g.setEdges(ref('model', 'm'), [
                { to: ref('material', 'a'), field: 'f' },
                { to: ref('material', 'b'), field: 'f' },
            ]);
            g.touch(ref('texture', 'rock'));
            expect(g.revisionOf(K('model', 'm'))).toBe(1);
        });

        it('announces the cascade as one ASSET_CHANGED', () => {
            chain(g);
            const seen: { origin: AssetRef; affected: AssetRef[] }[] = [];
            const listener = (p: { origin: AssetRef; affected: AssetRef[] }) => { seen.push(p); };
            engineEventBus.on('ASSET_CHANGED', listener);
            try {
                g.touch(ref('image', 'rock.png'));
            } finally {
                engineEventBus.off('ASSET_CHANGED', listener);
            }

            expect(seen).toHaveLength(1);
            expect(seen[0].origin).toEqual({ kind: 'image', id: 'rock.png' });
            expect(seen[0].affected).toHaveLength(5);
        });
    });

    describe('existence and dangling references', () => {
        it('distinguishes a declared node from a bare edge target', () => {
            g.setEdges(ref('material', 'stone'), [{ to: ref('texture', 'rock'), field: 'textures.baseTexture' }]);
            expect(g.has(K('material', 'stone'))).toBe(true);
            expect(g.has(K('texture', 'rock'))).toBe(false);
        });

        it('reports an edge to an undeclared asset as dangling', () => {
            g.setEdges(ref('material', 'stone'), [{ to: ref('texture', 'gone'), field: 'textures.baseTexture' }]);
            expect(g.dangling()).toEqual([
                { from: K('material', 'stone'), to: K('texture', 'gone'), field: 'textures.baseTexture' },
            ]);
        });

        it('reports nothing dangling once every target is declared', () => {
            chain(g);
            expect(g.dangling()).toEqual([]);
        });

        // The whole point: a delete must surface the break, not hide it.
        it('leaves incoming edges dangling when a referenced asset is removed', () => {
            chain(g);
            g.removeNode(ref('texture', 'rock'));

            expect(g.has(K('texture', 'rock'))).toBe(false);
            expect(g.incoming(K('texture', 'rock'))).toHaveLength(1);
            expect(g.dangling().map(e => e.from)).toEqual([K('material', 'stone')]);
        });

        it('unlinks the removed node from the assets IT referenced', () => {
            chain(g);
            g.removeNode(ref('material', 'stone'));
            expect(g.incoming(K('texture', 'rock'))).toEqual([]);
        });

        it('keeps the revision of a removed asset, so a re-import still reads as a change', () => {
            chain(g);
            g.touch(ref('texture', 'rock'));
            g.removeNode(ref('texture', 'rock'));
            expect(g.revisionOf(K('texture', 'rock'))).toBe(1);
        });
    });

    describe('clear', () => {
        it('drops every node, edge and revision', () => {
            chain(g);
            g.touch(ref('image', 'rock.png'));
            g.clear();

            expect(g.keys()).toEqual([]);
            expect(g.incoming(K('texture', 'rock'))).toEqual([]);
            expect(g.revisionOf(K('texture', 'rock'))).toBe(0);
            expect(g.dangling()).toEqual([]);
        });
    });
});
