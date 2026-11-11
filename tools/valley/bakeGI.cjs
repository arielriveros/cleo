// Bake an example's GI Volumes into it: the editor on a private dev server, in Chrome with WebGPU, the
// example imported, every volume of its scenes captured afresh, its capture exported, and the bakes written
// into the example's assets under each volume's bakeId.
//
//   node tools/valley/bakeGI.cjs                     # the Valley: fresh captures of every volume
//   node tools/valley/bakeGI.cjs --example dungeon   # the Dungeon
//   node tools/valley/bakeGI.cjs --url http://127.0.0.1:8090/    # an editor dev server already running
//   node tools/valley/bakeGI.cjs --example firing-line --scenes "Firing Line"   # another example (its volumes already name a bakeId)
//   node tools/valley/bakeGI.cjs --only "Hamlet GI"              # one volume (by name); the rest keep theirs
//   node tools/valley/bakeGI.cjs --scene <name>                  # one scene's volumes; the others keep theirs
//   node tools/valley/bakeGI.cjs --vite-config vite.other.config.ts  # the private dev server on another config
//
// With --url the dev server is someone else's and stays up: stop it before the bakes are written if it
// watches applications/editor/public (a watcher holding the old parts open fails the write with EBUSY).
//
// Why Chrome and not Electron: as tools/docsMedia/run.cjs explains, the desktop shell's Dawn runs out of
// memory on the Valley. The installed Chrome runs the editor on WebGPU. The page is the editor exactly as a
// user would open it, so a bake is what the editor's own "Save bake" would store.
//
// A bake is the volume's hit cache (what each probe ray met), not its light: the light is relit at runtime
// from it. It goes stale only when the geometry round the volume moves, which a load detects (the bake's
// geometry signature) and answers by capturing again.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const EXAMPLE = arg('--example') ?? 'valley';
const OUT = path.join(ROOT, 'applications', 'editor', 'public', 'examples', EXAMPLE);
const EDITOR_PORT = Number(process.env.GI_BAKE_PORT ?? 8092), CDP_PORT = Number(process.env.GI_BAKE_CDP ?? 9336);
const CHROME = process.env.CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE = path.join(os.tmpdir(), 'cleo-gi-bake-chrome');
const CLEO_URL = '/@fs/' + ROOT.split(path.sep).join('/') + '/src/cleo.ts';
const PRELUDE = 'const CLEO_URL = ' + JSON.stringify(CLEO_URL) + ';\n'
    + fs.readFileSync(path.join(ROOT, 'tools', 'docsMedia', 'prelude.js'), 'utf8');
/** Per volume: how long its capture may take before the bake gives up on it (it keeps its old bake). */
const VOLUME_TIMEOUT_MS = 20 * 60 * 1000;

const URL_ARG = arg('--url');
const ONLY = arg('--only');
const SCENE = arg('--scene');
/** The example's scenes, in the order they are baked: the one it opens with, then the others by name (its manifest's, by default). */
const SCENES = arg('--scenes') ? arg('--scenes').split(',') : (() => {
    const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));
    const metas = manifest.sceneMetas ?? [];
    return [...metas.filter(m => m.id === manifest.mainSceneId), ...metas.filter(m => m.id !== manifest.mainSceneId)].map(m => m.name);
})();
const VITE_CONFIG = arg('--vite-config');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const children = [];
function stopAll() {
    for (const c of children) {
        try { execSync(`taskkill /pid ${c.pid} /T /F`, { stdio: 'ignore' }); } catch { /* gone */ }
    }
}
async function waitFor(url, ms = 180000) {
    const start = Date.now();
    while (Date.now() - start < ms) {
        try { const r = await fetch(url); if (r.ok) return r; } catch { /* not up yet */ }
        await sleep(500);
    }
    throw new Error(`timed out waiting for ${url}`);
}

// --- DevTools protocol ------------------------------------------------------------------------------------

