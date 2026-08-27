import { clamp } from "../../../math";
import { StackItem, UIRect, copyRect, intersectRect, rectsEqual, setRect, solveRect } from "../../../uiLayout";
import { NodeType } from "../nodeType";
import { Node } from "../node";
import { SpriteNode } from "../spriteNode";
import { UIStackNode } from "./uiContainers";
import { UIRootNode } from "./uiRoot";

/**
 * The UI element base class and the types every UI node shares.
 */

export type UIImageFit = 'fill' | 'contain' | 'cover' | 'tile';
/** Which end a progress bar fills from. */
export type UIFillDirection = 'ltr' | 'rtl' | 'btt' | 'ttb';
/** Horizontal text alignment. */
export type UITextAlign = 'left' | 'center' | 'right';
/** Vertical text alignment within the element's rect. */
export type UITextVAlign = 'top' | 'middle' | 'bottom';
/** Whether an element's size is authored, or measured from its content by the DOM layer. */
export type UISizing = 'fixed' | 'content';

/**
 * RGBA in 0..1, **sRGB** — deliberately not the linear convention materials use. UI is composited by
 * the browser, outside the engine's linear pipeline, so a colour here goes straight to CSS.
 */
export type UIColor = [number, number, number, number];

export const rgba = (r: number, g: number, b: number, a: number): UIColor => [r, g, b, a];
export const emptyRect = (): UIRect => ({ x: 0, y: 0, width: 0, height: 0 });

/** Coerce serialized JSON into a fixed-length numeric tuple, tolerating absent or malformed input. */
export function numTuple<N extends number[]>(value: any, fallback: N): N {
    const out = fallback.slice() as N;
    if (!Array.isArray(value)) return out;
    for (let i = 0; i < out.length; i++)
        if (typeof value[i] === 'number' && isFinite(value[i])) out[i] = value[i];
    return out;
}

/**
 * Base class for every UI element.
 *
 * Rect authoring follows `RectTransform`: an anchor PAIR plus two offsets (see {@link solveRect}).
 * Screen-space UI nodes ignore `Node.position`/`rotation`/`scale` entirely; the one exception is a
 * world-space {@link UIRootNode}, whose `Node.position` IS the point it projects from.
 */
export class UINode extends Node {
    protected _anchorMin: [number, number] = [0, 0];
    protected _anchorMax: [number, number] = [0, 0];
    protected _offsetMin: [number, number] = [0, 0];
    protected _offsetMax: [number, number] = [100, 100];
    protected _pivot: [number, number] = [0, 0];
    protected _rotationDeg: number = 0;
    protected _scale2d: [number, number] = [1, 1];

    protected _opacity: number = 1;
    protected _tint: UIColor = rgba(1, 1, 1, 1);
    protected _zOrder: number = 0;
    protected _interactive: boolean = false;
    protected _clip: boolean = false;
    protected _sizing: UISizing = 'fixed';
    protected _padding: [number, number, number, number] = [0, 0, 0, 0];
    protected _borderRadius: number = 0;
    protected _borderWidth: number = 0;
    protected _borderColor: UIColor = rgba(0, 0, 0, 1);

    // --- Resolved by the UI pass. Derived state: assigned directly, never through _notifyChange. ---
    protected _rect: UIRect = emptyRect();        // absolute, in the root's reference units
    protected _localRect: UIRect = emptyRect();   // relative to the parent's rect — what the DOM writes
    protected _screenRect: UIRect = emptyRect();  // absolute, viewport CSS pixels — hit-tests + gizmos
    protected _clipRect: UIRect = emptyRect();
    protected _resolvedOpacity: number = 1;
    protected _resolvedVisible: boolean = true;
    protected _onScreen: boolean = true;
    protected _layoutVersion: number = 0;
    /**
     * Bumped by EVERY authored setter; the DOM layer re-reads a node whenever this moves.
     * `tests/uiNode.test.ts` asserts reflectively that every setter still bumps it.
     */
    protected _revision: number = 0;

    /** Content size measured by the DOM layer for `sizing: 'content'`, consumed by the NEXT solve. */
    protected _measured: [number, number] = [0, 0];

