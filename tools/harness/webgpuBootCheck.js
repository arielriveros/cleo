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
    // The game loop catches, logs and STOPS — `requestAnimationFrame` is inside its try, so a throw on
    // any frame after the first kills the loop silently as far as the probe is concerned (`_stage` is a
    // pass-through once the first frame completes). These messages are the only record of that, and
    // without them a dead loop looks exactly like a working one whose counters happen to read zero.
    //
    // CAPPED, and the cap is load-bearing: an uncapped collector hung this harness for ten minutes,
    // because the page does not log once — it logs continuously. That flood is itself a finding, so the
    // count is kept even though the messages are not.
    const consoleErrors = [];
    let consoleCount = 0;
    win.webContents.on('console-message', (_e, level, message) => {
        if (level < 2) return;
        consoleCount++;
        if (consoleErrors.length < 40) consoleErrors.push(message.slice(0, 900));
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
            //
            //    `expected.stage === null` is a real state, not a missing baseline: startup COMPLETES
            //    and the wall has moved past everything `_stage` wraps. The check inverts there —
            //    asserting there is no failure rather than that there is the right one — and the thing
            //    being ratcheted becomes `sceneError` below.
            const failedAt = probe.failedAt || {};
            if (expected.stage === null) {
                check('startup completes with no stage failure', probe.failedAt === null,
                    'expected none, got ' + JSON.stringify(probe.failedAt));
            } else {
                check('startup stops at the recorded stage', failedAt.stage === expected.stage,
                    'expected ' + expected.stage + ', got ' + failedAt.stage + ' — update '
                    + path.basename(BASELINE) + ' in the commit that moved it, with the diff');
            }
            check('stages reached match the baseline',
                JSON.stringify(probe.reached) === JSON.stringify(expected.reached),
                'expected ' + JSON.stringify(expected.reached) + ', got ' + JSON.stringify(probe.reached));

            // 2b. What stopped the PAGE, once startup itself no longer does.
            //
            //     `_stage` only wraps the renderer. The harness page builds a scene between
            //     `initialize()` and `run()`, and a throw in there means no frame is ever attempted —
            //     which reads identically to "everything is fine" if you only look at the probe. So the
            //     page's own error is part of the ratchet from here on: it is the thing that moves.
            const sceneError = await js('window.__error ? String(window.__error).split("\\n")[0] : null');
            // What the frame actually LOOKS like, on demand: `CLEO_WEBGPU_SHOT=1`.
            //
            // Not an assertion, and deliberately not one. This gate measures REACHABILITY - it knows
            // that nothing threw, and that is all it knows. The frame currently completes and comes out
            // BLACK, which is the honest state of the port and is invisible to every check here. Until
            // there is a signature comparison between the two backends, a human looking at a PNG is the
            // only instrument that can tell "it ran" from "it rendered".
            // What the frame SUBMITTED, reported beside the picture. A black frame with non-zero draws
            // is a different problem from a black frame with none, and this is the one number that
            // separates them.
            // AFTER forcing frames. `resetFrameStats` zeroes the counters at the top of the countable
            // part of a frame, while `frameMs` deliberately survives as the last completed frame's
            // value — so a read that lands between the reset and the first draw shows every counter at
            // zero next to a plausible frame time. That combination read as "the frame submitted
            // nothing" once already; it meant "the sample was taken in the gap".
            await win.webContents.capturePage();
            await sleep(250);
            await win.webContents.capturePage();
            const stats = await js('window.__stats ? JSON.stringify(window.__stats()) : null');
            if (stats) console.log('      frame stats: ' + stats);
            const scene = await js('(() => { try { return JSON.stringify({ models: window.__modelCount ? window.__modelCount() : -1, sceneSet: !!(window.__renderer && window.__renderer.deviceReady) }); } catch (e) { return "threw: " + e.message; } })()');
            console.log('      scene: ' + scene);
            const dims = await js('(() => { const s = window.__renderer.stats; return JSON.stringify({ w: s.width, h: s.height, rw: s.renderWidth, rh: s.renderHeight, pipeline: s.pipeline, backend: window.__renderer.backend }); })()');
            console.log('      dims: ' + dims);
            // Filtered to what is actionable. The page logs ~1800 level>=2 messages a run, most of them
            // scene-authoring noise ('AnimatedModel has no animations'), and the two or three that
            // matter are WebGPU validation failures naming a pipeline or an encoder.
            const notable = consoleErrors.filter(
                m => /bind group|pipeline|render pass|Invalid|uncaptured|usage/i.test(m));
            console.log('      console messages: ' + consoleCount + ' (level>=2)');
            for (const m of notable.slice(0, 5)) console.log('      log: ' + m.split('\n')[0]);

            // Does the RENDERER produce pixels, independent of whether the canvas composites?
            //
            // `screenshotOffscreen` renders into a private RGBA8 framebuffer and reads it back through
            // the device — no swap chain, no compositor, no capturePage. A black canvas with a non-black
            // readback means the frame is fine and the PRESENT path is not; both black means the frame is.
            const offscreen = await js(
                '(async () => { try { const e = window.__engine; if (!e) return "no engine";'
                + ' const url = await e.renderer.screenshotOffscreen(e.scene, 64);'
                + ' if (!url) return "empty"; const b = atob(url.split(",")[1]);'
                + ' let n = 0; for (let i = 0; i < b.length; i++) n += b.charCodeAt(i);'
                + ' return "png bytes=" + b.length + " checksum=" + n; }'
                + ' catch (err) { return "threw: " + err.message; } })()');
            console.log('      offscreen render: ' + offscreen);
            // Reported, not asserted — for now. `expected.offscreenBytes` is the current WebGPU figure,
            // and it is a RATCHET like the stage names above: a flat 64x64 PNG compresses to ~200 bytes,
            // a real one to several thousand, so this single number is the first thing in this migration
            // that can distinguish "the frame ran" from "the frame rendered". Raise it in the commit that
            // earns it. It becomes an assertion the day it is within reach of the WebGL2 reference.
            // PNG size alone cannot tell BLACK from TRANSPARENT, and they mean different things here:
            // `screenshotOffscreen` produces a transparent background on purpose and takes coverage
            // alpha from the scene depth, so an all-zero alpha would compress just as small as an
            // all-zero colour while pointing at the depth path instead of the colour path.
            const pixels = await js(
                '(async () => { try { const e = window.__engine;'
                + ' const url = await e.renderer.screenshotOffscreen(e.scene, 32); if (!url) return "empty";'
                + ' const img = new Image(); img.src = url; await img.decode();'
                + ' const c = document.createElement("canvas"); c.width = 32; c.height = 32;'
                + ' const x = c.getContext("2d"); x.drawImage(img, 0, 0);'
                + ' const d = x.getImageData(0, 0, 32, 32).data;'
                + ' let mr = 0, mg = 0, mb = 0, ma = 0, nz = 0;'
                + ' for (let i = 0; i < d.length; i += 4) {'
                + '   if (d[i] > mr) mr = d[i]; if (d[i+1] > mg) mg = d[i+1];'
                + '   if (d[i+2] > mb) mb = d[i+2]; if (d[i+3] > ma) ma = d[i+3];'
                + '   if (d[i] || d[i+1] || d[i+2] || d[i+3]) nz++; }'
                + ' return "maxRGBA=" + [mr,mg,mb,ma].join(",") + " nonZeroPx=" + nz + "/1024"; }'
                + ' catch (err) { return "threw: " + err.message; } })()');
            console.log('      offscreen pixels: ' + pixels);
            // Isolate READBACK from RENDERING: a bare clear into a fresh engine Framebuffer, read
            // straight back. Red means the device's pass + readback path is sound and the renderer's
            // own passes are what produce nothing; zeros mean everything measured above is measuring
            // the instrument.
            const clearProbe = await js(
                '(async () => { try { const r = window.__renderer;'
                + ' const fb = r._outlineMaskFBO;'
                + ' if (!fb || !fb.colors || !fb.colors[0]) return "no outline mask fbo";'
                + ' const enc = r.device.createCommandEncoder("clearProbe");'
                + ' const pass = enc.beginRenderPass(fb.renderTarget, { label: "clearProbe",'
                + '   colorAttachments: [{ target: 0, loadOp: "clear", storeOp: "store",'
                + '                        clearValue: [1, 0, 0, 1] }] });'
                + ' pass.end(); enc.finish();'
                + ' const px = await r.device.readPixels(fb.colors[0].attachmentView, 0, 0, 2, 2);'
                + ' return Array.from(px.slice(0, 8)).join(","); }'
                + ' catch (err) { return "threw: " + err.message; } })()');
            console.log('      clear+readback probe (expect 255,0,0,255): ' + clearProbe);
            // Did the GEOMETRY PASS rasterise anything? The G-buffer albedo is the first thing the
            // deferred pipeline writes, so non-zero bytes here mean vertices reached the rasteriser and
            // the problem is downstream; all-zero means the draws produce no fragments at all.
            const gbuf = await js(
                '(async () => { try { const r = window.__renderer;'
                + ' const fb = r._gBufferFBO; if (!fb || !fb.colors) return "no gbuffer";'
                + ' const out = [];'
                + ' for (let i = 0; i < fb.colors.length; i++) {'
                + '   const px = await r.device.readPixels(fb.colors[i].attachmentView, 0, 0, 32, 32);'
                + '   let nz = 0, mx = 0;'
                + '   for (let k = 0; k < px.length; k++) { if (px[k]) nz++; if (px[k] > mx) mx = px[k]; }'
                + '   out.push("c" + i + ":nz=" + nz + "/" + px.length + ",max=" + mx); }'
                + ' return out.join(" "); }'
                + ' catch (err) { return "threw: " + err.message; } })()');
            console.log('      g-buffer after a frame: ' + gbuf);
            // RAW WebGPU: a hardcoded triangle on the engine's own GPUDevice, bypassing every part of
            // the engine's draw path. This is the bisect. Red pixels mean the device, the queue, the
            // pipeline and the readback are all sound and the fault is in what the ENGINE feeds them;
            // no pixels mean the fault is below the engine entirely.
            const tri = await js(
                '(async () => { try { const dev = window.__renderer.device._device;'
                + ' const tex = dev.createTexture({ size: [32, 32], format: "rgba8unorm",'
                + '   usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });'
                + ' const mod = dev.createShaderModule({ code: `'
                + '@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {'
                + '  var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));'
                + '  return vec4<f32>(p[i], 0.0, 1.0); }'
                + '@fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(1.0, 0.0, 0.0, 1.0); }`});'
                + ' const pipe = dev.createRenderPipeline({ layout: "auto",'
                + '   vertex: { module: mod, entryPoint: "vs" },'
                + '   fragment: { module: mod, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },'
                + '   primitive: { topology: "triangle-list" } });'
                + ' const enc = dev.createCommandEncoder();'
                + ' const pass = enc.beginRenderPass({ colorAttachments: [{ view: tex.createView(),'
                + '   loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });'
                + ' pass.setPipeline(pipe); pass.draw(3); pass.end();'
                + ' const buf = dev.createBuffer({ size: 32 * 256,'
                + '   usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });'
                + ' enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: 256 },'
                + '   [32, 32]);'
                + ' dev.queue.submit([enc.finish()]);'
                + ' await buf.mapAsync(GPUMapMode.READ);'
                + ' const px = new Uint8Array(buf.getMappedRange().slice(0, 8));'
                + ' return Array.from(px).join(","); }'
                + ' catch (err) { return "threw: " + err.message; } })()');
            console.log('      raw webgpu triangle (expect 255,0,0,255): ' + tri);
            // What does the engine actually WRITE to its uniform buffers during a frame? An all-zero
            // view or projection matrix sends every vertex to w=0, which is degenerate: no fragments,
            // no validation error, and a clear that still lands - exactly the symptom. This counts the
            // writes over three real frames and reports how many carried any non-zero byte.
            const writes = await js(
                '(async () => { try { const dev = window.__renderer.device._device;'
                + ' const real = dev.queue.writeBuffer.bind(dev.queue);'
                + ' let calls = 0, nonZero = 0, bytes = 0;'
                + ' dev.queue.writeBuffer = function (buf, off, data, dOff, size) {'
                + '   calls++;'
                + '   const view = new Uint8Array(data.buffer ? data.buffer : data);'
                + '   bytes += view.length; let any = false;'
                + '   for (let i = 0; i < view.length; i++) if (view[i]) { any = true; break; }'
                + '   if (any) nonZero++;'
                + '   return real(buf, off, data, dOff, size); };'
                + ' await new Promise(r => requestAnimationFrame(() => requestAnimationFrame('
                + '   () => requestAnimationFrame(r))));'
                + ' dev.queue.writeBuffer = real;'
                + ' return "calls=" + calls + " withNonZeroData=" + nonZero + " bytes=" + bytes; }'
                + ' catch (err) { return "threw: " + err.message; } })()');
            console.log('      uniform writes over 3 frames: ' + writes);
            // Ground truth from the GPU commands themselves: for the first handful of indexed draws in
            // a real frame, what vertex buffer was bound, how big is it, how many indices, and what
            // viewport is in force. Everything above measured the engine's intent; this measures what
            // the driver was actually told.
            const cmds = await js(
                '(async () => { try { const P = GPURenderPassEncoder.prototype;'
                + ' const rec = []; let vb = null, vp = "default";'
                + ' const rsv = P.setVertexBuffer, rdi = P.drawIndexed, rvp = P.setViewport;'
                + ' P.setVertexBuffer = function (slot, buf, off) {'
                + '   if (slot === 0) vb = buf; return rsv.call(this, slot, buf, off); };'
                + ' P.setViewport = function (x, y, w, h, a, b) {'
                + '   vp = x + "," + y + "," + w + "x" + h; return rvp.call(this, x, y, w, h, a, b); };'
                + ' P.drawIndexed = function (n, i, f, bv) {'
                + '   if (rec.length < 6) rec.push("idx=" + n + " vbSize=" + (vb ? vb.size : "NONE")'
                + '     + " vp=" + vp);'
                + '   return rdi.call(this, n, i, f, bv); };'
                + ' await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));'
                + ' P.setVertexBuffer = rsv; P.drawIndexed = rdi; P.setViewport = rvp;'
                + ' return rec.length ? rec.join(" | ") : "no indexed draws recorded"; }'
                + ' catch (err) { return "threw: " + err.message; } })()');
            console.log('      first indexed draws: ' + cmds);
            // The last thing above the shader that has not been read back: the VALUES. Dump the first
            // 16 floats of the first few uniform-block writes in a frame. A sane view/projection pair
            // means the transform chain is intact and the fault is inside the shader or its bindings;
            // an identity or garbage matrix means it never got there.
            const mats = await js(
                '(async () => { try { const dev = window.__renderer.device._device;'
                + ' const real = dev.queue.writeBuffer.bind(dev.queue); const rec = [];'
                + ' dev.queue.writeBuffer = function (buf, off, data, dOff, size) {'
                + '   if (rec.length < 3 && data.byteLength >= 64) {'
                + '     const f = new Float32Array(data.buffer ? data.buffer : data, 0, 16);'
                + '     rec.push("[" + Array.from(f).map(v => v.toFixed(2)).join(",") + "]"); }'
                + '   return real(buf, off, data, dOff, size); };'
                + ' await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));'
                + ' dev.queue.writeBuffer = real;'
                + ' return rec.length ? rec.join(" ") : "no block writes seen"; }'
                + ' catch (err) { return "threw: " + err.message; } })()');
            console.log('      first uniform block writes: ' + mats);
            // THE SPLIT: was any fragment ever generated? The G-buffer's DEPTH attachment answers it
            // without touching a shader. Depth still at its clear means nothing rasterised, so the fault
            // is at or before clip space. Depth varying means fragments WERE produced and something
            // downstream (colour write mask, blend, attachment wiring) threw them away.
            const depth = await js(
                '(async () => { try { const r = window.__renderer;'
                + ' const t = r._gBufferFBO && r._gBufferFBO.depth;'
                + ' if (!t) return "no gbuffer depth";'
                + ' const fmt = t.format;'
                + ' if (fmt !== "depth32float") return "depth format is " + fmt + " (not copyable)";'
                + ' const dev = r.device._device; const tex = t.rhiTexture.handle;'
                + ' const enc = dev.createCommandEncoder();'
                + ' const buf = dev.createBuffer({ size: 32 * 256,'
                + '   usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });'
                + ' enc.copyTextureToBuffer({ texture: tex, aspect: "depth-only" },'
                + '   { buffer: buf, bytesPerRow: 256 }, [32, 32]);'
                + ' dev.queue.submit([enc.finish()]);'
                + ' await buf.mapAsync(GPUMapMode.READ);'
                + ' const f = new Float32Array(buf.getMappedRange().slice(0, 32 * 256));'
                + ' let mn = Infinity, mx = -Infinity, notOne = 0;'
                + ' for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {'
                + '   const v = f[y * 64 + x];'
                + '   if (v < mn) mn = v; if (v > mx) mx = v; if (v !== 1) notOne++; }'
                + ' return "min=" + mn + " max=" + mx + " notAtClear=" + notOne + "/1024"; }'
                + ' catch (err) { return "threw: " + err.message; } })()');
            console.log('      g-buffer depth: ' + depth);
            // THE SPLIT, via occlusion queries - depth24plus cannot be copied, but the hardware will
            // still say how many samples survived. Wrap the first few draws of the G-BUFFER pass (the
            // one with three colour attachments) in occlusion queries and resolve them.
            //   samples > 0  -> fragments ARE produced and pass depth; the fault is downstream (colour
            //                   write mask, blend, attachment wiring).
            //   samples == 0 -> nothing rasterises; the fault is at or before clip space.
            const occ = await js(
                '(async () => { try { const r = window.__renderer; const dev = r.device._device;'
                + ' const N = 64;'
                + ' const qs = dev.createQuerySet({ type: "occlusion", count: N });'
                + ' const out = dev.createBuffer({ size: N * 8,'
                + '   usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });'
                + ' let armed = true, active = null, enc = null, n = 0, done = false;'
                + ' const RBP = GPUCommandEncoder.prototype.beginRenderPass;'
                + ' const RDI = GPURenderPassEncoder.prototype.drawIndexed;'
                + ' const END = GPURenderPassEncoder.prototype.end;'
                + ' GPUCommandEncoder.prototype.beginRenderPass = function (d) {'
                + '   if (armed && !active && d.colorAttachments && d.colorAttachments.length >= 3) {'
                + '     const p = RBP.call(this, Object.assign({}, d, { occlusionQuerySet: qs }));'
                + '     active = p; enc = this; return p; }'
                + '   return RBP.call(this, d); };'
                + ' GPURenderPassEncoder.prototype.drawIndexed = function () {'
                + '   if (this === active && n < N) {'
                + '     this.beginOcclusionQuery(n); const v = RDI.apply(this, arguments);'
                + '     this.endOcclusionQuery(); n++; return v; }'
                + '   return RDI.apply(this, arguments); };'
                + ' GPURenderPassEncoder.prototype.end = function () {'
                + '   const v = END.call(this);'
                + '   if (this === active) { armed = false; active = null; done = true;'
                + '     const qb = dev.createBuffer({ size: N * 8,'
                + '       usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });'
                + '     enc.resolveQuerySet(qs, 0, N, qb, 0);'
                + '     enc.copyBufferToBuffer(qb, 0, out, 0, N * 8); }'
                + '   return v; };'
                + ' await new Promise(r2 => requestAnimationFrame(() => requestAnimationFrame(r2)));'
                + ' GPUCommandEncoder.prototype.beginRenderPass = RBP;'
                + ' GPURenderPassEncoder.prototype.drawIndexed = RDI;'
                + ' GPURenderPassEncoder.prototype.end = END;'
                + ' if (!done) return "never saw a 3-attachment pass with draws (n=" + n + ")";'
                + ' await out.mapAsync(GPUMapMode.READ);'
                + ' const q = new BigUint64Array(out.getMappedRange());'
                + ' const a = Array.from(q).map(Number);'
                + ' const nz = a.filter(function (v) { return v > 0; }).length;'
                + ' return "draws=" + n + " nonZero=" + nz + "/" + n + " max=" + Math.max.apply(null, a) + " last8=[" + a.slice(n - 8, n).join(",") + "] first8=[" + a.slice(0, 8).join(",") + "]"; }'
                + ' catch (err) { return "threw: " + err.message; } })()');
            console.log('      g-buffer occlusion: ' + occ);
            // ONE sample per draw means every vertex of a mesh lands on the same clip position - the
            // signature of position reading as a constant. So: what vertex layout is each pipeline
            // actually built with? An arrayStride of 0 makes every vertex read offset 0; a shaderLocation
            // that misses the WGSL's @location leaves position unfed. Both collapse a mesh to a point.
            const layouts = await js(
                '(async () => { try { const dev = window.__renderer.device._device;'
                + ' const real = dev.createRenderPipeline.bind(dev); const rec = [];'
                + ' dev.createRenderPipeline = function (d) {'
                + '   if (rec.length < 24 && d.vertex && d.vertex.buffers && d.vertex.buffers.length) {'
                + '     rec.push(d.label + " " + d.vertex.buffers.map(function (b) {'
                + '       return "stride=" + b.arrayStride + "[" + b.attributes.map(function (a) {'
                + '         return "loc" + a.shaderLocation + "@" + a.offset + ":" + a.format;'
                + '       }).join(" ") + "]"; }).join(" + ")); }'
                + '   return real(d); };'
                + ' window.__renderer._fullscreenPipelines.clear();'
                + ' await new Promise(r2 => requestAnimationFrame(() => requestAnimationFrame(r2)));'
                + ' dev.createRenderPipeline = real;'
                + ' return rec.length ? rec.join("  ||  ") : "no vertex pipelines rebuilt"; }'
                + ' catch (err) { return "threw: " + err.message; } })()');
            console.log('      pipeline vertex layouts: ' + layouts);
            // ModelTransform is u_model | u_view | u_projection, three mat4x4 at offsets 0/64/128 -
            // 192 bytes. Dump writes of that size: element 0 of each matrix, and the projection in
            // full. A zeroed projection sends every clip position to w=0; a projection that is present
            // but wrongly scaled squashes every object toward a point, which is what 1 sample per draw
            // looks like.
            const blk = await js(
                '(async () => { try { const dev = window.__renderer.device._device;'
                + ' const real = dev.queue.writeBuffer.bind(dev.queue); const rec = [];'
                + ' dev.queue.writeBuffer = function (buf, off, data, dOff, size) {'
                + '   if (rec.length < 2 && data.byteLength >= 192) {'
                + '     const f = new Float32Array(data.buffer ? data.buffer : data, 0, 48);'
                + '     rec.push("size=" + data.byteLength + " dstOffset=" + off'
                + '       + " model[0]=" + f[0].toFixed(3) + " view[0]=" + f[16].toFixed(3)'
                + '       + " proj=[" + Array.from(f.slice(32, 48)).map(function (v) {'
                + '           return v.toFixed(3); }).join(",") + "]"); }'
                + '   return real(buf, off, data, dOff, size); };'
                + ' await new Promise(r2 => requestAnimationFrame(() => requestAnimationFrame(r2)));'
                + ' dev.queue.writeBuffer = real;'
                + ' return rec.length ? rec.join("  ||  ") : "no 192-byte block writes seen"; }'
                + ' catch (err) { return "threw: " + err.message; } })()');
            console.log('      ModelTransform block: ' + blk);
            // Identity check. The matrices written are correct, so if the shader still sees zeros it is
            // reading a DIFFERENT buffer than the one written. Record every GPUBuffer that gets written
            // during a frame, and every buffer referenced by a ':uniforms' bind group, then intersect.
            // A uniform bind group pointing at a buffer nothing ever wrote is the whole bug.
            const ident = await js(
                '(async () => { try { const dev = window.__renderer.device._device;'
                + ' const rw = dev.queue.writeBuffer.bind(dev.queue);'
                + ' const rbg = dev.createBindGroup.bind(dev);'
                + ' const written = new Set(); const groups = [];'
                + ' dev.queue.writeBuffer = function (buf, off, data, dOff, size) {'
                + '   written.add(buf); return rw(buf, off, data, dOff, size); };'
                + ' dev.createBindGroup = function (d) {'
                + '   if (d.label && d.label.indexOf(":uniforms") >= 0)'
                + '     groups.push({ label: d.label, bufs: (d.entries || []).map(function (e) {'
                + '       return e.resource && e.resource.buffer; }).filter(Boolean) });'
                + '   return rbg(d); };'
                + ' window.__renderer._fullscreenPipelines.clear();'
                + ' await new Promise(r2 => requestAnimationFrame(() => requestAnimationFrame('
                + '   () => requestAnimationFrame(r2))));'
                + ' dev.queue.writeBuffer = rw; dev.createBindGroup = rbg;'
                + ' if (!groups.length) return "no :uniforms bind groups created";'
                + ' let hit = 0, miss = 0; const missed = [];'
                + ' for (const g of groups) for (const b of g.bufs) {'
                + '   if (written.has(b)) hit++;'
                + '   else { miss++; if (missed.length < 5) missed.push(g.label + "(size " + b.size + ")"); } }'
                + ' return "groups=" + groups.length + " boundBuffersWritten=" + hit'
                + '   + " neverWritten=" + miss + (missed.length ? " e.g. " + missed.join(", ") : ""); }'
                + ' catch (err) { return "threw: " + err.message; } })()');
            console.log('      uniform buffer identity: ' + ident);
            // VALIDATE THE INSTRUMENT before trusting it. This migration has already been misled twice
            // by instrumentation that read zero for its own reasons. A full-viewport triangle into a
            // 32x32 target must report 1024 samples; anything else means the occlusion numbers above
            // describe the query, not the geometry.
            const occVal = await js(
                '(async () => { try { const dev = window.__renderer.device._device;'
                + ' const tex = dev.createTexture({ size: [32, 32], format: "rgba8unorm",'
                + '   usage: GPUTextureUsage.RENDER_ATTACHMENT });'
                + ' const mod = dev.createShaderModule({ code: `'
                + '@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {'
                + '  var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));'
                + '  return vec4<f32>(p[i], 0.0, 1.0); }'
                + '@fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(1.0, 0.0, 0.0, 1.0); }`});'
                + ' const pipe = dev.createRenderPipeline({ layout: "auto",'
                + '   vertex: { module: mod, entryPoint: "vs" },'
                + '   fragment: { module: mod, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },'
                + '   primitive: { topology: "triangle-list" } });'
                + ' const qs = dev.createQuerySet({ type: "occlusion", count: 1 });'
                + ' const qb = dev.createBuffer({ size: 8,'
                + '   usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });'
                + ' const out = dev.createBuffer({ size: 8,'
                + '   usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });'
                + ' const enc = dev.createCommandEncoder();'
                + ' const pass = enc.beginRenderPass({ occlusionQuerySet: qs,'
                + '   colorAttachments: [{ view: tex.createView(), loadOp: "clear", storeOp: "store",'
                + '     clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });'
                + ' pass.setPipeline(pipe); pass.beginOcclusionQuery(0); pass.draw(3);'
                + ' pass.endOcclusionQuery(); pass.end();'
                + ' enc.resolveQuerySet(qs, 0, 1, qb, 0); enc.copyBufferToBuffer(qb, 0, out, 0, 8);'
                + ' dev.queue.submit([enc.finish()]);'
                + ' await out.mapAsync(GPUMapMode.READ);'
                + ' return String(new BigUint64Array(out.getMappedRange())[0]); }'
                + ' catch (err) { return "threw: " + err.message; } })()');
            console.log('      occlusion instrument check (expect 1024): ' + occVal);
            // Fragments pass and colour writes are enabled, so either the draws write nothing or they
            // write somewhere ELSE. Stamp the G-buffer pass's own clear a distinctive green and then
            // read the texture this harness has been sampling all along. Green means we are reading the
            // right texture and the draws genuinely write nothing; the old clear means the pass renders
            // into a different texture than the one being read, and every measurement above was aimed
            // at the wrong object.
            const aim = await js(
                '(async () => { try { const r = window.__renderer; const dev = r.device._device;'
                + ' const RBP = GPUCommandEncoder.prototype.beginRenderPass; let stamped = 0;'
                + ' GPUCommandEncoder.prototype.beginRenderPass = function (d) {'
                + '   if (d.colorAttachments && d.colorAttachments.length >= 3) {'
                + '     stamped++;'
                + '     const c = d.colorAttachments.map(function (a, i) {'
                + '       return i === 0 ? Object.assign({}, a, { loadOp: "clear",'
                + '         clearValue: { r: 0, g: 1, b: 0, a: 1 } }) : a; });'
                + '     return RBP.call(this, Object.assign({}, d, { colorAttachments: c })); }'
                + '   return RBP.call(this, d); };'
                + ' await new Promise(r2 => requestAnimationFrame(() => requestAnimationFrame(r2)));'
                + ' GPUCommandEncoder.prototype.beginRenderPass = RBP;'
                + ' const t0 = r._gBufferFBO.colors[0];'
                + ' const W = t0.width, H = t0.height;'
                + ' const cx = Math.max(0, (W >> 1) - 32), cy = Math.max(0, (H >> 1) - 32);'
                + ' const px = await r.device.readPixels(t0.attachmentView, cx, cy, 64, 64);'
                + ' let green = 0, other = 0;'
                + ' for (let i = 0; i + 8 <= px.length; i += 8) {'
                + '   const isGreen = px[i] === 0 && px[i + 1] === 0 && px[i + 2] === 0'
                + '     && px[i + 3] === 60 && px[i + 4] === 0 && px[i + 5] === 0;'
                + '   if (isGreen) green++; else other++; }'
                + ' return "gbuffer=" + W + "x" + H + " sampledAt=" + cx + "," + cy'
                + '   + " stillGreen=" + green + " overwrittenByDraws=" + other; }'
                + ' catch (err) { return "threw: " + err.message; } })()');
            console.log('      is the G-buffer the pass target: ' + aim);
            // Four passes per frame carry three colour attachments. Observe them WITHOUT changing them:
            // label, loadOp, and how many draws each records. If a later pass re-clears what an earlier
            // one drew, the survivor is whatever the last pass left - and a last pass with no draws
            // leaves exactly a clear, which is precisely what every readback here has shown.
            const passes = await js(
                '(async () => { try { const dev = window.__renderer.device._device;'
                + ' const RBP = GPUCommandEncoder.prototype.beginRenderPass;'
                + ' const RDI = GPURenderPassEncoder.prototype.drawIndexed;'
                + ' const RD = GPURenderPassEncoder.prototype.draw;'
                + ' const rec = []; const seen = new Map();'
                + ' GPUCommandEncoder.prototype.beginRenderPass = function (d) {'
                + '   const pass = RBP.call(this, d);'
                + '   if (d.colorAttachments && d.colorAttachments.length >= 3) {'
                + '     const e = { label: d.label || "?", n: 0,'
                + '       ops: d.colorAttachments.map(function (a) { return a.loadOp; }).join("/") };'
                + '     rec.push(e); seen.set(pass, e); }'
                + '   return pass; };'
                + ' GPURenderPassEncoder.prototype.drawIndexed = function () {'
                + '   const e = seen.get(this); if (e) e.n++; return RDI.apply(this, arguments); };'
                + ' GPURenderPassEncoder.prototype.draw = function () {'
                + '   const e = seen.get(this); if (e) e.n++; return RD.apply(this, arguments); };'
                + ' await new Promise(r2 => requestAnimationFrame(() => requestAnimationFrame(r2)));'
                + ' GPUCommandEncoder.prototype.beginRenderPass = RBP;'
                + ' GPURenderPassEncoder.prototype.drawIndexed = RDI;'
                + ' GPURenderPassEncoder.prototype.draw = RD;'
                + ' const half = rec.slice(rec.length / 2);'
                + ' return half.map(function (e) {'
                + '   return e.label + " loadOp=" + e.ops + " draws=" + e.n; }).join("  |  "); }'
                + ' catch (err) { return "threw: " + err.message; } })()');
            console.log('      3-attachment passes per frame: ' + passes);
            // '[EntryPoint "fs_main"] infringes limits' was set aside earlier as a separate defect. It
            // may be THE defect: an invalid pipeline makes every draw recorded against it a no-op, and
            // the harness scene's default material is exactly the one that fails. Chromium truncates
            // the reason in the console, so capture it in JS and print it whole.
            const limits = await js(
                '(async () => { try { const r = window.__renderer; const dev = r.device._device;'
                + ' const errs = []; const prev = dev.onuncapturederror;'
                + ' dev.onuncapturederror = function (e) { errs.push(e.error.message); };'
                + ' r._fullscreenPipelines.clear();'
                + ' await new Promise(r2 => requestAnimationFrame(() => requestAnimationFrame('
                + '   () => requestAnimationFrame(r2))));'
                + ' dev.onuncapturederror = prev;'
                + ' const tally = new Map();'
                + ' for (const m of errs) {'
                + '   const k = m.split(String.fromCharCode(10))[0].slice(0, 130);'
                + '   tally.set(k, (tally.get(k) || 0) + 1); }'
                + ' const rows = Array.from(tally.entries()).sort(function (a, b) { return b[1] - a[1]; });'
                + ' return "total=" + errs.length + " ;; " + rows.slice(0, 8).map(function (x) {'
                + '   return x[1] + "x " + x[0]; }).join(" ;; "); }'
                + ' catch (err) { return "threw: " + err.message; } })()');
            console.log('      uncaptured error tally: ' + limits);
            const lim2 = await js(
                '(async () => { try {'
                + ' const a = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });'
                + ' return "adapterMax=" + a.limits.maxBindGroups'
                + '   + " deviceGranted=" + window.__renderer.device._device.limits.maxBindGroups; }'
                + ' catch (err) { return "threw: " + err.message; } })()');
            console.log('      maxBindGroups: ' + lim2);
            const bytes = Number((/bytes=(\d+)/.exec(offscreen) || [])[1] ?? -1);
            if (expected.offscreenBytes !== undefined)
                console.log('      offscreen vs baseline: ' + bytes + ' (baseline '
                            + expected.offscreenBytes + ')');

            if (process.env.CLEO_WEBGPU_SHOT) {
                await win.webContents.capturePage();
                await sleep(400);
                const img = await win.webContents.capturePage();
                fs.writeFileSync(path.join(__dirname, 'shots', 'webgpu-frame.png'), img.toPNG());
                console.log('      shot: shots/webgpu-frame.png');
            }
            console.log('      scene build: ' + (sceneError || 'completed'));
            if (expected.sceneError === null) {
                check('the scene builds', !sceneError, String(sceneError));
            } else {
                check('the scene stops where the baseline says',
                    !!sceneError && sceneError.includes(expected.sceneError),
                    'expected to contain ' + JSON.stringify(expected.sceneError) + ', got '
                    + JSON.stringify(sceneError));
            }

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
                // The backend declining something it has not built yet, by name. Distinct from a
                // validation error (the driver refusing a real command) and from a missing port (a
                // WebGL2-only path being reached) - this is the RHI saying "not implemented", which is
                // the honest state for a feature WebGPU spells differently rather than not at all.
                notImplemented: /has no |does not exist yet|not implemented/i,
            };
            const wanted = expected.stage === null ? null : REASONS[expected.reason];
            if (expected.stage !== null)
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
        // The reference for the same offscreen probe the WebGPU side runs. A flat image compresses to a
        // couple of hundred bytes; a real one does not, so the two numbers say which of them rendered.
        const ref = await js(
            '(async () => { try { const e = window.__engine;'
            + ' const url = await e.renderer.screenshotOffscreen(e.scene, 64);'
            + ' if (!url) return "empty"; const b = atob(url.split(",")[1]);'
            + ' let n = 0; for (let i = 0; i < b.length; i++) n += b.charCodeAt(i);'
            + ' return "png bytes=" + b.length + " checksum=" + n; }'
            + ' catch (err) { return "threw: " + err.message; } })()');
        console.log('      webgl2 offscreen render: ' + ref);
        // This one IS asserted: it is the reference the WebGPU number is measured against, and a
        // reference that quietly went flat would make the comparison meaningless in the direction that
        // looks like progress.
        const refBytes = Number((/bytes=(\d+)/.exec(ref) || [])[1] ?? -1);
        check('webgl2 renders a non-trivial image', refBytes > 2000,
              ref + ' — a flat 64x64 PNG is ~200 bytes; this is the reference the WebGPU side is '
              + 'compared against, so it must not be blank');
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
