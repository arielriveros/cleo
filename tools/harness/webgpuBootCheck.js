// How far does the ENGINE get on a WebGPU device, and does WebGL2 still get all the way?
//
// `harness:webgpu` proves the RHI's `WebGPUDevice` works against a real driver. It says nothing about
// the engine, because until now `Renderer.initialize()` could not acquire that device at all — it did
// `canvas.getContext('webgl2')` unconditionally. This check drives the engine's own startup with
// `?backend=webgpu&cleoWebgpuProbe=1` and asserts on `renderer.deviceProbe`.
//
//   npm run harness:webgpu:boot
//
// It is a RATCHET, not a pass/fail on the port being finished. Startup is EXPECTED to fail on WebGPU
// today; what is asserted is that it fails at exactly the stage recorded in `webgpuBoot.json`, with a
// `glDevice()` message. Porting a resource owner moves the failure forward, that file is edited in the
// same commit, and the diff is the progress. Two things this shape catches that a boolean cannot:
//
//   - a silent REGRESSION (the failure moves backwards, or acquisition quietly falls back to WebGL2
//     and every assertion below still "passes" against a WebGL2 device);
//   - a silent WIN nobody wrote down (the failure moves forward and the baseline was never updated),
//     which is how a port ends up with unreviewed behaviour changes in it.
//
// The WebGL2 half of the run is not decoration either: it is the control. Every change to device
// acquisition is a change to the only code path that ships, and "reached firstFrame" is the cheapest
// statement that it still starts and still draws.
//
// The page MUST be served over the privileged `app://` scheme. WebGPU is gated on a secure context, so
// a `file://` page reports `navigator.gpu` missing on hardware that has it — which looks exactly like
// "this Electron has no WebGPU" and is not.
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..', '..');
const root = path.resolve(path.join(__dirname, 'pages', 'mesh'));
const BASELINE = path.join(__dirname, 'webgpuBoot.json');

// A FIXED profile directory, reused across runs — the same reasoning as every other harness here: these
// scripts end in `app.exit()` and never clean up, and `mkdtempSync` left a multi-megabyte Chromium
// profile behind on each run until the system drive was full. Its own name, because two harnesses
// running at once collide on a profile lock.
const profileDir = path.join(os.tmpdir(), 'cleo-webgpuboot-profile');
fs.mkdirSync(profileDir, { recursive: true });
app.setPath('userData', profileDir);
protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

function stage(pageDir, files) {
    for (const [from, to] of files) {
        const src = path.join(REPO, from);
        if (!fs.existsSync(src)) { console.error('missing ' + from + ' — run `npm run build:dev` first'); process.exit(1); }
        fs.mkdirSync(path.dirname(path.join(pageDir, to)), { recursive: true });
        fs.copyFileSync(src, path.join(pageDir, to));
    }
}
stage(root, [['dist/cleo.js', 'cleo.js']]);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const results = [];
function check(name, pass, detail) {
    results.push({ name, pass: !!pass, detail: pass ? '' : String(detail == null ? '' : detail).slice(0, 600) });
}

/**
 * Load the mesh page with a query string and wait for startup to settle either way.
 *
 * "Either way" is the point: on WebGPU the page's `await engine.initialize()` REJECTS (engine.ts no
 * longer swallows it), so `__ready` never becomes true and waiting only for that would time out after
 * 50 seconds instead of reporting a probe. `__error` is the other terminal state.
 */
async function boot(win, query) {
    await win.loadURL('app://mesh/index.html' + query);
    const js = (src) => win.webContents.executeJavaScript(src);
    for (let i = 0; i < 200; i++) {
        const state = await js('window.__ready === true ? "ready" : (window.__error ? "error" : null)').catch(() => null);
        if (state) return { js, state };
        await sleep(250);
    }
    return { js, state: 'timeout' };
}

/** The probe, as a plain object across the structured clone. */
const readProbe = (js) => js('window.__renderer ? JSON.parse(JSON.stringify(window.__renderer.deviceProbe)) : null');

