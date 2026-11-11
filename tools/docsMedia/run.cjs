// Docs media capture: Chrome, with a profile of its own, on a PRIVATE editor dev server, driven over the DevTools
// protocol behind a tiny local HTTP API.
//
//   node tools/docsMedia/run.cjs
//
// Why Chrome and not Electron: the desktop shell's Electron 31 ships a Dawn whose D3D12 backend runs out of memory
// once the Valley enters Play, and the editor's WebGL2 path does not compile the cloud shader. The installed Chrome
// runs both the editor and Play on WebGPU.
//
// It starts the editor (8090) and the Creator (8091) dev servers -- never the user's own 8080/8081 -- opens a
// 1600x900 window with WebGPU, and listens on 127.0.0.1:8095:
//
//   POST /eval            body = an async function body run in the page, with prelude.js's helpers in scope;
//                         answers its JSON result.
//   POST /shot?out=F      a screenshot of the page to PNG F; &crop=x,y,w,h crops to a CSS-pixel rectangle.
//   POST /canvas?out=F    the engine canvas's own pixels (full render size) to PNG F.
//   POST /frames?dir=D&n=N&fps=F[&crop=…]   N PNG frames into D, F per second (for a GIF).
//   POST /record?dir=D&seconds=S   a screencast: S seconds of frames as JPEGs in D, with frames.json (times).
//   POST /click?x=X&y=Y   a real left click at CSS pixel (X, Y).
//   POST /drag?x1=&y1=&x2=&y2=[&steps=N]   a real left-button drag between two CSS pixels.
//   POST /files?selector=S&path=F[&path=…]   files picked into the <input type=file> matching S.
//   POST /reload, POST /quit
//
// tools/docsMedia/README.md lists every shot and the calls that take it.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
// DOCS_MEDIA_EDITOR_PORT / _CREATOR_PORT / _CDP_PORT / _PROFILE let a second session (another worktree) run beside one.
const EDITOR_PORT = Number(process.env.DOCS_MEDIA_EDITOR_PORT ?? 8090), CREATOR_PORT = Number(process.env.DOCS_MEDIA_CREATOR_PORT ?? 8091);
const CONTROL_PORT = Number(process.env.DOCS_MEDIA_PORT ?? 8095), CDP_PORT = Number(process.env.DOCS_MEDIA_CDP_PORT ?? 9333);
const WIDTH = 1600, HEIGHT = 900;
const CHROME = process.env.CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE = process.env.DOCS_MEDIA_PROFILE ?? path.join(os.tmpdir(), 'cleo-docs-media-chrome');
// The engine module exactly as the editor imports it (outside the editor root, so served under /@fs/).
const CLEO_URL = '/@fs/' + ROOT.split(path.sep).join('/') + '/src/cleo.ts';
// Read per call, so the helpers can be edited while the window stays up.
const prelude = () => 'const CLEO_URL = ' + JSON.stringify(CLEO_URL) + ';\n' + fs.readFileSync(path.join(__dirname, 'prelude.js'), 'utf8');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const children = [];
function serve(cwd, port, env = {}) {
    // DOCS_MEDIA_VITE_CONFIG: a config file name in each app folder (e.g. one with its own cacheDir, for a worktree
    // whose node_modules is shared with another checkout's dev server).
    const config = process.env.DOCS_MEDIA_VITE_CONFIG ? ['--config', process.env.DOCS_MEDIA_VITE_CONFIG] : [];
    const child = spawn('npx', ['vite', ...config, '--port', String(port), '--strictPort'], {
        cwd, env: { ...process.env, ...env }, shell: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', d => process.stdout.write(`[vite ${port}] ${d}`));
    child.stderr.on('data', d => process.stderr.write(`[vite ${port}] ${d}`));
    children.push(child);
}
async function waitFor(url, ms = 120000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        try { const r = await fetch(url); if (r.ok) return r; } catch { /* not up yet */ }
        await sleep(500);
    }
    throw new Error(`timed out waiting for ${url}`);
}
function stopAll() {
    for (const c of children) {
        try { execSync(`taskkill /pid ${c.pid} /T /F`, { stdio: 'ignore' }); } catch { /* gone */ }
    }
}

// --- DevTools protocol ------------------------------------------------------------------------------------

let ws, nextId = 1;
const pending = new Map();
function cdp(method, params = {}) {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function connect() {
    const targets = await (await waitFor(`http://127.0.0.1:${CDP_PORT}/json`)).json();
    const page = targets.find(t => t.type === 'page');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.id && pending.has(msg.id)) {
            const p = pending.get(msg.id); pending.delete(msg.id);
            msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
        } else if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
            console.log(`[page ${msg.params.type}] ${msg.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300)}`);
        } else if (msg.method === 'Page.screencastFrame') {
            // Acknowledge at once, or Chrome stops sending; keep the frame only while a recording is open.
            cdp('Page.screencastFrameAck', { sessionId: msg.params.sessionId }).catch(() => {});
            if (recording) recording.push({ t: msg.params.metadata.timestamp, data: msg.params.data });
        } else if (msg.method === 'Inspector.targetCrashed') console.log('[docsMedia] page crashed');
    };
    await cdp('Runtime.enable');
    await cdp('Page.enable');
    // Files changing under the dev servers (another editor at work) must not reload the page mid-session: the
    // Vite client's socket drops its reload and update messages. /reload still reloads.
    await cdp('Page.addScriptToEvaluateOnNewDocument', { source: FREEZE_HMR });
    await cdp('Inspector.enable').catch(() => {});
    // A fixed CSS viewport, so shots are the same size on every machine.
    await cdp('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
}

