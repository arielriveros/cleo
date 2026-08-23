// Capture one labelled screenshot per renderer feature, for a side-by-side build comparison.
//
// Used to compare the WGSL-authored shaders against the hand-written GLSL they replaced. Both builds
// run on WebGL2 — the WGSL is translated at build time — so this is an equivalence check on the
// translation, not a backend comparison.
//
//   CLEO_GALLERY_DIR=<dir>  where the PNGs go (default: shots/gallery)
//
// Drives the same scene and the same configurations as passCheck, so a difference here is a difference
// the pass gate would also see.
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

const root = path.resolve(process.env.CLEO_MESH_DIR || path.join(__dirname, 'pages', 'mesh'));
const outDir = path.resolve(process.env.CLEO_GALLERY_DIR || path.join(__dirname, 'shots', 'gallery'));
fs.mkdirSync(outDir, { recursive: true });

// A FIXED profile directory, reused across runs.
//
// It was `mkdtempSync`, which leaves the profile behind on every run because these scripts end
// with `app.exit()` and never clean up. Several hundred harness runs filled the system drive to
// zero bytes free — Electron writes a real Chromium profile in there, several megabytes each.
// A fixed path is also faster to start, and these run sequentially so there is nothing to collide
// with.
const profileDir = path.join(os.tmpdir(), 'cleo-gallery-profile');
fs.mkdirSync(profileDir, { recursive: true });
app.setPath('userData', profileDir);
protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const REPO = path.resolve(__dirname, '..', '..');
function stage(pageDir, files) {
    for (const [from, to] of files) {
        const src = path.join(REPO, from);
        if (!fs.existsSync(src)) { console.error('missing ' + from); process.exit(1); }
        fs.mkdirSync(path.dirname(path.join(pageDir, to)), { recursive: true });
        fs.copyFileSync(src, path.join(pageDir, to));
    }
}
// Only stage when asked: the comparison build's cleo.js is copied in by the caller.
if (process.env.CLEO_GALLERY_STAGE !== 'no') stage(root, [['dist/cleo.js', 'cleo.js']]);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Renderer state per shot, reset wholesale so one shot cannot leak into the next. */
const DEFAULTS = {
    debugView: 'final', gridVisible: false,
    bloomIntensity: 0, bloomThreshold: 1,
    ssaoEnabled: false, ssaoRadius: 0.5, ssaoPower: 1.0, motionBlurEnabled: false,
    chromaticAberrationStrength: 0, shadowsEnabled: true, renderScale: 1, exposure: 2,
};

const SHOTS = [
    { name: '01-scene', title: 'Lit scene', patch: {},
      covers: 'geometryPBR, geometryBlinnPhong, geometryBasic, deferredLighting, shadowMap, skybox, tilemap, present, composer, screen' },
    { name: '02-bloom', title: 'Bloom', patch: { bloomIntensity: 2, bloomThreshold: 0.4 },
      covers: 'bloom, bloomDownsample, bloomUpsample, composer' },
    { name: '03-ssao', title: 'SSAO', patch: { ssaoEnabled: true, ssaoRadius: 2.0, ssaoPower: 4.0 },
      covers: 'ssao, ssaoBlur' },
    { name: '04-motionblur', title: 'Motion blur', patch: { motionBlurEnabled: true, motionBlurIntensity: 1 }, motion: 6.0,
      covers: 'motionBlurVelocity, motionBlurTileMax, motionBlurNeighborMax, motionBlur' },
    { name: '05-chromatic', title: 'Chromatic aberration', patch: { chromaticAberrationStrength: 4 },
      covers: 'chromaticAberration' },
    { name: '06-godrays', title: 'God rays', patch: {}, sky: { godRaysEnabled: true },
      covers: 'volumetricGodRays (+ the shared shadow library)' },
    { name: '07-skyfog', title: 'Atmospheric fog', patch: {}, sky: { fogEnabled: true, fogDensity: 0.02, fogStart: 2, fogMaxOpacity: 0.9 },
      covers: 'skyFog, skyAtmosphere' },
    { name: '08-grid', title: 'Editor grid', patch: { gridVisible: true }, covers: 'grid' },
    { name: '09-albedo', title: 'Debug: albedo', patch: { debugView: 'albedo' }, covers: 'debugView' },
    { name: '10-normal', title: 'Debug: normals', patch: { debugView: 'normal' }, covers: 'debugView (mode 1)' },
    { name: '11-shadowmap', title: 'Debug: shadow cascade', patch: { debugView: 'shadow' }, covers: 'shadowDebug' },
    { name: '12-overdraw', title: 'Debug: overdraw', patch: { debugView: 'overdraw' }, covers: 'overdraw, debugView (mode 7)' },
    // Its own shot because the overlay draws with the depth test off: enabled globally it would sit on
    // top of all twelve others. It is the only thing in the engine that binds `basicInstanced`.
    { name: '13-skeleton', title: 'Skeleton overlay', patch: {}, overlay: true,
      covers: 'basicInstanced' },
];

app.whenReady().then(async () => {
    protocol.handle('app', (request) => {
        let pathname = decodeURIComponent(new URL(request.url).pathname);
        if (!pathname || pathname === '/') pathname = '/index.html';
        const filePath = path.resolve(path.join(root, pathname));
        if (!filePath.startsWith(root)) return new Response('Forbidden', { status: 403 });
        return net.fetch(pathToFileURL(filePath).toString());
    });

    const win = new BrowserWindow({ width: 1000, height: 700, show: false, backgroundColor: '#202028', webPreferences: { contextIsolation: true } });
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
    if (!ready) { console.log('timed out waiting for the scene'); app.exit(1); return; }

    if (await js('typeof window.__resetShaderUse === "function"')) await js('window.__resetShaderUse()');
    for (const shot of SHOTS) {
        await js(`window.__setRender(${JSON.stringify({ ...DEFAULTS, ...shot.patch })})`);
        await js('window.__stopMotion()');
        await js(`window.__setSky(${JSON.stringify({ fogEnabled: false, godRaysEnabled: false, ...(shot.sky || {}) })})`);
        // Reset explicitly every shot rather than only when a shot wants it, for the same reason
        // DEFAULTS is spread wholesale above: state that is only ever turned ON leaks forward.
        await js(`window.__setSkeletonOverlay(${shot.overlay === true})`);
        await sleep(500);
        if (shot.motion) { await js(`window.__startMotion(${shot.motion})`); await sleep(400); }
        else await sleep(300);

        // capturePage returns the last COMPOSITED frame, so it lags a state change by one call.
        await win.webContents.capturePage();
        await sleep(300);
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, shot.name + '.png'), img.toPNG());
        console.log('  ' + shot.name + '  ' + shot.title);
        await js('window.__stopMotion()');
    }

    // Which programs the shots actually bound. Recorded from the run that demonstrably produces the
    // screenshots, so it is ground truth for "what do these images cover" rather than a reconstruction
    // of the same configuration in a second script.
    const used = await js('window.__shadersUsed ? window.__shadersUsed() : null');
    if (used) {
        fs.writeFileSync(path.join(outDir, 'shadersUsed.json'), JSON.stringify(used, null, 2));
        console.log(used.length + ' programs bound: ' + used.join(' '));
    }

    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(
        SHOTS.map(s => ({ name: s.name, title: s.title, covers: s.covers })), null, 2));
    console.log('wrote ' + SHOTS.length + ' shots to ' + outDir);
    app.exit(0);
});
