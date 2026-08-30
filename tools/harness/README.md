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
group on WebGPU and silently did not draw. Both of those are in `customShaders.ts` and covered in
`tests/customShaderDialects.test.ts`; the packer's is in `texturePacker.ts`, where the ratchet is the
regression test — an orientation bug needs two real devices to see.

Two more came out of following the residual down instead of calling it noise. The diffuse-irradiance
convolution sampled its source cube through `textureSample`, which picks a mip from screen-space
derivatives — and there are none worth having when the "screen" is a cube face and the sample vector
sweeps a hemisphere between loop iterations. The two backends computed different levels, so every
probe's irradiance differed slightly: invisible on any surface direct light reaches, and the entire
colour of one that faces away from it. The `every` scene has such a surface on purpose.

And a uniform name was written to only the FIRST block declaring it. One program can declare the same
member twice — `u_view` lives in the transform block for the vertex stage and in the forward lighting
block for cascade selection — and for a custom forward material the transform block was the one that
lost, so the mesh drew at the origin with w = 0 and rasterised nothing. Right draw count, no validation
error, a shadow on the floor with nothing above it. `deferred.full` went 13/25 to 24/25 on that one
change; `debugCascades` went with it, because the built-in programs lost the same name the other way
round.

**Where it stands.** `base`, both `every2d` profiles and `forward.every` are 25/25 pixel-identical.
`deferred.every` and `deferred.full` are 24/25, and the one configuration left is `debugSSAO` at
1-2/128.

That last one is float divergence, not a bug: about 5% of pixels differ by 4-8/255 whatever is switched
on, and SSAO roughly doubles that because it compares reconstructed depths against a bias, so a
rounding difference flips a sample in or out. It is NOT the rotation noise — holding that constant on
both backends changes nothing, which is worth writing down because it is the obvious suspect. Outside
SSAO, eleven pixels in the whole frame differ by more than 40/255, all of them one specular highlight.

## `pomShots.js` — the parallax comparison, as pictures

`npm run harness:pom`. Not a gate: it renders and writes PNGs to `tools/harness/shots/pom/`, to be
looked at.

It builds a 400 m landscape carrying a brick height map at whatever tiling is asked for, plus the same
maps on a standard PBR slab beside it, captures the frame with the march on and with the layer depth
zeroed, and writes both plus an amplified difference. The difference is also reduced to a number —
mean, worst, and the percentage of pixels that moved — so "the relief looks flat" can be answered with
a measurement instead of an opinion.

    CLEO_POM_TILINGS=31,300   tilings to render (default 31,300)
    CLEO_POM_DEPTH=0.06       displacementScale, a fraction of one texture repeat
    CLEO_POM_CAMY=1.3         camera height, metres
    CLEO_POM_PITCH=14         camera pitch, degrees down

It exists because every other gate here answers "is the march alive", and none of them answers "does it
look like the same material on a mesh" — which was the actual complaint, and which four rounds of
reasoning about uniforms failed to settle. Two traps it was built on top of are worth knowing:
`scene.start()` does not start the render loop (`engine.isPaused = false; engine.run()` does), and POM
with a flat albedo and no normal map renders perfectly flat *correctly*, because a marched uv has
nothing to reveal.
