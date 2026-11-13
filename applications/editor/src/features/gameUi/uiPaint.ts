import {
    UINode, UIRootNode, UITextNode, UIImageNode, UIButtonNode, UIProgressBarNode, UISliderNode, UIToggleNode,
    UITextInputNode, TextureManager,
} from 'cleo';
import type { UIColor } from 'cleo';
import { cssColor } from './uiSync';

/**
 * The game UI painted onto a 2D canvas, for a movie frame (features/sequencer/movie/).
 *
 * In the game the UI is DOM over the canvas (UILayer.tsx, uiSync.ts), so a frame read back from the renderer
 * has none of it: no captions, no letterbox, no fade. This paints the same nodes the same way the DOM lays
 * them out, from the same solved layout — the root's origin and scale, each box's local rect, pivot, rotation
 * and scale, siblings in z order, padding, borders and corner radii, clipping, group opacity, tints, images
 * by their fit, and text with its font, weight, alignment, line height, letter spacing and wrapping — at the
 * movie's own resolution rather than the editor viewport's.
 *
 * Mirrors syncLayout/syncContent: a change to how the DOM draws a node belongs in both. A world-space root
 * placed through a perspective plane matrix is the one thing a 2D canvas cannot draw (it is affine only);
 * it is left out, once with a warning.
 */

