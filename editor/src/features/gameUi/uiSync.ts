import {
    UINode, UIRootNode, UITextNode, UIImageNode, UIButtonNode, UIProgressBarNode,
    UISliderNode, UIToggleNode, UITextInputNode, UIColor, TextureManager,
} from 'cleo';

/**
 * The imperative half of the game-UI renderer.
 *
 * React owns STRUCTURE (which elements exist, of what type, under which parent) and re-renders only when
 * the scene tree changes. Everything that moves — rects, opacity, text, fill fractions — is written
 * straight to the DOM from here, once per frame, skipping any node whose `layoutVersion` /
 * `contentVersion` has not moved.
 *
 * That split is load-bearing, not an optimisation. A `setState` per frame over a two-hundred-element HUD
 * re-reconciles the whole tree every frame and costs more than the renderer does; the version counters
 * mean a settled HUD writes nothing at all.
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
    const to255 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
    return `rgba(${to255(c[0])}, ${to255(c[1])}, ${to255(c[2])}, ${Math.max(0, Math.min(1, c[3]))})`;
}

/**
 * Resolve a texture id to something an `<img>` can load.
 *
 * `Texture.data` is the decoded `HTMLImageElement` the engine uploaded from, so its `src` is already a
 * URL (object URL or data URI) the browser can reuse with no second decode. Returns '' for an unknown id
 * rather than throwing — a UI image whose texture has not finished loading should render empty, not take
 * the frame down.
 */
export function textureSrc(id: string | null): string {
    if (!id) return '';
    const texture = TextureManager.Instance.getTexture(id);
    const data = texture?.data as HTMLImageElement | undefined;
    return data && typeof data.src === 'string' ? data.src : '';
}

/**
 * The CSS `display` a visible node should use.
 *
 * Centralised because layout and content are synced on independent version counters: if both wrote
 * `display`, a layout-only frame would reset a flex box to block and silently drop its alignment.
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
 * Write one node's resolved geometry to its element.
 *
 * Uses `transform: translate3d` rather than `left`/`top` so the browser can composite the move without a
 * layout pass — with a HUD that follows a moving target this is the difference between a free frame and a
 * full reflow of the overlay.
 *
 * `opacity` and `display` are written from the node's OWN values, not the resolved ones: the DOM is
 * nested, so the browser already multiplies opacity and hides descendants of a hidden ancestor. Writing
 * the resolved values would apply the ancestor chain twice.
 */
function syncLayout(binding: UIBinding, interactive: boolean, editorPick: boolean): void {
    const { node, box } = binding;
    const style = box.style;

    if (node instanceof UIRootNode) {
        // A root is positioned in real viewport pixels and carries the single scale for its whole
        // subtree; its descendants then lay out in reference units underneath it.
        const rect = node.rect;
        style.width = `${rect.width}px`;
        style.height = `${rect.height}px`;
        style.transformOrigin = '0 0';
        const plane = node.planeMatrix;
        if (plane) {
            // Non-billboarded world UI: one homography places the whole quad, so the usual
            // left/top + scale would fight it. Anchored at the origin and let the matrix do everything.
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
        // A content-sized axis is left to the browser: the element cannot be measured while the engine is
        // also dictating its size, so the DOM owns that axis and reports back (see measureContent).
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
    // Interactivity is opt-in per node so a HUD never swallows a click meant for the 3D scene. In the
    // editor everything is clickable regardless, because there the click SELECTS rather than activates —
    // a panel with `interactive: false` still has to be selectable by clicking it.
    style.pointerEvents = editorPick || (interactive && node.interactive) ? 'auto' : 'none';
    style.padding = node.padding.some(v => v !== 0)
        ? `${node.padding[1]}px ${node.padding[2]}px ${node.padding[3]}px ${node.padding[0]}px`
        : '';
}

/**
 * Feed the browser's measurement of a content-sized element back to the engine.
 *
 * Necessarily one frame behind: the measurement is the result of the layout that this very call will feed
 * into, so it cannot exist any earlier. The 0.5px threshold is what makes that loop settle rather than
 * oscillate forever on a sub-pixel difference — without it every content-sized element re-writes its
 * styles on every frame.
 */
function measureContent(binding: UIBinding): void {
    const { node, box } = binding;
    if (node.sizing !== 'content') return;
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    // offsetWidth is pre-transform layout px, so it is already in the root's reference units and needs no
    // compensation for the root's scale.
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
            // CSS cannot multiply an image by an arbitrary colour without a filter matrix, so an image's
            // tint contributes its ALPHA only. Documented rather than silently ignored; use a coloured
            // panel behind a white sprite for a real tint.
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
            // The fill grows from whichever edge the direction names, so a right-to-left bar drains the
            // way a fuel gauge does rather than jumping.
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
            // Never clobber the field while the user is typing in it: React-style controlled updates on a
            // focused input move the caret to the end on every keystroke.
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

    // Panel, stack, spacer: the box itself is the whole element.
    style.background = cssColor(node.tint);
    applyBorder(style, node);
}

/**
 * Push one frame of resolved layout and content into the DOM.
 *
 * `force` re-writes every binding regardless of version, which the editor needs after a structural
 * re-render has produced brand-new elements that no version counter knows about yet.
 */
/** Reused across frames so the batched measure pass allocates nothing. */
const pendingMeasure: UIBinding[] = [];

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

        // Two counters, two reasons to re-write. `revision` moves when the user (or a script) authored
        // something, and touches BOTH paths because an authored property can land in either. `layoutVersion`
        // moves when the solve produced different geometry, which only the layout path cares about — that
        // split is what keeps a world-space label (whose transform changes every frame) from also
        // re-writing every colour and string it owns, sixty times a second.
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

    // Measurements happen AFTER every write, never interleaved with them. Reading `offsetWidth` forces the
    // browser to flush pending layout, so measuring inside the loop above would mean one forced reflow per
    // content-sized element per frame — the classic layout-thrash. Batched like this it is one flush total.
    //
    // Unconditional (rather than gated on a version) because a content-sized element also changes size when
    // its font finishes loading or its container reflows, and neither of those moves a counter.
    for (const binding of pendingMeasure) measureContent(binding);
    pendingMeasure.length = 0;
}
