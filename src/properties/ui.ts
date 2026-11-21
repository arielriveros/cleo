// The UI nodes' declared properties (see declare.ts), documented on the UI page (docs/editor/ui.md): every
// element's Anchor & Rect and Appearance, and each type's own fields, which its Element card shows (a root's:
// Canvas). UI colours are sRGB 0..1 RGBA, which is what a colour's editor reads and writes as they are.

import { ColorAlpha, Vec2, Vec4 } from '../core/scripting/fieldTypes';
import { Choice, Integer } from '../core/properties/types';
import { Node } from '../core/scene/nodes/node';
import { Texture } from '../graphics/texture';
import { UINode } from '../core/scene/nodes/ui/uiNode';
import { UIRootNode } from '../core/scene/nodes/ui/uiRoot';
import { UITextNode, UIImageNode } from '../core/scene/nodes/ui/uiContent';
import { UIStackNode, UISpacerNode } from '../core/scene/nodes/ui/uiContainers';
import { UIButtonNode, UIProgressBarNode, UISliderNode, UIToggleNode, UITextInputNode } from '../core/scene/nodes/ui/uiWidgets';
import { assetIdAccess, declareProperties, nodeIdAccess, type PropertyDeclaration } from './declare';

const DOCS = 'editor/ui';

// ----- Anchor & Rect, Appearance: every element -----

/** One side of the rect on one axis: an inset from that edge on a stretched axis, else a position or a size. */
function rectEdge(axis: 0 | 1, far: boolean): PropertyDeclaration<UINode> {
    const stretched = (n: UINode) => n.anchorMin[axis] !== n.anchorMax[axis];
    const names = axis === 0 ? (far ? ['Right', 'Width'] : ['Left', 'Pos X']) : (far ? ['Bottom', 'Height'] : ['Top', 'Pos Y']);
    const with2 = (v: [number, number], x: number): [number, number] => (axis === 0 ? [x, v[1]] : [v[0], x]);
    return {
        key: `rect.${axis ? 'y' : 'x'}${far ? 1 : 0}`, type: Number,
        label: n => (stretched(n) ? names[0] : names[1]),
        get: n => (!far ? n.offsetMin[axis] : stretched(n) ? n.offsetMax[axis] : n.offsetMax[axis] - n.offsetMin[axis]),
        set: (n, v) => {
            const x = Number(v);
            if (!far) n.offsetMin = with2(n.offsetMin, x);
            // On a pinned axis the size moves the far offset with the near one.
            else n.offsetMax = with2(n.offsetMax, stretched(n) ? x : n.offsetMin[axis] + x);
        },
    };
}

// Two cards' sections: the anchors' grid of presets stays the Anchor & Rect card's own.
declareProperties(UINode, 'Appearance', [
    // A root's rect is the viewport's, or its projection's.
    { title: 'Anchors and rectangles', when: n => !(n instanceof UIRootNode), props: [
        rectEdge(0, false), rectEdge(0, true), rectEdge(1, false), rectEdge(1, true),
        { key: 'pivot', type: Vec2, min: 0, max: 1, step: 0.05 },
        { key: 'rotationDeg', label: 'Rotation', type: Number },
        { key: 'scale2d', label: 'Scale', type: Vec2, step: 0.1 },
    ] },
    { title: '', props: [
        { key: 'tint', label: 'Color', type: ColorAlpha },
        { key: 'opacity', type: Number, min: 0, max: 1, step: 0.01 },
        { key: 'zOrder', label: 'Z order', type: Integer },
        { key: 'interactive', type: Boolean },
        { key: 'clip', label: 'Clip children', type: Boolean },
        { key: 'borderRadius', label: 'Corner radius', type: Number, min: 0 },
        { key: 'borderWidth', label: 'Border width', type: Number, min: 0 },
        { key: 'borderColor', label: 'Border color', type: ColorAlpha },
        { key: 'padding', type: Vec4 },
    ] },
], { docs: DOCS, section: 'appearance' });

// ----- Each type's own fields -----

const screen = (n: UIRootNode) => n.space !== 'world';