    /** Previous rect, so `layoutVersion` bumps only on an actual change rather than every frame. */
    private readonly _prevRect: UIRect = emptyRect();

    constructor(name: string, type: NodeType = 'uiPanel', id?: string) {
        super(name, type, id);
    }

    // --- Rect ---
    public get anchorMin(): [number, number] { return this._anchorMin; }
    public set anchorMin(v: [number, number]) { const p = this._anchorMin; this._anchorMin = numTuple(v, [0, 0]); this._touch(); this._notifyChange('component', 'anchorMin', p, this._anchorMin); }
    public get anchorMax(): [number, number] { return this._anchorMax; }
    public set anchorMax(v: [number, number]) { const p = this._anchorMax; this._anchorMax = numTuple(v, [0, 0]); this._touch(); this._notifyChange('component', 'anchorMax', p, this._anchorMax); }
    public get offsetMin(): [number, number] { return this._offsetMin; }
    public set offsetMin(v: [number, number]) { const p = this._offsetMin; this._offsetMin = numTuple(v, [0, 0]); this._touch(); this._notifyChange('component', 'offsetMin', p, this._offsetMin); }
    public get offsetMax(): [number, number] { return this._offsetMax; }
    public set offsetMax(v: [number, number]) { const p = this._offsetMax; this._offsetMax = numTuple(v, [0, 0]); this._touch(); this._notifyChange('component', 'offsetMax', p, this._offsetMax); }
    public get pivot(): [number, number] { return this._pivot; }
    public set pivot(v: [number, number]) { const p = this._pivot; this._pivot = numTuple(v, [0, 0]); this._touch(); this._notifyChange('component', 'pivot', p, this._pivot); }
    public get rotationDeg(): number { return this._rotationDeg; }
    public set rotationDeg(v: number) { const p = this._rotationDeg; this._rotationDeg = v; this._touch(); this._notifyChange('component', 'rotationDeg', p, v); }
    public get scale2d(): [number, number] { return this._scale2d; }
    public set scale2d(v: [number, number]) { const p = this._scale2d; this._scale2d = numTuple(v, [1, 1]); this._touch(); this._notifyChange('component', 'scale2d', p, this._scale2d); }

    /** Set position + size, the reading the inspector shows on a PINNED axis (`anchorMin === anchorMax`). */
    public setRect(x: number, y: number, width: number, height: number): UINode {
        this.offsetMin = [x, y];
        this.offsetMax = [x + width, y + height];
        return this;
    }

    /** Pin both axes to one anchor point (0..1 of the parent), e.g. `(1, 0)` for the top-right corner. */
    public setAnchor(x: number, y: number): UINode {
        this.anchorMin = [x, y];
        this.anchorMax = [x, y];
        return this;
    }

    /** Stretch to fill the parent, inset by the given margins. */
    public stretch(left: number = 0, top: number = 0, right: number = 0, bottom: number = 0): UINode {
        this.anchorMin = [0, 0];
        this.anchorMax = [1, 1];
        this.offsetMin = [left, top];
        this.offsetMax = [-right, -bottom];
        return this;
    }

