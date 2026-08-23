// Do the uniform offsets we COMPUTE match what a real driver actually uses?
//
// WebGL2 never had to answer this: it asks the driver for `UNIFORM_OFFSET`, `UNIFORM_ARRAY_STRIDE` and
// `UNIFORM_MATRIX_STRIDE` and writes where it is told. WebGPU has no such reflection — a uniform buffer
// is bytes, and the shader reads whatever sits at the offset its struct declares — so the offsets have
// to come from `tools/wgslLayout.mjs`, applying the WGSL uniform address space rules by hand.
//
// A hand-rolled packer that is subtly wrong does not throw. It writes `u_exposure` two floats past
// where the shader reads it, and the frame renders with whatever was there — which is exactly the class
// of bug that is impossible to find from the picture. So every computed number is checked here against
// the driver's answer for the same struct, across every program the engine registers.
//
//   npm run harness:uniforms
//
// The driver is the authority. A disagreement means wgslLayout.mjs is wrong, not the driver.
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..', '..');
const root = path.resolve(process.env.CLEO_MESH_DIR || path.join(__dirname, 'pages', 'mesh'));
const WGSL_DIR = path.join(REPO, 'src', 'graphics', 'shaders', 'wgsl');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-uniforms-')));
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

/**
 * Registered program name -> the `.wgsl` module it was built from.
 *
 * Needed because the two names differ (`blinn_phongGeometry` is built from `geometryBlinnPhong.wgsl`),
 * and matching a member across ALL modules instead is actively wrong: `u_material.emissive` exists in
 * both the forward and deferred Blinn-Phong material structs at different offsets, so a cross-module
 * search happily compared one struct's layout against the other's driver report and called it a
 * mismatch. Read the mapping out of renderer.ts rather than maintaining a second copy of it.
 */
function programToModule() {
    const src = fs.readFileSync(path.join(REPO, 'src', 'graphics', 'renderer.ts'), 'utf-8');
    const imports = new Map();   // identifier -> wgsl stem
    for (const m of src.matchAll(/^import\s+(\w+)\s+from\s+'\.\/shaders\/wgsl\/([\w.]+)\.wgsl'/gm))
        imports.set(m[1], m[2]);
    const creates = new Map();   // local shader variable -> wgsl stem
    for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*new Shader\(\)\.create\(\s*(\w+)\./g))
        if (imports.has(m[2])) creates.set(m[1], imports.get(m[2]));
    const programs = new Map();  // registered name -> wgsl stem
    for (const m of src.matchAll(/addShader\(\s*'([^']+)'\s*,\s*(\w+)\s*\)/g))
        if (creates.has(m[2])) programs.set(m[1], creates.get(m[2]));
    return programs;
}

/** The layout we compute, for every `.wgsl` program, keyed by member name. */
async function computeLayouts() {
    const { resolveIncludes } = await import(pathToFileURL(path.join(REPO, 'tools/shaderIncludes.mjs')).href);
    const { findUniformBlocks } = await import(pathToFileURL(path.join(REPO, 'tools/wgslTranslate.mjs')).href);

    const layouts = new Map();   // wgsl file stem -> Map(memberName -> {offset, arrayStride, matrixStride})
    for (const file of fs.readdirSync(WGSL_DIR).filter(f => f.endsWith('.wgsl'))) {
        const full = path.join(WGSL_DIR, file);
        const composed = resolveIncludes(fs.readFileSync(full, 'utf-8'), path.dirname(full), {
            read: p => fs.readFileSync(p, 'utf-8'),
            resolve: (dir, rel) => path.resolve(dir, rel),
        });
        const members = new Map();
        for (const block of findUniformBlocks(composed))
            for (const member of block.flat) members.set(member.name, member);
        if (members.size) layouts.set(path.basename(file, '.wgsl'), members);
    }
    return layouts;
}

