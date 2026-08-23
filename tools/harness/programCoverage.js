// Dump the set of shader programs the gallery scene actually compiles.
//
// Coverage claims about "which shaders the screenshots exercise" are worth exactly as much as the
// measurement behind them, so this drives the same shot configurations as captureGallery and then reads
// ShaderManager's registry rather than reasoning about what the scene probably draws.
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

const root = path.resolve(process.env.CLEO_MESH_DIR || path.join(__dirname, 'pages', 'mesh'));
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-cover-')));
protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const DEFAULTS = {
    debugView: 'final', gridVisible: false,
    bloomIntensity: 0, bloomThreshold: 1,
    ssaoEnabled: false, ssaoRadius: 0.5, ssaoPower: 1.0, motionBlurEnabled: false,
    chromaticAberrationStrength: 0, shadowsEnabled: true, renderScale: 1, exposure: 2,
};
// Mirrors captureGallery's shot list exactly, including the bits that are easy to leave out and that
// silently cost coverage: motion blur early-outs at zero camera velocity, and the sky features are node
// state rather than renderer state so they need their own patch.
const SHOTS = [
    { patch: {} },
    { patch: { bloomIntensity: 2, bloomThreshold: 0.4 } },
    { patch: { ssaoEnabled: true, ssaoRadius: 2.0, ssaoPower: 4.0 } },
    { patch: { motionBlurEnabled: true, motionBlurIntensity: 1 }, motion: 6.0 },
    { patch: { chromaticAberrationStrength: 4 } },
    { patch: {}, sky: { godRaysEnabled: true } },
    { patch: {}, sky: { fogEnabled: true, fogDensity: 0.02, fogStart: 2, fogMaxOpacity: 0.9 } },
    { patch: { gridVisible: true } },
    { patch: { debugView: 'albedo' } },
    { patch: { debugView: 'normal' } },
    { patch: { debugView: 'shadow' } },
    { patch: { debugView: 'overdraw' } },
];

app.whenReady().then(async () => {
    protocol.handle('app', (request) => {
        let pathname = decodeURIComponent(new URL(request.url).pathname);
        if (!pathname || pathname === '/') pathname = '/index.html';
        const filePath = path.resolve(path.join(root, pathname));
        if (!filePath.startsWith(root)) return new Response('Forbidden', { status: 403 });
        return net.fetch(pathToFileURL(filePath).toString());
    });

    const win = new BrowserWindow({ width: 1000, height: 700, show: false, webPreferences: { contextIsolation: true } });
    win.webContents.on('render-process-gone', (_e, d) => { console.log('!! renderer gone ' + JSON.stringify(d)); app.exit(2); });
    const query = process.env.CLEO_PIPELINE === 'forward' ? '?forward=1' : '';
    await win.loadURL('app://mesh/index.html' + query);
    const js = (src) => win.webContents.executeJavaScript(src);

    let ready = false;
    for (let i = 0; i < 200; i++) {
        const r = await js('window.__ready === true ? "ok" : (window.__error || null)').catch(() => null);
        if (r === 'ok') { ready = true; break; }
        if (r) { console.log('scene failed: ' + String(r).slice(0, 400)); app.exit(1); return; }
        await sleep(250);
    }
    if (!ready) { console.log('timed out'); app.exit(1); return; }

    await js('window.__resetShaderUse()');
    for (const shot of SHOTS) {
        await js('window.__setRender(' + JSON.stringify({ ...DEFAULTS, ...shot.patch }) + ')');
        await js('window.__stopMotion()');
        await js('window.__setSky(' + JSON.stringify({ fogEnabled: false, godRaysEnabled: false, ...(shot.sky || {}) }) + ')');
        await sleep(400);
        if (shot.motion) { await js('window.__startMotion(' + shot.motion + ')'); await sleep(500); }
        else await sleep(300);
        await js('window.__stopMotion()');
    }

    const names = await js('window.__shaderNames ? window.__shaderNames() : null');
    const used = await js('window.__shadersUsed ? window.__shadersUsed() : null');
    console.log((used || []).length + ' programs actually bound');
    console.log('UNUSED: ' + (names || []).filter(n => !(used || []).includes(n)).join(' '));
    if (!names) { console.log('could not reach ShaderManager.Instance._shaders'); app.exit(1); return; }
    const out = path.join(__dirname, 'shots', 'coverage-' + (process.env.CLEO_PIPELINE || 'deferred') + '.json');
    fs.writeFileSync(out, JSON.stringify(names, null, 2));
    console.log(names.length + ' programs compiled -> ' + out);
    console.log(names.join(' '));
    app.exit(0);
});
