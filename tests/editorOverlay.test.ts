import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Node } from '../src/core/scene/nodes/node';
import { isEditorOnlyNode, markEditorOnly } from '../src/core/scene/editorNodes';
import { DEFAULT_BLEND, OVERLAY_BLEND, OVERLAY_COMPOSITE_BLEND } from '../src/graphics/rhi/types';

/**
 * The editor overlay layer: grid, gizmos, helper wireframes and helper icons are drawn into a buffer
 * of their own and composited AFTER the post chain, so none of them can bloom, throw a lens-flare
 * ghost, blur into depth of field or move the auto-exposure meter.
 *
 * Two halves are worth pinning, because both failed silently when they were wrong:
 *   * WHICH nodes are chrome. The obvious test — an `__editor__` name — is the wrong one.
 *   * WHERE those draws land. A pass retargeted back at `_sceneFBO` puts the chrome straight back
 *     into the post chain, and looks completely normal until someone turns bloom up.
 */

const RENDERER = readFileSync(join(__dirname, '../src/graphics/renderer.ts'), 'utf8');

describe('the chrome predicate', () => {
    it('is opt-in, not derived from the name', () => {
        // The regression this exists for. `__editor__` means "hidden from the tree and from
        // serialization", which also covers the animation editor's lit ground plane and the preview
        // skybox — real geometry that must stay in the image the post chain grades. A name test would
        // strip both from the G-buffer and punch a hole in every asset thumbnail.
        expect(isEditorOnlyNode(new Node('__editor__ground'))).toBe(false);
        expect(isEditorOnlyNode(new Node('__debug__body_7'))).toBe(false);
    });

    it('accepts the flag and the legacy gizmo duck-type', () => {
        const marked = new Node('collider');
        markEditorOnly(marked);
        expect(isEditorOnlyNode(marked)).toBe(true);

        const gizmo = new Node('__editor__gizmo__x_axis');
        (gizmo as any).isGizmo = true;
        expect(isEditorOnlyNode(gizmo)).toBe(true);
    });

    it('marks a whole subtree, because helpers are groups of wireframes', () => {
        const group = new Node('__debug__body_1');
        const shape = new Node('__debug__shape_0');
        const nested = new Node('__debug__shape_0_child');
        shape.addChild(nested);
        group.addChild(shape);
        markEditorOnly(group);
        for (const node of [group, shape, nested]) expect(isEditorOnlyNode(node)).toBe(true);

        markEditorOnly(group, false);
        for (const node of [group, shape, nested]) expect(isEditorOnlyNode(node)).toBe(false);
    });
});

describe('the overlay blend presets', () => {
    // The overlay buffer is NOT the scene buffer, so the bloom-mask contract does not apply to it:
    // its alpha is coverage and every draw has to accumulate some. `DEFAULT_BLEND` here would leave
    // alpha at the cleared zero and the whole layer would composite invisibly — which is exactly the
    // failure mode, and it looks like "the grid disappeared" rather than like a blend bug.
    it('accumulates coverage alpha, unlike the scene default', () => {
        expect(OVERLAY_BLEND.alpha).toEqual(
            { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' });
        expect(OVERLAY_BLEND.alpha).not.toEqual(DEFAULT_BLEND.alpha);
        expect(OVERLAY_BLEND.color).toEqual(DEFAULT_BLEND.color);
    });

    it('composites premultiplied, matching what the shader emits', () => {
        // overlayComposite.wgsl returns `toSrgb(rgb / a) * a`, so the source factor is `one`.
        expect(OVERLAY_COMPOSITE_BLEND.color.srcFactor).toBe('one');
        expect(OVERLAY_COMPOSITE_BLEND.color.dstFactor).toBe('one-minus-src-alpha');
    });
});

describe('where the chrome passes draw', () => {
    /** The body of a renderer method, up to the next top-level `private`/`public` member. */
    const bodyOf = (name: string): string => {
        const at = RENDERER.indexOf(`private ${name}(`);
        expect(at, `${name} not found`).toBeGreaterThan(-1);
        const rest = RENDERER.slice(at);
        const end = rest.indexOf('\n    private ', 1);
        return end === -1 ? rest : rest.slice(0, end);
    };

    it('opens every chrome pass on the overlay target, never the scene buffer', () => {
        for (const name of ['_renderGrid', '_renderGizmos']) {
            const body = bodyOf(name);
            expect(body, `${name} must use _beginOverlayPass`).toContain('_beginOverlayPass(');
            // The leak this whole feature closes: `compose` copies `_sceneFBO` into the post chain.
            expect(body, `${name} must not target _sceneFBO`).not.toContain('_sceneFBO.renderTarget');
        }
        expect(bodyOf('_renderEditorOverlay')).toContain("_beginOverlayPass('overlay.helpers')");
    });

    it('keeps the composite past the display resolve', () => {
        // `present` is the last chain node; the overlay node is added after it, and passes keep the
        // order they were added in. Reordering these two would tonemap and grade the chrome.
        const graph = RENDERER.indexOf("id: 'present'");
        const overlay = RENDERER.indexOf("id: 'overlay'");
        expect(graph).toBeGreaterThan(-1);
        expect(overlay).toBeGreaterThan(graph);
        // It resolves to the screen with clear=false: a second pass over what `present` just wrote.
        expect(bodyOf('_overlayCompositePass')).toContain("this._screenTarget(), 'overlay.composite', false");
    });

    it('leaves the chrome out of the G-buffer and the depth snapshot', () => {
        expect(bodyOf('_inGBuffer')).toContain('isEditorOnlyNode(node)');
    });

    it('never writes the depth attachment it borrows from the scene', () => {
        // `_overlayTarget` attaches `_sceneFBO.depth`, which game sprites are still tested against
        // further down the frame. A gizmo that wrote depth there would occlude them — it used to.
        for (const name of ['_renderGizmos', '_renderEditorOverlay'])
            expect(bodyOf(name)).not.toContain('depthWriteEnabled: true');
    });
});
