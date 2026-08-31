import {
    UINode, UIRootNode, UITextNode, UIImageNode, UIButtonNode, UIProgressBarNode,
    UISliderNode, UIToggleNode, UITextInputNode, UIColor, TextureManager,
} from 'cleo';
import { clamp } from '../../utils/math';

/**
 * The imperative half of the game-UI renderer.
 *
 * React owns structure and re-renders only when the scene tree changes. Everything that moves — rects,
 * opacity, text, fill fractions — is written straight to the DOM from here, once per frame, skipping any
 * node whose `layoutVersion` / `contentVersion` has not moved.
 */

/** The DOM handles for one UI node. Sub-element refs are null for types that do not use them. */
export interface UIBinding {
    node: UINode;
    box: HTMLElement;
    /** Text span for a text/button/toggle label, kept separate so children are not clobbered. */
    label?: HTMLElement | null;
    image?: HTMLImageElement | null;
    /** Filled portion of a progress bar or slider. */
    fill?: HTMLElement | null;
    /** Slider knob. */
    knob?: HTMLElement | null;
    input?: HTMLInputElement | null;
    lastLayout: number;
    lastRevision: number;
}

export type UIRegistry = Map<string, UIBinding>;

/** `[r,g,b,a]` in 0..1 sRGB to a CSS colour. */
export function cssColor(c: UIColor | undefined): string {
    if (!c) return 'transparent';
    const to255 = (v: number) => Math.round(clamp(v, 0, 1) * 255);
    return `rgba(${to255(c[0])}, ${to255(c[1])}, ${to255(c[2])}, ${clamp(c[3], 0, 1)})`;
}

/**
 * Resolve a texture id to a URL an `<img>` can load. Returns '' for an unknown id rather than throwing,
 * so a texture that has not finished loading renders empty.
 */
export function textureSrc(id: string | null): string {
    if (!id) return '';
    const texture = TextureManager.Instance.getTexture(id);
    const data = texture?.data as HTMLImageElement | undefined;
    return data && typeof data.src === 'string' ? data.src : '';
}

/**
 * The CSS `display` a visible node should use. Only one sync path may write `display`: layout and content
 * run on independent version counters, so a second writer would reset a flex box on a layout-only frame.
 */
function displayFor(node: UINode): string {
    return (node instanceof UITextNode || node instanceof UIButtonNode || node instanceof UIToggleNode)
        ? 'flex' : 'block';
}

function applyBorder(style: CSSStyleDeclaration, node: UINode): void {
    style.borderRadius = node.borderRadius ? `${node.borderRadius}px` : '';
    style.border = node.borderWidth > 0 ? `${node.borderWidth}px solid ${cssColor(node.borderColor)}` : '';
}

/**
 * Write one node's resolved geometry to its element. Moves go through `transform: translate3d`, not
 * `left`/`top`, so the browser composites without a layout pass. `opacity` and `display` come from the
 * node's own values, never the resolved ones — the nested DOM already applies the ancestor chain.
 */
function syncLayout(binding: UIBinding, interactive: boolean, editorPick: boolean): void {
    const { node, box } = binding;
    const style = box.style;

    if (node instanceof UIRootNode) {
        // A root is positioned in real viewport pixels and carries the scale for its whole subtree;
        // descendants lay out in reference units underneath it.
        const rect = node.rect;
        style.width = `${rect.width}px`;
        style.height = `${rect.height}px`;
        style.transformOrigin = '0 0';
        const plane = node.planeMatrix;
        if (plane) {
            // Non-billboarded world UI: one homography places the whole quad, so it must be anchored at
            // the origin — left/top + scale would fight the matrix.
            style.left = '0';
            style.top = '0';
            style.transform = `matrix3d(${plane.join(',')})`;
        } else {
            style.left = `${node.origin.x}px`;
            style.top = `${node.origin.y}px`;
            style.transform = `scale(${node.scaleFactor})`;
        }
        style.display = node.visible && node.onScreen ? 'block' : 'none';
    } else {
        const rect = node.localRect;
        const [sx, sy] = node.scale2d;
        style.left = '0';
        style.top = '0';
        // A content-sized axis is left to the browser: the DOM owns that axis and reports back
        // (measureContent). The engine must not also dictate its size.
        const contentSized = node.sizing === 'content';
        const autoX = contentSized && node.anchorMin[0] === node.anchorMax[0];
        const autoY = contentSized && node.anchorMin[1] === node.anchorMax[1];
        style.width = autoX ? 'max-content' : `${rect.width}px`;
        style.height = autoY ? 'max-content' : `${rect.height}px`;
        let transform = `translate3d(${rect.x}px, ${rect.y}px, 0)`;
        if (node.rotationDeg) transform += ` rotate(${node.rotationDeg}deg)`;
        if (sx !== 1 || sy !== 1) transform += ` scale(${sx}, ${sy})`;
        style.transform = transform;
        style.transformOrigin = `${node.pivot[0] * 100}% ${node.pivot[1] * 100}%`;
        style.display = node.visible ? displayFor(node) : 'none';
    }

    style.opacity = String(node.opacity);
    style.zIndex = String(node.zOrder);
    style.overflow = node.clip ? 'hidden' : '';
    // Interactivity is opt-in per node so a HUD never swallows a click meant for the 3D scene; in the
    // editor everything is clickable, because there a click selects rather than activates.
    style.pointerEvents = editorPick || (interactive && node.interactive) ? 'auto' : 'none';
    style.padding = node.padding.some(v => v !== 0)
        ? `${node.padding[1]}px ${node.padding[2]}px ${node.padding[3]}px ${node.padding[0]}px`
        : '';
}