    // --- Appearance ---
    public get opacity(): number { return this._opacity; }
    public set opacity(v: number) { const p = this._opacity; this._opacity = clamp(v, 0, 1); this._touch(); this._notifyChange('component', 'opacity', p, this._opacity); }
    public get tint(): UIColor { return this._tint; }
    public set tint(v: UIColor) { const p = this._tint; this._tint = numTuple(v, rgba(1, 1, 1, 1)); this._touch(); this._notifyChange('component', 'tint', p, this._tint); }
    public get zOrder(): number { return this._zOrder; }
    public set zOrder(v: number) { const p = this._zOrder; this._zOrder = v; this._touch(); this._notifyChange('component', 'zOrder', p, v); }
    public get interactive(): boolean { return this._interactive; }
    public set interactive(v: boolean) { const p = this._interactive; this._interactive = v; this._touch(); this._notifyChange('component', 'interactive', p, v); }
    public get clip(): boolean { return this._clip; }
    public set clip(v: boolean) { const p = this._clip; this._clip = v; this._touch(); this._notifyChange('component', 'clip', p, v); }
    public get sizing(): UISizing { return this._sizing; }
    public set sizing(v: UISizing) { const p = this._sizing; this._sizing = v; this._touch(); this._notifyChange('component', 'sizing', p, v); }
    public get padding(): [number, number, number, number] { return this._padding; }
    public set padding(v: [number, number, number, number]) { const p = this._padding; this._padding = numTuple(v, [0, 0, 0, 0]); this._touch(); this._notifyChange('component', 'padding', p, this._padding); }
    public get borderRadius(): number { return this._borderRadius; }
    public set borderRadius(v: number) { const p = this._borderRadius; this._borderRadius = Math.max(0, v); this._touch(); this._notifyChange('component', 'borderRadius', p, this._borderRadius); }
    public get borderWidth(): number { return this._borderWidth; }
    public set borderWidth(v: number) { const p = this._borderWidth; this._borderWidth = Math.max(0, v); this._touch(); this._notifyChange('component', 'borderWidth', p, this._borderWidth); }
    public get borderColor(): UIColor { return this._borderColor; }
    public set borderColor(v: UIColor) { const p = this._borderColor; this._borderColor = numTuple(v, rgba(0, 0, 0, 1)); this._touch(); this._notifyChange('component', 'borderColor', p, this._borderColor); }

    // --- Resolved layout (read-only; LIVE objects reused across frames, never copies) ---
    /** Absolute rect in the root's reference units. */
    public get rect(): UIRect { return this._rect; }
    /** Rect relative to the parent element — what the DOM layer positions with. */
    public get localRect(): UIRect { return this._localRect; }
    /** Absolute rect in viewport CSS pixels, post root-scale. Hit-testing and editor gizmos use this. */
    public get screenRect(): UIRect { return this._screenRect; }
    /** Intersection of every clipping ancestor's rect, in reference units. */
    public get clipRect(): UIRect { return this._clipRect; }
    /** This node's opacity multiplied down the ancestor chain. */
    public get resolvedOpacity(): number { return this._resolvedOpacity; }
    /** This node's `visible` AND every ancestor's. */
    public get resolvedVisible(): boolean { return this._resolvedVisible; }
    /** False when a world-space ancestor is behind the camera or fully outside the viewport. */
    public get onScreen(): boolean { return this._onScreen; }
    /** Bumped only when the resolved geometry actually changed — the DOM layer's skip check. */
    public get layoutVersion(): number { return this._layoutVersion; }
    /** Bumped by every authored setter — the DOM layer's other skip check. */
    public get revision(): number { return this._revision; }

    /** Mark this node's authored state changed. EVERY setter must call it. */
    protected _touch(): void { this._revision++; }

    /**
     * Report the content size the DOM measured, for `sizing: 'content'`. Consumed by the NEXT frame's
     * solve: the measurement cannot exist until the DOM has laid the element out.
     */
    public setMeasuredContentSize(width: number, height: number): void {
        this._measured[0] = width;
        this._measured[1] = height;
    }

    /** Last measurement reported by the DOM layer, so it can tell whether anything actually changed. */
    public get measuredContentSize(): readonly [number, number] { return this._measured; }

    /** The main-axis size this node contributes to a parent {@link UIStackNode}. */
    protected _stackItem(horizontal: boolean): StackItem {
        const authored = horizontal
            ? this._offsetMax[0] - this._offsetMin[0]
            : this._offsetMax[1] - this._offsetMin[1];
        const measured = horizontal ? this._measured[0] : this._measured[1];
        return { size: this._sizing === 'content' && measured > 0 ? measured : Math.max(0, authored), flex: 0 };
    }

