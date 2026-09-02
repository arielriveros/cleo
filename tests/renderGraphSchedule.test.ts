import { describe, it, expect } from 'vitest';
import { RenderGraphBuilder, RenderGraphError } from '../src/graphics/renderGraph/graph';
import type { ResourceDesc } from '../src/graphics/renderGraph/resources';

/**
 * The scheduler's job is to refuse an order that cannot run.
 *
 * That matters because the feature it exists for is letting a user REORDER the post chain, and every
 * ordering constraint in the renderer today is a prose comment. A chain that reads a buffer nothing
 * has filled does not throw on either backend: the framebuffer keeps whatever was in it, so the frame
 * renders with last frame's bloom, or with uninitialized memory, and looks merely odd rather than
 * broken. The renderer already carries a family of `_xProducedThisFrame` booleans for exactly this
 * failure — this is the same guard, made general.
 *
 * Pure: the graph is generic over its physical resource type, so these tests instantiate it with
 * strings and need no GL context.
 */

const TRANSIENT: Omit<ResourceDesc, 'name'> = {
    size: { kind: 'render' },
    format: 'rgba16float',
    colorAttachments: 1,
    depth: false,
    lifetime: 'transient',
};

const IMPORTED: Omit<ResourceDesc, 'name'> = { ...TRANSIENT, lifetime: 'imported' };

/** A pass that touches nothing, for order assertions. */
function noop() { /* nothing to record */ }

describe('render graph scheduling', () => {
    it('runs passes in the order they were added', () => {
        const graph = new RenderGraphBuilder<string>();
        const a = graph.declare({ ...TRANSIENT, name: 'a' });
        graph.addPass({ id: 'first', scope: 'bloom', writes: [a], execute: noop });
        graph.addPass({ id: 'second', scope: 'chromatic', reads: [a], execute: noop });
        graph.addPass({ id: 'third', scope: 'present', reads: [a], execute: noop });

        expect(graph.compile(64, 64).order).toEqual(['first', 'second', 'third']);
    });

    it('refuses a read of a declared resource nothing has written yet', () => {
        const graph = new RenderGraphBuilder<string>();
        const scene = graph.declare({ ...TRANSIENT, name: 'scene' });
        graph.addPass({ id: 'reader', scope: 'bloom', reads: [scene], execute: noop });

        expect(() => graph.compile(64, 64)).toThrow(RenderGraphError);
        expect(() => graph.compile(64, 64)).toThrow(/reads 'scene' before any pass writes it/);
    });

    it('accepts a read of an IMPORTED resource with no producer inside the graph', () => {
        // The scene buffer is filled by the imperative scene render, which the graph never sees. If
        // this were treated as a missing producer, nothing in the post chain could read the image.
        const graph = new RenderGraphBuilder<string>();
        const scene = graph.importResource({ ...IMPORTED, name: 'scene' }, 'sceneFBO');
        graph.addPass({ id: 'compose', scope: 'present', reads: [scene], execute: noop });

        expect(() => graph.compile(64, 64)).not.toThrow();
    });

    it('refuses a pass that names one resource twice', () => {
        const graph = new RenderGraphBuilder<string>();
        const a = graph.declare({ ...TRANSIENT, name: 'a' });
        expect(() => graph.addPass({ id: 'p', scope: 'bloom', reads: [a], writes: [a], execute: noop }))
            .toThrow(/names 'a' more than once/);
    });

    it('refuses a pass that names a resource that does not exist', () => {
        const graph = new RenderGraphBuilder<string>();
        expect(() => graph.addPass({ id: 'p', scope: 'bloom', reads: [7 as never], execute: noop }))
            .toThrow(/does not exist/);
    });

    it('refuses two resources with the same name', () => {
        // The name is the pool's key for a persistent resource, so a duplicate would make one of the
        // two silently unreachable rather than merely confusing.
        const graph = new RenderGraphBuilder<string>();
        graph.declare({ ...TRANSIENT, name: 'compose' });
        expect(() => graph.declare({ ...TRANSIENT, name: 'compose' })).toThrow(/duplicate resource name/);
    });

    it('refuses declare() for an imported descriptor, and importResource() for a declared one', () => {
        const graph = new RenderGraphBuilder<string>();
        expect(() => graph.declare({ ...IMPORTED, name: 'x' })).toThrow(/use importResource/);
        expect(() => graph.importResource({ ...TRANSIENT, name: 'y' }, 'fb')).toThrow(/use declare/);
    });
});

describe('render graph pass context', () => {
    it('hands a pass the storage it declared', () => {
        const graph = new RenderGraphBuilder<string>();
        const scene = graph.importResource({ ...IMPORTED, name: 'scene' }, 'sceneFBO');
        const out = graph.declare({ ...TRANSIENT, name: 'out' });
        let sawRead = '';
        let sawWrite = '';
        graph.addPass({
            id: 'copy', scope: 'present', reads: [scene], writes: [out],
            execute: ctx => { sawRead = ctx.read(scene); sawWrite = ctx.target(out); },
        });

        graph.compile(64, 64).execute({
            transient: slot => `slot${slot}`,
            persistent: name => `persist:${name}`,
        });

        expect(sawRead).toBe('sceneFBO');
        expect(sawWrite).toBe('slot0');
    });

    it('throws when a pass touches a resource it did not declare', () => {
        // This is the assertion that replaces the comments. A pass that quietly reaches for another
        // pass's buffer is exactly how the god-ray scratch buffer became reusable-by-argument.
        const graph = new RenderGraphBuilder<string>();
        const a = graph.declare({ ...TRANSIENT, name: 'a' });
        const b = graph.declare({ ...TRANSIENT, name: 'b' });
        graph.addPass({ id: 'writeA', scope: 'bloom', writes: [a], execute: noop });
        graph.addPass({ id: 'writeB', scope: 'chromatic', writes: [b], execute: ctx => { ctx.read(a); } });

        expect(() => graph.compile(64, 64).execute({
            transient: slot => `slot${slot}`,
            persistent: name => name,
        })).toThrow(/pass 'writeB' reads 'a' without declaring it/);
    });

    it('skips a pass whose scope is switched off, without running it', () => {
        // The profiler kill switch has to skip the pass AND its timing together — a switched-off pass
        // that is still timed reports a row nobody can explain.
        const graph = new RenderGraphBuilder<string>();
        const a = graph.declare({ ...TRANSIENT, name: 'a' });
        const ran: string[] = [];
        graph.addPass({ id: 'on', scope: 'bloom', writes: [a], execute: () => { ran.push('on'); } });
        graph.addPass({ id: 'off', scope: 'chromatic', reads: [a], execute: () => { ran.push('off'); } });

        graph.compile(64, 64).execute(
            { transient: slot => `slot${slot}`, persistent: name => name },
            scope => scope !== 'chromatic',
        );

        expect(ran).toEqual(['on']);
    });
});
