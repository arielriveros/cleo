# Real-GPU harnesses

Electron drivers that render through a real driver and check the result. They exist because
the unit suite is DOM-free and therefore has no GL context at all: everything below is a class of bug
`npm test` and `tsc` structurally cannot see.

They are the gate for the WebGPU migration (see `WEBGPU_ROADMAP.md`). Every shader conversion has to
leave all three green.

## Running

Electron lives in `desktop/`, and the drivers stage `dist/cleo.js` themselves, so build first:

```sh
npm run build:dev
desktop/node_modules/.bin/electron tools/harness/meshCheck.js
desktop/node_modules/.bin/electron tools/harness/passCheck.js
desktop/node_modules/.bin/electron tools/harness/nagaCheck.js
```

> If `ELECTRON_RUN_AS_NODE` is set in your shell, unset it for these commands
> (`env -u ELECTRON_RUN_AS_NODE …`). With it set, `electron` runs as plain Node, `require('electron')`
> returns a path string instead of the API, and the driver fails in a way that looks unrelated.

Each exits non-zero on failure and prints one `PASS`/`FAIL` line per check.

## What each one covers

### `meshCheck.js` — geometry and resources

Builds a scene through the engine's public API — cube, sphere, textured floor, sky cubemap, instanced
cubes, a skinned mesh, a tilemap — and asserts the frame stats against a known baseline
(**48 draws / 18862 triangles / 56586 vertices / 9 objects**). A scrambled vertex stride or a dropped
attribute shows up here as wrong geometry and nowhere else.

It also compiles every custom-material prelude on the real driver. That matters because the screen
prelude is *generated* from an interface description: text that reads correctly can still fail to
compile, and no unit test has a driver to find out.

### `passCheck.js` — per-pass visual signatures

The mesh harness renders with bloom, SSAO, motion blur and chromatic aberration **off**. Converting the
fullscreen shader programs rewrites exactly those passes, and nothing would notice: draw counts would not
move and the screenshot would not move. This driver turns on one pass at a time and reduces each frame to
an 8×8 grid of per-cell **mean and standard deviation**.

The deviation channel is load-bearing, not decoration. With mean-only cells, SSAO and a half-resolution
render measured as *identical to base* — a blur preserves local means almost exactly, and nearly every
pass worth gating here is a blur.

Record a baseline after an intentional change:

```sh
CLEO_PASS_BASELINE=write desktop/node_modules/.bin/electron tools/harness/passCheck.js
```

Two passes are held to a weaker contract ("it ran and moved the frame beyond the noise floor") because
they *cannot* be reproducible:

- **SSAO** builds its hemisphere kernel and its 4×4 rotation-noise texture from `Math.random()` at
  renderer construction, so two sessions genuinely produce different AO.
- **Motion blur** reprojects against the previous frame, so it needs the camera actually moving, which
  makes its output phase-dependent. It is compared against a motion-matched control instead.

`combined` deliberately excludes SSAO so that one stacked-pass configuration stays exact.

### `nagaCheck.js` — the WGSL translation path

Loads the vendored naga wasm the way the editor does (a `webpackIgnore`'d dynamic import over the page's
own protocol), installs it via `setWgslTranslator`, and checks all four verdict states: translates,
compiles-but-not-portable, engine-limitation, and outright broken. Every part of that is runtime-only and
invisible to the type checker.

It also asserts that **no WGSL is produced when no translator is installed** — if that ever fails, naga
has become reachable from the engine bundle and every published game is carrying 1.3 MB of shader
compiler.

### `backendDiff.js` — WebGL2 against WebGPU, configuration by configuration

Every other driver measures ONE backend. `webgpuBootCheck.js` gets closest — it renders the same scene
on both and compares the compressed size of the result — but a single scalar can only say "about two
percent off", and two percent has no owner.

This one loads the mesh page twice, once per backend, drives both through the SAME list of renderer
configurations (`passConfigs.js`, shared with `passCheck.js`, plus the thirteen `DebugView` channels the
baselined list does not reach) and diffs the 8×8 signatures per configuration. A difference then arrives
named: `debugCascades` disagrees, `debugNormal` does not.

It compares the two backends **against each other**, never against a stored picture. Recording a WebGPU
baseline today would freeze today's bugs as correct — the exact failure that let `basicSkinned` render
as a torn fan with a green gate, because the baseline had captured the corruption.

`backendDiff.json` is therefore a **ratchet**, not a baseline: per configuration, how many of the 128
values differ. A number may only go DOWN. It records how far apart the backends are today and refuses to
let them drift further, without ever claiming the current difference is correct.

```sh
npm run harness:backenddiff                       # verify
CLEO_BACKEND_DIFF=write npm run harness:backenddiff   # record, after a change that earned it
CLEO_DIFF_SHOT=<config> npm run harness:backenddiff   # write both backends' PNG for one config
```

Two things make it trustworthy, and both were needed:

- **`?seed=1`** on the page installs a deterministic `Math.random` BEFORE the engine is constructed, so
  the two renderers build the same SSAO kernel and rotation noise. Without it `ssao` and `debugSSAO`
  differ for a reason that is about neither backend. Opt-in, so no existing baseline moves. With it the
  whole run is byte-reproducible.
- **Both windows are checked for the backend they actually got.** A request can be refused, and every
  signature would then match perfectly for the worst possible reason.

Motion-dependent configurations are reported but not gated: they are phase-dependent, which no seed
fixes.

### `webgpuBootCheck.js` — engine startup on a WebGPU device

`webgpuCheck.js` proves the RHI's `WebGPUDevice` works against a real driver. This one drives the
ENGINE's own startup at it — `?backend=webgpu&cleoWebgpuProbe=1` on the mesh page — and reads
`renderer.deviceProbe`, which records the stage startup reached and the stage it died at.

It is a **ratchet**, not a pass/fail on the port being finished: startup is expected to fail on WebGPU
today, and `webgpuBoot.json` records exactly where. Porting a resource owner moves the failure forward
and that file is edited in the same commit, so the progress is a reviewable diff. It catches the two
things a boolean cannot — a failure that moves BACKWARDS, and one that moves forward without anybody
writing it down. It also catches the failure mode that motivated the whole check: acquisition silently
falling back to WebGL2 while every WebGPU-shaped assertion still passes against a WebGL2 device.

The second half of the run loads the same page with `?backend=webgl2` and asserts it still reaches
`firstFrame`. That is the control — device acquisition is the only code path that ships.

## Notes

- `pages/*/cleo.js` and `pages/naga/naga/` are staged copies, rewritten on every run. They are ignored by
  git; the sources are `dist/` and `src/graphics/rhi/webgpu/naga/`.
- `mesh:full` on the deferred pipeline has a known INTERMITTENT 2-cell difference (`cell21.sd`,
  `cell23.sd`, each ~8 low). It predates the WebGPU work and reproduces with every WebGPU change
  reverted. The likely mechanism is the volumetric clouds' Bayer 1/16 temporal resolve, which needs
  sixteen frames to converge and only gets as many as a hidden window's throttled `requestAnimationFrame`
  delivers — a less-converged cloud has less local contrast, which is exactly the direction the two
  cells move. Re-run before believing it.
- `passBaseline.json` **is** committed — it is the reference the gate compares against. So is
  `webgpuBoot.json`, which is a ratchet rather than a recording: never re-record it to make a red run
  green, and never edit it without the port that moved it in the same commit.
- The mesh harness pins `shadowStagger = false`. Staggered cascades make a single-frame stat snapshot
  depend on the frame index, which would make the baseline meaningless.
