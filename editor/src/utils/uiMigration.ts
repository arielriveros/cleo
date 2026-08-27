import { Logger } from 'cleo';
import { cryptoRandomId } from './ids';

/**
 * Convert the legacy DOM-overlay UI blob — a sibling `ui: { version, elements }` key of absolutely
 * positioned CSS style bags — into UI nodes in the serialized scene tree.
 *
 * Works on SERIALIZED JSON, never on live nodes: it must run before `Scene.parse`, and on scene blobs that
 * are never opened at all (publish reads closed scenes straight from storage).
 */

/** Fields the legacy model understood. Anything else is reported rather than silently dropped. */
const KNOWN_STYLE_KEYS = new Set([
    'position', 'left', 'top', 'width', 'height', 'padding', 'margin', 'backgroundColor', 'color',
    'fontSize', 'fontFamily', 'fontWeight', 'textAlign', 'borderRadius', 'border', 'zIndex',
    'display', 'justifyContent', 'alignItems', 'gap',
]);

/** CSS colour (hex or rgb/rgba) to the engine's 0..1 sRGB tuple. */
function parseCssColor(value: any, fallback: [number, number, number, number]): [number, number, number, number] {
    if (typeof value !== 'string' || !value.trim()) return fallback;
    const text = value.trim();

    const hex = text.match(/^#([0-9a-f]{3,8})$/i);
    if (hex) {
        let h = hex[1];
        if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join('');
        const n = (i: number) => parseInt(h.slice(i * 2, i * 2 + 2), 16) / 255;
        return [n(0), n(1), n(2), h.length >= 8 ? n(3) : 1];
    }

    const rgb = text.match(/^rgba?\(([^)]+)\)$/i);
    if (rgb) {
        const parts = rgb[1].split(',').map(p => parseFloat(p.trim()));
        if (parts.length >= 3 && parts.every(p => isFinite(p)))
            return [parts[0] / 255, parts[1] / 255, parts[2] / 255, parts.length > 3 ? parts[3] : 1];
    }

    if (text === 'transparent') return [0, 0, 0, 0];
    return fallback;
}

const num = (v: any, fallback = 0): number => (typeof v === 'number' && isFinite(v) ? v : fallback);

function weightToNumber(w: any): number {
    if (typeof w === 'number') return w;
    if (w === 'bold') return 700;
    if (w === 'normal') return 400;
    return 400;
}

/** Map one legacy element (and its children) onto a serialized UI node. */
function convertElement(el: any, warnings: string[]): any | null {
    if (!el || typeof el !== 'object') return null;

    const style = (el.style && typeof el.style === 'object') ? el.style : {};
    for (const key of Object.keys(style))
        if (!KNOWN_STYLE_KEYS.has(key)) warnings.push(`${el.name || el.type}: dropped style '${key}'`);

    const left = num(style.left);
    const top = num(style.top);
    // A legacy element with no explicit size was content-sized. Nothing can measure here, so pick a
    // default and let `sizing: 'content'` have the DOM layer measure it on the first frame.
    const hasSize = typeof style.width === 'number' || typeof style.height === 'number';
    const width = num(style.width, el.type === 'text' ? 200 : 100);
    const height = num(style.height, el.type === 'text' ? 24 : 40);

    const padding = num(style.padding);
    const background = parseCssColor(style.backgroundColor, [0, 0, 0, 0]);
    const foreground = parseCssColor(style.color, [1, 1, 1, 1]);

    // `display: flex` plus a justify/align pair is the only layout the legacy model could express; it maps
    // exactly onto a stack.
    const isFlex = style.display === 'flex';
    const type = el.type === 'container' ? (isFlex ? 'uiStack' : 'uiPanel')
        : el.type === 'text' ? 'uiText'
            : el.type === 'image' ? 'uiImage'
                : el.type === 'button' ? 'uiButton'
                    : null;
    if (!type) {
        warnings.push(`skipped unknown element type '${el.type}'`);
        return null;
    }

    const ui: any = {
        // Absolute CSS left/top/width/height IS a top-left pin: both anchors at (0,0), offsets in pixels.
        anchorMin: [0, 0], anchorMax: [0, 0],
        offsetMin: [left, top],
        offsetMax: [left + width, top + height],
        pivot: [0, 0], rotationDeg: 0, scale2d: [1, 1],
        opacity: 1,
        // `tint` is the background on a box and the text colour on a text run.
        tint: type === 'uiText' ? foreground : background,
        zOrder: num(style.zIndex),
        // Only a button was ever clickable in the legacy overlay.
        interactive: type === 'uiButton',
        clip: false,
        sizing: hasSize ? 'fixed' : 'content',
        padding: [padding, padding, padding, padding],
        borderRadius: num(style.borderRadius),
        borderWidth: 0,
        borderColor: [0, 0, 0, 1],
    };

    if (type === 'uiText') {
        ui.text = String(el.content ?? '');
        ui.fontSize = num(style.fontSize, 16);
        ui.fontFamily = typeof style.fontFamily === 'string' ? style.fontFamily : '';
        ui.fontWeight = weightToNumber(style.fontWeight);
        ui.align = ['left', 'center', 'right'].includes(style.textAlign) ? style.textAlign : 'left';
        ui.vAlign = 'top';
        ui.wrap = true;
        ui.lineHeight = 1.2;
    } else if (type === 'uiImage') {
        // The legacy `src` was a raw URL or data URI that bypassed the texture store, so there is no id to
        // map it to; the reference is dropped with a warning and must be re-pointed at a real texture.
        if (el.src) warnings.push(`${el.name || 'image'}: image source '${String(el.src).slice(0, 40)}…' must be re-assigned from the texture library`);
        ui.textureId = null;
        ui.fit = 'fill';
        ui.uvRect = [0, 0, 1, 1];
    } else if (type === 'uiButton') {
        ui.label = String(el.label ?? 'Button');
        ui.disabled = false;
        ui.hoverTint = [1, 1, 1, 0.15];
        ui.pressedTint = [0, 0, 0, 0.2];
        ui.disabledTint = [0.5, 0.5, 0.5, 0.4];
    } else if (type === 'uiStack') {
        ui.direction = 'row';
        ui.gap = num(style.gap);
        ui.justify = style.justifyContent === 'center' ? 'center'
            : style.justifyContent === 'flex-end' ? 'end'
                : style.justifyContent === 'space-between' ? 'spaceBetween'
                    : style.justifyContent === 'space-around' ? 'spaceAround' : 'start';
        ui.align = style.alignItems === 'center' ? 'center'
            : style.alignItems === 'flex-end' ? 'end' : 'stretch';
        ui.reverse = false;
    }

    if (el.script) {
        warnings.push(`${el.name || el.type}: its script used the removed UI sandbox and was NOT ported — ` +
            `re-author it as a class script on the node`);
    }

    return {
        id: typeof el.id === 'string' && el.id ? el.id : cryptoRandomId(),
        name: el.name || type,
        type,
        position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        // Read `visible` straight off the raw JSON: the legacy sanitizer dropped it.
        visible: el.visible !== false,
        variables: [],
        spawnOnStart: true,
        children: Array.isArray(el.children)
            ? el.children.map((c: any) => convertElement(c, warnings)).filter(Boolean)
            : [],
        ui,
    };
}

