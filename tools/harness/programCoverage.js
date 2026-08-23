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
// A FIXED profile directory, reused across runs.
//
// It was `mkdtempSync`, which leaves the profile behind on every run because these scripts end
// with `app.exit()` and never clean up. Several hundred harness runs filled the system drive to
// zero bytes free — Electron writes a real Chromium profile in there, several megabytes each.
// A fixed path is also faster to start, and these run sequentially so there is nothing to collide
// with.
const profileDir = path.join(os.tmpdir(), 'cleo-cover-profile');
fs.mkdirSync(profileDir, { recursive: true });
app.setPath('userData', profileDir);
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
// Programs that CANNOT bind, whatever the scene contains. Listed so that the report can tell
// "structurally unreachable" apart from "a conversion broke this" — without the distinction the
// UNUSED line is just noise a reader learns to skip.
//
//   terrain                     an alias of the same Shader object as terrainGeometry, registered only
//                               so ModelNode.initializeModel can reflect its attributes (renderer.ts,
//                               'terrain' is used by ModelNode.initializeModel).
//   blinn_phongGeometry*        dead in the deferred pipeline: opaque blinn_phong materials are pushed
//                               onto the opaqueForwardQueue and drawn by the FORWARD blinn_phong
//                               programs instead, so nothing ever reaches the G-buffer variants. They
//                               are kept because their reflected attributes are the canonical vertex
//                               layout. Delete them only together with that dependency.
const UNREACHABLE = new Set([
    'terrain',
    'blinn_phongGeometry', 'blinn_phongGeometrySkinned', 'blinn_phongGeometryInstanced',
]);

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
    // Mirrors captureGallery's shot 13: the skeleton overlay is the only thing in the engine that
    // binds `basicInstanced`, and it is off by default because it draws with the depth test off.
    { patch: {}, overlay: true },
];

app.whenReady().then(async () => {
    protocol.handle('app', (request) => {
        let pathname = decodeURIComponent(new URL(request.url).pathname);
        if (!pathname || pathname === '/') pathname = '/index.html';
        const filePath = path.resolve(path.join(root, pathname));
        if (!filePath.startsWith(root)) return new Response('Forbidden', { status: 403 });
        return net.fetch(pathToFileURL(filePath).toString());
    });

    // backgroundThrottling MUST be off. The window is hidden, and Chromium throttles rAF in a hidden
    // window to almost nothing — whole shots went by without a single frame, so the passes they exist to
    // exercise were reported as never bound. captureGallery never hit this because capturePage forces a
    // frame; this script only drives state and reads back, so it has nothing to force one.
    const win = new BrowserWindow({ width: 1000, height: 700, show: false, webPreferences: { contextIsolation: true, backgroundThrottling: false } });
    win.webContents.on('render-process-gone', (_e, d) => { console.log('!! renderer gone ' + JSON.stringify(d)); app.exit(2); });
    // CLEO_SCENE=full adds terrain, foliage and clouds — five shader families the base scene has no
    // content for, so without it their programs compile and never bind and this report says so.
    const params = new URLSearchParams();
    if (process.env.CLEO_PIPELINE === 'forward') params.set('forward', '1');
    if (process.env.CLEO_SCENE === 'full') params.set('scene', 'full');
    // Every bit of the material/topology grid, by default. The gallery keeps its scene fixed so its
    // shots stay comparable; coverage has no such constraint and a larger scene can only bind MORE
    // programs, so leaving these off simply under-reported the Basic and Blinn-Phong variants.
    params.set('extras', process.env.CLEO_EXTRAS || '15');
    const query = params.toString() ? '?' + params.toString() : '';
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

    // Read the set BEFORE resetting. The one-shot bakes — IBL irradiance/prefilter/BRDF, the cloud
    // noise volume — run once during scene start and never again, so a reset-then-drive measurement
    // reported them as "never bound" when in fact they had already done all the work they will ever do.
    const atLoad = await js('window.__shadersUsed()') || [];
    await js('window.__resetShaderUse()');
    for (const shot of SHOTS) {
        await js('window.__setRender(' + JSON.stringify({ ...DEFAULTS, ...shot.patch }) + ')');
        await js('window.__stopMotion()');
        await js('window.__setSky(' + JSON.stringify({ fogEnabled: false, godRaysEnabled: false, ...(shot.sky || {}) }) + ')');
        await js('window.__setSkeletonOverlay(' + (shot.overlay === true) + ')');
        if (shot.motion) await js('window.__startMotion(' + shot.motion + ')');
        // Force real frames, and force them WHILE the shot's state is live.
        //
        // Two things bit here. This window is never shown, and Chromium gives a never-shown window
        // almost no rAF at all, so whole shots went by without the scene drawing once and the passes
        // they exist to exercise were reported as never bound. Setting backgroundThrottling false does
        // not cover a never-shown window; only a capture forces the frame. captureGallery never hit
        // this because capturing is what that script does.
        //
        // Then the motion-blur shot broke, because motion was stopped before the forced frames ran and
        // the pass early-outs at zero camera velocity. The capture has to happen inside the shot's
        // state, not after it — which is what makes this a loop rather than a settle-then-read.
        for (let f = 0; f < 5; f++) { await win.webContents.capturePage(); await sleep(60); }
        await js('window.__stopMotion()');
    }


    // Off-frame passes, which no amount of driving the viewport can reach: `probePreview` renders a
    // baked probe cubemap into its own FBO for the editor's inspector.
    await js('window.__probePreview ? window.__probePreview(64) : null');

    const names = await js('window.__shaderNames ? window.__shaderNames() : null');
    const driven = await js('window.__shadersUsed ? window.__shadersUsed() : null') || [];
    const used = Array.from(new Set([...atLoad, ...driven])).sort();
    console.log(used.length + ' programs actually bound (' + driven.length + ' driven, '
        + atLoad.filter(n => !driven.includes(n)).length + ' at scene load only)');
    console.log('AT LOAD ONLY: ' + atLoad.filter(n => !driven.includes(n)).join(' '));
    const unused = (names || []).filter(n => !used.includes(n));
    const unexpected = unused.filter(n => !UNREACHABLE.has(n));
    console.log('UNUSED (unreachable by design): ' + unused.filter(n => UNREACHABLE.has(n)).join(' '));
    console.log('UNUSED (unexpected): ' + (unexpected.join(' ') || 'none'));
    if (!names) { console.log('could not reach ShaderManager.Instance._shaders'); app.exit(1); return; }
    const out = path.join(__dirname, 'shots', 'coverage-' + (process.env.CLEO_PIPELINE || 'deferred')
        + (process.env.CLEO_SCENE === 'full' ? '-full' : '') + '.json');
    fs.writeFileSync(out, JSON.stringify(names, null, 2));
    console.log(names.length + ' programs compiled -> ' + out);
    console.log(names.join(' '));

    const complete = process.env.CLEO_SCENE === 'full' && process.env.CLEO_PIPELINE !== 'forward';
    if (complete && unexpected.length) {
        console.log('\nFAIL  ' + unexpected.length + ' program(s) never bound in the configuration where every');
        console.log('      program is supposed to. Either the scene lost the content that drove them, or a');
        console.log('      conversion broke the path that binds them.');
        app.exit(1);
        return;
    }
    if (complete) console.log('\nALL PASS');
    app.exit(0);
});