    /**
     * Resolve this node and its descendants.
     *
     * `parentRect` is absolute in reference units; `origin`/`scale` convert that space into viewport
     * pixels for {@link screenRect}. Hidden subtrees are still solved; dormant subtrees are pruned.
     */
    public solveUI(
        parentRect: UIRect,
        parentClip: UIRect,
        parentOpacity: number,
        parentVisible: boolean,
        parentOnScreen: boolean,
        origin: { x: number, y: number },
        scale: number,
    ): void {
        copyRect(this._prevRect, this._rect);

        solveRect(this._rect, parentRect, this._anchorMin, this._anchorMax, this._offsetMin, this._offsetMax);
        this._applyContentSize();

        setRect(this._localRect,
            this._rect.x - parentRect.x, this._rect.y - parentRect.y, this._rect.width, this._rect.height);
        setRect(this._screenRect,
            origin.x + this._rect.x * scale, origin.y + this._rect.y * scale,
            this._rect.width * scale, this._rect.height * scale);

        if (this._clip) intersectRect(this._clipRect, parentClip, this._rect);
        else copyRect(this._clipRect, parentClip);

        this._resolvedOpacity = parentOpacity * this._opacity;
        this._resolvedVisible = parentVisible && this._visible;
        this._onScreen = parentOnScreen;

        if (!rectsEqual(this._prevRect, this._rect)) this._layoutVersion++;

        this._solveChildren(origin, scale);
    }

    /**
     * Resolve this node into a slot a {@link UIStackNode} assigned it. The stack owns the MAIN axis, so
     * the slot rect is used verbatim there; the cross axis still goes through the ordinary anchor solve
     * unless `align` overrides it.
     */
    public solveUIInSlot(
        slot: UIRect,
        stackRect: UIRect,
        parentClip: UIRect,
        parentOpacity: number,
        parentVisible: boolean,
        parentOnScreen: boolean,
        origin: { x: number, y: number },
        scale: number,
        horizontal: boolean,
        align: 'start' | 'center' | 'end' | 'stretch',
    ): void {
        copyRect(this._prevRect, this._rect);

        // Cross-axis size: authored unless the stack stretches it.
        const crossMeasured = horizontal ? this._measured[1] : this._measured[0];
        const crossAuthored = this._sizing === 'content' && crossMeasured > 0
            ? crossMeasured
            : (horizontal
                ? this._offsetMax[1] - this._offsetMin[1]
                : this._offsetMax[0] - this._offsetMin[0]);
        const crossAvail = horizontal ? slot.height : slot.width;
        const crossSize = align === 'stretch' ? crossAvail : Math.max(0, crossAuthored);
        const crossOffset = align === 'center' ? (crossAvail - crossSize) / 2
            : align === 'end' ? crossAvail - crossSize
                : 0;

        if (horizontal) setRect(this._rect, slot.x, slot.y + crossOffset, slot.width, crossSize);
        else setRect(this._rect, slot.x + crossOffset, slot.y, crossSize, slot.height);

        // The DOM nests a stack's children inside the STACK element, so local coordinates are measured
        // from the stack's rect rather than the slot. `stackRect` carries that origin.
        setRect(this._localRect,
            this._rect.x - stackRect.x, this._rect.y - stackRect.y, this._rect.width, this._rect.height);

        setRect(this._screenRect,
            origin.x + this._rect.x * scale, origin.y + this._rect.y * scale,
            this._rect.width * scale, this._rect.height * scale);

        if (this._clip) intersectRect(this._clipRect, parentClip, this._rect);
        else copyRect(this._clipRect, parentClip);

        this._resolvedOpacity = parentOpacity * this._opacity;
        this._resolvedVisible = parentVisible && this._visible;
        this._onScreen = parentOnScreen;

        if (!rectsEqual(this._prevRect, this._rect)) this._layoutVersion++;

        this._solveChildren(origin, scale);
    }

    /**
     * Replace the solved extent with the measured content size, on any PINNED axis, when `sizing` asks.
     * Pinned axes only: a stretched axis is sized by the distance between its anchors. The measurement
     * comes from the DOM one frame earlier (see `setMeasuredContentSize`).
     */
    protected _applyContentSize(): void {
        if (this._sizing !== 'content') return;
        if (this._anchorMin[0] === this._anchorMax[0] && this._measured[0] > 0) this._rect.width = this._measured[0];
        if (this._anchorMin[1] === this._anchorMax[1] && this._measured[1] > 0) this._rect.height = this._measured[1];
    }

    /** Solve every live UI child against this node's rect. {@link UIStackNode} overrides it. */
    protected _solveChildren(origin: { x: number, y: number }, scale: number): void {
        for (const child of this._children)
            if (child instanceof UINode && child.spawned)
                child.solveUI(this._rect, this._clipRect, this._resolvedOpacity, this._resolvedVisible,
                    this._onScreen, origin, scale);
    }