export interface UIPaintOptions {
    /** The font a node with no family of its own inherits (the page's, as the DOM layer would). */
    defaultFamily: string;
    /** The font size a button, toggle or input label inherits, in px. */
    defaultFontSize: number;
    /** Called once per root left out (a perspective world-space root). */
    onSkipped?: (root: UIRootNode, why: string) => void;
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Top-level roots, as UILayer renders them: a root nested in another is drawn by its parent's walk. */
export function topLevelRoots(roots: Iterable<UIRootNode>): UIRootNode[] {
    return [...roots].filter(root => {
        for (let p = root.parent; p; p = p.parent) if (p instanceof UIRootNode) return false;
        return true;
    });
}

/** Siblings in paint order: z order, then tree order (CSS: every box is its own stacking context). */
function paintOrder(nodes: readonly UINode[]): UINode[] {
    return nodes.map((node, i) => ({ node, i })).sort((a, b) => a.node.zOrder - b.node.zOrder || a.i - b.i).map(e => e.node);
}

const DEG = Math.PI / 180;

/** Paint every root of `roots` onto `ctx` (already holding the 3D frame), in z order. */
export function paintUI(ctx: Ctx, roots: Iterable<UIRootNode>, options: UIPaintOptions): void {
    const top = paintOrder(topLevelRoots(roots)) as UIRootNode[];
    for (const root of top) paintRoot(ctx, root, options);
}

function paintRoot(ctx: Ctx, root: UIRootNode, o: UIPaintOptions): void {
    if (!root.visible || !root.onScreen) return;
    if (root.planeMatrix) { o.onSkipped?.(root, 'a world-space panel seen in perspective cannot be drawn into a movie frame'); return; }
    ctx.save();
    ctx.translate(root.origin.x, root.origin.y);
    ctx.scale(root.scaleFactor, root.scaleFactor);
    withOpacity(ctx, root.opacity, root.uiChildren.length > 1, c => {
        if (root.clip) { c.beginPath(); c.rect(0, 0, root.rect.width, root.rect.height); c.clip(); }
        for (const child of paintOrder(root.uiChildren)) paintNode(c, child, o);
    });
    ctx.restore();
}

function paintNode(ctx: Ctx, node: UINode, o: UIPaintOptions): void {
    if (node instanceof UIRootNode) { paintRoot(ctx, node, o); return; }
    if (!node.visible) return;
    const r = node.localRect;
    const w = r.width, h = r.height;
    const [sx, sy] = node.scale2d;
    const ox = node.pivot[0] * w, oy = node.pivot[1] * h;
    ctx.save();
    // CSS: transform-origin at the pivot, then translate, rotate, scale.
    ctx.translate(ox + r.x, oy + r.y);
    if (node.rotationDeg) ctx.rotate(node.rotationDeg * DEG);
    if (sx !== 1 || sy !== 1) ctx.scale(sx, sy);
    ctx.translate(-ox, -oy);
    withOpacity(ctx, node.opacity, node.uiChildren.length > 0, c => {
        drawBox(c, node, w, h, o);
        const bw = hasBorder(node) ? node.borderWidth : 0;
        if (node.clip) {
            // overflow: hidden clips to the padding box, rounded with the corners.
            c.beginPath();
            roundRect(c, bw, bw, Math.max(0, w - 2 * bw), Math.max(0, h - 2 * bw), Math.max(0, node.borderRadius - bw));
            c.clip();
        }
        // Absolutely positioned children sit in the padding box: inside the border, ignoring padding.
        if (bw) c.translate(bw, bw);
        for (const child of paintOrder(node.uiChildren)) paintNode(c, child, o);
    });
    ctx.restore();
}

/**
 * Run `paint` at `opacity`. CSS opacity is GROUP opacity: a box and everything in it are composited first and
 * faded as one, so where two children overlap the back one does not show through. With more than one thing
 * to draw that needs a layer; a lone box is the same as a plain alpha.
 */
function withOpacity(ctx: Ctx, opacity: number, needsLayer: boolean, paint: (ctx: Ctx) => void): void {
    const a = Math.min(1, Math.max(0, opacity));
    if (a <= 0) return;
    if (a >= 1) { paint(ctx); return; }
    if (!needsLayer) {
        ctx.save();
        ctx.globalAlpha *= a;
        paint(ctx);
        ctx.restore();
        return;
    }
    const canvas = ctx.canvas as HTMLCanvasElement | OffscreenCanvas;
    const layer = new OffscreenCanvas(canvas.width, canvas.height);
    const lctx = layer.getContext('2d')!;
    lctx.setTransform(ctx.getTransform());
    paint(lctx);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha *= a;
    ctx.drawImage(layer, 0, 0);
    ctx.restore();
}

/** Which node kinds draw the border (uiSync's applyBorder callers). */
function hasBorder(node: UINode): boolean {
    return !(node instanceof UITextNode) && node.borderWidth > 0;
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, radius: number): void {
    const rr = Math.min(radius, w / 2, h / 2);
    if (rr > 0 && typeof (ctx as CanvasRenderingContext2D).roundRect === 'function') (ctx as CanvasRenderingContext2D).roundRect(x, y, w, h, rr);
    else ctx.rect(x, y, w, h);
}

function fill(ctx: Ctx, color: UIColor | undefined, w: number, h: number, radius: number): void {
    if (!color || color[3] <= 0) return;
    ctx.fillStyle = cssColor(color);
    ctx.beginPath();
    roundRect(ctx, 0, 0, w, h, radius);
    ctx.fill();
}

function stroke(ctx: Ctx, node: UINode, w: number, h: number): void {
    const bw = node.borderWidth;
    if (!(bw > 0)) return;
    ctx.strokeStyle = cssColor(node.borderColor);
    ctx.lineWidth = bw;
    ctx.beginPath();
    roundRect(ctx, bw / 2, bw / 2, Math.max(0, w - bw), Math.max(0, h - bw), Math.max(0, node.borderRadius - bw / 2));
    ctx.stroke();
}

/** The content box: inside the border and the padding ([left, top, right, bottom]). */
function contentBox(node: UINode, w: number, h: number): { x: number; y: number; w: number; h: number } {
    const bw = hasBorder(node) ? node.borderWidth : 0;
    const [pl, pt, pr, pb] = node.padding;
    return { x: bw + pl, y: bw + pt, w: Math.max(0, w - 2 * bw - pl - pr), h: Math.max(0, h - 2 * bw - pt - pb) };
}

function drawBox(ctx: Ctx, node: UINode, w: number, h: number, o: UIPaintOptions): void {
    const radius = node.borderRadius;
    if (node instanceof UITextNode) {
        drawText(ctx, node.text, contentBox(node, w, h), {
            family: node.fontFamily || o.defaultFamily, size: node.fontSize, weight: node.fontWeight,
            color: cssColor(node.tint), align: node.align, vAlign: node.vAlign, lineHeight: node.lineHeight,
            letterSpacing: node.letterSpacing, wrap: node.wrap,
        });
        return;
    }
    if (node instanceof UIImageNode) {
        drawImage(ctx, node, contentBox(node, w, h));
        stroke(ctx, node, w, h);
        return;
    }
    if (node instanceof UIButtonNode) {
        fill(ctx, node.disabled ? node.disabledTint : node.tint, w, h, radius);
        stroke(ctx, node, w, h);
        drawText(ctx, node.label, contentBox(node, w, h), {
            family: o.defaultFamily, size: o.defaultFontSize, weight: 400, color: '#fff', align: 'center', vAlign: 'center',
            lineHeight: 1.2, letterSpacing: 0, wrap: false,
        });
        return;
    }
    if (node instanceof UIProgressBarNode) {
        fill(ctx, node.tint, w, h, radius);
        const f = Math.min(1, Math.max(0, node.fraction));
        const horizontal = node.direction === 'ltr' || node.direction === 'rtl';
        const fw = horizontal ? w * f : w, fh = horizontal ? h : h * f;
        const fx = node.direction === 'rtl' ? w - fw : 0, fy = node.direction === 'btt' ? h - fh : 0;
        ctx.save();
        ctx.beginPath(); roundRect(ctx, 0, 0, w, h, radius); ctx.clip();
        ctx.fillStyle = cssColor(node.fillTint);
        ctx.fillRect(fx, fy, fw, fh);
        ctx.restore();
        stroke(ctx, node, w, h);
        return;
    }
    if (node instanceof UISliderNode) {
        fill(ctx, node.tint, w, h, radius);
        const f = Math.min(1, Math.max(0, node.fraction));
        ctx.save();
        ctx.beginPath(); roundRect(ctx, 0, 0, w, h, radius); ctx.clip();
        ctx.fillStyle = cssColor(node.fillTint);
        if (node.vertical) ctx.fillRect(0, h * (1 - f), w, h * f); else ctx.fillRect(0, 0, w * f, h);
        ctx.restore();
        stroke(ctx, node, w, h);
        ctx.fillStyle = cssColor(node.handleTint);
        ctx.beginPath();
        if (node.vertical) ctx.arc(w / 2, h * (1 - f), 7, 0, Math.PI * 2); else ctx.arc(w * f, h / 2, 7, 0, Math.PI * 2);
        ctx.fill();
        return;
    }
    if (node instanceof UIToggleNode) {
        fill(ctx, node.checked ? node.onTint : node.offTint, w, h, radius);
        stroke(ctx, node, w, h);
        const box = contentBox(node, w, h);
        const ky = box.y + (box.h - 12) / 2;
        ctx.fillStyle = node.checked ? '#fff' : 'rgba(255,255,255,0.35)';
        ctx.beginPath(); roundRect(ctx, box.x, ky, 12, 12, 2); ctx.fill();
        drawText(ctx, node.label, { x: box.x + 18, y: box.y, w: Math.max(0, box.w - 18), h: box.h }, {
            family: o.defaultFamily, size: o.defaultFontSize, weight: 400, color: '#fff', align: 'left', vAlign: 'center',
            lineHeight: 1.2, letterSpacing: 0, wrap: false,
        });
        return;
    }
    if (node instanceof UITextInputNode) {
        fill(ctx, node.tint, w, h, radius);
        stroke(ctx, node, w, h);
        const box = contentBox(node, w, h);
        const empty = node.value === '';
        const text = empty ? node.placeholder : node.password ? '•'.repeat(node.value.length) : node.value;
        drawText(ctx, text, { x: box.x + 6, y: box.y, w: Math.max(0, box.w - 12), h: box.h }, {
            family: o.defaultFamily, size: node.fontSize, weight: 400, color: empty ? '#757575' : '#000', align: 'left',
            vAlign: 'center', lineHeight: 1.2, letterSpacing: 0, wrap: false,
        });
        return;
    }
    if (node instanceof UIRootNode) return;
    fill(ctx, node.tint, w, h, radius);
    stroke(ctx, node, w, h);
}

function drawImage(ctx: Ctx, node: UIImageNode, box: { x: number; y: number; w: number; h: number }): void {
    const image = node.textureId ? TextureManager.Instance.getTexture(node.textureId)?.data as HTMLImageElement | undefined : undefined;
    if (!image || !(image.naturalWidth > 0) || box.w <= 0 || box.h <= 0) return;
    const iw = image.naturalWidth, ih = image.naturalHeight;
    let dx = box.x, dy = box.y, dw = box.w, dh = box.h;
    if (node.fit === 'contain' || node.fit === 'cover') {
        const s = node.fit === 'contain' ? Math.min(box.w / iw, box.h / ih) : Math.max(box.w / iw, box.h / ih);
        dw = iw * s; dh = ih * s;
        dx = box.x + (box.w - dw) / 2; dy = box.y + (box.h - dh) / 2;
    }
    ctx.save();
    // Only the tint's alpha: CSS cannot multiply an <img> by a colour, so the DOM layer does not either.
    ctx.globalAlpha *= Math.min(1, Math.max(0, node.tint[3]));
    if (node.fit === 'cover') { ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h); ctx.clip(); }
    ctx.drawImage(image, dx, dy, dw, dh);
    ctx.restore();
}