/**
 * Feed the browser's measurement of a content-sized element back to the engine. Necessarily one frame
 * behind. The 0.5px threshold is what makes the loop settle instead of oscillating on a sub-pixel
 * difference.
 */
function measureContent(binding: UIBinding): void {
    const { node, box } = binding;
    if (node.sizing !== 'content') return;
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    // offsetWidth is pre-transform layout px, so it is already in the root's reference units.
    const measured = node.measuredContentSize;
    if (Math.abs(w - measured[0]) > 0.5 || Math.abs(h - measured[1]) > 0.5)
        node.setMeasuredContentSize(w, h);
}

/** Write one node's type-specific content. Only runs when `revision` moved. */
function syncContent(binding: UIBinding): void {
    const { node, box } = binding;
    const style = box.style;

    if (node instanceof UIRootNode) return;

    if (node instanceof UITextNode) {
        if (binding.label && binding.label.textContent !== node.text) binding.label.textContent = node.text;
        style.color = cssColor(node.tint);
        style.fontSize = `${node.fontSize}px`;
        style.fontFamily = node.fontFamily || '';
        style.fontWeight = String(node.fontWeight);
        style.textAlign = node.align;
        style.lineHeight = String(node.lineHeight);
        style.whiteSpace = node.wrap ? 'normal' : 'nowrap';
        style.alignItems = node.vAlign === 'top' ? 'flex-start' : node.vAlign === 'bottom' ? 'flex-end' : 'center';
        style.justifyContent = node.align === 'left' ? 'flex-start' : node.align === 'right' ? 'flex-end' : 'center';
        return;
    }

    if (node instanceof UIImageNode) {
        if (binding.image) {
            const src = textureSrc(node.textureId);
            if (binding.image.getAttribute('src') !== src) binding.image.setAttribute('src', src);
            binding.image.style.objectFit = node.fit === 'tile' ? 'fill' : node.fit;
            binding.image.style.width = '100%';
            binding.image.style.height = '100%';
            // An image's tint contributes its alpha only; CSS cannot multiply by an arbitrary colour.
            binding.image.style.opacity = String(node.tint[3]);
        }
        applyBorder(style, node);
        return;
    }

    if (node instanceof UIButtonNode) {
        if (binding.label && binding.label.textContent !== node.label) binding.label.textContent = node.label;
        style.background = cssColor(node.disabled ? node.disabledTint : node.tint);
        style.cursor = node.disabled ? 'not-allowed' : 'pointer';
        style.alignItems = 'center';
        style.justifyContent = 'center';
        style.color = '#fff';
        applyBorder(style, node);
        return;
    }

    if (node instanceof UIProgressBarNode) {
        style.background = cssColor(node.tint);
        applyBorder(style, node);
        if (binding.fill) {
            const f = node.fraction;
            const fs = binding.fill.style;
            fs.background = cssColor(node.fillTint);
            fs.position = 'absolute';
            fs.borderRadius = 'inherit';
            // The fill grows from whichever edge the direction names.
            const horizontal = node.direction === 'ltr' || node.direction === 'rtl';
            fs.width = horizontal ? `${f * 100}%` : '100%';
            fs.height = horizontal ? '100%' : `${f * 100}%`;
            fs.left = node.direction === 'rtl' ? 'auto' : '0';
            fs.right = node.direction === 'rtl' ? '0' : 'auto';
            fs.top = node.direction === 'btt' ? 'auto' : '0';
            fs.bottom = node.direction === 'btt' ? '0' : 'auto';
        }
        return;
    }

    if (node instanceof UISliderNode) {
        style.background = cssColor(node.tint);
        applyBorder(style, node);
        const f = node.fraction;
        if (binding.fill) {
            const fs = binding.fill.style;
            fs.background = cssColor(node.fillTint);
            fs.position = 'absolute';
            fs.left = '0';
            fs.bottom = '0';
            fs.width = node.vertical ? '100%' : `${f * 100}%`;
            fs.height = node.vertical ? `${f * 100}%` : '100%';
            fs.borderRadius = 'inherit';
        }
        if (binding.knob) {
            const ks = binding.knob.style;
            ks.background = cssColor(node.handleTint);
            ks.position = 'absolute';
            ks.width = ks.height = '14px';
            ks.borderRadius = '50%';
            ks.pointerEvents = 'none';
            if (node.vertical) { ks.left = '50%'; ks.bottom = `calc(${f * 100}% - 7px)`; ks.transform = 'translateX(-50%)'; }
            else { ks.top = '50%'; ks.left = `calc(${f * 100}% - 7px)`; ks.transform = 'translateY(-50%)'; }
        }
        style.cursor = 'pointer';
        return;
    }

    if (node instanceof UIToggleNode) {
        style.background = cssColor(node.checked ? node.onTint : node.offTint);
        style.alignItems = 'center';
        style.gap = '6px';
        style.color = '#fff';
        style.cursor = 'pointer';
        applyBorder(style, node);
        if (binding.label && binding.label.textContent !== node.label) binding.label.textContent = node.label;
        if (binding.knob) {
            const ks = binding.knob.style;
            ks.width = ks.height = '12px';
            ks.flex = '0 0 auto';
            ks.borderRadius = '2px';
            ks.background = node.checked ? '#fff' : 'rgba(255,255,255,0.35)';
        }
        return;
    }

    if (node instanceof UITextInputNode) {
        style.background = cssColor(node.tint);
        applyBorder(style, node);
        if (binding.input) {
            // Never write the field while it is focused: that moves the caret to the end on every
            // keystroke.
            if (document.activeElement !== binding.input && binding.input.value !== node.value)
                binding.input.value = node.value;
            binding.input.placeholder = node.placeholder;
            binding.input.readOnly = node.readOnly;
            binding.input.type = node.password ? 'password' : 'text';
            const is = binding.input.style;
            is.width = '100%';
            is.height = '100%';
            is.border = 'none';
            is.outline = 'none';
            is.background = 'transparent';
            is.fontSize = `${node.fontSize}px`;
            is.padding = '0 6px';
        }
        return;
    }

    style.background = cssColor(node.tint);
    applyBorder(style, node);
}