app.whenReady().then(async () => {
    const computed = await computeLayouts();
    const moduleOf = programToModule();

    protocol.handle('app', (request) => {
        let pathname = decodeURIComponent(new URL(request.url).pathname);
        if (!pathname || pathname === '/') pathname = '/index.html';
        const filePath = path.resolve(path.join(root, pathname));
        if (!filePath.startsWith(root)) return new Response('Forbidden', { status: 403 });
        return net.fetch(pathToFileURL(filePath).toString());
    });

    const win = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { contextIsolation: true } });
    win.webContents.on('render-process-gone', (_e, d) => { console.log('!! renderer gone ' + JSON.stringify(d)); app.exit(2); });
    await win.loadURL('app://mesh/index.html');
    const js = (src) => win.webContents.executeJavaScript(src);

    let ready = false;
    for (let i = 0; i < 200; i++) {
        const r = await js('window.__ready === true ? "ok" : (window.__error || null)').catch(() => null);
        if (r === 'ok') { ready = true; break; }
        if (r) { console.log('scene failed: ' + String(r).slice(0, 400)); app.exit(1); return; }
        await sleep(250);
    }
    if (!ready) { console.log('timed out waiting for the scene'); app.exit(1); return; }

    const driver = await js('window.__uniformLayouts ? window.__uniformLayouts() : null');
    if (!driver) { console.log('FAIL  the page does not expose __uniformLayouts'); app.exit(1); return; }

    // The driver names a member by its full path, prefixed with the block and its instance:
    // `LightingUniforms_block_0Fragment.u_lighting.u_pointLights[3].ambient`. Our path is the tail of
    // that. Comparing on the last SEGMENT instead was the first thing tried and it is wrong — every
    // struct-array element has a member called `ambient`, so it compared a struct-relative offset (16)
    // against a block-absolute one (464) and reported 350 phantom mismatches.
    const candidates = (name) => {
        const parts = name.replace(/\[0\]$/, '').split('.');
        const out = [];
        for (let i = 0; i < parts.length; i++) out.push(parts.slice(i).join('.'));
        return out;
    };

    let checked = 0, mismatched = 0, programsSeen = 0;
    const failures = [];

    const unmapped = [];
    for (const [program, members] of Object.entries(driver)) {
        if (!members || members.length === 0) continue;
        const stem = moduleOf.get(program);
        const table = stem ? computed.get(stem) : null;
        // A program with a block but no WGSL module would mean the mapping above has drifted, which
        // would silently shrink this check to nothing. Say so rather than passing vacuously.
        if (!table) { unmapped.push(program); continue; }
        programsSeen++;
        for (const reported of members) {
            let expected = null, name = null;
            for (const candidate of candidates(reported.name)) {
                const hit = table.get(candidate);
                if (hit) { expected = hit; name = candidate; break; }
            }
            if (!expected) continue;   // a member this module does not declare

            checked++;
            const problems = [];
            if (expected.offset !== reported.offset)
                problems.push(`offset computed ${expected.offset} vs driver ${reported.offset}`);
            if (expected.arrayStride !== undefined && reported.arrayStride > 0
                && expected.arrayStride !== reported.arrayStride)
                problems.push(`arrayStride computed ${expected.arrayStride} vs driver ${reported.arrayStride}`);
            if (expected.matrixStride !== undefined && reported.matrixStride > 0
                && expected.matrixStride !== reported.matrixStride)
                problems.push(`matrixStride computed ${expected.matrixStride} vs driver ${reported.matrixStride}`);

            if (problems.length) {
                mismatched++;
                failures.push(`  ${program}.${name} (${expected.type}): ${problems.join(', ')}`);
            }
        }
    }

    console.log('');
    console.log(`      ${programsSeen} programs with uniform blocks, ${checked} members compared`);
    if (mismatched) {
        console.log(`FAIL  ${mismatched} member(s) disagree with the driver`);
        for (const line of failures.slice(0, 25)) console.log(line);
        if (failures.length > 25) console.log(`  ... and ${failures.length - 25} more`);
        console.log('\n1 FAILED');
        app.exit(1);
        return;
    }
    if (unmapped.length) {
        console.log(`FAIL  ${unmapped.length} program(s) have uniform blocks but no WGSL module mapping`);
        console.log('      ' + unmapped.join(' '));
        console.log('');
        console.log('1 FAILED');
        app.exit(1);
        return;
    }
    if (checked === 0) {
        console.log('FAIL  nothing was compared — the name matching is broken, not the layout');
        app.exit(1);
        return;
    }
    console.log('PASS  every computed offset matches the driver');
    console.log('\nALL PASS');
    app.exit(0);
});
