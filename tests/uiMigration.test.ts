import { describe, it, expect } from 'vitest';
import { migrateLegacyUI, migrateGameDataUI } from '../editor/src/utils/uiMigration';
import { Node } from '../src/core/scene/nodes/node';
import { UIRootNode } from '../src/core/scene/nodes/ui/uiRoot';
import { UIPanelNode, UIStackNode } from '../src/core/scene/nodes/ui/uiContainers';
import { UITextNode } from '../src/core/scene/nodes/ui/uiContent';
import { UIButtonNode } from '../src/core/scene/nodes/ui/uiWidgets';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';

const sceneRoot = () => ({ name: 'root', type: 'node', children: [] as any[] });

const legacy = (elements: any[]) => ({ version: 1, elements });

describe('migrateLegacyUI', () => {
    it('does nothing when there is no legacy blob', () => {
        const scene = sceneRoot();
        expect(migrateLegacyUI(scene, undefined)).toBe(false);
        expect(migrateLegacyUI(scene, { version: 1, elements: [] })).toBe(false);
        expect(scene.children).toEqual([]);
    });

    it('appends one uiRoot holding the converted elements', () => {
        const scene = sceneRoot();
        const ok = migrateLegacyUI(scene, legacy([
            { id: 'a', type: 'text', name: 'Score', content: 'Score: 0', style: { left: 20, top: 20 } },
        ]));
        expect(ok).toBe(true);
        expect(scene.children).toHaveLength(1);
        expect(scene.children[0].type).toBe('uiRoot');
        expect(scene.children[0].name).toBe('UI');
        expect(scene.children[0].children[0].type).toBe('uiText');
    });

    // The legacy overlay laid everything out in raw CSS pixels. Anything but constantPixel would silently
    // rescale every migrated HUD relative to where the author left it.
    it('uses constantPixel so a migrated HUD keeps its authored pixel positions', () => {
        const scene = sceneRoot();
        migrateLegacyUI(scene, legacy([{ id: 'a', type: 'container', style: { left: 0, top: 0 }, children: [] }]));
        expect(scene.children[0].ui.scaleMode).toBe('constantPixel');
    });

    it('maps absolute left/top/width/height onto a top-left pin', () => {
        const scene = sceneRoot();
        migrateLegacyUI(scene, legacy([
            { id: 'p', type: 'container', style: { left: 30, top: 40, width: 200, height: 100 }, children: [] },
        ]));
        const panel = scene.children[0].children[0];
        expect(panel.ui.anchorMin).toEqual([0, 0]);
        expect(panel.ui.anchorMax).toEqual([0, 0]);
        expect(panel.ui.offsetMin).toEqual([30, 40]);
        expect(panel.ui.offsetMax).toEqual([230, 140]);
    });

    it('maps the four legacy types, and a flex container to a stack', () => {
        const scene = sceneRoot();
        migrateLegacyUI(scene, legacy([
            { id: '1', type: 'container', style: {}, children: [] },
            { id: '2', type: 'text', content: 'hi', style: {} },
            { id: '3', type: 'image', src: 'data:image/png;base64,AAA', style: {} },
            { id: '4', type: 'button', label: 'Go', style: {} },
            { id: '5', type: 'container', style: { display: 'flex', justifyContent: 'space-between', gap: 8 }, children: [] },
        ]));
        const kids = scene.children[0].children;
        expect(kids.map((k: any) => k.type)).toEqual(['uiPanel', 'uiText', 'uiImage', 'uiButton', 'uiStack']);
        expect(kids[4].ui.justify).toBe('spaceBetween');
        expect(kids[4].ui.gap).toBe(8);
    });

    it('converts CSS colours, sending background to a panel and text colour to a text run', () => {
        const scene = sceneRoot();
        migrateLegacyUI(scene, legacy([
            { id: '1', type: 'container', style: { backgroundColor: 'rgba(0,0,0,0.5)' }, children: [] },
            { id: '2', type: 'text', content: 'x', style: { color: '#ff8000' } },
        ]));
        const [panel, text] = scene.children[0].children;
        expect(panel.ui.tint[3]).toBeCloseTo(0.5, 5);
        expect(text.ui.tint[0]).toBeCloseTo(1, 2);
        expect(text.ui.tint[1]).toBeCloseTo(0.5, 1);
        expect(text.ui.tint[2]).toBeCloseTo(0, 2);
    });

    // The legacy `parseUI` sanitizer dropped `visible` entirely, so a saved-hidden element came back
    // visible on every load — the classic "my Game Over panel is always on screen" bug.
    it('preserves visible: false, which the legacy model dropped', () => {
        const scene = sceneRoot();
        migrateLegacyUI(scene, legacy([
            { id: '1', type: 'container', name: 'GameOver', visible: false, style: {}, children: [] },
            { id: '2', type: 'container', name: 'Hud', style: {}, children: [] },
        ]));
        const [over, hud] = scene.children[0].children;
        expect(over.visible).toBe(false);
        expect(hud.visible).toBe(true);
    });

    it('keeps nesting', () => {
        const scene = sceneRoot();
        migrateLegacyUI(scene, legacy([
            {
                id: 'root', type: 'container', style: { left: 10, top: 10 }, children: [
                    { id: 'kid', type: 'text', content: 'inner', style: { left: 5, top: 5 } },
                ],
            },
        ]));
        const panel = scene.children[0].children[0];
        expect(panel.children).toHaveLength(1);
        expect(panel.children[0].type).toBe('uiText');
    });

    it('only marks an element content-sized when it had no explicit size', () => {
        const scene = sceneRoot();
        migrateLegacyUI(scene, legacy([
            { id: '1', type: 'text', content: 'a', style: { left: 0, top: 0 } },
            { id: '2', type: 'text', content: 'b', style: { left: 0, top: 0, width: 120, height: 20 } },
        ]));
        const [auto, fixed] = scene.children[0].children;
        expect(auto.ui.sizing).toBe('content');
        expect(fixed.ui.sizing).toBe('fixed');
    });

    it('skips an unknown element type instead of producing a broken node', () => {
        const scene = sceneRoot();
        migrateLegacyUI(scene, legacy([{ id: '1', type: 'videoPlayer', style: {} }]));
        expect(scene.children).toEqual([]);
    });

    it('is idempotent: a second run over a migrated tree does nothing', () => {
        const scene = sceneRoot();
        const blob = legacy([{ id: '1', type: 'text', content: 'x', style: {} }]);
        expect(migrateLegacyUI(scene, blob)).toBe(true);
        expect(migrateLegacyUI(scene, blob)).toBe(false);
        expect(scene.children).toHaveLength(1);
    });

    it('produces nodes that actually parse back into the right classes', () => {
        const scene = sceneRoot();
        migrateLegacyUI(scene, legacy([
            { id: '1', type: 'container', style: { left: 10, top: 10, width: 300, height: 80 }, children: [
                { id: '2', type: 'text', content: 'Health', style: { left: 8, top: 8, color: '#ffffff' } },
                { id: '3', type: 'button', label: 'Quit', style: { left: 8, top: 40 } },
            ] },
            { id: '4', type: 'container', style: { display: 'flex' }, children: [] },
        ]));

        const parent = new Node('parent');
        parseNodeJson(parent, scene.children[0]);
        const root = parent.children[0] as UIRootNode;

        expect(root).toBeInstanceOf(UIRootNode);
        expect(root.scaleMode).toBe('constantPixel');
        const panel = root.children[0] as UIPanelNode;
        expect(panel).toBeInstanceOf(UIPanelNode);
        expect(panel.offsetMin).toEqual([10, 10]);
        expect(panel.offsetMax).toEqual([310, 90]);
        expect(panel.children[0]).toBeInstanceOf(UITextNode);
        expect((panel.children[0] as UITextNode).text).toBe('Health');
        expect(panel.children[1]).toBeInstanceOf(UIButtonNode);
        expect((panel.children[1] as UIButtonNode).label).toBe('Quit');
        expect(root.children[1]).toBeInstanceOf(UIStackNode);
    });
});