declareProperties(UIRootNode, 'Canvas', [
    { title: '', props: [
        { key: 'space', type: Choice(['screen', 'world'], ['Screen', 'World']) },
        { key: 'referenceResolution', label: 'Reference size', type: Vec2, min: 1, step: 1 },
        { key: 'scaleMode', label: 'Scale mode', type: Choice(['scaleWithScreen', 'constantPixel', 'constantPhysical'], ['Scale with screen', 'Constant pixel', 'Constant physical']), when: screen },
        { key: 'matchWidthOrHeight', label: 'Match', type: Number, min: 0, max: 1, step: 0.05, when: n => screen(n) && n.scaleMode === 'scaleWithScreen' },
        { key: 'uiTargetId', label: 'Follow', type: Node, when: n => !screen(n), ...nodeIdAccess('uiTargetId') },
        { key: 'referenceDistance', label: 'Reference distance', type: Number, min: 0.01, step: 0.5, when: n => !screen(n) },
        { key: 'minScale', label: 'Min scale', type: Number, min: 0, step: 0.05, when: n => !screen(n) },
        { key: 'maxScale', label: 'Max scale', type: Number, min: 0, step: 0.5, when: n => !screen(n) },
        { key: 'clampToScreen', label: 'Clamp to screen', type: Boolean, when: n => !screen(n) },
        { key: 'hideBehindCamera', label: 'Hide behind camera', type: Boolean, when: n => !screen(n) },
    ] },
], { docs: DOCS, section: 'canvases' });

/** An element type's own fields, documented under its heading of Element types. */
function element<N extends UINode>(Class: abstract new (...args: any[]) => N, section: string, props: PropertyDeclaration<N>[]): void {
    declareProperties(Class, 'Element', [{ title: '', props }], { docs: DOCS, section });
}

element(UITextNode, 'text', [
    { key: 'text', type: String, multiline: true },
    { key: 'fontSize', label: 'Font size', type: Number, min: 1 },
    { key: 'fontFamily', label: 'Font family', type: String },
    { key: 'fontWeight', label: 'Weight', type: Number, min: 100, max: 900, step: 100, readout: v => v.toFixed(0) },
    { key: 'align', type: Choice(['left', 'center', 'right'], ['Left', 'Center', 'Right']) },
    { key: 'vAlign', label: 'Vertical', type: Choice(['top', 'middle', 'bottom'], ['Top', 'Middle', 'Bottom']) },
    { key: 'wrap', type: Boolean },
    { key: 'lineHeight', label: 'Line height', type: Number, min: 0, step: 0.1 },
    { key: 'letterSpacing', label: 'Letter spacing', type: Number, min: -0.5, max: 2, step: 0.05 },
]);

element(UIImageNode, 'image', [
    { key: 'textureId', label: 'Texture', type: Texture, ...assetIdAccess('texture', 'textureId') },
    { key: 'fit', type: Choice(['fill', 'contain', 'cover', 'tile'], ['Fill', 'Contain', 'Cover', 'Tile']) },
]);

element(UIButtonNode, 'button', [
    { key: 'label', type: String },
    { key: 'disabled', type: Boolean },
    { key: 'disabledTint', label: 'Disabled color', type: ColorAlpha },
]);

element(UIStackNode, 'column-and-row', [
    { key: 'direction', type: Choice(['column', 'row'], ['Column', 'Row']) },
    { key: 'gap', type: Number },
    { key: 'justify', type: Choice(['start', 'center', 'end', 'spaceBetween', 'spaceAround'], ['Start', 'Center', 'End', 'Space between', 'Space around']) },
    { key: 'align', type: Choice(['stretch', 'start', 'center', 'end'], ['Stretch', 'Start', 'Center', 'End']) },
    { key: 'reverse', type: Boolean },
]);

element(UISpacerNode, 'spacer', [
    { key: 'flex', type: Number, min: 0, step: 0.5 },
]);

element(UIProgressBarNode, 'progress', [
    { key: 'min', type: Number },
    { key: 'max', type: Number },
    { key: 'value', type: Number },
    { key: 'fillTint', label: 'Fill color', type: ColorAlpha },
    { key: 'direction', type: Choice(['ltr', 'rtl', 'btt', 'ttb'], ['Left to right', 'Right to left', 'Bottom to top', 'Top to bottom']) },
    { key: 'smoothing', type: Number, min: 0, step: 0.05 },
]);

element(UISliderNode, 'slider', [
    { key: 'min', type: Number },
    { key: 'max', type: Number },
    { key: 'step', type: Number, min: 0, step: 0.1 },
    { key: 'value', type: Number },
    { key: 'vertical', type: Boolean },
    { key: 'fillTint', label: 'Fill color', type: ColorAlpha },
    { key: 'handleTint', label: 'Handle color', type: ColorAlpha },
]);

element(UIToggleNode, 'toggle', [
    { key: 'label', type: String },
    { key: 'checked', type: Boolean },
    { key: 'onTint', label: 'On color', type: ColorAlpha },
    { key: 'offTint', label: 'Off color', type: ColorAlpha },
]);

element(UITextInputNode, 'text-input', [
    { key: 'value', type: String },
    { key: 'placeholder', type: String },
    { key: 'maxLength', label: 'Max length', type: Integer, min: 0 },
    { key: 'fontSize', label: 'Font size', type: Number, min: 1 },
    { key: 'password', type: Boolean },
    { key: 'readOnly', label: 'Read only', type: Boolean },
]);