/** Installed before any page script: Vite's HMR socket (protocol `vite-hmr`) never delivers `full-reload` or `update`. */
const FREEZE_HMR = `(() => {
    const W = window.WebSocket;
    const Wrapped = function (url, protocols) {
        const ws = protocols === undefined ? new W(url) : new W(url, protocols);
        if (String(protocols ?? '').includes('vite-hmr')) {
            const add = ws.addEventListener.bind(ws);
            ws.addEventListener = (type, fn, opts) => add(type, type !== 'message' ? fn : (ev) => {
                try { const t = JSON.parse(ev.data).type; if (t === 'full-reload' || t === 'update') return; } catch { /* not JSON */ }
                fn(ev);
            }, opts);
        }
        return ws;
    };
    Wrapped.prototype = W.prototype;
    Object.assign(Wrapped, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    window.WebSocket = Wrapped;
})();`;

/** Screencast frames while a /record is open: { t: seconds, data: base64 JPEG }. */
let recording = null;

async function evalInPage(body) {
    const expression = `(async () => { ${prelude()}\n${body}\n})().then(v => JSON.stringify(v ?? null), e => JSON.stringify({ error: String(e && e.stack || e) }))`;
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return { error: r.exceptionDetails.text };
    return JSON.parse(r.result.value);
}

async function capture(crop) {
    const r = await cdp('Page.captureScreenshot', {
        format: 'png',
        ...(crop ? { clip: { x: crop[0], y: crop[1], width: crop[2], height: crop[3], scale: 1 } } : {}),
    });
    return Buffer.from(r.data, 'base64');
}

function readBody(req) {
    return new Promise(res => { let s = ''; req.on('data', d => s += d); req.on('end', () => res(s)); });
}

