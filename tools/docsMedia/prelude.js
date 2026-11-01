// Helpers in scope for every /eval body (tools/docsMedia/run.cjs). `CLEO_URL` is prepended by the driver: the
// engine module the editor itself loaded, so its singletons (CleoEngine.instance, Game) are the live ones.
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const cleo = () => import(/* @vite-ignore */ CLEO_URL);
const engine = async () => (await cleo()).CleoEngine.instance;
const scene = async () => (await engine())?.scene;
const renderer = async () => (await engine())?.renderer;

/** Hold a key (KeyboardEvent.code) for `ms`. The input sampler listens on window and takes untrusted events. */
const keyDown = (code) => window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }));
const keyUp = (code) => window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true }));
const key = async (code, ms = 120) => { keyDown(code); await wait(ms); keyUp(code); };

/** The first visible element whose title, aria-label or own text is exactly `text`. */
const byText = (text, root = document) => [...root.querySelectorAll('button, [role=button], [role=tab], [role=menuitem], a, span, div, li')]
    .find(el => el.offsetParent !== null && ((el.getAttribute('title') ?? '').trim() === text || (el.getAttribute('aria-label') ?? '').trim() === text
        || (el.children.length === 0 && el.textContent.trim() === text)));
const click = async (text) => {
    const el = typeof text === 'string' ? byText(text) : text;
    if (!el) throw new Error(`nothing to click: ${text}`);
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    el.click();
    await wait(150);
    return true;
};

/** The 3D viewport's canvas rectangle, in CSS pixels: [x, y, w, h]. */
const viewportRect = () => {
    const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
    const r = c.getBoundingClientRect();
    return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
};

/** Find a node by name anywhere in the active scene. */
const node = async (name) => {
    const s = await scene();
    let found = null;
    const walk = (n) => { if (found) return; if (n.name === name) found = n; for (const c of n.children ?? []) walk(c); };
    for (const n of s.nodes ?? s.root?.children ?? []) walk(n);
    return found;
};

/** Put the active camera at `pos` looking at `target` (degrees; engine forward is +Z, +pitch looks down). */
const lookAt = async (pos, target) => {
    const s = await scene();
    const cam = s.activeCamera;
    const dx = target[0] - pos[0], dy = target[1] - pos[1], dz = target[2] - pos[2];
    const yaw = Math.atan2(dx, dz) * 180 / Math.PI;
    const pitch = -Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI;
    cam.setPosition(pos);
    cam.setRotation([pitch, yaw, 0]);
    return { yaw, pitch };
};

/** The editor's boot steps (app-kit loadingStore): true once every one has settled. */
const APPKIT = CLEO_URL.replace('/src/cleo.ts', '/applications/app-kit/src/');
const loadState = async () => {
    const m = await import(/* @vite-ignore */ APPKIT + 'feedback/loadingStore.ts');
    const l = m.currentLoad();
    return l ? l.steps.map(s => `${s.label}:${s.status}`) : null;
};

/**
 * Pin the 3D viewport over the whole window (or put it back): gameplay shots at the full capture size. Only the
 * capture's own page is restyled; the engine's resize observer re-renders at the new size. Overlays inside the
 * viewport (the toolbar, gizmo buttons) are hidden with it unless `keepOverlays`.
 */
const fullscreenViewport = async (on = true, keepOverlays = false) => {
    const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
    const host = c.parentElement;
    let style = document.getElementById('docs-media-fullscreen');
    if (!on) { style?.remove(); host.removeAttribute('data-docs-media'); host.style.removeProperty('left'); host.style.removeProperty('top'); await wait(800); return viewportRect(); }
    host.setAttribute('data-docs-media', '1');
    if (!style) { style = document.createElement('style'); style.id = 'docs-media-fullscreen'; document.head.appendChild(style); }
    style.textContent = `[data-docs-media] { position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; z-index: 99999 !important; }
        [data-docs-media] > canvas { width: 100% !important; height: 100% !important; }
        ${keepOverlays ? '' : '[data-docs-media] > :not(canvas) { display: none !important; }'}`;
    await wait(300);
    // A transformed ancestor makes `fixed` relative to itself: shift by wherever it landed, so it covers the window.
    const r = host.getBoundingClientRect();
    host.style.setProperty('left', `${-r.x}px`, 'important');
    host.style.setProperty('top', `${-r.y}px`, 'important');
    await wait(1200);
    return viewportRect();
};