describe('migrateGameDataUI', () => {
    it('consumes the top-level ui key and removes it', () => {
        const json: any = { scene: sceneRoot(), ui: legacy([{ id: '1', type: 'text', content: 'x', style: {} }]) };
        expect(migrateGameDataUI(json)).toBe(true);
        expect(json.ui).toBeUndefined();
        expect(json.scene.children[0].type).toBe('uiRoot');
    });

    it('also handles the older scene.ui placement', () => {
        const json: any = { scene: { ...sceneRoot(), ui: legacy([{ id: '1', type: 'text', content: 'x', style: {} }]) } };
        expect(migrateGameDataUI(json)).toBe(true);
        expect(json.scene.ui).toBeUndefined();
        expect(json.scene.children[0].type).toBe('uiRoot');
    });

    it('strips the legacy key even when there was nothing to migrate', () => {
        const json: any = { scene: sceneRoot(), ui: { version: 1, elements: [] } };
        expect(migrateGameDataUI(json)).toBe(false);
        expect(json.ui).toBeUndefined();
    });

    it('survives a blob with no scene', () => {
        const json: any = { ui: legacy([{ id: '1', type: 'text', content: 'x', style: {} }]) };
        expect(migrateGameDataUI(json)).toBe(false);
        expect(json.ui).toBeUndefined();
    });
});
