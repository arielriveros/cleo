// Per-pass visual signatures, so converting a shader cannot regress a pass nobody is looking at.
//
// The mesh harness proves geometry and draw counts, and it has caught real bugs — but its scene renders
// with bloom, SSAO, motion blur and chromatic aberration all OFF. Converting the ~24 fullscreen programs
// to WGSL would rewrite exactly those passes with no gate underneath them: draw counts would not move,
// the screenshot would not move, and a broken bloom would ship.
//
// So each configuration below turns one pass on, renders, and reduces the frame to an 8x8 grid of
// quantised cell means. That signature is stable across runs (it survives dithering and sub-pixel AA)
// and sensitive to anything a shader rewrite would plausibly get wrong — a channel swap, a lost blur, a
// wrong exposure, an inverted mask.
//
//   record:  CLEO_PASS_BASELINE=write   -> writes passBaseline.json
//   verify:  (default)                  -> compares against it
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const { compare, captureSignature } = require('./signature');
// Shared with backendDiff.js, which drives the same list against the other backend.
const { CONFIGS, captureConfigs } = require('./passConfigs');

const root = path.resolve(process.env.CLEO_MESH_DIR || path.join(__dirname, 'pages', 'mesh'));

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

stage(root, [['dist/cleo.js', 'cleo.js']]);
const baselinePath = path.join(__dirname, 'passBaseline.json');
const writing = process.env.CLEO_PASS_BASELINE === 'write';

// A FIXED profile directory, reused across runs.
//
// It was `mkdtempSync`, which leaves the profile behind on every run because these scripts end
// with `app.exit()` and never clean up. Several hundred harness runs filled the system drive to
// zero bytes free — Electron writes a real Chromium profile in there, several megabytes each.
// A fixed path is also faster to start, and these run sequentially so there is nothing to collide
// with.
const profileDir = path.join(os.tmpdir(), 'cleo-pass-profile');
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

  const win = new BrowserWindow({ width: 1000, height: 700, show: false, backgroundColor: '#202028', webPreferences: { contextIsolation: true } });
  win.webContents.on('render-process-gone', (_e, d) => { console.log('!! renderer gone ' + JSON.stringify(d)); app.exit(2); });
  await win.loadURL('app://mesh/index.html');
  const js = (src) => win.webContents.executeJavaScript(src);

  let ready = false;
  for (let i = 0; i < 200; i++) {
    const r = await js('window.__ready === true ? "ok" : (window.__error || null)').catch(() => null);
    if (r === 'ok') { ready = true; break; }
    if (r) { check('scene built', false, String(r).slice(0, 500)); app.exit(1); return; }
    await sleep(250);
  }
  if (!ready) { check('scene built', false, 'timed out'); app.exit(1); return; }

  const capture = () => captureSignature(win, sleep);

  const baseline = (!writing && fs.existsSync(baselinePath))
    ? JSON.parse(fs.readFileSync(baselinePath, 'utf-8')) : null;
  if (!writing && !baseline) console.log('  (no baseline on disk — recording only)');

  // A PNG of one configuration, on demand. Not part of the gate — the signature is — but the gate
  // reports a delta and a delta cannot be looked at. `CLEO_PASS_SHOT=<name> CLEO_PASS_TAG=<label>`
  // writes `shots/pass-<name>-<label>.png`, which is how the overdraw investigation got anywhere:
  // two builds, two labels, and the corruption was obvious in a second.
  const onShot = async (name) => {
    if (process.env.CLEO_PASS_SHOT !== name) return;
    const img = await win.webContents.capturePage();
    const out = path.join(__dirname, 'shots', `pass-${name}-${process.env.CLEO_PASS_TAG || 'x'}.png`);
    fs.writeFileSync(out, img.toPNG());
    console.log('      shot: ' + out);
  };

  const { signatures, stats, missing } = await captureConfigs(CONFIGS, { js, capture, sleep, onShot });
  for (const m of missing)
    check(`${m.name}: every setting exists on the renderer`, false, 'ignored: ' + m.ignored.join(', '));

  // A configuration whose signature equals `base` did not change the picture, which for these passes
  // means it did not run — the gate would then be watching nothing.
  for (const cfg of CONFIGS) {
    if (cfg.name === 'base' || cfg.motion) continue;   // motion pair is judged against each other below
    const d = compare(signatures.base, signatures[cfg.name]);
    check(`${cfg.name} visibly changes the frame`, d.material > 0,
          'nothing moved beyond the noise floor — the pass did not run, so nothing here is under test');
    if (d.differing) console.log(`      ${cfg.name}: ${d.differing}/128 values differ, worst delta ${d.worst}`);
  }

  // The motion-blur contract, compared against its own motion-matched control rather than against base.
  const mb = compare(signatures.motionBlurOff, signatures.motionBlur);
  check('motion blur changes the frame under motion', mb.differing > 0,
        'identical with the pass on and off — the gather pass did nothing');
  console.log(`      motionBlur vs motionBlurOff: ${mb.differing}/128 values differ, worst delta ${mb.worst}`);

  if (writing) {
    const exact = {};
    for (const cfg of CONFIGS) if (cfg.exact !== false) exact[cfg.name] = signatures[cfg.name];
    fs.writeFileSync(baselinePath, JSON.stringify(exact, null, 2));
    console.log('\nbaseline written to ' + baselinePath);
  } else if (baseline) {
    for (const cfg of CONFIGS) {
      if (cfg.exact === false) continue;   // phase-dependent; held to the weaker contract above
      const was = baseline[cfg.name];
      if (!was) { check(`${cfg.name} has a baseline`, false, 'not in baseline file'); continue; }
      const d = compare(was, signatures[cfg.name]);
      check(`${cfg.name} matches baseline`, d.material === 0,
            `${d.material}/128 values differ beyond the noise floor (worst delta ${d.worst})`);
    }
  }

  console.log('');
  console.log('  draw calls per configuration: ' +
    Object.entries(stats).map(([k, v]) => k + '=' + v.drawCalls).join('  '));

  const failed = results.filter(x => !x).length;
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  app.exit(failed ? 1 : 0);
});
