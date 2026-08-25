// Drives nagacheck/index.html: the editor's WGSL translation path, in a real browser.
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

const root = path.resolve(process.env.CLEO_NAGA_DIR || path.join(__dirname, 'pages', 'naga'));

// Stage the engine bundle next to the page it is loaded from. Doing it here rather than expecting a
// manual copy is what makes a stale `cleo.js` impossible: the harness always tests the dist that exists
// right now, and a forgotten rebuild shows up as an old bundle rather than as a mystery pass.
const REPO = path.resolve(__dirname, '..', '..');
function stage(pageDir, files) {
  for (const [from, to] of files) {
    const src = path.join(REPO, from);
    if (!fs.existsSync(src)) {
      console.error('missing ' + from + ' — run `npm run build:dev` first');
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(path.join(pageDir, to)), { recursive: true });
    fs.copyFileSync(src, path.join(pageDir, to));
  }
}

stage(root, [
  ['dist/cleo.js', 'cleo.js'],
  ['src/graphics/rhi/webgpu/naga/nagaGlsl.js', 'naga/nagaGlsl.js'],
  ['src/graphics/rhi/webgpu/naga/nagaGlsl_bg.wasm', 'naga/nagaGlsl_bg.wasm'],
]);
// A FIXED profile directory, reused across runs.
//
// It was `mkdtempSync`, which leaves the profile behind on every run because these scripts end
// with `app.exit()` and never clean up. Several hundred harness runs filled the system drive to
// zero bytes free — Electron writes a real Chromium profile in there, several megabytes each.
// A fixed path is also faster to start, and these run sequentially so there is nothing to collide
// with.
const profileDir = path.join(os.tmpdir(), 'cleo-naga-profile');
fs.mkdirSync(profileDir, { recursive: true });
app.setPath('userData', profileDir);
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const results = [];
const check = (name, ok, detail) => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '   -> ' + String(detail ?? '')}`);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  protocol.handle('app', (request) => {
    let pathname = decodeURIComponent(new URL(request.url).pathname);
    if (!pathname || pathname === '/') pathname = '/index.html';
    const filePath = path.resolve(path.join(root, pathname));
    if (!filePath.startsWith(root)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(filePath).toString());
  });

  const win = new BrowserWindow({ width: 400, height: 300, show: false, webPreferences: { contextIsolation: true } });
  win.webContents.on('render-process-gone', (_e, d) => { console.log('!! renderer gone ' + JSON.stringify(d)); app.exit(2); });
  await win.loadURL('app://naga/index.html');
  const js = (src) => win.webContents.executeJavaScript(src);

  let ready = false;
  for (let i = 0; i < 160; i++) {
    const r = await js('window.__ready === true ? "ok" : (window.__error || null)').catch(() => null);
    if (r === 'ok') { ready = true; break; }
    if (r) { check('page initialised', false, String(r).slice(0, 600)); app.exit(1); return; }
    await sleep(250);
  }
  if (!ready) { check('page initialised', false, 'timed out'); app.exit(1); return; }

  check('naga wasm loads over the page protocol', await js('window.__installed === true'), 'translator not installed');
  console.log('      naga version ' + await js('window.__nagaVersion'));

  const r = JSON.parse(await js('JSON.stringify(window.__results())'));

  check('a portable screen material compiles and translates', r.screenGood.ok && r.screenGood.hasWgsl,
        r.screenGood.error || r.screenGood.wgslError);
  check('its WGSL looks like WGSL', /(@fragment|struct|var<)/.test(r.screenGood.wgslHead || ''),
        (r.screenGood.wgslHead || '').slice(0, 120));

  // The lit modes. Both used to be refused here with an engine-limitation message; both translate now,
  // and these check the two things that made forward the last one — its lights arriving as struct
  // members of a bound block, and the shadow library's comparison samplers surviving the split.
  check('a lit forward material compiles and translates', r.forward.ok && r.forward.hasWgsl,
        JSON.stringify(r.forward).slice(0, 300));
  check('its lights came through as WGSL structs', /struct DirectionalLight/.test(r.forward.wgslHead || ''),
        (r.forward.wgslHead || '').slice(0, 160));
  check('a deferred material compiles and translates', r.deferred.ok && r.deferred.hasWgsl,
        JSON.stringify(r.deferred).slice(0, 300));

  // Whichever way this one lands it must not be reported as a compile failure — that is the distinction
  // the whole two-verdict return shape exists to preserve.
  check('an unusual screen material still compiles for WebGL2', r.screenOdd.ok, r.screenOdd.error);
  console.log('      screenOdd: ' + (r.screenOdd.hasWgsl ? 'translated' : 'wgslError: ' + String(r.screenOdd.wgslError).slice(0, 160)));

  check('a broken shader reports the GL error and no WGSL', !r.broken.ok && !!r.broken.error && !r.broken.hasWgsl,
        JSON.stringify(r.broken).slice(0, 300));
  check('the GL error is not polluted by a naga diagnostic', !r.broken.wgslError, r.broken.wgslError);

  const failed = results.filter(x => !x).length;
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  app.exit(failed ? 1 : 0);
});