app.whenReady().then(async () => {
    protocol.handle('app', (request) => {
        let pathname = decodeURIComponent(new URL(request.url).pathname);
        if (!pathname || pathname === '/') pathname = '/index.html';
        const filePath = path.resolve(path.join(root, pathname));
        if (!filePath.startsWith(root)) return new Response('Forbidden', { status: 403 });
        return net.fetch(pathToFileURL(filePath).toString());
    });

    const expected = JSON.parse(fs.readFileSync(BASELINE, 'utf-8'));

    const win = new BrowserWindow({
        width: 800, height: 600, show: process.env.CLEO_SHOW === '1',
        backgroundColor: '#202028',
        webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    win.webContents.on('render-process-gone', (_e, d) => { console.log('!! renderer gone ' + JSON.stringify(d)); app.exit(2); });

    // ---------------------------------------------------------------------------------------------
    // WebGPU: acquisition happens, and startup stops exactly where the baseline says.
    // ---------------------------------------------------------------------------------------------
    {
        const { js, state } = await boot(win, '?backend=webgpu&cleoWebgpuProbe=1');
        const probe = await readProbe(js);
        // Reported before anything is asserted, because when this check fails the probe IS the report.
        console.log('      webgpu probe: ' + JSON.stringify(probe));

        if (!probe) {
            check('the page exposes a device probe', false, 'window.__renderer is missing (state=' + state + ')');
        } else {
            const backend = await js('window.__renderer.backend').catch(e => 'threw: ' + e);
            const caps = await js('(() => { try { return window.__renderer.capabilities.backend; } catch (e) { return "threw: " + e.message; } })()');

            // 1. Acquisition ACTUALLY happened. Without this every later assertion could be satisfied by
            //    a silent fallback to WebGL2 — which is what the code did before this task, and it would
            //    have looked identical from here.
            check('renderer.backend === webgpu', backend === 'webgpu',
                'got ' + backend + ' — fallbackReason: ' + (probe.fallbackReason || 'none'));
            check('capabilities.backend === webgpu', caps === 'webgpu', 'got ' + caps);
            check('probe reached the device stage', probe.reached.includes('device'), JSON.stringify(probe.reached));

            // 2. THE RATCHET. Stage and reached-set both, so a failure that moves forward is caught even
            //    when the failing stage name happens to be unchanged.
            const failedAt = probe.failedAt || {};
            check('startup stops at the recorded stage', failedAt.stage === expected.stage,
                'expected ' + expected.stage + ', got ' + failedAt.stage + ' — update ' + path.basename(BASELINE)
                + ' in the commit that moved it, with the diff');
            check('stages reached match the baseline',
                JSON.stringify(probe.reached) === JSON.stringify(expected.reached),
                'expected ' + JSON.stringify(expected.reached) + ', got ' + JSON.stringify(probe.reached));

            // 3. And it stopped for the RIGHT REASON, which the baseline names.
            //
            //    Two kinds exist and they are not interchangeable. `glDevice` is the port's own worklist
            //    marker — a class that declared itself WebGL2-only and said so. `rawGl` is a TypeError on
            //    an undefined `gl`, i.e. code that reached the context directly with nothing announcing
            //    it. Both are legitimate stopping points at different stages (`preInitialize` is raw GL
            //    on purpose and always was), so the EXPECTED kind is recorded rather than assumed. What
            //    this catches is a stage failing for a reason nobody predicted, which is how a genuine
            //    regression would otherwise hide behind a stage name that looks familiar.
            const REASONS = {
                glDevice: /WebGL2-only path was reached/,
                rawGl: /Cannot read properties of undefined/,
                // A GPUTexture fixes its size at creation; the engine's `Texture` is created at 0x0 and
                // sized by a later upload. Not a missing port but a shape mismatch, and it is announced
                // by the backend rather than discovered as a crash — a third distinct kind.
                creationSize: /fixes its size at creation/,
                // A WebGPU validation error, i.e. the engine got far enough to build a real command and
                // the driver refused it. A different class again from "this path is WebGL2-only": there
                // is nothing left to port here, only something to get right.
                gpuValidation: /Failed to execute|Invalid |validation/i,
            };
            const wanted = REASONS[expected.reason];
            check('the recorded failure reason is a known kind', !!wanted,
                'baseline `reason` is ' + JSON.stringify(expected.reason)
                + ', expected one of ' + Object.keys(REASONS).join(' | '));
            if (wanted)
                check('startup stops for the recorded reason (' + expected.reason + ')',
                    wanted.test(failedAt.message || ''), JSON.stringify(failedAt.message));
            // The stack names the CALL, which is the actual work item. Reported, never asserted on —
            // its shape is a V8 detail and pinning it would make this check fail on an Electron bump.
            if (failedAt.stack) console.log('      first unported call:\n        '
                + String(failedAt.stack).split('\n').slice(0, 4).join('\n        '));
        }
    }

    // ---------------------------------------------------------------------------------------------
    // WebGL2: the control. Same page, same engine, all the way to a drawn frame.
    // ---------------------------------------------------------------------------------------------
    {
        const { js, state } = await boot(win, '?backend=webgl2');
        check('webgl2 startup completes', state === 'ready', 'state=' + state + ' — ' + await js('window.__error || ""'));
        // capturePage FORCES a frame. This window is not shown, so rAF is throttled to nothing and the
        // `firstFrame` stage would never be taken — the check would fail with the renderer working fine.
        await win.webContents.capturePage();
        await sleep(200);
        await win.webContents.capturePage();

        const probe = await readProbe(js);
        console.log('      webgl2 probe: ' + JSON.stringify(probe && probe.reached));
        const reached = (probe && probe.reached) || [];
        check('webgl2 reaches firstFrame', reached.includes('firstFrame'), JSON.stringify(reached));
        check('webgl2 records no stage failure', probe && probe.failedAt === null, JSON.stringify(probe && probe.failedAt));
        check('webgl2 reports no fallback', probe && probe.fallbackReason === null, probe && probe.fallbackReason);
    }

    console.log('');
    let failed = 0;
    for (const result of results) {
        console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.name}`);
        if (result.detail) console.log(`      ${result.detail}`);
        if (!result.pass) failed++;
    }
    if (!results.length) { console.log('FAIL  no checks ran'); failed++; }
    console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
    app.exit(failed ? 1 : 0);
});