function control() {
    http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://x');
        const crop = url.searchParams.get('crop')?.split(',').map(Number);
        try {
            let out = null;
            if (url.pathname === '/eval') out = await evalInPage(await readBody(req));
            else if (url.pathname === '/shot') {
                const file = url.searchParams.get('out');
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, await capture(crop));
                out = { file, bytes: fs.statSync(file).size };
            } else if (url.pathname === '/canvas') {
                // The engine canvas at its full render size, read in the page (pinned fullscreen, the panel
                // that holds it still clips what a screenshot of the page sees).
                const file = url.searchParams.get('out');
                const data = await evalInPage('return await canvasDataUrl()');
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, Buffer.from(data.slice(data.indexOf(',') + 1), 'base64'));
                out = { file, bytes: fs.statSync(file).size };
            } else if (url.pathname === '/frames') {
                const dir = url.searchParams.get('dir'), n = Number(url.searchParams.get('n') ?? 60);
                const fps = Number(url.searchParams.get('fps') ?? 15);
                fs.rmSync(dir, { recursive: true, force: true });
                fs.mkdirSync(dir, { recursive: true });
                const t0 = Date.now();
                for (let i = 0; i < n; i++) {
                    const due = t0 + (i * 1000) / fps;
                    if (Date.now() < due) await sleep(due - Date.now());
                    fs.writeFileSync(path.join(dir, `f${String(i).padStart(3, '0')}.png`), await capture(crop));
                }
                out = { dir, n, seconds: (Date.now() - t0) / 1000 };
            } else if (url.pathname === '/record') {
                // A screencast: Chrome streams composited frames as they are drawn (a screenshot per frame is
                // ~0.8 s at this size). Frames land in D as f000.jpg… with their times in frames.json; the encoder
                // resamples them to a steady rate.
                const dir = url.searchParams.get('dir'), seconds = Number(url.searchParams.get('seconds') ?? 5);
                fs.rmSync(dir, { recursive: true, force: true });
                fs.mkdirSync(dir, { recursive: true });
                recording = [];
                await cdp('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 1 });
                await sleep(seconds * 1000);
                await cdp('Page.stopScreencast');
                const frames = recording; recording = null;
                const t0 = frames[0]?.t ?? 0;
                frames.forEach((f, i) => fs.writeFileSync(path.join(dir, `f${String(i).padStart(4, '0')}.jpg`), Buffer.from(f.data, 'base64')));
                fs.writeFileSync(path.join(dir, 'frames.json'), JSON.stringify(frames.map(f => f.t - t0)));
                out = { dir, frames: frames.length, seconds: frames.length ? frames[frames.length - 1].t - t0 : 0 };
            } else if (url.pathname === '/click') {
                // A real left click at CSS pixel (x, y): libraries that ignore synthetic DOM events
                // (dockview's tabs) see it as a user's.
                const x = Number(url.searchParams.get('x')), y = Number(url.searchParams.get('y'));
                for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
                    await cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
                out = true;
            } else if (url.pathname === '/drag') {
                // A real left-button drag from (x1, y1) to (x2, y2) in `steps` moves, then a release.
                const n = (k) => Number(url.searchParams.get(k));
                const [x1, y1, x2, y2] = [n('x1'), n('y1'), n('x2'), n('y2')];
                const steps = Math.max(1, n('steps') || 12);
                await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, buttons: 0 });
                await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1 });
                for (let i = 1; i <= steps; i++) {
                    const t = i / steps;
                    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t, button: 'left', buttons: 1 });
                    await sleep(16);
                }
                await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1 });
                out = true;
            } else if (url.pathname === '/files') {
                // Pick files into an <input type=file>, as the file dialog would: ?selector=CSS&path=F (repeatable).
                const { root } = await cdp('DOM.getDocument', { depth: 0 });
                const { nodeId } = await cdp('DOM.querySelector', { nodeId: root.nodeId, selector: url.searchParams.get('selector') });
                if (!nodeId) throw new Error(`no element for ${url.searchParams.get('selector')}`);
                await cdp('DOM.setFileInputFiles', { nodeId, files: url.searchParams.getAll('path') });
                out = true;
            } else if (url.pathname === '/reload') { await cdp('Page.reload', { ignoreCache: true }); out = true; }
            else if (url.pathname === '/quit') {
                res.end('{}');
                try { await cdp('Browser.close'); } catch { /* closing */ }
                stopAll(); process.exit(0);
            }
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(out));
        } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: String(e && e.stack || e) }));
        }
    }).listen(CONTROL_PORT, '127.0.0.1', () => console.log(`[docsMedia] control on http://127.0.0.1:${CONTROL_PORT}`));
}

(async () => {
    serve(path.join(ROOT, 'applications', 'creator'), CREATOR_PORT);
    serve(path.join(ROOT, 'applications', 'editor'), EDITOR_PORT, { CLEO_CREATOR_PORT: String(CREATOR_PORT) });
    await waitFor(`http://localhost:${EDITOR_PORT}/`);
    await waitFor(`http://localhost:${CREATOR_PORT}/creator/`);
    const chrome = spawn(CHROME, [
        `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check',
        '--enable-unsafe-webgpu', '--force-device-scale-factor=1', `--window-size=${WIDTH + 16},${HEIGHT + 140}`,
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
        // DOCS_MEDIA_START=creator opens Cleo Creator (on the editor origin) instead of the editor, which
        // would otherwise open its last project first -- the Valley's load holds the page for minutes.
        process.env.DOCS_MEDIA_START === 'creator' ? `http://localhost:${EDITOR_PORT}/creator/` : `http://localhost:${EDITOR_PORT}/`,
    ], { stdio: 'ignore' });
    children.push(chrome);
    await connect();
    control();
})().catch(e => { console.error(e); stopAll(); process.exit(1); });

process.on('SIGINT', () => { stopAll(); process.exit(0); });
