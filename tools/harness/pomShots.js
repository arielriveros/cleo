// Render the terrain-parallax comparison and SAVE THE PICTURES. Not a gate — a look.
//
// Every assertion about this feature so far has been an assertion about a number: a uniform, a mip
// level, an offset in centimetres. All of them agreed the march was correct, and the surface on screen
// was still wrong, four times running. This driver exists to stop arguing with the screenshot: it
// renders a 400 m landscape carrying a brick height map at whatever tiling is asked for, plus the same
// map on a standard PBR plane one metre per repeat away, and writes each frame to disk.
//
//   node/electron tools/harness/pomShots.js
//   CLEO_POM_TILINGS=31,100,300 CLEO_POM_DEPTH=0.06 ... same, other settings
//
// Also dumps the resolved uniforms per configuration, so a picture that shows nothing can be read
// against the numbers that produced it rather than against an assumption about them.
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, 'pages', 'pom');
const REPO = path.resolve(__dirname, '..', '..');
for (const [from, to] of [['dist/cleo.js', 'cleo.js']]) {
  const src = path.join(REPO, from);
  if (!fs.existsSync(src)) { console.error('missing ' + from + ' — run `npm run build:dev` first'); process.exit(1); }
  fs.copyFileSync(src, path.join(root, to));
}
const shotDir = process.env.CLEO_SHOT_DIR || path.join(__dirname, 'shots', 'pom');
fs.mkdirSync(shotDir, { recursive: true });

const TILINGS = (process.env.CLEO_POM_TILINGS || '31,300').split(',');
const DEPTH = process.env.CLEO_POM_DEPTH || '0.06';
const RELIEF = process.env.CLEO_POM_RELIEF || '1';
const CAMY = process.env.CLEO_POM_CAMY || '1.3';
const PITCH = process.env.CLEO_POM_PITCH || '14';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.whenReady().then(async () => {
  protocol.handle('app', (request) => {
    let pathname = decodeURIComponent(new URL(request.url).pathname);
    if (!pathname || pathname === '/') pathname = '/index.html';
    const filePath = path.resolve(path.join(root, pathname));
    if (!filePath.startsWith(root)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(filePath).toString());
  });

  const win = new BrowserWindow({
    width: 1000, height: 700, show: process.env.CLEO_SHOW === '1',
    backgroundColor: '#202028',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const errs = [];
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl === 3) errs.push(msg); });

  for (const tiling of TILINGS) {
    await win.loadURL(`app://pom/index.html?tiling=${tiling}&depth=${DEPTH}&camy=${CAMY}&pitch=${PITCH}`);
    const js = (s) => win.webContents.executeJavaScript(s);
    for (let i = 0; i < 200; i++) {
      const r = await js('window.__ready === true ? (window.__error || true) : null').catch(() => null);
      if (r === true) break;
      if (typeof r === 'string') { console.error('PAGE ERROR: ' + r); app.exit(1); return; }
      await sleep(100);
    }
    // The terrain bake is asynchronous in the texture decode; give it frames, and force them, because a
    // window that is never shown does not composite on rAF alone.
    // POLL FOR THE PACK, don't count frames. `TexturePacker.resolve` returns null until the packed
    // normal+height texture has actually been rendered, and until it does `u_hasHeight{i}` is 0 and the
    // whole height path -- march AND height-aware blend -- is off. A fixed frame budget turned that into
    // "the march produces nothing", which is indistinguishable from the bug being investigated.
    let packed = false;
    for (let i = 0; i < 120; i++) {
      await win.webContents.capturePage();
      await sleep(80);
      const u = JSON.parse(await js('window.__uniforms()'));
      if (u.packId && u.packId !== 'null' && u.hasHeight0 === 1) { packed = true; break; }
    }
    if (!packed) console.log('      WARNING: pack never resolved — the height path is off');

    console.log(`tiling ${tiling}: ` + await js('window.__uniforms()'));

    // capturePage returns the LAST COMPOSITED frame, so every state change is followed by a throwaway.
    const shoot = async (name) => {
      await win.webContents.capturePage();
      await sleep(120);
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(shotDir, name), img.toPNG());
      return img;
    };
    const tag = (RELIEF === '1' ? '' : `.r${RELIEF}`) + (CAMY === '1.3' ? '' : `.y${CAMY}`);
    const on = await shoot(`t${tiling}${tag}.on.png`);
    await js('window.__setMarch(0)');
    const off = await shoot(`t${tiling}${tag}.off.png`);
    await js('window.__setMarch(null)');

    // THE NUMBER, so "looks the same to me" is not the finding. The two frames differ only by the
    // march, so any pixel that moved is the effect and every pixel that did not is its absence. The
    // amplified difference is written out too: where the effect lives is as informative as how much.
    const a = on.getBitmap(), b = off.getBitmap(), sz = on.getSize();
    let sum = 0, worst = 0, moved = 0;
    const vis = Buffer.alloc(a.length);
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
      sum += d; if (d > worst) worst = d; if (d > 2) moved++;
      const v = Math.min(255, d * 12);
      vis[i] = v; vis[i + 1] = v; vis[i + 2] = v; vis[i + 3] = 255;
    }
    const px = a.length / 4;
    fs.writeFileSync(path.join(shotDir, `t${tiling}.diff.png`),
      require('electron').nativeImage.createFromBitmap(vis, sz).toPNG());
    console.log(`      march A/B: mean ${(sum / px).toFixed(2)}/255, worst ${worst}, `
                + `${(moved / px * 100).toFixed(1)}% of pixels moved  -> t${tiling}${tag}.diff.png (x12)`);
  }
  if (errs.length) console.log('console errors:\n  ' + errs.slice(0, 8).join('\n  '));
  app.exit(0);
});
