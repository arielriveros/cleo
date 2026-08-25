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


### `compareGallery.js` — the same comparison, as pictures

`backendDiff.js` answers "are the two backends the same?" as 128 numbers per capture and a ranked
table. That is the right shape for a gate and the wrong shape for a person: a delta cannot be looked
at. `CLEO_DIFF_SHOT` exists because of that gap, and it writes two PNGs for one named configuration.

This writes all of them. Four profiles — `every` and `every2d`, each deferred and forward — over the
same 28 configurations, in three images each: WebGL2, WebGPU, and their difference. Plus an
`index.html` to read them in.

```sh
npm run harness:compare
CLEO_COMPARE_PROFILES=deferred.every    # restrict the run (default: all four)
CLEO_COMPARE_DIR=<dir>                  # default: shots/compare
CLEO_COMPARE_GAIN=8                     # difference amplification
```

It is a **viewer, not a gate** — nothing here fails a build. It shares `passConfigs.js` with
`passCheck` and `backendDiff` so the frames it shows are the frames the gate measures, and it prints
`compare()`'s own numbers beside each pair so the page and the gate cannot disagree about what they are
looking at. It inherits the honoured-backend check too, for the same reason: a refused request would
make every pair identical for the worst possible reason, and that is the one failure a page of pictures
cannot show you.

The difference image is the maximum absolute channel difference, amplified (×8 by default) and drawn as
grey on black — read it as *where*, not as *how much*, and read `peak pixel` for the magnitude. The
amplification is the point: an honest difference of 4/255 is invisible, and "invisible" is exactly the
answer that image must not give by accident.

Output lands under `shots/`, which is gitignored — about 20 MB for a full run.

**What it showed first, and what that was.** On both `every` profiles the composited configurations
carried regular horizontal banding across the lower frame — ~185/255 at its peak while the signature
only moved 28/128, which is exactly the kind of localised difference block averaging hides and a
picture does not. That is what the page was built to catch, and it caught it on the first run.

It was the screen-space custom material, and through it a convention the port had not settled.
`fragTexCoord` addresses the RENDER TARGET, and the two APIs number a target's rows from opposite
ends; the engine reconciles that on the fullscreen quad (`renderer.ts`, the `v0` constant), so
`texture(u_screenTexture, fragTexCoord)` returns this pixel on both backends — but it reconciles it by
giving the coordinate opposite MEANINGS. The scene's tint sampled a USER texture at
`fragTexCoord * 4.0`, which therefore tiled from the bottom on one backend and from the top on the
other. No single varying can do better: the pixel a fragment must read is fixed and the two APIs
number it from opposite ends, so the prelude now also offers `screenUV()` — the same position with one
meaning — and the scene uses it. `base` went 28/128 -> 3, `combined` 18 -> 0, forward's worst 32 -> 8.

A packed texture came out of the same hunt. `TexturePacker._bake` builds a fullscreen quad of its
own and paired clip-space y with V the WebGL2 way on both backends, so every channel pack was
vertically mirrored on WebGPU — smooth, in the right channel, and upside down. `debugMetallic` on
`deferred.every` went 6/128 to 0, and `forward.every` reached full parity at 25/25.

The hunt also turned up a second bug the gate could not have found, because it needs a material to be
EDITED: a screen material that declares a value uniform its source does not read lost its whole bind
group on WebGPU and silently did not draw. Both of those are in `customShaders.ts` and covered in `tests/customShaderDialects.test.ts`; the
packer's is in `texturePacker.ts`, where the ratchet is the regression test — an orientation bug
needs two real devices to see.

**What is left.** 1-4 signature cells at worst 8/128 on `deferred.every`, and `deferred.full`'s
`debugSSAO` recorded at 2 rather than 0. Both are float divergence between two shader compilers
doing the same arithmetic: about 5% of pixels differ by 4-8/255 whatever is switched on, and SSAO
roughly doubles that because it compares reconstructed depths against a bias, so a rounding
difference flips a sample in or out. It is NOT the rotation noise — holding that constant on both
backends changes nothing, which is worth knowing because it is the obvious suspect. Outside SSAO,
eleven pixels in the whole frame differ by more than 40/255, all of them one specular highlight.

`deferred.full`'s entries were re-recorded here — every one of them fell (30 to 6, 20 to 0) except
`debugSSAO`, which rose from 0 to 2. That entry was recorded at `f492421`, before `0720c01` put two
custom-material models into the same scene; two more objects in the depth buffer is two more
objects for SSAO to occlude against. A stale baseline, not drift.

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
- **Two committed WebGL2 baselines do not reproduce on every machine, and that is not a code
  regression.** `passBaseline.json`'s `bloom` entry and `meshShading.deferred.json` both fail here in a
  way that reproduces at `203bbaf` — before any of the WebGPU parity work — with a freshly deleted
  Chromium profile, a fresh build, and the window shown rather than hidden. The deferred shading
  signature is consistently ~6 of 128 values out, always the same cells, always in the direction of
  less local contrast. The adapter is a single Intel Arc 140T; there is no second GPU to have switched
  to.

  So before reading a red `harness:mesh` or `harness:pass` as "my change moved WebGL2", **run the same
  driver at HEAD as a control and compare the two failure lines to each other**, not to the committed
  baseline. Identical cells and identical deltas mean the change moved nothing. Do NOT re-record either
  baseline to make the run green: what they were recorded against is exactly the thing that needs
  finding out.

  `backendDiff.js` is immune to this and is the signal to trust meanwhile — it compares two windows
  inside one session, so anything machine-dependent is shared by both and cancels.
- `mesh:full` on the deferred pipeline has a known INTERMITTENT shading difference, and it is much
  larger than it was first recorded as. Measured at the branch point `203bbaf`, with every WebGPU
  change reverted, four consecutive runs of the same command reported **10, 16, 19 and 16** differing
  cells — not the two (`cell21.sd`, `cell23.sd`) this note used to name. The base scene shows the same
  thing at a smaller scale: 5 to 6 cells.

  The signature is identical every time and is what identifies it: `sd` always DOWN and `mean` always
  UP, never the reverse. The likely mechanism is the volumetric clouds' Bayer 1/16 temporal resolve,
  which needs sixteen frames to converge and only gets as many as a hidden window's throttled
  `requestAnimationFrame` delivers — a less-converged cloud has less local contrast and, where the
  cloud is thin, more brightness, which is exactly those two directions.

  So: before believing a red `mesh` or `mesh:full` run, re-run it, and check the DIRECTION. Cells
  moving both ways, or a `mean` moving down, is not this. If it is still ambiguous, stash and measure
  the same command at `203bbaf` — that is what established the band above.
- `passBaseline.json` **is** committed — it is the reference the gate compares against. So is
  `webgpuBoot.json`, which is a ratchet rather than a recording: never re-record it to make a red run
  green, and never edit it without the port that moved it in the same commit.
- The mesh harness pins `shadowStagger = false`. Staggered cascades make a single-frame stat snapshot
  depend on the frame index, which would make the baseline meaningless.