export interface TextStyle {
    family: string;
    size: number;
    weight: number;
    color: string;
    align: 'left' | 'center' | 'right';
    /** 'top' and 'bottom'; anything else centres, as the DOM layer's flex alignment does. */
    vAlign: 'top' | 'middle' | 'center' | 'bottom';
    /** A multiple of the size. */
    lineHeight: number;
    /** In em. */
    letterSpacing: number;
    wrap: boolean;
}

/**
 * Break `text` into lines as `white-space` does: pre-line (a newline breaks, spaces collapse, long lines
 * wrap at spaces) when wrapping, nowrap (everything on one line) when not.
 */
export function layoutLines(text: string, width: number, wrap: boolean, measure: (s: string) => number): string[] {
    const collapse = (s: string) => s.replace(/[ \t]+/g, ' ').trim();
    if (!wrap) return [collapse(text.replace(/\n/g, ' '))];
    const out: string[] = [];
    for (const paragraph of text.split('\n')) {
        const words = collapse(paragraph).split(' ').filter(Boolean);
        if (words.length === 0) { out.push(''); continue; }
        let line = words[0];
        for (let i = 1; i < words.length; i++) {
            const candidate = `${line} ${words[i]}`;
            if (measure(candidate) <= width + 0.01) line = candidate;
            else { out.push(line); line = words[i]; }
        }
        out.push(line);
    }
    return out;
}

