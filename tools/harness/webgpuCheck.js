// Real-GPU checks for the WebGPU device (WEBGPU_ROADMAP.md M6, device tier).
//
// Runs the RHI's own `acquireWebGPUDevice` against a live driver and asserts on pixels read back from
// it, including two of the engine's real `.wgsl` programs. Nothing here can be covered by vitest: the
// DOM-free suite has no `navigator.gpu`, and a mocked device would only ever confirm the mock.
//
//   npm run harness:webgpu
//
// The page MUST be served over the privileged `app://` scheme. WebGPU is gated on a secure context, so
// a `file://` or `data:` page reports `navigator.gpu` missing on hardware that supports it — which
// looks exactly like "this Electron has no WebGPU" and is not.
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, 'pages', 'webgpu');
if (!fs.existsSync(path.join(root, 'bundle.js'))) {
    console.error('missing tools/harness/pages/webgpu/bundle.js — run `npm run harness:webgpu:build` first');
    process.exit(1);
}

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-webgpu-')));
protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
    protocol.handle('app', (request) => {
        let pathname = decodeURIComponent(new URL(request.url).pathname);
        if (!pathname || pathname === '/') pathname = '/index.html';
        const filePath = path.resolve(path.join(root, pathname));
        if (!filePath.startsWith(root)) return new Response('Forbidden', { status: 403 });
        return net.fetch(pathToFileURL(filePath).toString());
    });

    const win = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { contextIsolation: true } });
    const consoleErrors = [];
    win.webContents.on('console-message', (_e, level, message) => {
        // Electron's own insecure-CSP notice is not ours and fires on every page.
        if (level >= 2 && !message.includes('Electron Security Warning')) consoleErrors.push(message.slice(0, 300));
    });
    win.webContents.on('render-process-gone', (_e, details) => {
        console.log('!! renderer gone ' + JSON.stringify(details));
        app.exit(2);
    });

    await win.loadURL('app://webgpu/index.html');
    const js = (src) => win.webContents.executeJavaScript(src);

    let ready = false;
    for (let i = 0; i < 200; i++) {
        if (await js('window.__gpuReady === true').catch(() => false)) { ready = true; break; }
        await sleep(250);
    }
    if (!ready) { console.log('\ntimed out waiting for the checks'); app.exit(1); return; }

    const error = await js('window.__gpuError');
    if (error) {
        console.log('\nFAIL  the harness threw\n' + String(error).split('\n').slice(0, 12).join('\n'));
        app.exit(1);
        return;
    }

    const results = await js('window.__gpuResults') || [];
    console.log('');
    let failed = 0;
    for (const result of results) {
        console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.name}`);
        if (result.detail) console.log(`      ${result.detail}`);
        if (!result.pass) failed++;
    }
    if (consoleErrors.length) {
        console.log('\nFAIL  console reported errors');
        for (const message of consoleErrors) console.log('      ' + message);
        failed++;
    }
    if (!results.length) { console.log('FAIL  no checks ran'); failed++; }

    console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
    app.exit(failed ? 1 : 0);
});