    /** Live UI children in paint order: `zOrder` ascending, ties broken by tree order. */
    public get uiChildren(): UINode[] {
        const kids: UINode[] = [];
        for (const child of this._children) if (child instanceof UINode) kids.push(child);
        // Array.prototype.sort is stable, so equal zOrders keep tree order — which is what authoring expects.
        return kids.sort((a, b) => a._zOrder - b._zOrder);
    }

    protected _serializeUIBase(): any {
        return {
            anchorMin: [...this._anchorMin], anchorMax: [...this._anchorMax],
            offsetMin: [...this._offsetMin], offsetMax: [...this._offsetMax],
            pivot: [...this._pivot], rotationDeg: this._rotationDeg, scale2d: [...this._scale2d],
            opacity: this._opacity, tint: [...this._tint], zOrder: this._zOrder,
            interactive: this._interactive, clip: this._clip, sizing: this._sizing,
            padding: [...this._padding], borderRadius: this._borderRadius,
            borderWidth: this._borderWidth, borderColor: [...this._borderColor],
        };
    }

    /**
     * Per-UI-type payload, merged into the `ui` block. Distinct from {@link _serializePayload}, which
     * contributes to the node's top level — the two names must not be confused when overriding.
     */
    protected _serializeUIPayload(): any { return {}; }

    protected _serializePayload(): any {
        return {
            // Unlike every other node family, UI persists `visible`: a panel authored hidden and revealed
            // by a script is the common case here.
            visible: this._visible,
            ui: { ...this._serializeUIBase(), ...this._serializeUIPayload() },
        };
    }

    /** Restore the shared UI block. Subclasses read their payload from the same `json.ui` object. */
    protected _parseUIBase(ui: any): void {
        if (!ui) return;
        this._anchorMin = numTuple(ui.anchorMin, [0, 0]);
        this._anchorMax = numTuple(ui.anchorMax, [0, 0]);
        this._offsetMin = numTuple(ui.offsetMin, [0, 0]);
        this._offsetMax = numTuple(ui.offsetMax, [100, 100]);
        this._pivot = numTuple(ui.pivot, [0, 0]);
        if (typeof ui.rotationDeg === 'number') this._rotationDeg = ui.rotationDeg;
        this._scale2d = numTuple(ui.scale2d, [1, 1]);
        if (typeof ui.opacity === 'number') this._opacity = clamp(ui.opacity, 0, 1);
        this._tint = numTuple(ui.tint, rgba(1, 1, 1, 1));
        if (typeof ui.zOrder === 'number') this._zOrder = ui.zOrder;
        if (typeof ui.interactive === 'boolean') this._interactive = ui.interactive;
        if (typeof ui.clip === 'boolean') this._clip = ui.clip;
        if (ui.sizing === 'content' || ui.sizing === 'fixed') this._sizing = ui.sizing;
        this._padding = numTuple(ui.padding, [0, 0, 0, 0]);
        if (typeof ui.borderRadius === 'number') this._borderRadius = Math.max(0, ui.borderRadius);
        if (typeof ui.borderWidth === 'number') this._borderWidth = Math.max(0, ui.borderWidth);
        this._borderColor = numTuple(ui.borderColor, rgba(0, 0, 0, 1));
    }

    /**
     * The shared parse tail for every UI type. Ends at `Node.finishParse`, which already calls
     * `parent.addChild(node)`; a second `addChild` would fire a spurious reparent SCENE_CHANGED per node.
     */
    protected static _parseUI(node: UINode, parent: Node, json: any): void {
        node._parseUIBase(json?.ui);
        node._parsePayload(json?.ui ?? {});
        // Assigned to the field, not through the setter: the setter emits a visibility SCENE_CHANGED and
        // a scene load is not an edit.
        if (json?.visible === false) node._visible = false;
        Node.finishParse(node, parent, json);
    }

    /** Per-type payload restore. Mirrors {@link _serializePayload}. */
    protected _parsePayload(_ui: any): void { /* no payload on the base */ }

    public static parse(parent: Node, json: any): void {
        UINode._parseUI(new UINode(json.name, json.type, json.id), parent, json);
    }
}
