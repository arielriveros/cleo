import { StackItem, StackJustify, UIRect, setRect, stackLayout } from "../../../uiLayout";
import { Node } from "../node";
import { UINode, rgba } from "./uiNode";

/**
 * UI elements that arrange other elements: Panel, Stack, Spacer.
 *
 * UIPanelNode ships alongside the layout containers because all three are "a box that holds other boxes"; UIStackNode additionally needs UISpacerNode at runtime (an `instanceof` in its layout), so they cannot be separated without a cycle.
 */

export class UIPanelNode extends UINode {
    constructor(name: string = 'panel', id?: string) {
        super(name, 'uiPanel', id);
        this._tint = rgba(0, 0, 0, 0.4);
    }

    public static parse(parent: Node, json: any): void {
        UINode._parseUI(new UIPanelNode(json.name, json.id), parent, json);
    }
}

/** A run of text. `tint` is the text colour here, not a background. */

export class UIStackNode extends UINode {
    private _direction: 'row' | 'column' = 'column';
    private _gap: number = 4;
    private _justify: StackJustify = 'start';
    private _align: 'start' | 'center' | 'end' | 'stretch' = 'stretch';
    private _reverse: boolean = false;

    /** Reused across frames so the layout pass allocates nothing per stack. */
    private readonly _slots: { offset: number, size: number }[] = [];
    private readonly _items: StackItem[] = [];

    constructor(name: string = 'stack', direction: 'row' | 'column' = 'column', id?: string) {
        super(name, 'uiStack', id);
        this._direction = direction;
        this._offsetMax = [200, 200];
    }

    public get direction(): 'row' | 'column' { return this._direction; }
    public set direction(v: 'row' | 'column') { const p = this._direction; this._direction = v; this._touch(); this._notifyChange('component', 'direction', p, v); }
    public get gap(): number { return this._gap; }
    public set gap(v: number) { const p = this._gap; this._gap = v; this._touch(); this._notifyChange('component', 'gap', p, v); }
    public get justify(): StackJustify { return this._justify; }
    public set justify(v: StackJustify) { const p = this._justify; this._justify = v; this._touch(); this._notifyChange('component', 'justify', p, v); }
    public get align(): 'start' | 'center' | 'end' | 'stretch' { return this._align; }
    public set align(v: 'start' | 'center' | 'end' | 'stretch') { const p = this._align; this._align = v; this._touch(); this._notifyChange('component', 'align', p, v); }
    public get reverse(): boolean { return this._reverse; }
    public set reverse(v: boolean) { const p = this._reverse; this._reverse = v; this._touch(); this._notifyChange('component', 'reverse', p, v); }

    /**
     * Lay children out along the main axis, then solve each one against the slot it was given.
     *
     * Each child is solved against a one-child parent rect representing its slot, so its own anchors and
     * offsets still apply on the CROSS axis — which is how `align: 'stretch'` and a fixed cross size end
     * up being the same mechanism rather than two.
     */
    protected _solveChildren(origin: { x: number, y: number }, scale: number): void {
        const kids: UINode[] = [];
        for (const child of this._children)
            if (child instanceof UINode && child.spawned) kids.push(child);
        if (kids.length === 0) return;

        const horizontal = this._direction === 'row';
        const [padL, padT, padR, padB] = this._padding;
        const innerX = this._rect.x + padL;
        const innerY = this._rect.y + padT;
        const innerW = Math.max(0, this._rect.width - padL - padR);
        const innerH = Math.max(0, this._rect.height - padT - padB);

        this._items.length = kids.length;
        for (let i = 0; i < kids.length; i++)
            this._items[i] = kids[i] instanceof UISpacerNode
                ? { size: 0, flex: (kids[i] as UISpacerNode).flex }
                : (kids[i] as any)._stackItem(horizontal);

        stackLayout(this._slots, this._items, horizontal ? innerW : innerH,
            this._gap, this._justify, this._reverse);

        const slotRect: UIRect = { x: 0, y: 0, width: 0, height: 0 };
        for (let i = 0; i < kids.length; i++) {
            const slot = this._slots[i];
            if (horizontal) setRect(slotRect, innerX + slot.offset, innerY, slot.size, innerH);
            else setRect(slotRect, innerX, innerY + slot.offset, innerW, slot.size);

            const child = kids[i];
            // Inside a stack the main axis is owned by the layout, so the child's own main-axis anchors
            // are overridden to "fill the slot"; the cross axis keeps whatever it was authored with.
            child.solveUIInSlot(slotRect, this._rect, this._clipRect, this._resolvedOpacity,
                this._resolvedVisible, this._onScreen, origin, scale, horizontal, this._align);
        }
    }

    protected _serializeUIPayload(): any {
        return {
            direction: this._direction, gap: this._gap, justify: this._justify,
            align: this._align, reverse: this._reverse,
        };
    }

    protected _parsePayload(ui: any): void {
        if (ui.direction === 'row' || ui.direction === 'column') this._direction = ui.direction;
        if (typeof ui.gap === 'number') this._gap = ui.gap;
        if (['start', 'center', 'end', 'spaceBetween', 'spaceAround'].includes(ui.justify)) this._justify = ui.justify;
        if (['start', 'center', 'end', 'stretch'].includes(ui.align)) this._align = ui.align;
        if (typeof ui.reverse === 'boolean') this._reverse = ui.reverse;
    }

    public static parse(parent: Node, json: any): void {
        UINode._parseUI(new UIStackNode(json.name, 'column', json.id), parent, json);
    }
}

/** Flexible empty space inside a {@link UIStackNode}. Draws nothing. */
export class UISpacerNode extends UINode {
    private _flex: number = 1;

    constructor(name: string = 'spacer', id?: string) {
        super(name, 'uiSpacer', id);
    }

    public get flex(): number { return this._flex; }
    public set flex(v: number) { const p = this._flex; this._flex = Math.max(0, v); this._touch(); this._notifyChange('component', 'flex', p, this._flex); }

    protected _serializeUIPayload(): any { return { flex: this._flex }; }
    protected _parsePayload(ui: any): void { if (typeof ui.flex === 'number') this._flex = Math.max(0, ui.flex); }

    public static parse(parent: Node, json: any): void {
        UINode._parseUI(new UISpacerNode(json.name, json.id), parent, json);
    }
}

/**
 * A filled bar showing `value` between `min` and `max`.
 *
 * This exists so a health bar is a data binding rather than a script rewriting a width every frame —
 * which is what the legacy overlay forced, and the reason its HUD scripts were mostly layout arithmetic.
 */