let ws, nextId = 1, closed = false;
const pending = new Map();
function cdp(method, params = {}) {
    if (closed) return Promise.reject(new Error('the DevTools connection closed'));
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function connect() {
    const targets = await (await waitFor(`http://127.0.0.1:${CDP_PORT}/json`)).json();
    const page = targets.find(t => t.type === 'page');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    // A closed connection fails what is waiting on it: a pending reply alone keeps nothing alive, and the
    // script would otherwise just stop, exit code 0, with nothing said.
    ws.onclose = () => {
        for (const p of pending.values()) p.reject(new Error('the DevTools connection closed'));
        pending.clear();
        closed = true;
    };
    ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.id && pending.has(msg.id)) {
            const p = pending.get(msg.id); pending.delete(msg.id);
            msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
        } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
            console.log(`[page error] ${msg.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300)}`);
        } else if (msg.method === 'Inspector.targetCrashed') console.log('[bakeGI] page crashed');
    };
    await cdp('Runtime.enable');
    await cdp('Page.enable');
    await cdp('Inspector.enable').catch(() => {});
}

/** Run `body` (an async function body, prelude.js's helpers in scope) in the page; its JSON result. */
async function evaluate(body) {
    const expression = `(async () => { ${PRELUDE}\n${body} })().then(v => JSON.stringify(v === undefined ? null : v), e => JSON.stringify({ __error: String(e && e.stack || e) }))`;
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 600000 });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
    const value = JSON.parse(r.result.value);
    if (value && value.__error) throw new Error(value.__error);
    return value;
}

/** Poll `body` until it answers truthy (exceptions count as not yet: the page may be reloading). */
async function until(body, ms, label) {
    const start = Date.now();
    while (Date.now() - start < ms) {
        if (closed) throw new Error(`the browser went away waiting for ${label}`);
        try { const v = await evaluate(body); if (v) return v; } catch { /* between pages */ }
        await sleep(2000);
    }
    throw new Error(`timed out: ${label}`);
}

// --- The bake ---------------------------------------------------------------------------------------------

/** The page's Valley, booted: its scene has its GI volumes and the editor's boot steps have all settled. */
const BOOTED = `
    const e = await engine();
    if (!e?.scene || e.scene.giVolumes.size === 0) return false;
    const steps = await loadState();
    return !steps || steps.every(s => !s.endsWith(':pending') && !s.endsWith(':running'));
`;