/** True when the serialized subtree already contains a UI node — i.e. it has been migrated. */
function hasUINodes(json: any): boolean {
    if (typeof json?.type === 'string' && json.type.startsWith('ui') && json.ui) return true;
    return Array.isArray(json?.children) && json.children.some(hasUINodes);
}

/**
 * Fold a legacy `ui` blob into a serialized scene tree, as a `uiRoot` named 'UI' under the scene root.
 * Idempotent twice over — no blob, or a tree that already holds UI nodes — because publish and the play
 * builder both read closed-scene blobs and can reach it more than once.
 *
 * @param sceneJson The serialized ROOT node (`{ name: 'root', children: [...] }`).
 * @returns whether anything was migrated.
 */
export function migrateLegacyUI(sceneJson: any, ui: any): boolean {
    const elements = Array.isArray(ui?.elements) ? ui.elements : [];
    if (!sceneJson || elements.length === 0) return false;
    if (hasUINodes(sceneJson)) return false;

    const warnings: string[] = [];
    const children = elements.map((el: any) => convertElement(el, warnings)).filter(Boolean);
    if (children.length === 0) return false;

    const root = {
        id: cryptoRandomId(),
        name: 'UI',
        type: 'uiRoot',
        position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        visible: true,
        variables: [],
        spawnOnStart: true,
        children,
        ui: {
            anchorMin: [0, 0], anchorMax: [0, 0], offsetMin: [0, 0], offsetMax: [100, 100],
            pivot: [0, 0], rotationDeg: 0, scale2d: [1, 1],
            opacity: 1, tint: [1, 1, 1, 1], zOrder: 0, interactive: false, clip: false,
            sizing: 'fixed', padding: [0, 0, 0, 0], borderRadius: 0, borderWidth: 0, borderColor: [0, 0, 0, 1],
            space: 'screen',
            // The legacy overlay positioned everything in raw CSS pixels, which only `constantPixel`
            // reproduces; anything else silently rescales every migrated HUD.
            referenceResolution: [1920, 1080],
            scaleMode: 'constantPixel',
            matchWidthOrHeight: 0.5,
            referenceDpr: 1,
            uiTargetId: null, referenceDistance: 10, minScale: 0.1, maxScale: 4,
            billboard: true, clampToScreen: false, hideBehindCamera: true,
        },
    };

    sceneJson.children = Array.isArray(sceneJson.children) ? [...sceneJson.children, root] : [root];

    Logger.info(`Migrated ${children.length} legacy UI element(s) into scene nodes`, 'UI');
    for (const warning of warnings) Logger.warn(warning, 'UI');
    return true;
}

/**
 * Run the migration against a game-data blob and strip the legacy key.
 * The `ui` key lives at the top level, and older saves put it on `scene.ui`; both are consumed here.
 */
export function migrateGameDataUI(json: any): boolean {
    if (!json) return false;
    const blob = json.ui ?? json.scene?.ui;
    const migrated = migrateLegacyUI(json.scene, blob);
    delete json.ui;
    if (json.scene) delete json.scene.ui;
    return migrated;
}