function drawText(ctx: Ctx, text: string, box: { x: number; y: number; w: number; h: number }, style: TextStyle): void {
    if (!text) return;
    ctx.save();
    ctx.font = `${style.weight} ${style.size}px ${style.family}`;
    const spacing = style.letterSpacing ? `${style.letterSpacing * style.size}px` : '0px';
    if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D).letterSpacing = spacing;
    ctx.fillStyle = style.color;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    const lines = layoutLines(text, box.w, style.wrap, s => ctx.measureText(s).width);
    const lh = style.lineHeight * style.size;
    const total = lines.length * lh;
    const top = style.vAlign === 'top' ? box.y : style.vAlign === 'bottom' ? box.y + box.h - total : box.y + (box.h - total) / 2;
    const probe = ctx.measureText('Hg');
    const ascent = probe.fontBoundingBoxAscent ?? style.size * 0.8;
    const descent = probe.fontBoundingBoxDescent ?? style.size * 0.2;
    lines.forEach((line, i) => {
        const lw = ctx.measureText(line).width;
        const x = style.align === 'left' ? box.x : style.align === 'right' ? box.x + box.w - lw : box.x + (box.w - lw) / 2;
        // CSS centres the font's ascent-plus-descent in the line box.
        const baseline = top + i * lh + (lh - (ascent + descent)) / 2 + ascent;
        ctx.fillText(line, x, baseline);
    });
    ctx.restore();
}