async function main() {
    let url = URL_ARG;
    if (!url) {
        const editor = path.join(ROOT, 'applications', 'editor');
        const viteArgs = ['vite', '--port', String(EDITOR_PORT), '--strictPort', '--host', '127.0.0.1'];
        if (VITE_CONFIG) viteArgs.push('--config', VITE_CONFIG);
        const child = spawn('npx', viteArgs, {
            cwd: editor, shell: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.on('data', d => process.stdout.write(`[vite] ${d}`));
        child.stderr.on('data', d => process.stderr.write(`[vite] ${d}`));
        children.push(child);
        url = `http://127.0.0.1:${EDITOR_PORT}/`;
    }
    await waitFor(url);
    // A browser already on the port (a run that was killed leaves its Chrome behind) would take this
    // run's window and drop it: refuse instead.
    try {
        await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
        throw new Error(`something already listens on ${CDP_PORT} (a Chrome left by an earlier run?): close it, or set GI_BAKE_CDP`);
    } catch (e) { if (String(e.message).startsWith('something already')) throw e; }
    fs.rmSync(PROFILE, { recursive: true, force: true });
    children.push(spawn(CHROME, [
        `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check',
        '--enable-unsafe-webgpu', '--window-size=1600,900', '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', url,
    ], { stdio: 'ignore' }));
    await connect();

    // WebGPU, then the Valley as a new project (it reloads into it).
    await until(`localStorage.setItem('cleo_renderer_backend', 'webgpu'); return true;`, 60000, 'the editor page');
    await cdp('Page.reload');
    await sleep(3000);
    await until(`
        const ex = await import('/src/utils/examples.ts');
        const entry = (await ex.loadExampleIndex()).find(x => x.slug === ${JSON.stringify(EXAMPLE)});
        if (!entry) return false;
        setTimeout(() => ex.importExample(entry, undefined, true), 0);
        return true;`, 120000, 'the example index');
    log('importing the Valley');
    await sleep(10000);
    await until(BOOTED, 15 * 60 * 1000, 'the Valley to boot');
    log('the Valley is open');

    // Start from what the example carries: a volume this run does not bake keeps its bake.
    const { packFormat2, readGiBakes } = await import(pathToFileURL(path.join(ROOT, 'tools', 'exampleKit', 'packFormat2.mjs')).href);
    const bakes = new Map(readGiBakes(OUT).map(b => [b.id, b.bytes]));

    // Every scene is opened, even one this run does not bake: its volumes name the bakes it keeps.
    const volumes = [];
    for (const name of SCENES) {
        const seen = new Set(volumes.map(v => v.id));
        if (name !== SCENES[0]) {
            await evaluate(`await openAsset(${JSON.stringify(name)}); return true;`);
            // Open once the engine holds the scene's own volumes and the editor has settled.
            await until(`
                const opened = await engine();
                const ids = [...(opened?.scene?.giVolumes ?? [])].map(v => v.id);
                if (ids.length === 0 || ids.some(id => ${JSON.stringify([...seen])}.includes(id))) return false;
                ${BOOTED}`, 5 * 60 * 1000, `the ${name} scene to open`);
            log(`the ${name} scene is open`);
        }
        const own = await evaluate(`
            const s = await scene();
            return [...s.giVolumes].map(v => ({ id: v.id, name: v.name, bakeId: v.bakeId, probes: v.probeCount,
                centre: [...v.worldPosition] }));`);
        volumes.push(...own);
        const chosen = own.filter(v => v.bakeId && (!SCENE || SCENE === name) && (!ONLY || v.name === ONLY));
        log(`${name}: ${own.length} GI volumes, baking ${chosen.length}: ${chosen.map(v => `${v.name} (${v.probes})`).join(', ')}`);
        await bakeVolumes(chosen, bakes);
    }

    // Only the bakes a volume of the example names.
    const wanted = new Set(volumes.map(v => v.bakeId).filter(Boolean));
    const giBakes = [...bakes].filter(([id]) => wanted.has(id)).map(([id, bytes]) => ({ id, bytes }));
    stopAll();
    children.length = 0;
    await sleep(1000);
    const largest = await packFormat2(OUT, { giBakes });
    const total = giBakes.reduce((n, b) => n + b.bytes.length, 0);
    log(`${giBakes.length} GI bakes (${(total / 1048576).toFixed(1)} MB) written into applications/editor/public/examples/${EXAMPLE}/; largest file ${(largest / 1048576).toFixed(1)} MB`);
}

/** Capture each of `chosen` (volumes of the open scene) afresh and put its bake in `bakes` by bakeId. */
async function bakeVolumes(chosen, bakes) {
    for (const v of chosen) {
        const started = Date.now();
        // The camera inside the volume (its capture runs nearest the camera first) and the editor's fill
        // budget raised. A volume that loaded a bake drops it and captures afresh; one without is capturing
        // already, since the project opened.
        await evaluate(`
            const c = await cleo(); const e = await engine(); const s = e.scene;
            const v = [...s.giVolumes].find(x => x.id === ${JSON.stringify(v.id)});
            const p = ${JSON.stringify(v.centre)};
            await lookAt([p[0], p[1] + 0.5, p[2]], [p[0], p[1] + 0.5, p[2] + 1]);
            e.renderer.gi.fillDrawsPerFrame = 400;
            if (c.GiBakeRegistry.get(v.bakeId)) {
                c.GiBakeRegistry.delete(v.bakeId);
                v.requestCapture();
            }
            return true;`);
        await sleep(3000);
        try {
            await until(`
                const e = await engine();
                const v = [...e.scene.giVolumes].find(x => x.id === ${JSON.stringify(v.id)});
                return !!v && e.renderer.gi.isCaptured(v);`,
                VOLUME_TIMEOUT_MS, `${v.name} to capture`);
        } catch (e) {
            log(`${v.name}: ${e.message}; it keeps the bake it had`);
            continue;
        }
        const out = await evaluate(`
            const e = await engine();
            const v = [...e.scene.giVolumes].find(x => x.id === ${JSON.stringify(v.id)});
            const bytes = await e.renderer.gi.exportBake(v, e.scene);
            if (!bytes) return null;
            let s = '';
            for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
            const d = e.renderer.gi.describe().find(x => x.id === v.id);
            return { b64: btoa(s), active: d.active, probes: d.probes };`);
        if (!out) { log(`${v.name}: nothing to export; it keeps the bake it had`); continue; }
        const bytes = Buffer.from(out.b64, 'base64');
        bakes.set(v.bakeId, bytes);
        log(`${v.name}: ${out.active} of ${out.probes} probes active, ${(bytes.length / 1048576).toFixed(2)} MB, ${((Date.now() - started) / 1000).toFixed(0)} s`);
    }
}

process.on('SIGINT', () => { stopAll(); process.exit(1); });
main().then(() => { stopAll(); process.exit(0); }, (e) => { console.error(e); stopAll(); process.exit(1); });