/** Reused across frames so the batched measure pass allocates nothing. */
const pendingMeasure: UIBinding[] = [];

/**
 * Push one frame of resolved layout and content into the DOM.
 *
 * @param force Re-write every binding regardless of version; needed after a structural re-render has
 *   produced elements no version counter knows about yet.
 */
export function syncUI(
    registry: UIRegistry,
    interactive: boolean,
    force: boolean = false,
    editorPick: boolean = false,
): void {
    for (const binding of registry.values()) {
        const { node } = binding;
        // A node removed from the scene between the last React commit and this frame still has a binding.
        if (!node.scene && !force) continue;

        // `revision` moves on an authored change and drives both paths; `layoutVersion` moves when the
        // solve produced different geometry and drives the layout path only.
        const revision = node.revision;
        const layoutVersion = node.layoutVersion;
        const authored = force || revision !== binding.lastRevision;

        if (authored || layoutVersion !== binding.lastLayout) {
            syncLayout(binding, interactive, editorPick);
            binding.lastLayout = layoutVersion;
        }
        if (authored) {
            syncContent(binding);
            binding.lastRevision = revision;
        }

        if (node.sizing === 'content') pendingMeasure.push(binding);
    }

    // Measurements must come after every write, never interleaved: reading `offsetWidth` flushes pending
    // layout, so measuring inside the loop above is one forced reflow per content-sized element.
    // Unconditional, because a font load or container reflow resizes content without moving a counter.
    for (const binding of pendingMeasure) measureContent(binding);
    pendingMeasure.length = 0;
}
