import { Node } from "../node";
import { UINode, numTuple } from "./uiNode";
import type { UIImageFit, UITextAlign, UITextVAlign } from "./uiNode";

/**
 * UI elements that display content: Text and Image.
 */

export class UITextNode extends UINode {
    private _text: string = 'Text';
    private _fontSize: number = 16;
    private _fontFamily: string = '';
    private _fontWeight: number = 400;
    private _align: UITextAlign = 'left';
    private _vAlign: UITextVAlign = 'top';
    private _wrap: boolean = true;
    private _lineHeight: number = 1.2;

    constructor(name: string = 'text', id?: string) {
        super(name, 'uiText', id);
        this._offsetMax = [200, 24];
    }

    public get text(): string { return this._text; }
    public set text(v: string) {
        const next = String(v ?? '');
        if (next === this._text) return;   // scripts rewrite this every frame; only a real change counts
        const p = this._text;
        this._text = next;
        this._touch();
        this._notifyChange('component', 'text', p, next);
    }
    public get fontSize(): number { return this._fontSize; }
    public set fontSize(v: number) { const p = this._fontSize; this._fontSize = Math.max(1, v); this._touch(); this._notifyChange('component', 'fontSize', p, this._fontSize); }
    public get fontFamily(): string { return this._fontFamily; }
    public set fontFamily(v: string) { const p = this._fontFamily; this._fontFamily = v ?? ''; this._touch(); this._notifyChange('component', 'fontFamily', p, this._fontFamily); }
    public get fontWeight(): number { return this._fontWeight; }
    public set fontWeight(v: number) { const p = this._fontWeight; this._fontWeight = v; this._touch(); this._notifyChange('component', 'fontWeight', p, v); }
    public get align(): UITextAlign { return this._align; }
    public set align(v: UITextAlign) { const p = this._align; this._align = v; this._touch(); this._notifyChange('component', 'align', p, v); }
    public get vAlign(): UITextVAlign { return this._vAlign; }
    public set vAlign(v: UITextVAlign) { const p = this._vAlign; this._vAlign = v; this._touch(); this._notifyChange('component', 'vAlign', p, v); }
    public get wrap(): boolean { return this._wrap; }
    public set wrap(v: boolean) { const p = this._wrap; this._wrap = v; this._touch(); this._notifyChange('component', 'wrap', p, v); }
    public get lineHeight(): number { return this._lineHeight; }
    public set lineHeight(v: number) { const p = this._lineHeight; this._lineHeight = Math.max(0, v); this._touch(); this._notifyChange('component', 'lineHeight', p, this._lineHeight); }

    protected _serializeUIPayload(): any {
        return {
            text: this._text, fontSize: this._fontSize, fontFamily: this._fontFamily,
            fontWeight: this._fontWeight, align: this._align, vAlign: this._vAlign,
            wrap: this._wrap, lineHeight: this._lineHeight,
        };
    }

    protected _parsePayload(ui: any): void {
        if (typeof ui.text === 'string') this._text = ui.text;
        if (typeof ui.fontSize === 'number') this._fontSize = Math.max(1, ui.fontSize);
        if (typeof ui.fontFamily === 'string') this._fontFamily = ui.fontFamily;
        if (typeof ui.fontWeight === 'number') this._fontWeight = ui.fontWeight;
        if (ui.align === 'left' || ui.align === 'center' || ui.align === 'right') this._align = ui.align;
        if (ui.vAlign === 'top' || ui.vAlign === 'middle' || ui.vAlign === 'bottom') this._vAlign = ui.vAlign;
        if (typeof ui.wrap === 'boolean') this._wrap = ui.wrap;
        if (typeof ui.lineHeight === 'number') this._lineHeight = Math.max(0, ui.lineHeight);
    }

    public static parse(parent: Node, json: any): void {
        UINode._parseUI(new UITextNode(json.name, json.id), parent, json);
    }
}

/**
 * A textured quad.
 *
 * `textureId` references the engine's texture store, never a raw URL or data URI: that is what makes a
 * UI image participate in asset hashing, resync and the publish pass that packs referenced textures.
 */
export class UIImageNode extends UINode {
    private _textureId: string | null = null;
    private _fit: UIImageFit = 'fill';
    private _uvRect: [number, number, number, number] = [0, 0, 1, 1];

    constructor(name: string = 'image', id?: string) {
        super(name, 'uiImage', id);
        this._offsetMax = [64, 64];
    }

    public get textureId(): string | null { return this._textureId; }
    public set textureId(v: string | null) { const p = this._textureId; this._textureId = v || null; this._touch(); this._notifyChange('component', 'textureId', p, this._textureId); }
    public get fit(): UIImageFit { return this._fit; }
    public set fit(v: UIImageFit) { const p = this._fit; this._fit = v; this._touch(); this._notifyChange('component', 'fit', p, v); }
    public get uvRect(): [number, number, number, number] { return this._uvRect; }
    public set uvRect(v: [number, number, number, number]) { const p = this._uvRect; this._uvRect = numTuple(v, [0, 0, 1, 1]); this._touch(); this._notifyChange('component', 'uvRect', p, this._uvRect); }

    protected _serializeUIPayload(): any {
        return { textureId: this._textureId, fit: this._fit, uvRect: [...this._uvRect] };
    }

    protected _parsePayload(ui: any): void {
        this._textureId = typeof ui.textureId === 'string' ? ui.textureId : null;
        if (ui.fit === 'fill' || ui.fit === 'contain' || ui.fit === 'cover' || ui.fit === 'tile') this._fit = ui.fit;
        this._uvRect = numTuple(ui.uvRect, [0, 0, 1, 1]);
    }

    public static parse(parent: Node, json: any): void {
        UINode._parseUI(new UIImageNode(json.name, json.id), parent, json);
    }
}