/** The landscape's height at world x, z (for placing cameras above the ground), or 0 with no landscape. */
const groundAt = async (x, z) => {
    const s = await scene();
    let land = null;
    const walk = (n) => { if (land) return; if (n.nodeType === 'landscape') land = n; for (const c of n.children ?? []) walk(c); };
    for (const n of s.nodes ?? []) walk(n);
    if (!land) return 0;
    const t = land.terrain;
    const p = land.worldPosition;
    return (t.heightAt?.(x - p[0], z - p[2]) ?? t.sampleHeight?.(x - p[0], z - p[2]) ?? 0) + p[1];
};

/** Put the camera `dist` metres from `target` at compass `yaw` and `elev` degrees up, never below ground + 2 m. */
const orbit = async (target, dist, yaw, elev) => {
    const a = yaw * Math.PI / 180, e = elev * Math.PI / 180;
    const pos = [target[0] - Math.sin(a) * Math.cos(e) * dist, target[1] + Math.sin(e) * dist, target[2] - Math.cos(a) * Math.cos(e) * dist];
    pos[1] = Math.max(pos[1], (await groundAt(pos[0], pos[2])) + 2);
    return lookAt(pos, target);
};

/** A full pointer press on an element (dockview tabs and menus listen for pointer events, not click). */
const press = async (el) => {
    if (typeof el === 'string') el = byText(el);
    if (!el) throw new Error('nothing to press');
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerdown', o));
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new PointerEvent('pointerup', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
    await wait(300);
    return true;
};
/** A dock tab by its title. */
const tab = (title) => [...document.querySelectorAll('.dv-tab, [role=tab]')].find(t => t.textContent.trim() === title);
/** A scene-tree row by node name. */
const treeRow = (name) => [...document.querySelectorAll('[role=treeitem], [data-node-id], .tree-row, div')].find(el => el.children.length <= 3 && el.textContent.trim() === name && el.offsetParent !== null);

/** Patch the live render settings (e.g. { dofEnabled: false } for a free camera far from the DoF focus). */
const renderSettings = async (patch) => {
    const r = await renderer();
    r.applyRenderSettings({ ...r.getRenderSettings(), ...patch });
    return true;
};
/**
 * The engine canvas's own pixels, as a PNG data URL at the full render size. Read in the same task the renderer
 * presents in: a WebGPU canvas's texture is only valid until that task ends, so a read from any other callback
 * comes back black.
 */
const canvasDataUrl = async () => {
    const r = await renderer();
    return new Promise(res => {
        r.render = function (s) {
            Object.getPrototypeOf(r).render.call(this, s);
            delete r.render;
            res(document.querySelector('canvas').toDataURL('image/png'));
        };
    });
};

/** Type into an input the way React sees it (the native setter, then an input event). */
const typeInto = async (input, text) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(600);
};
/** Open an asset from the explorer by name: search for it, then double-click its card or row. */
const openAsset = async (name) => {
    await press(tab('Assets'));
    const search = [...document.querySelectorAll('input')].find(i => i.placeholder === 'Search' && i.offsetParent !== null);
    await typeInto(search, name);
    await wait(1200);
    const hit = [...document.querySelectorAll('*')].filter(el => el.offsetParent !== null && el.children.length === 0 && el.textContent.trim() === name);
    const target = hit[hit.length - 1];
    if (!target) throw new Error(`asset not found: ${name}`);
    const r = target.getBoundingClientRect();
    target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.x + 4, clientY: r.y + 4 }));
    await wait(2500);
    return true;
};

/** A scene/editor tab in the strip under the menu bar, by its title. */
const editorTab = (title) => [...document.querySelectorAll('div.group')].find(el => el.textContent.trim() === title && el.getBoundingClientRect().y > 28 && el.getBoundingClientRect().y < 60);
