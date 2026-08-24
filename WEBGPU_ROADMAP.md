# WebGPU as a secondary backend — roadmap

> Status: in progress. Written 2026-08-21 against commit `5d2516e`; file paths and counts
> below are from that snapshot, so re-measure before relying on them.
>
> Done: M0-M3, the shader migration (40 of 57 programs on WGSL, pixel-verified against the
> GLSL they replaced), and the **device half of M6**. Not done: the renderer still issues
> ~160 raw `gl.*` calls, so nothing above the RHI can reach the WebGPU device yet.

## Context

Cleo is a WebGL2 engine (`package.json` describes it as one literally). The renderer is a single
5,417-line class with 885 raw `gl.*` tokens, 383 loose `setUniform` calls, no UBOs anywhere, and a
16-texture-unit budget that is already saturated — `renderer.ts` carries two named constants
(`SHADOW_UNIT = 6`, `SPOT_SHADOW_UNIT = 15`) whose comments explain that cascades were collapsed into a
texture array *because* the deferred pass sat at 15 of the 16 units ES 3.00 guarantees, and that custom
materials silently drop samplers past unit 15.

The goal is a second backend, for three reasons:

- **Performance headroom** — compute shaders, storage buffers, far lower per-draw CPU cost.
- **Future-proofing** — WebGL2 is legacy; the engine is still small enough to refactor.
- **Unblocking features WebGL2 can't reach** — clustered lighting (today `MAX_POINT_LIGHTS = 16`,
  `MAX_SPOTLIGHTS = 8`), GPU-driven culling, compute-based post, skinning beyond `MAX_BONES = 100`.

Scope decisions taken up front:

| Decision | Choice |
|---|---|
| Parity target | **Full parity** — all ~30 passes |
| Shader strategy | **GLSL stays the source of truth**; naga (wasm) translates to WGSL |
| Coexistence | **Device abstraction (RHI)** — refactor the WebGL2 renderer onto it first, then add WebGPU |
| Fallback | **WebGL2 keeps shipping**; both backends live in the bundle |

WebGPU support as of Aug 2026 is ~82–85% globally: Chrome/Edge 113+, Safari 26+ (macOS Tahoe, iOS 26),
Firefox 147 on Windows and ARM macOS. That last gap is why WebGL2 stays.

---

## The starting position

### What is already in our favour

- **One context, one creation site.** [`src/graphics/glContext.ts`](src/graphics/glContext.ts) is an
  18-line module exporting `let gl` as a live binding. Created only at
  [`renderer.ts:794-798`](src/graphics/renderer.ts#L794-L798) — `getContext('webgl2')` appears exactly
  twice in the whole repo, both there. Nine files import the binding.
- **The editor never touches GL.** 157 `from 'cleo'` imports across `editor/src`, zero `gl.*`. Workers
  are explicitly firewalled. `gl` / `setGLContext` are not in the public barrel
  ([`src/cleo.ts`](src/cleo.ts)); the only escape hatch is a `Renderer.context` getter no editor file
  uses.
- **State is already funnelled.** [`systems/glState.ts`](src/graphics/systems/glState.ts) — 164 call
  sites go through a dedup cache for program / VAO / caps / cull / depthMask / texture binds.
- **Draws funnel through two files** — [`mesh.ts`](src/graphics/mesh.ts) and
  [`tilemap/tileMesh.ts`](src/graphics/tilemap/tileMesh.ts). Seven `drawElements` / `drawArrays` sites
  in total.
- **A third of `src/graphics` is deliberately GL-free** and ports unchanged: `shadowMath.ts`,
  `ssaoKernel.ts`, `indexFormat.ts`, `renderStats.ts`, `lighting.ts`, `material.ts`, `animator.ts`,
  `ik.ts`, `animationRetarget.ts`, `tilemap/cellMath.ts`, and all of `core/`. Several say so in their
  header comments — it is a stated rule, kept for the DOM-free test suite.
- **UI is DOM-composited**, not a render pass. Zero porting work for the whole UI node system.
- `TextureConfig` is already backend-neutral (string unions, not GL enums).
- `gpuProfiler` is the one dependency-injected component — the template for everything else.

### What works against us

- **No UBOs at all.** Zero `bindBufferBase` / `UNIFORM_BUFFER` in `src/`. Every uniform is an individual
  `gl.uniform*`, including per-light arrays expanded by *name string* at
  [`renderer.ts:151-164`](src/graphics/renderer.ts#L151-L164). WebGPU has no loose uniforms. This is the
  single biggest structural gap.
- **`_setLighting` is O(lights × programs)** —
  [`renderer.ts:4186`](src/graphics/renderer.ts#L4186) rebinds every forward program once per light, per
  frame.
- **Skinning uploads 100 mat4 = 6,400 floats per skinned draw**, regardless of real bone count —
  [`_uploadBoneMatrices`, renderer.ts:3427](src/graphics/renderer.ts#L3427).
- **GL enums leak into public signatures** — `Mesh.draw(mode: number = gl.TRIANGLES)`, every `GLState`
  parameter, and `Texture._target` compared against `gl.TEXTURE_CUBE_MAP` inside the otherwise-pure
  `byteSize` getter.
- **`TileMesh` is a second, independent VBO/IBO/VAO implementation** that bypasses `Mesh` (its header
  explains it forked for per-cell tint/opacity attributes).
- **No frame graph.** Passes are hardcoded private method calls in a fixed order; framebuffers are
  long-lived constructor fields; `_composeIndex` is a hand-rolled 2-buffer ping-pong.
- **`customShaders.ts` hand-duplicates constants** (light counts, light structs, PBR helpers, G-buffer
  layout, `toLinear`/`toSrgb`) because runtime GLSL can't `#include`. Its header comment enumerates
  exactly what must be kept in sync.
- **No GPU tests exist.** vitest runs `environment: 'node'` — no jsdom, no headless GL; the policy is
  stated in [`vitest.config.ts`](vitest.config.ts). Render-adjacent tests such as
  [`tests/bloom.test.ts`](tests/bloom.test.ts) assert on *shader source text*, not pixels.

### Inventory

| Thing | Count |
|---|---|
| Engine source | 38,377 LOC |
| Editor source | 42,627 LOC |
| `renderer.ts` | 5,417 LOC |
| Raw `gl.*` tokens | 885, across 12 files |
| `setUniform` call sites | 383 (374 in `renderer.ts`) |
| `GLState.*` call sites | 164 (129 in `renderer.ts`) |
| Shader files | 65 (`.vs` / `.fs` / `.glsl`), 4,595 lines |
| Registered programs | 57 |
| Named render passes | 29 (`RENDER_PASSES` in `gpuProfiler.ts`) |
| G-buffer targets | 3 colour + depth |

---

## Design decisions

### 1. The RHI speaks WebGPU's vocabulary

New directory `src/graphics/rhi/`. Emulating WebGPU semantics on WebGL2 is routine — every engine that
supports both does it. Emulating GL's mutable global state on WebGPU is impossible. So the abstraction
is shaped like WebGPU, and the WebGL2 backend translates *down* into the deduped `GLState` calls it
already makes.

```
src/graphics/rhi/
  types.ts          string-union formats & enums: TextureFormat, VertexFormat,
                    PrimitiveTopology, CompareFunction, BlendFactor, AddressMode,
                    FilterMode, LoadOp/StoreOp, BufferUsage, TextureUsage, ShaderStage
  device.ts         interface Device + DeviceCapabilities (maxSamplers, hasCompute,
                    hasTimestampQuery, preferredCanvasFormat, ...)
  resources.ts      interface Buffer / Texture / Sampler / RenderPipeline / BindGroup
  pipelineCache.ts  descriptor-hash → pipeline (shared by both backends)
  webgl2/           WebGL2Device — where the existing 885 gl.* sites relocate to
  webgpu/           WebGPUDevice — new
```

### 2. `setUniform(name, value)` survives — behind a `UniformSet`

374 call sites is too much churn to eat up front, and the goal is to keep `renderer.ts` recognisable
through the refactor. The bridge is a `UniformSet` per program: a **CPU-side std140 buffer** plus a
name→offset map derived from shader reflection.

- `setUniform(name, value)` writes into the `ArrayBuffer`. **Signature unchanged, zero call-site churn.**
- `flush()` on WebGL2 → the existing `gl.uniform*` dispatch.
- `flush()` on WebGPU → `queue.writeBuffer(range)` + `setBindGroup`.

Sets are grouped by update frequency, which is also what fixes the two hot-path problems above:

| Group | Contents | Written |
|---|---|---|
| `@group(0)` | view, proj, invViewProj, prevViewProj, camera pos, time, exposure | once / frame |
| `@group(1)` | lights, cascade matrices + splits, spot matrices, IBL handles | once / pass |
| `@group(2)` | material properties + material textures | per material |
| `@group(3)` | model matrix, normal matrix, bone matrices (storage buffer) | per draw |

Group 1 collapses `_setLighting`'s per-light × per-program loop into a single buffer write. Group 3 lets
bone matrices become a storage buffer, retiring `MAX_BONES = 100`.

### 3. GLSL stays the source of truth; naga translates

One shader tree, no dual authoring — and, decisively, **existing user-authored custom materials saved in
projects keep working**.

- **Build time** for the 57 built-in programs: a webpack step runs naga over
  [`src/graphics/shaders/`](src/graphics/shaders/) and emits WGSL alongside the GLSL. Shipped games never
  pay for the wasm on the critical path.
- **Runtime** (naga wasm, ~1–2 MB, lazily fetched) only for user custom materials assembled by
  [`systems/customShaders.ts`](src/graphics/systems/customShaders.ts). Results cached by content hash in
  IndexedDB, and baked to WGSL at publish time so published games don't load naga either.
- **Prerequisite:** move `#include` resolution out of the `ts-shader-loader` webpack rule into a shared
  preprocessor module callable at runtime. This also retires the manual constant duplication in
  `customShaders.ts` that its own header warns about — worth doing regardless of WebGPU.

**Probe naga's GLSL-ES-300 frontend early**, before the rest is committed. Known-risky constructs in
this codebase:

| Construct | Where |
|---|---|
| `sampler2DArrayShadow` + hardware depth compare | [`environment/shadows.glsl`](src/graphics/shaders/environment/shadows.glsl) (239 lines, the shared include) |
| `gl_FragDepth` | [`screen/grid.fs`](src/graphics/shaders/screen/grid.fs) |
| MRT layout qualifiers | [`deferred/geometryPBR.fs`](src/graphics/shaders/deferred/geometryPBR.fs) |
| Dynamic indexing of uniform arrays | cascade / light loops throughout |
| 3D-texture sampling with explicit LOD | [`environment/volumetricClouds.fs`](src/graphics/shaders/environment/volumetricClouds.fs) (343 lines) |

Each gap is either a shader rewrite or a naga patch. Find out in week one, not month four.

### 4. Both backends ship

`graphics.backend: 'auto' | 'webgl2' | 'webgpu'` on `CleoConfig`. `auto` requests a WebGPU adapter and
falls back to WebGL2. The published player bundles both — `dist/cleo.js` is already 9.2 MB, so measure
the delta and keep a per-backend dynamic `import()` split in reserve.

---

## Milestones

> **M0–M5 refactor working WebGL2 code with no visible payoff — that is where the risk lives.
> Hard rule: every one of them ships with WebGL2 output pixel-identical, verified by screenshot diff.**

### M0 — Foundations, no behaviour change

- Add `@webgpu/types` to root and `editor/` devDependencies. Neither tsconfig pins `types` / `typeRoots`,
  so it auto-injects; the editor has `skipLibCheck: true`. No config surgery needed.
- Write `rhi/types.ts` and `rhi/device.ts`. Nothing consumes them yet.
- **Make device acquisition async.** Move `getContext` out of the `Renderer` constructor into
  `Renderer.initialize(): Promise<void>`. [`engine.ts:105`](src/core/engine.ts#L105) `_initialize()` is
  already `async` and already awaits, so the engine side is a one-line change — but audit
  [`EngineContext.tsx:4475`](editor/src/features/EngineContext.tsx#L4475), which constructs the engine
  and uses the renderer immediately.
- Add `Renderer.backend` and a `DeviceCapabilities` object that passes can branch on.

### M1 — De-GL-ify public signatures

- Replace raw GL enums in `Texture` / `Framebuffer` / `Mesh` / `GLState` signatures with the RHI string
  unions. `Mesh.draw(mode = gl.TRIANGLES)` → `topology: PrimitiveTopology = 'triangle-list'`.
- Extend `TextureConfig` with explicit `format` + `usage` flags (already string-based — a good start).
- Replace `Mesh._CANON_ATTR` name-matching and the hardcoded 14-float / 56-byte skinned stride with an
  explicit `VertexBufferLayout` descriptor. WebGPU pipelines need this up front; WebGL2 uses it happily.
- Pure unit tests for the format / enum mapping tables — fits the existing DOM-free vitest policy.

### M2 — Resources behind the RHI

- Rewrite [`texture.ts`](src/graphics/texture.ts), [`framebuffer.ts`](src/graphics/framebuffer.ts),
  [`cubeFramebuffer.ts`](src/graphics/cubeFramebuffer.ts),
  [`layeredDepthFramebuffer.ts`](src/graphics/layeredDepthFramebuffer.ts),
  [`mesh.ts`](src/graphics/mesh.ts) and [`tilemap/tileMesh.ts`](src/graphics/tilemap/tileMesh.ts) to call
  `device.*`. Ship `WebGL2Device` — the 885 `gl.*` sites relocate into `rhi/webgl2/` rather than
  disappearing.
- Fold `TileMesh` onto the shared buffer / vertex-layout abstraction; an explicit `VertexBufferLayout`
  removes the reason it forked from `Mesh`.
- `Framebuffer` → `RenderTarget` + an explicit `RenderPassDescriptor` (attachments, loadOp / storeOp,
  clearValue). This is what turns `_beginPass`
  ([`renderer.ts:3576`](src/graphics/renderer.ts#L3576)) into a real pass boundary rather than a
  profiler scope.

### M3 — Shader toolchain

- Extract the `#include` preprocessor into a shared module; make `customShaders.ts` use it and delete its
  duplicated constants.
- Integrate naga wasm behind `rhi/webgpu/glslToWgsl.ts`. Build-time step for built-ins, runtime path for
  custom materials, content-hash cache.
- **Run the frontend-gap probe from §3 and record the results.** Adjust scope here if something is
  unsupported. — **DONE, and it blocks. See below.**
- Snapshot tests over generated WGSL (pure text — fits vitest).

#### Probe results (2026-08-22) — the naga plan does not survive contact

The probe was meant to tell us which of the five flagged constructs naga's GLSL frontend chokes on. It
never got that far, because the premise is wrong: **there is no usable naga WASM build to ship.**

- `naga` on npm is version 1.0.0 with no description, no repository and no relation to gfx-rs — a name
  squat.
- `naga-wasm`, `naga-oil`, `@gfx-rs/naga`, `glsl-wgsl`, `spirv-cross-wasm`, `tint-wasm`: none exist.
- The only real one is **`wasm-naga@0.3.2`, published 2022-05-24** and unmaintained since. Its API is
  `glsl_in` / `wgsl_in` / `msl_out` / `spv_out` — **there is no `wgsl_out`**, so it cannot emit WGSL at
  all, which is the one thing we need it for.

Running its GLSL frontend over all 62 shaders anyway, to see how far it gets:

| Attempt | Result |
|---|---|
| As authored | 62/62 refused — `InvalidVersion(300)`; it rejects `#version 300 es` outright |
| `#version` stripped | 62/62 refused — `InvalidToken` on `precision` and `layout` |

`precision highp float;` and `layout(location = N)` are not exotic; they are core GLSL ES 3.00. A frontend
that rejects both cannot read this dialect, so the probe says **nothing** about `sampler2DArrayShadow`,
`gl_FragDepth`, MRT layout qualifiers, dynamic uniform-array indexing or 3D sampling. Those remain
genuinely unknown.

The blocker is availability, not capability: current naga (in-tree at gfx-rs/wgpu) has a much stronger
GLSL frontend and a real WGSL backend. It simply is not published in a form a web build can consume, and
there is no Rust toolchain on this machine to build one.

**This needs a decision before any more M3 work.** The forcing constraint is user-authored custom
materials: GLSL saved inside existing projects must run on WebGPU, and that means translating at
*runtime*, in the browser.

1. **Build and vendor naga ourselves** — `wasm-pack` over gfx-rs/naga, artifact checked in or published
   to our own registry. Keeps the roadmap's strategy intact. Cost: Rust in the build pipeline, and we
   own the upgrade treadmill.
2. **Build-time translation only** (`naga-cli`, Rust at build time, no runtime wasm). Cheaper and covers
   all 62 engine shaders — but leaves custom materials with no runtime path, so they would need a WGSL
   authoring mode or a translation service.
3. **Invert the source of truth** — author WGSL, generate GLSL ES 300 for WebGL2. Roadmap option 4,
   previously rejected on rewrite cost. It is worth re-pricing now that the reverse direction has no
   shippable tool.
4. **Hand-author both** — rejected before and no more attractive now.

#### Update — naga is built and vendored, and it changes the direction (2026-08-22)

Option 1 was chosen and is **done**: `tools/naga-wasm/` is a wasm-bindgen wrapper around naga, built with
`npm run naga:build`, artifact vendored to `src/graphics/rhi/webgpu/naga/` and committed so a normal
build needs no Rust. Pinned to naga **29.0.4** — 30.0.1 does not compile its own `glsl-in` feature.

With a real naga in hand, the probe finally answered the original question, and the answer inverts the
plan. Isolating construct by construct:

| Construct | GLSL → WGSL | WGSL → GLSL ES 300 |
|---|---|---|
| MRT layout qualifiers | works | works |
| `gl_FragDepth` | works | works |
| dynamic index into a uniform block | works | works |
| struct array + loop (the light loop) | works | works |
| varyings, vertex stage | works with explicit `location` | works |
| `precision` qualifiers | **not implemented** | emitted correctly |
| `#version 300 es` | **rejected** — only desktop 440/450/460 | emitted correctly |
| `sampler2D`, `samplerCube`, `sampler2DArrayShadow`, `sampler3D` | **not a type at all** | emitted correctly |

**naga's GLSL frontend is Vulkan GLSL, not OpenGL ES GLSL.** Combined samplers are absent from its type
table (`naga/src/front/glsl/types.rs` knows `sampler`, `samplerShadow`, `texture2D`, …); only the
separate `texture2D` + `sampler` pair parses. That is a design choice, not a version gap, and it is not
a shim away — it would mean rewriting every sampling call in 4,595 lines of engine GLSL *and* in every
user-authored custom material.

Its GLSL **backend** emits exactly the dialect we need — `#version 300 es`, `precision highp float`,
`uniform highp sampler2DArrayShadow`, std140 blocks, MRT outputs — because that is the path wgpu itself
uses to run WGSL on WebGL2. It is naga's most exercised combination by a wide margin.

So the roadmap's §3 decision ("GLSL stays the source of truth; naga translates") is not achievable with
naga. The viable shape is **option 4, inverted**: author WGSL, generate GLSL ES 300 for WebGL2. That was
rejected earlier on rewrite cost; it should be re-priced, because it is now the only direction with a
working tool, and it moves the WebGL2 path onto generated code rather than the WebGPU one.

Both directions are exported today (`wgsl_to_glsl`, `glsl_to_wgsl`) at 1.42 MB. Dropping the dead
direction takes the artifact to 1.04 MB.

The open question is no longer "can naga do it" but **"what happens to user-authored custom materials"**,
since those are GLSL stored inside saved projects. That needs a decision before M3 continues.

The `#include` extraction below is independent of all of this and can proceed either way.

#### Resolved — custom materials keep their GLSL, and the editor translates it (2026-08-22)

The open question above is answered: **the user keeps writing GLSL.** One snippet is assembled twice —
against an ES 300 prelude for WebGL2 and against a Vulkan GLSL prelude for naga — and the *body* never
has to differ. Both preludes are generated from a single `PreludeInterface` description in
`systems/customShaders.ts`, because a hand-maintained second copy would drift the moment somebody added
a built-in to one and not the other, and the symptom would be a user's material failing for a reason
they did not cause and cannot see.

Translation runs in the **editor**, never in a player. The engine holds a slot (`setWgslTranslator`);
`editor/src/utils/wgslTranslator.ts` fills it with a `webpackIgnore`'d dynamic import of the vendored
artifact, so naga stays out of both bundles and is fetched only when a custom material is opened. The
result is stored on the material as `compiledWgsl`, stamped with `compiledWgslType` — the content hash
it was produced from, which makes staleness a comparison rather than an event and survives save/load.

##### What Vulkan GLSL will and will not take (measured, naga 29.0.4)

Every item was probed against the real wasm; none of it is inference.

| Construct | Verdict |
|---|---|
| `#version 300 es`, `precision` | **rejected** — `InvalidVersion(300)`, `InvalidProfile("es")`. Vulkan GLSL is `#version 450`, no precision qualifiers anywhere. |
| `uniform sampler2D t;` | **rejected** — no combined samplers. Split into `texture2D` + `sampler` and rebuild with `#define t sampler2D(t_t, t_s)`. naga runs a real preprocessor, so the user's `texture(t, uv)` is untouched. Verified for `sampler2D`, `samplerCube`, `sampler2DArray` and `sampler2DArrayShadow`. |
| loose `uniform float u_time;` | **rejected** — "uniform/buffer blocks require layout(binding=X)". Everything scalar must live in an explicitly bound block. |
| `bool` as a block member | **rejected** — `NonHostShareable`. Carried as an `int` plus a `#define`. |
| `in mat3 TBN;` | **rejected** — `NotIOShareableType`. A mat3 is not a valid interface type; it has to become three `vec3` varyings, on both sides of the boundary. |
| `uniform struct X { … } inst;` | **rejected** — same binding error. The struct definition has to be split out from the instance. |
| struct arrays in a block, function overloading, global `const vec4`, 3 MRT outputs | **accepted.** |

##### Consequences

- **Screen mode is fully supported today.** It has no lighting, no shadow library and no mat3 varying,
  so its prelude renders into both dialects and a realistic post-process material translates end to end.
- **Forward and deferred are not**, and the blocker is engine text, not user text: those preludes carry
  all three rejected constructs plus `shadows.glsl`, 239 lines of GLSL ES with `highp` throughout.
  Porting them is the same work as moving the engine's own forward lighting to WGSL — M7, not here.
  Until then `vulkanUnsupportedReason()` returns prose explaining the engine's limitation, and the
  editor shows that instead of a naga diagnostic pointing into a prelude the user never wrote.
- The two verdicts stay separate all the way to the UI. GL failure blocks apply; naga failure is a
  warning. "Works on WebGL2, not on WebGPU" is now a real state a project can be in, and it is said
  plainly rather than being collapsed into either an error or silence.

### M4 — `UniformSet` + bind groups

- Implement the std140 CPU-buffer `UniformSet`. Reflection comes from `getActiveUniform` (WebGL2) and
  from naga's reflection output (WebGPU). Wire `ShaderManager.setUniform` through it.
- Regroup uniforms by frequency per the table in §2.
- Retire `_textureSlot()`'s fixed slots in favour of bind-group entries. The WebGL2 backend keeps
  assigning units internally, but nothing above the RHI knows about "unit 15" any more.
- Bone matrices → storage buffer on WebGPU, uniform array on WebGL2.

### Checkpoint — pricing the remaining 55 programs (2026-08-22)

Two pilots are done (`screen`, `present`). This is the re-assessment the plan called for before
converting the rest, based on measurement rather than extrapolation from two fullscreen passes.

#### The inventory

57 registered programs over 62 shader files and ~4,600 lines. Two are converted. The rest splits into
tiers that are *not* comparable in cost:

| Tier | Count | Shape |
|---|---|---|
| Fullscreen (`ScreenVertex` + one `.fs`) | ~24 | Identical to both pilots. Bloom x3, motion blur x4, SSAO x2, clouds x3, god rays, composer, grid, outline, debug views, sky fog, probe preview, BRDF, deferred lighting. |
| Material / geometry | ~31 | pbr / default / basic, each x forward, deferred, skinned, instanced; shadow casters x4; terrain x3; tilemap; IBL x3; skybox. |

#### What WGSL can express — 15 of 16, measured

Every construct the remaining shaders need was probed through the real `wgsl_to_glsl`:

**Works:** comparison samplers (`texture_depth_2d_array` + `sampler_comparison` → `sampler2DArrayShadow`),
texture arrays, cube textures, three-target MRT, integer vertex attributes for bone indices, per-instance
`mat4` as four `vec4` locations, `instance_index` / `vertex_index`, arrays of structs in uniform blocks,
derivatives, `discard`, `textureLoad`, `textureDimensions`, `frag_depth`, `front_facing`. (`texture_2d_array`
needs its template argument — `texture_2d_array<f32>` — unlike `texture_depth_2d_array`.)

**Does not work — the one real blocker:** `out mat3 TBN`. WGSL has no matrix interface type; it fails
validation as `NotIOShareableType`. It has to become three `vec3` varyings recombined in the fragment
stage, which is proven to work but is a change to the **contract between** a vertex and a fragment stage.
13 shader files reference TBN, so each material family must convert atomically — a half-converted pair
links cleanly and renders garbage.

So the risk is not "can WGSL do this". It is one contract change, plus the shared-chunk ordering.

#### The gate had a hole, and it is now closed

The mesh harness renders with bloom, SSAO, motion blur and chromatic aberration **off**. Converting the
fullscreen tier would have rewritten precisely those passes with nothing underneath: draw counts would not
move, the screenshot would not move, and a broken bloom would ship. `passCheck.js` now toggles each pass
and compares an 8x8 grid of per-cell mean **and standard deviation**.

The variance channel is not decoration. With mean-only cells, SSAO and a half-resolution render measured
as *identical to base* — a blur preserves local means almost exactly, and nearly every pass worth gating
here is a blur. Adding deviation took SSAO from 2 differing values to 20, halfScale from 3 to 16, motion
blur from 4 to 25.

Two passes cannot have an exact cross-run baseline, both found by a gate that failed 1 run in 3:

- **SSAO** builds its kernel *and* its 4x4 rotation-noise texture from `Math.random()` at renderer
  construction, so two sessions genuinely differ. Normal for SSAO, fatal for a baseline.
- **Motion blur** reprojects against the previous frame, so it needs real camera motion, which makes the
  output phase-dependent.

Both are held to "the pass ran and moved the frame beyond the noise floor" against a motion-matched
control; `combined` deliberately excludes SSAO so one stacked configuration stays exact. Four consecutive
verification runs pass clean.

#### The raw-uniform-location landmine (found the hard way, 2026-08-22)

Converting `ssao.fs` to WGSL made SSAO output a uniform 1.0 while still paying for a full-resolution
pass. Nothing errored. The cause was not in the shader: `_renderSSAO` uploaded its kernel through a
cached `gl.getUniformLocation(program, 'u_samples[0]')`, and that returns **null** for a member of a
std140 block — the same value an unused uniform returns, so the guard `if (loc)` swallowed it.

**Eight more sites have the same shape** and will fire during the material tier: four cascade uniforms
and three spot-shadow uniforms in `_uploadShadowUniforms`, plus `u_boneMatrices` for skinning. Each one
belongs to a shader that has not moved to WGSL yet.

They cannot just be switched to `setUniform`: GL names an array `u_cascadeMatrices[0]`, so
`Shader.storeUniforms` files it under that name and a bare-name set finds nothing — which is precisely
why the raw locations exist. Doing it properly means registering the `[0]`-stripped name in
`storeUniforms` and having `_setUniform` pick the `*v` variants when `size > 1`. **That is worth
scheduling as its own step before any material shader converts**, rather than discovering it eight more
times. The gates do cover it in the meantime (the mesh harness renders shadows and a skinned mesh; the
pass harness has a `noShadows` configuration), but a gate catching it is a worse outcome than it not
happening.

#### Recommended order

1. **Fullscreen tier (~24)**, in batches, sharing `chunks/fullscreen.wgsl` and `chunks/tonemap.wgsl`.
   Low risk, high count, and now the only tier with real coverage underneath it.
2. **The TBN contract change** on its own, across all 13 files, converting nothing else.
3. **`shadows.glsl` → a WGSL chunk** (239 lines, included by every forward material) before its consumers.
4. **Material families**, one at a time, each atomically across its vertex and fragment stages.
5. Stragglers: terrain, clouds, sky atmosphere, IBL.

One caveat worth stating plainly: both harnesses currently live in a session-scoped scratch directory, not
in the repository. They are the only thing standing between this migration and silent visual regressions,
and they should be committed before the conversion work begins in earnest.

### M5 — Pipeline state objects

- Collapse `GLState.enable/disable/cullFace/depthMask` plus `_applyCull` and `_restoreDefaultBlend` into
  immutable `RenderPipeline` descriptors, cached by descriptor hash. The WebGL2 backend translates a
  pipeline bind into the deduped state calls it already makes.
- The largest `renderer.ts` diff of the project (~129 `GLState` sites). Consider splitting `renderer.ts`
  into pass modules first — see Risks.

### M6 — WebGPU first light

**The device half is done** (`rhi/webgpu/webgpuDevice.ts`, `webgpuEnums.ts`). Unlike `WebGL2Device`,
it declares `implements Device` outright: every concept the RHI names exists natively in WebGPU, so
there was nothing to stub. That makes it the reference implementation, and it did its other job —
finding where the interface was wrong. Two corrections came out of it:

- `ShaderModuleDescriptor.source` still claimed **GLSL** was the source of truth for both backends.
  M3 inverted that. It now takes WGSL and carries `entryPoints`, because WebGPU needs an entry-point
  name at pipeline creation and has no `main` convention to fall back on.
- `ShaderModule` gained `entryPoints` for the same reason, and its `stage` is now a MASK: one WGSL
  module carries both stages, since naga derives varying names from a module's location numbers and
  the two stages only agree when they came from the same module.

Verified on a real driver by `npm run harness:webgpu` (9 checks), which is where the shape differences
that matter actually surfaced:

- **Secure context.** `navigator.gpu` is undefined on a `data:` or `file://` page, so the harness page
  is served over the privileged `app://` scheme. Missing this reads exactly like "this Electron has no
  WebGPU" and cost a wrong conclusion once.
- **A pipeline must declare the pass's depth format.** WebGPU validates the whole attachment state,
  colour formats and depth alike; a pipeline with no `depthStencil` cannot draw into a target that has
  a depth view, and the failure is an invalidated command buffer with every attachment reading black.
  WebGL2 never cared, because depth testing was global state a shader neither saw nor declared. Every
  G-buffer pipeline will have to name it.
- **`copyTextureToBuffer` rows must start on 256-byte boundaries**, so readback allocates a padded
  staging buffer and strips the padding. This is why `Device.readPixels` is async for both backends.
- Optional features (`float32-filterable`, `timestamp-query`) must be *requested* at `requestDevice`;
  an adapter that supports one still yields a device without it. Intersect, request, then report what
  was granted.

Still to do — the half that needs M5:

- Swap-chain presentation into the editor viewport (`getCurrentSurfaceTarget` and
  `reconfigureSurface` exist; nothing calls them).
- Pipeline and bind-group **caches**. Both are created per call today, which is correct but not yet
  fast, and the cache key is the reason `rhi/types.ts` uses string unions.
- Target: geometry pass → deferred lighting → present. One scene, PBR, no shadows. This validates the
  RHI before parity work begins, and it cannot start until `renderer.ts` stops calling `gl` directly.

### M7 — Parity sweep (~30 passes)

Ordered by dependency and risk.

1. **Shadows** — cascade `TEXTURE_2D_ARRAY` + spot atlas. `framebufferTextureLayer` →
   `createView({ baseArrayLayer })`. Depth compare maps cleanly (`sampler_comparison` /
   `textureSampleCompare`). Keep the staggered cascade update
   ([`renderer.ts:4119`](src/graphics/renderer.ts#L4119)).
2. **Core post** — SSAO + blur, bloom (6 mips), tonemap / present, chromatic aberration, outline, grid
   (`gl_FragDepth` → `@builtin(frag_depth)`).
3. **Depth copy** — `blitFramebuffer` → `copyTextureToTexture`. `_copySceneDepth`
   ([`renderer.ts:2549`](src/graphics/renderer.ts#L2549)) already exists because a depth texture can't be
   sampled while bound for testing, so the shape is already right.
4. **Motion blur** — velocity → tileMax → neighborMax → gather.
5. **IBL + sky bakes** — BRDF LUT, irradiance, prefilter mips, sky-atmosphere cubemap, probe capture.
   Cube faces → `createView({ dimension: '2d', baseArrayLayer: face })`.
6. **Volumetric clouds** — the 3D noise bake currently renders slice-by-slice via
   `framebufferTextureLayer`
   ([`_bakeCloudNoise`, renderer.ts:2924](src/graphics/renderer.ts#L2924)). **WebGPU render passes
   cannot target 3D texture slices, so this must become a compute shader** — strictly better anyway.
   Then the Bayer 1/16 temporal resolve with ping-pong history.
7. **God rays, skyFog.**
8. **Terrain splat** (9 samplers today — trivial under bind groups) and **foliage instancing**.
9. **Tilemap / 2D pass / sprites.**
10. **Gizmos, skeleton overlay, selection mask, debug views, overdraw.**
11. **Thumbnails — an API break.** `screenshotOffscreen`
    ([`renderer.ts:1176`](src/graphics/renderer.ts#L1176)) uses `gl.readPixels` and returns a data URL
    *synchronously*. WebGPU readback is `copyTextureToBuffer` + `mapAsync`. Needs an async variant
    threaded through `captureClean` / `renderModelThumbnail` in
    [`editor/src/utils/modelThumbnails.ts`](editor/src/utils/modelThumbnails.ts) and its callers.
12. **Custom materials** (forward / deferred / screen) via the runtime naga path.
13. **GPU profiler** — `EXT_disjoint_timer_query_webgl2` → `GPUQuerySet` timestamp queries (an optional
    WebGPU feature; gate on it). [`gpuProfiler.ts`](src/graphics/gpuProfiler.ts) is already DI'd, so this
    is the easy one.

### M8 — Editor & platform

- Backend selector in
  [`RendererOptions.tsx`](editor/src/features/renderer/RendererOptions.tsx); plumb `graphics.backend`
  through `CleoConfig`.
- Async engine init through [`EngineContext.tsx`](editor/src/features/EngineContext.tsx) and
  [`EngineViewport.tsx`](editor/src/features/EngineViewport.tsx). The canvas is re-parented on every mode
  switch ([`DockLayout.tsx:243`](editor/src/features/layout/DockLayout.tsx#L243) and `:460`) — a WebGPU
  canvas context survives re-parenting but must be reconfigured on resize.
- Publish: bake WGSL at publish time, bump `PLAYER_CONTRACT`, ship both backends with runtime fallback.
- Desktop: Electron 31 → Chromium 126. Verify WebGPU is enabled without extra flags in the packaged app.

### M9 — Spend the capability

The reason for the port. None of this is possible on WebGL2.

- **Compute cloud-noise bake** — forced in M7.6; now generalise the compute path.
- **Clustered / tiled forward+ lighting** → retires `MAX_POINT_LIGHTS = 16` and `MAX_SPOTLIGHTS = 8` in
  [`shaders/constants.glsl`](src/graphics/shaders/constants.glsl).
- **Compute skinning** into a storage buffer → retires `MAX_BONES = 100` and the 6,400-float per-draw
  upload.
- **GPU frustum culling + indirect draw** → retires the `3 + cascadeCount + spotCasters` CPU traversals
  of `scene.models` every frame.
- **Material texture arrays** instead of per-draw sampler binds.

---

---

## What is left before WebGPU renders a frame

Measured 2026-08-23, not estimated. Re-measure rather than trusting these numbers once the migration
moves — the counts are the point, and they only mean something fresh.

**Already done, and worth naming so it is not re-planned:**

- The **device**. `rhi/webgpu/webgpuDevice.ts` is a complete `Device` — pipelines, bind groups, render
  passes, layered attachments, readback — verified on a real driver by `npm run harness:webgpu`.
- **Async device acquisition.** `Renderer.initialize()` exists and both hosts await it
  (`core/engine.ts`, `editor/src/features/EngineContext.tsx`).
- **The command model on WebGL2.** `rhi/webgl2/webgl2Commands.ts`, plus build-time WGSL reflection, so
  renderer passes can move onto an API both backends implement.
- **Every shader program is WGSL.** All 57, with GLSL ES 300 generated at build time by naga. The two
  remaining `.vs`/`.fs` files are `materials/pbr.vs` and `screen/screen.vs`, which `customShaders.ts`
  pastes in as *text* to build a user's custom material — they are not programs.
- **The uniform layer.** `tools/wgslLayout.mjs` computes WGSL uniform offsets and `rhi/uniformSet.ts`
  writes by name; `npm run harness:uniforms` checks all 1,697 members across 53 programs against the
  offsets a real driver reports, and they agree exactly.
- **The three framebuffer classes**, collapsed into `RenderTarget` (see item 3).

### 1. Renderer passes onto the RHI command model — done

Current surface in `renderer.ts`: **35** real `gl.*` calls (from ~120), **87** `GLState` calls,
**27** program binds, **48** `setBindGroup` sites.

**Every draw in the deferred pipeline now goes through the RHI: `rhiDrawCalls` is 165 of 165 in the
full scene and 101 of 101 in the base one.** The last per-frame holdout was the SELECTION OUTLINE MASK,
which had never been migrated at all — it bound a program by name, set uniforms and drew straight at the
context. It was found by instrumenting `Mesh`'s three legacy draw entry points with per-call-site
counters rather than by reading the code: the base scene reported zero legacy draws, the full scene
exactly one per frame, and tagging the call sites named it in one run. Two notes from doing that, since
the obvious version does not work: capturing `new Error().stack` per draw is slow enough to stall the
harness before it prints anything, and a string accumulator grows without bound — count into a map.

The migrated pass draws **one pipeline per SOURCE material**, not one for the pass. `outline` reads
position only, but the buffer it reads was interleaved for whichever program the mesh was built for — a
Basic model packs 20 bytes per vertex and a PBR one 56 — so `builtFor` has to follow the buffer or the
silhouette is a stretched bar. The pre-existing shading baseline passes unchanged, which is the evidence
that the image did not move.

The forward pipeline is at 152 of 153. The one remaining legacy draw is a `customGeom:` material — a
DEFERRED custom shader — being drawn by the FORWARD pipeline, where it has no program reflection and
`bindMaterial` returns false. Handling it properly means deriving a forward reflection for a shader
written to fill a G-buffer, which is a correctness question and not a plumbing one.

**Two things this uncovered. One was a real rendering bug and is fixed; the other is still open.**

*The `animated ? null` stride convention was wrong for the Basic family — FIXED.* Five call sites told
the pipeline that a skinned mesh is always the full 56-byte layout, citing `createAnimated`. But
`ModelNode.initializeModel` re-`create`s EVERY mesh — animated included — packed to its MATERIAL
program's attributes, so a Basic skinned model is 20 bytes. Reading it at 56 walks every third vertex.

**This was visible in the harness screenshot the whole time and the baseline had recorded it as
correct**: `basicSkinned` rendered as a torn yellow fan where its PBR and Blinn-Phong siblings render as
clean columns. Nobody looked, because the gate compares a signature against a baseline that already
contained the corruption — the exact failure mode that once let a cube draw as a flat bar in the
G-buffer. All five sites now pass `material.type` unconditionally, the column is a column, and the four
shading baselines plus `passBaseline.json` were re-recorded against the corrected picture with **zero
frame-stat drift** (the fix changes what is drawn, not how much).

*`_recordDraw` still does not reproduce `Mesh.draw` for two meshes — OPEN.* The overdraw debug channel
was migrated, reverted, re-tried after the stride fix, and reverted again. What is known, all measured:
the pass, the pipeline state and the clear port cleanly (keeping the new pass and putting `mesh.draw()`
back inside it is byte-identical); routing through `_recordDraw` turns two meshes into spiky fans
(10/128 cells, worst delta 40); the corruption is **identical before and after the stride fix** and the
affected meshes are **not** animated. Both come from the harness block that crosses every material type
with every TOPOLOGY, which is the next thing to look at. Left legacy: it is a debug channel, and a
visibly wrong picture is a bad trade for one draw call. Evidence:
`tools/harness/shots/pass-debugOverdraw-{old,fixed}.png`.

The selection outline over `basicSkinned` is now correct on the RHI path, and worth recording that the
legacy path was the worse of the two there — it drew the mesh itself as a torn fan and raised
`INVALID_OPERATION` three times a frame, because the outline program re-initialised the mesh's VAO and
the geometry pass then drew against it. `harness:mesh` selects that mesh on every run now.

Foliage was the last material family to move — both its colour pass and its shadow casters, which now
record inside the cascade's own encoder rather than after it closed.

**A correction worth keeping.** This section previously read 164 of 165 and claimed the missing draw was
"not a live path — a one-shot in whichever startup frame the harness happens to sample", on the strength
of instrumenting the non-RHI draw sites and counting zero. That was wrong: the instrumentation covered
the sites that had ALREADY been migrated and had a fallback branch, and the outline mask was not among
them because it had never been touched. It fired every single frame. The lesson is the same one the
coverage harness taught — an instrument that only watches the paths you already know about reports
silence, and silence reads as success.

Foliage meshes are the clearest case for the two-program vertex layout: every one is initialised from
`blinn_phongGeometry`'s five attributes whatever later draws it, so the pipeline has to be told
`builtFor: 'blinn_phongGeometry'` rather than inferring a stride from the depth or billboard program
that declares fewer. Recording them also deleted the instance-divisor teardown: locations 5-8 left at
divisor 1 corrupt the next NON-instanced draw of the same mesh, and a VAO keyed by pipeline AND buffers
simply cannot have that problem.

**The hardcoded texture units are gone.** `SHADOW_UNIT = 6`, `SPOT_SHADOW_UNIT = 15`,
`reserveTextureUnits()` and the encoder's reserved set no longer exist, and with them the rule that a
custom material silently dropped every sampler past unit 15. Units are assigned per pass, packed from 0
by the bind groups, which is the whole reason the RHI has a bind-group layout at all.

The last two pieces were the light-probe capture and the sky. The capture renders six cube faces and was
the only remaining caller of the immediate-mode draw path — which is what kept the constants alive, since
`_bindShadowsToForwardShaders` had to keep binding at them for its sake. The sky was three near-copies of
the same eleven lines (baked atmosphere / user skybox, in the deferred overlay, the forward pipeline and
the capture); they are one `_renderSky` now, because a pipeline has to state its depth and cull rules out
loud and three places stating them slightly differently is how a sky ends up depth-writing in one
pipeline and not the other.

**One thing is deliberately not a pass and never will be.** The cloud noise volume bake writes 3D texture
slices; a WebGPU render attachment must be a 2D or 2D-array view, so its WebGPU form is a COMPUTE shader
writing a storage texture — a rewrite, not a migration. Forcing it through `createRenderTarget` would
also regress WebGL2, where targets are deduped and evicted with their texture: 128 + 64 slices would
strand ~192 cached framebuffers where one re-pointed attachment costs nothing.

**Both depth blits go through the RHI too.** `CommandEncoder.copyTextureToTexture` is implemented on
WebGL2 over a pair of scratch framebuffers — not `createRenderTarget`, whose targets are deduped and
retained for the life of their attachments, where a copy is transient and its source changes with every
resize. One trap, and it does not fail where it happens: `framebufferTexture2D` writes to the DRAW
binding (`gl.FRAMEBUFFER` is an alias for it), so attaching while READ and DRAW point at different
objects lands BOTH attachments on the draw one. The blit then reads an incomplete framebuffer and every
later draw raises INVALID_FRAMEBUFFER_OPERATION.

What is left of the raw GL in `renderer.ts`: four `getError` debug checkpoints that exist on purpose,
the cloud-noise bake, two `getUniformLocation` mentions that are inside comments, and the clear/blend
restores the foliage pass still inherits.

**Two bugs this step surfaced**, both of the kind that only a pixel gate finds:

- `ModelNode.initializeModel` packs a mesh's vertex buffer to exactly the attributes its **material's**
  program declares — a Basic model is 20 bytes per vertex, a PBR one 56 — but `modelVertexLayout`
  assumed the full 56 for everything. Reading the former at the latter's stride walks every third
  vertex: an unlit cube rendered as a flat stretched bar. It had been doing so in the deferred G-buffer
  since the geometry pass migrated, and the deferred baselines had recorded it as correct. The function
  now takes the buffer's program as well as the drawing one, the pipeline cache keys on both, and
  `tests/rhiMapping.test.ts` pins it. **The deferred baselines were re-recorded**; the forward pipeline,
  which had always drawn these through `Mesh`'s own packed VAO, never moved and is what confirmed the
  new output is the right one.
- `DEFAULT_BLEND` said `one`/`one-minus-src-alpha` for the alpha half while
  `Renderer._restoreDefaultBlend` sets `zero`/`one`. Nothing had used the constant, so it and its unit
  test agreed with each other and with nothing else. The forward transparent pass was the first caller;
  left alone it would have accumulated coverage into the bloom mask and dimmed every bloom source
  behind a transparent object.


### 2. Shader and program management — the last blocker

`shader.ts` is **121** `gl.*` and `systems/uniformBlocks.ts` **39** — linking, reflection and uniform
upload, all WebGL2-only. With the draw path portable, this is the only thing between the engine and a
WebGPU frame, and it is not a port: WebGPU binds by group and binding and needs no reflection at all,
so it becomes a backend-specific path behind `createShaderModule`.

Two shapes have to change, and the second is the work:

- `ShaderManager.bind(name)` selects a linked GL program. WebGPU has no `useProgram` — a pipeline
  carries its own module — so on that backend the bind is bookkeeping, not a GPU call.
- **~330 `setUniform(name, value)` call sites** reach uniforms the WebGL2 way: by name, into a std140
  block whose member offsets the driver reports. WebGPU has no such reflection; uniforms are bytes at
  offsets computed from the WGSL layout rules.

**The replacement now exists up to the Shader itself.** `tools/wgslLayout.mjs` computes the offsets and
`npm run harness:uniforms` checks all 1,697 members across 53 programs against what a real driver
reports. `rhi/uniformSet.ts` writes one block by name; `ProgramUniforms` beside it owns one set per
block, routes a bare name to whichever block declares it (first match in declaration order, memoised),
and flushes only what changed. `harness:webgpu` proves the routing on a real adapter with the `outline`
program — matrices in group 1, colour in group 2, no textures — so a name landing in the wrong block
does not merely shade differently, it moves the geometry.

**The seam is cut.** `rhi/shaderProgram.ts` writes down what the engine actually asks of a shader —
six members: `attributes`, `use`, `setUniform`, `hasUniform`, `flushUniformBlocks`, `dispose` (plus
`describeBlockLayout` for `harness:uniforms`). `Shader implements ShaderProgram` and `ShaderManager`
stores and returns the INTERFACE, so a second implementation can exist without touching a call site.

Exactly three places still need the concrete class, and each is honest about why: the WebGL2 backend
reaches `.program` for the GL handle (a WebGPU backend would reach for its own type in the same place),
and two `systems/` helpers that merely HOLD a program were widened to the interface instead.

One member is WebGL2-shaped and says so: `AttributeInfo.layout` carries the four numbers
`vertexAttribPointer` wants, including a GL enum. It exists because `Mesh` has a fallback path for
attributes outside the canonical model layout. WebGPU carries vertex formats on the pipeline and has
no use for it, so a WebGPU program leaves it undefined rather than inventing a meaning.

**The WebGPU program exists.** `rhi/webgpu/webgpuShaderProgram.ts` implements the same six members and
shares no code with the WebGL2 one — which is the point of the interface. `use()` is bookkeeping (there
is no `useProgram`; the pipeline carries the module), uniforms go through `ProgramUniforms`, and
attributes are DECLARED rather than discovered.

That last one needed a build-time addition: `findVertexInputs` reads the vertex stage's `@location(N)`
parameters out of the WGSL and the loader ships them as `vertexInputs`. It reads the SAME declaration
the translator already renames when it adds the engine's `a_` prefix for GLSL, so the two cannot
disagree about a name or a location. WebGL2 gets this from `getActiveAttrib`; WebGPU has no such call and
is handed its vertex layout up front.

`harness:webgpu` drives the whole shape on a real adapter: attributes reported, `hasUniform` answering
across both blocks, and a value set with `setUniform` + `flushUniformBlocks` — the same two calls the
renderer makes ~330 times — reaching the shader and colouring the pixel.

`Device.createShaderProgram(descriptor)` now decides which implementation gets built. A `.wgsl`
import carries everything either backend needs, so the call reads
`device.createShaderProgram({ label: 'present', ...PresentProgram })`. Each backend refuses a
descriptor missing ITS half — which is the right outcome for a custom material assembled from a
user's GLSL at runtime: it cannot run on WebGPU and should say so rather than render something else.

**The renderer calls that factory now, and `new Shader()` survives in exactly one place in the engine
— inside the WebGL2 backend.** The 55 `new Shader().create(...)` locals plus the 56 `addShader` calls
that named each local again collapsed into one `programs` table of `['registeredName', XProgram]` rows,
iterated once through `this.device.createShaderProgram({ ...descriptor, label: name })`. `renderer.ts`
no longer imports `Shader` at all. Two aliases share one object (`terrain` / `terrainGeometry`) via a
descriptor-identity map — linking the same source twice would give two programs whose uniform state
drifts apart silently.

`customShaders.ts` goes through the same factory, which matters more than it looks: it is the caller
that assembles GLSL from a user's source at runtime, and on WebGPU it must REFUSE rather than build a
WebGL2 `Shader` against a context that is not there. Routing it there also moved failure cleanup into
the factory — `Shader`'s constructor creates the two GL shader objects and `create` throws without
deleting them, so every failed custom-material compile leaked a pair.

**The device handle is neutral.** `rhi/deviceHandle.ts` owns `device`, typed as the INTERFACE. That
single re-typing is what turned an invisible question into a compiler answer: nine modules had imported
the handle from the WebGL2 backend and were therefore typed against `WebGL2Device`, and the moment the
type narrowed, **26 errors named every remaining WebGL2-only coupling in the engine** — VAOs, raw
`WebGLBuffer` handles into `vertexAttribPointer`, global UNIFORM_BUFFER binding points, synchronous
`readPixelsSync`, `createFramebuffer`.

Those did not get hidden by widening `Device` with methods only one backend can implement. They go
through `glDevice()`, a narrowing accessor that throws when another backend is live. **40 call sites,
and the list is the worklist**: `mesh.ts` 19, `tileMesh.ts` 7, `renderer.ts` 6, `uniformBlocks.ts` 2,
`webgl2Commands.ts` 2, the three framebuffer wrappers 1 each, `texturePacker.ts` 1. The renderer's six
are the vertex-layout buffers and the cloud-noise bake framebuffer; everything else it does —
pipelines, bind groups, passes, shader programs, textures, readback — is on the interface.
`texture.ts` is fully neutral.

The framebuffer wrappers went from three mixed couplings each to **one named one**: `unbind()`, which
restores the default framebuffer. `Framebuffer.beginPass` turned out to have zero callers and was
deleted (so did the raw `framebuffer` accessor); `LayeredDepthFramebuffer.clearAll` opens its per-layer
clears through a `CommandEncoder` instead of the WebGL2 device's own `beginRenderPass`; and
`createRenderTarget` / `createTextureView` are interface methods with no reason to be narrowed. What is
left in all three is the LEGACY BIND MODEL — `RenderTarget.bind()`, which WebGPU has no equivalent for
because a target there is named by the pass that opens it. Those calls disappear with the last draw
that is not recorded against a pass encoder, which is the same set of sites `Mesh` is at the centre of.

The renderer also stopped asking about the GL context. Eight `if (gl)` guards meant "has the device
been acquired yet", which is a question `_deviceReady` already answers; there is now no `gl`
truthiness test anywhere in `renderer.ts`.

**A constraint the migration will hit everywhere, found while proving this:** WebGPU requires a bind
group at every index up to a pipeline's highest, and the engine numbers groups by ROLE — 0 textures,
1 transform, 2 material, 3 shadows, 4 shadow uniforms, 5 lighting — so no program plays every role and
nearly all of them have gaps. `outline` uses 1 and 2; `overdraw` uses 0 and 1. The failure is a
validation error at DRAW time ("No bind group set at group index 0"), far from the pass that forgot, so
`WebGPURenderPassEncoder.setPipeline` fills the gaps itself: a draw site has no business knowing which
roles its shader happens not to play.

Keeping all ~330 call sites unchanged is the design constraint, not an aspiration: rewriting them is
how a migration this size acquires a second class of bug on top of the one it is fixing.

### 3. Resource classes

Raw `gl.*` outside the backend, by file: `framebuffer.ts` **2** (both inside doc comments),
`cubeFramebuffer.ts` **0**, `layeredDepthFramebuffer.ts` **0**, `mesh.ts` **6**,
`tilemap/tileMesh.ts` **2**, `systems/texturePacker.ts` **12**.

The three framebuffer classes now share one `RenderTarget`: the attachment entry point is chosen from
the **view's texture dimension**, so a 2D target, a cube face and one layer of a depth array stopped
being three kinds of framebuffer and became three kinds of `TextureView`. Cube depth moved from a
renderbuffer to a depth texture (WebGPU has no renderbuffers). Targets are deduped by attachment set
and evicted when an attachment is destroyed — without that, each IBL bake stranded ~36 framebuffers.

The 8 remaining in `mesh.ts`/`tileMesh.ts` are **only the draw calls**, left deliberately: a draw
belongs on `RenderPassEncoder.drawIndexed`, and a `device.drawIndexed` to hold it would be throwaway
API that the geometry-pass migration deletes. `texturePacker.ts` is untouched.

**`Texture` is typed by the RHI interface now.** Its field, its uploads and its allocations all go
through methods both backends can implement; the two that cannot — `bind` to a texture unit and
`unbind` — are cast at their call sites, so the coupling is a named exception rather than the whole
class. The interface gained the upload SHAPES the engine actually uses, because collapsing them into a
single `writeTexture` does not survive contact: an immutable array needs its layer count at allocation,
a volume needs its depth, a cube needs all six faces before it is complete.

Two couplings went with it. `configure()` took three GL enums that `graphics/texture.ts` computed
itself — it takes a neutral descriptor and resolves the triple in the backend. And every upload used to
be a `bindForUpload()`-then-upload PAIR, which WebGPU has no concept of; each one binds itself now, so
there is no call a caller has to remember to make first.

What is left here is `systems/texturePacker.ts` (12 raw calls) and the two mesh draw calls. Both are
now visible in the `glDevice()` list above rather than being implicit in an import.

### 4. Device gaps and platform

- **WebGL2Device is complete.** It declares `implements Device`, so the compiler enforces it, and the last
  method that threw — `copyTextureToTexture` — is implemented. Nothing in the interface is a stub.
- **`reallocateBuffer` is on the interface now, and returns the buffer to use from now on.** A
  `GPUBuffer`'s size is fixed at creation, so growing one means destroying it and making another;
  WebGL2 re-specifies storage in place and hands the same object back. Modelling that as a return value
  rather than hiding it is the point — a caller keeping its old handle would hold a destroyed buffer on
  one backend and a live one on the other. Every caller assigns the result; `harness:webgpu` checks
  both the reuse and the grow case on a real adapter.
- **Device acquisition — done.** `Renderer.initialize()` splits into `_acquireDevice()` (backend-aware,
  async) and `_allocateTargets()`, with an `_initializing` promise guard distinct from `_deviceReady`:
  the second guards a call after the first finished, the new one guards a call while the first is still
  awaiting an adapter — impossible on WebGL2, ordinary on WebGPU. `setGLContext` runs on the WebGL2
  branch only; a canvas hosts one context type.

  **A WebGPU device is now genuinely acquired and the failure point is a recorded number.** A runtime
  hatch (`?cleoWebgpuProbe=1`) lets acquisition happen while `WEBGPU_IMPLEMENTED` keeps its exact
  meaning, and `Renderer.deviceProbe` records which stages were reached and where it stopped.
  Measured: `reached: [device, profiler]`, `failedAt: screenQuad` — `new Mesh()` calling `glDevice()`.
  `harness:webgpu:boot` pins that stage in `webgpuBoot.json` as a **ratchet**: as each `glDevice()` owner
  is ported the expected stage moves forward in a commit, with a diff. It also asserts the same page
  with `?backend=webgl2` still reaches `firstFrame`, so the gate cannot pass by silently falling back.

  `engine.ts` no longer swallows the failure — it logs, stores `initializeError`, and rethrows.

- **`gpuProfiler` on WebGPU timestamp queries — done.** `gpuProfiler` is a facade over a swappable
  `GpuProfilerBackend`; the WebGL2 implementation's body is byte-identical (verified by diff) and all
  ~26 call sites, `engine.ts` and the renderer getters changed zero lines. `WebGPUDevice` owns a
  128-slot `GPUQuerySet`, a `QUERY_RESOLVE` buffer and an 8-entry `MAP_READ` ring, all internal; only
  `setTimestampCollection` and `collectTimestamps` reach the RHI, both no-ops on WebGL2.

  **The scope-vs-pass mismatch is stated, not papered over.** `attribution: 'scopes' | 'passes'` drives
  a UI hint, and unmapped labels report as `pass:<label>` rather than borrowing a scope's name. Two
  findings corrected the plan: `forwardOpaque` and `transparent` are **not** lost — `_runForwardQueue`
  opens a real pass in both pipelines, and on the forward pipeline WebGPU reports *more* than WebGL2
  does. `frameEnd` is the only genuine loss, and it is a gain: per-pass timestamps already exclude the
  drain it exists to absorb. There were **four** ambiguous `compose` labels, not three.

  One measured trap: Chrome quantises timestamps to ~100 µs, so an empty clear reads back a genuine
  zero delta. Dropping `end <= begin` made real passes vanish from the readout; only `end < begin` and
  wholly-untouched slot pairs are dropped now, and 0.0000 ms reports as "below the measurement floor".
  The per-pass `queue.submit` inflates every absolute number — recorded as a known bias naming the
  encoder-per-frame fix, never subtracted.

- **Cloud-noise bake on compute — done.** Four RHI additions and no more: `createComputePipeline`,
  `CommandEncoder.beginComputePass`, a `{ binding, storageTextureView }` discriminant, and
  `Device.createWholeTextureView` (the gap that made it possible — `createTextureView` narrows a 3D
  texture to a `2d` single-layer view, which `texture_storage_3d` rejects). WebGL2 throws on 1 and 2 in
  the `glDevice()` voice. Selection gates on `capabilities.hasCompute`, and `_bakeCloudNoiseRaster` is
  today's body moved **byte-identically**, which is what makes "WebGL2 cannot move" diff-checkable.

  The noise field is extracted to `chunks/cloudNoiseField.wgsl` and shared by both entry points, so the
  two paths cannot drift into two different fields — pinned by a contract test.

  **Measured: the compute and raster fields are bit-exact** (max channel difference 0/255 on both
  volumes), better than the ±1 LSB budgeted. Against a CPU twin, 99.9% within 2 LSB; the isolated large
  outliers are f32 `fract((c.x+c.y)*c.z)` boundary flips at magnitude ~18000, a property of the hash
  rather than of either implementation.

  The naga build trap was real: `wgslTranslate.mjs` sent every declared stage through the GLSL **ES 300**
  backend, and restoring `'compute'` to that loop reproduces `MissingFeatures(COMPUTE_SHADER)` — i.e.
  adding `@compute` to any `.wgsl` would have broken the build for both backends.

  A bug caught in the first draft, worth keeping: sharing one uniform buffer across both dispatches
  bakes **both** volumes with the second one's settings, because `writeBuffer` is queued and the encoder
  submits once, so both writes land before either dispatch runs. The harness now bakes two
  differently-configured volumes on one encoder specifically to gate it — a single-volume check cannot
  see it.

- **`Mesh`'s VAO is lazy, and the ratchet has moved twice.** `mesh.ts` went from **19 `glDevice()`
  sites to 5**, all of them now inside legacy draw paths that WebGPU cannot reach anyway. The insight is
  that `Mesh`'s own VAO was never needed by the RHI path at all — `WebGL2Device.vertexArrayFor` builds
  and caches its own, keyed by pipeline and buffer set — so the constructor was allocating a
  `WebGLVertexArrayObject` before anything had decided whether a legacy draw would ever happen. Buffers
  go through the neutral `device`; the VAO is created on first use by a legacy caller.

  One coupling had to survive and is now stated rather than implicit: `ELEMENT_ARRAY_BUFFER` is VAO
  state on WebGL2, so an index upload while another mesh's VAO is bound rewrites *that* mesh's index
  binding. `_bindOwnVAO()` binds this mesh's own first, and is a no-op on a backend that has neither the
  binding point nor the coupling.

  `_configureDefaultState` followed: its `getExtension('EXT_color_buffer_float')` asked exactly what
  `capabilities.floatRenderable` already answers, so the fatal check now goes through the device. The
  rest — standing depth func, blend enable, `drawingBufferColorSpace` — is WebGL2 context state with no
  WebGPU counterpart, and is guarded as such rather than left looking unported.

  **Measured progress on a real adapter**, each step recorded in `webgpuBoot.json` with a `history`
  entry:

  | reached | stopped at | why |
  |---|---|---|
  | `device, profiler` | `screenQuad` | `new Mesh()` → `glDevice().createVertexArray()` |
  | `+ screenQuad, framebuffers` | `preInitialize` | raw `gl.clearColor` on an undefined `gl` |
  | `+ preInitialize` | `programs` | `Texture.create` → a `GPUTexture` fixes its size at creation |

  The gate now records the expected failure *kind* alongside the stage (`glDevice` / `rawGl` /
  `creationSize`), because those are not interchangeable and a stage failing for an unpredicted reason is
  exactly what would otherwise hide behind a familiar-looking stage name.

  **`Texture` sizing is fixed, and it was smaller than it looked.** `graphics/texture.ts` already knew
  its dimensions before every upload — it just never told the device. It syncs before each upload and
  allocate now, and `WebGPUTexture.setSize` reallocates the `GPUTexture` when they change: the exact
  analogue of `reallocateBuffer`, same wrapper and a new handle. Free on WebGL2, where `setSize` records
  four numbers and touches no GL. The allocate-shaped calls assert the size rather than no-opping,
  because an empty body is also what a caller that forgot to sync would see.

  A run of small guards followed, each revealed by the last: `Texture.bind`/`unbind` (a texture unit is
  not a WebGPU concept — and `_finishUpload` calls `unbind` after every upload, so it killed a path that
  had otherwise completed), the whole `Mesh` VAO-configuration family, and the renderer + foliage
  instance buffers widened to the RHI `Buffer`.

  **Startup now reaches the first real render pass** — `_initializeIBL` → `_renderBRDFLUT` →
  `beginRenderPass`, refused on its colour attachment. A new class of blocker: nothing left to port,
  only something to get right. `glDevice()` sites are down to **21**, and the ratchet has a
  `gpuValidation` reason kind for what it measures from here.

  **The superseded blocker was `Texture` sizing** — the general `_needsCreationTimeSize` reform that the
  compute-bake work deliberately did not attempt (it widened `TextureConfig` with an explicit `size` for
  the one storage volume instead). Every engine `Texture` is created at 0×0 and sized by a later upload;
  a `GPUTexture` cannot be.

- **Startup and scene construction complete on WebGPU; a frame runs.** Chunk 1 of the render-path work.
  The probe reaches `frame.packTextures` inside `_render` and stops at `generateMipmaps`.

  Five things had to be true at once, and **none of them was individually visible to the ratchet** —
  fix the view and you die on an empty shader module; fix the module and you die on a format mismatch:

  1. **`Texture.view` returned a concrete `WebGL2TextureView` through an unchecked cast.** Split into
     `attachmentView` (one mip, one layer) and `sampledView` (whole texture, own dimension), because
     those are different objects on WebGPU and collapsing them gives a `2d` view of face 0 for every
     cubemap binding. `Texture.view` and `Texture.gpu` were **deleted**, not deprecated — the split only
     works if no neutral-sounding third option is left to pick by accident.
  2. **The memo is keyed on a new `Texture.generation`**, bumped where `WebGPUTexture.setSize` already
     destroys and recreates the handle. Keying on dimensions would have duplicated that exact condition
     in another file with nothing checking the two agree.
  3. **`_pipelineFor` built every shader module with `source: ''`** even though every `.wgsl` import
     already carries the WGSL and its entry points. The WebGPU backend now refuses an empty module *by
     name*, which is the right answer for the one caller that genuinely has none — a custom material
     assembled from a user's GLSL at runtime.
  4. **Attachment formats were hardcoded `rgba8unorm` with no depth state**, while the real targets are
     `rgba16float`, `r8unorm` and `bgra8unorm`. Derived from the target now, via a `_passTarget` field
     with the same lifetime as `_passEncoder`. Two of forty sites build their pipeline before the pass
     opens and pass an explicit target.
  5. **Depth attachments ignored `baseArrayLayer`**, so every shadow cascade would have rendered into
     the same view. WebGL2 already honoured it by re-pointing the framebuffer's depth attachment.

  **The WebGL2 hazard this created, and the fix.** Synthesising depth state for passes that never asked
  for it would make `apply` issue `gl.depthFunc` — and `depthFunc` is CONTEXT state, so it leaks past
  the pipeline into the next legacy draw, which still relies on the standing `LEQUAL`. The synthesised
  default is `always` + no writes, and `apply` maps that pair onto the same branch as no depth state at
  all. A DOM-free test pins the predicate.

  **`GLState` needed more than a guard.** `GLState.enable(gl.DEPTH_TEST)` evaluates `gl.DEPTH_TEST` at
  the **call site**, so guarding inside the class could never have been enough. The enum-taking
  overloads were replaced by named methods (`depthTest`/`blend`/`cull`) and **deleted**, so the shape
  cannot regress; 42 call sites in the renderer, 4 in `texturePacker`. `depthMask` and `bindVAO` carry
  no enum and needed only the guard. The guard sits *before* the `frameStats` bookkeeping — a HUD
  reporting hundreds of state changes on a backend with no global state would be describing nothing.

  Also: six epilogue `unbind()` calls deleted (each ran after a pass ended, and the next RHI pass
  rebinds its own target and viewport), `_setViewport`/`_restoreDefaultBlend` guarded, and the 0×0
  allocation clamped so boot is not buried in ~40 asynchronous validation errors.

  **The ratchet gained resolution when it needed it.** `_render`'s phases are staged too, so the probe
  reports `frame.packTextures … firstFrame` rather than going flat; `_stage` becomes a pass-through
  once the first frame completes, so `reached` cannot grow per frame. The gate learned that
  `stage: null` is a real state — startup *succeeds* — and started ratcheting on `sceneError`, the
  page's own wall, which is otherwise indistinguishable from "everything is fine".

- **A COMPLETE FRAME RUNS ON WEBGPU — and it is black.** Both halves of that sentence matter.
  `reached` is now identical to the WebGL2 control: `device, profiler, screenQuad, framebuffers,
  preInitialize, programs, frame.packTextures, frame.foliage, frame.cascades, frame.spotShadows,
  frame.scene, frame.post, firstFrame`. Nothing throws. `CLEO_WEBGPU_SHOT=1` writes
  `shots/webgpu-frame.png`, and it is empty.

  That is not a contradiction, it is the shape of the remaining work: the boot gate measures
  REACHABILITY, and reachability is now done. Correctness has never been measured on this backend at
  all, and no existing gate can see it.

  What chunks 2 and 3 took to get there, each found by the previous one failing:

  - **Mip-chain generation** (`WebGPUMipGenerator`): a fullscreen-triangle blit, one pass per level per
    layer, pipelines cached per format. **2D and cube together** — the plan intended to defer cube, but
    the first thing that needed a chain was the sky-atmosphere bake, and since a cube face *is* an array
    layer, splitting the loop to defer half of it would have been more code than doing both.
  - **`RenderPipeline.resources` on the interface.** The material bind group reached it as
    `(pipeline as any).module.resources` — a property only the WebGL2 pipeline has. Same shape as every
    other blind spot in this port: an untyped cast that the backend it was written against satisfies.
  - **`GLState.cullFace` takes a side, not an enum**, and `glCullMode` returns one. The last of the
    call-site enum reads, and it failed in `_renderCascades` for exactly the documented reason.
  - **`Framebuffer.bind`/`unbind` guarded**, and **`TileMesh` given the same lazy-VAO split as `Mesh`** —
    buffers through the neutral device, the vertex-array object only where one exists.

  **The frame now submits exactly the same work as WebGL2** - `101/101` draw calls, 17 objects, 29794
  triangles, 89382 vertices, matching `meshBaseline.deferred.json` number for number, in 6.4 ms. And it
  is still black, because **every draw is rejected by validation**.

  Getting from "black, no information" to "black, and here is why" meant clearing two instrumentation
  lies first. Both are worth recording, because each produced a confident wrong diagnosis:

  - **The WebGPU encoder kept no `frameStats` at all.** Every counter read zero, so a black frame looked
    like *nothing drew* when it meant *nothing counted*. `isTriangleTopology` moved from
    `webgl2/glEnums.ts` to `rhi/types.ts` in the process - it asks about the RHI's own topology union,
    and leaving it in one backend would have meant the other importing it.
  - **`frameMs` deliberately survives `resetFrameStats`** (it holds the last completed frame's value),
    which put a plausible frame time beside zeroed counters and made an empty sample look finished.

  Two real bugs behind the zeros: `_checkGLErrors` calls `gl.getError()` and the mesh harness *enables*
  `debugGLErrors`, so it threw on every frame - and the game loop logs and does **not** reschedule, so it
  died silently after the first. And index, bone and instance buffers were created without `COPY_DST`,
  which WebGL2 ignores and WebGPU rejects.

  **The remaining blocker is identified with its mechanism: uniform bind groups are never bound.** The
  renderer builds texture and material bind groups and nothing for uniform blocks, so every uniform
  group is unset and WebGPU drops the draw - `No bind group set at group index 0`, from encoder
  `skyAtmosphereBake`. `harness:webgpu` passes only because it binds them by hand. The fix that keeps all
  ~330 `setUniform` call sites unchanged - the migration's whole constraint - is for
  `WebGPURenderPassEncoder.setPipeline` to bind them, mirroring what the WebGL2 encoder already does with
  `ShaderManager.Instance.flushBound()`.

  **Bind groups are satisfied now, and the frame is still blank** - which is progress, because those
  were two different problems and only one of them is left.

  Two backend-side fixes, both deliberately NOT at the call sites, because "keep all ~330 `setUniform`
  sites unchanged" is the migration's standing constraint:

  - **Uniform blocks are bound as bind groups**, in `WebGPURenderPassEncoder.setPipeline`. WebGL2
    uploads them to global `UNIFORM_BUFFER` binding points and the draw finds them; WebGPU has no
    globals, so without this every uniform group was unset and the driver dropped the draw. Grouped by
    GROUP INDEX rather than one bind group per block - several blocks share an index, and WebGPU rejects
    a bind group whose entry count does not match its layout.
  - **The sampler entry is synthesised** in `createBindGroup`. This engine keeps filter and wrap state
    on the TEXTURE, so `_textureBindGroup` emits one entry per texture and nothing for the sampler;
    WebGL2 sees one combined sampler, WGSL declares a `texture_2d` + `sampler` pair. The sampler is
    built from `WebGPUTexture.samplingConfig` and cached on that state, not per texture, because a
    pipeline has a hard cap on how many it may bind.

  **The instrument that finally made this measurable.** Both backends render the same scene through
  `screenshotOffscreen` - a private RGBA8 framebuffer read back through the device, with no swap chain
  and no compositor - and the PNG size says whether anything is there. A flat 64x64 compresses to ~200
  bytes; a real one to several thousand. **WebGL2 gives 6100, WebGPU gives 202.** That single number is
  now a ratchet field (`offscreenBytes`), the WebGL2 side is asserted so the reference cannot quietly go
  flat, and it is the first thing in this migration that can tell "the frame ran" from "the frame
  rendered". It also killed the swap-chain hypothesis outright: nothing is produced even offscreen.

  **What is left is no longer a list of suspects but one measurable question.** One pipeline still fails
  to build (`[EntryPoint "fs_main"] infringes limits` for `blinn_phong`, truncated by Chromium). And a
  known limitation is recorded in `_flushUniforms`: `queue.writeBuffer` is ordered against the SUBMIT,
  not against commands already recorded, so every draw in a pass reads the LAST value written - correct
  for single-draw passes, wrong for multi-object ones, and the fix is dynamic offsets.

  **The blankness is now narrowed by elimination rather than guessed at.** Three measurements, all on a
  real adapter:

  1. A bare clear into an engine `Framebuffer`, read straight back: **`255,0,0,255`**. The device's pass
     and readback path are sound.
  2. The offscreen render is **`maxRGBA=0,0,0,0`, 0/1024 non-zero pixels** — so it is not the
     transparent-background/coverage-alpha path, and not the swap chain either.
  3. The G-buffer after a frame reads **`nz=1024/8192 max=60`** on albedo and exactly zero on the other
     two attachments. 1024 of 8192 bytes is precisely what a clear to alpha 1.0 looks like in f16 — that
     is the CLEAR, not geometry.

  So: **draws are recorded and validate, and produce no fragments.** Everything around them is proven.

  Found on the way: engine colour textures carried no `COPY_SRC`, so any readback of one would have been
  refused. WebGL2 needs no such declaration — anything attached to a framebuffer can be `readPixels`'d —
  which is exactly why it was invisible.

  **Remaining candidates, none yet tested:** vertex attribute locations disagreeing between the
  pipeline's layout and the WGSL `@location` (geometry would collapse rather than error); uniform VALUES
  not arriving, so view/projection are zero and everything lands outside the frustum; or depth state
  rejecting every fragment. The cheapest next probe is reading back a uniform buffer — that separates
  "drawn somewhere off-screen" from "not drawn".

  **Where to look next, in the order it would bite:** the surface present path (does the final blit
  reach the swap-chain texture at all), bind-group numbering for the material and lighting groups, and
  the uniform buffers — `ProgramUniforms` writes by computed WGSL offset and `harness:uniforms` verifies
  those against a real driver, but nothing has yet verified them END TO END by a pixel. The right gate
  is a signature comparison between the two backends on one scene, which needs a readback the harness
  can hash.

- **Swap chain into the viewport — done.** `reconfigureSurface` is on the `Device` interface (a
  documented no-op on WebGL2) and `Renderer.resize` calls it; the present pass already reached the
  screen through `getCurrentSurfaceTarget`. `harness:webgpu` now acquires its device with a real canvas
  and proves the whole path on a driver: the surface target describes the canvas, **a render pass
  writes to the swap-chain texture** (read back and checked, not merely acquired), and the surface
  follows a resize.

  **Measured while writing that gate:** `reconfigureSurface` is NOT required for a plain resize.
  `configure()` carries no size and `getCurrentTexture()` reads the canvas's current dimensions, so the
  resize check passes with the call commented out. The first draft of the interface doc claimed the
  opposite; it now says what the driver actually does. The call is kept because `resize()` is also what
  runs after the editor re-parents the canvas on a mode switch, which is the case that does need it.
- **`screenshotOffscreen` is async — done**, along with `renderProbePreview`. Both go through
  `device.readPixels`, and `readPixelsSync` is private to the WebGL2 backend, so no caller outside that
  file can reach a synchronous readback. The ripple was as small as measured, with one correction: the
  two `captureMaterialSphere` call sites are in `saveMaterialTab` / `saveTerrainMaterialTab`, which were
  NOT already async — they are now, and `saveTabById` awaits them like every other kind.

  The non-obvious part is the ordering, and all four sites are written the same way: **render and
  restore before awaiting.** An async function body runs synchronously to its first `await`, so
  `screenshotOffscreen` finishes drawing and hands the pipeline back to the live viewport before the
  promise exists; `captureClean` and `captureMaterialSphere` likewise restore the grid and the camera on
  the returned promise rather than after awaiting it. Awaiting first would leave the editor's viewport
  square, grid-less and dollied for the length of a readback — a microtask on WebGL2 and a real gap on
  WebGPU.
- **`gpuProfiler`**: `EXT_disjoint_timer_query_webgl2` becomes `GPUQuerySet` timestamp queries — an
  optional WebGPU feature, so gate on `capabilities.hasTimestampQuery`.
- **Secure context.** `navigator.gpu` is undefined outside one. The harness pages are served over a
  privileged `app://` scheme for exactly this reason; the desktop shell's loading path must be checked
  before concluding WebGPU is unavailable there.
- **No editor or desktop source touches WebGL.** Measured across `editor/src` and `desktop/`: every hit
  for `webgl2` / `WebGL2RenderingContext` / `renderer.context` is a build artifact, a node_modules file
  or `lib.dom.d.ts`. The host already selects a backend (`readBackendPreference`, with
  `backendFallbackReason` surfaced in Renderer Settings), so there is nothing to port up there — only a
  second backend to give it.
- **Publish**: bake WGSL at publish time, bump `PLAYER_CONTRACT`, ship both backends with fallback.

### Sizing, honestly

**Item 1 is done.** Every draw goes through the RHI and both devices implement the whole interface.
What is left is not the draw path; it is everything a draw needs to be handed.

The order is forced, and it is not the order these items are numbered in:

1. **`Texture`** (item 3). Uploads have to be expressible through the interface before anything can
   be bound. Nothing downstream can be tested without it.
2. **`Shader` / uniforms** (item 2). The offsets, the per-block writer and the name routing all exist
   and are driver-verified; what is missing is a `Shader` that owns a `ProgramUniforms` instead of
   `gl.uniform*`, across 59 `new Shader()` sites and ~330 `setUniform` calls that must not change.
3. **A device-neutral renderer.** Nine modules import the WebGL2 singleton by name. Mechanical, except
   for the three WebGL2-only uses (`readPixelsSync`, `createFramebuffer`) that 1 and 2 resolve first.
4. **The swap chain** (item 4). `reconfigureSurface` exists and nothing outside the device calls it.

Only after 1-3 can anything be tested end to end, which is why the first WebGPU frame is several
sessions away rather than one. **There is still no unsolved problem** — the shader-direction and device
questions are settled and proven — but the earlier claim that a first frame "needs item 2 and the swap
chain and nothing else" was wrong: it omitted textures entirely.

Two things will not be ready even then, and both degrade rather than break:

- **Forward and deferred custom materials cannot produce WGSL** (see `vulkanUnsupportedReason`): a
  `mat3` varying, an inline `uniform struct` for lights, and a GLSL-ES shadow library. These are
  user-authored shaders in real projects, so WebGPU needs a fallback or a clear failure, not a guess.
- **The cloud noise volume bake** is a compute-shader rewrite, not a migration.

## Verification

### Existing gates — must stay green through every milestone

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs `npm run typecheck` + `npm test` for the
engine, then `npm run build:dev` + editor `npm run typecheck`. The editor builds with babel-loader, so
`tsc --noEmit` is the **only** type check that ever runs against editor code — never skip it.

**The engine typecheck starts from `src/cleo.ts` and follows imports** (tsconfig uses `files`, not
`include`). Anything nothing shipped imports is therefore checked by NOTHING — the WebGPU backend was
in exactly that position, and the harness bundle that does import it runs ts-loader with
`transpileOnly`. A device method referencing three unimported names built clean through both. The
WebGPU files are named explicitly in `files` now; keep them there, and add any future backend the same
way the moment it exists.

### Unit tests (vitest, DOM-free — keep the existing policy)

RHI format / enum mapping tables, `VertexBufferLayout` descriptors, std140 packing offsets, WGSL
translation snapshots, `RenderPassDescriptor` construction. Extend the source-text contract-test style
already used by [`tests/bloom.test.ts`](tests/bloom.test.ts) and
[`tests/shaderShadowContract.test.ts`](tests/shaderShadowContract.test.ts).

### The harness gates that exist today

Run all of these after any renderer or shader change. None needs a GPU runner beyond a real desktop;
all of them drive Electron against the actual driver.

| command | what it holds |
|---|---|
| `npm run harness:mesh` / `:forward` | frame stats + an 8x8 mean/stddev shading signature, per pipeline |
| `npm run harness:mesh:full` / `:full:forward` | the same, for the `?scene=full` profile below |
| `npm run harness:pass` | per-pass signatures, toggling one pass at a time |
| `npm run harness:coverage` | which programs actually **bind**; fails on an unexpected zero |
| `npm run harness:uniforms` | every computed WGSL uniform offset against the driver's own answer |
| `npm run harness:webgpu` | the WebGPU device tier on a real adapter |
| `npm run harness:naga` | WGSL -> GLSL translation |

**`?scene=full`.** The default harness scene had no terrain, foliage, clouds, sprites, gizmos,
skeleton overlay, selection outline, probe preview or drawing screen material — so five shader
families and four whole draw paths were converted with nothing exercising them. The full profile adds
all of it, behind a flag and with its own baselines — adding it to the default scene would have moved
every existing baseline at once, and a baseline that moves for two reasons cannot attribute either. It
is the configuration in which every reachable program is supposed to bind, and `harness:coverage` fails
there if one does not.

Three things learned building it, all of which had silently defeated a measurement:

- **A hidden Electron window barely runs `requestAnimationFrame`.** Whole shots went by without the
  scene drawing once, so passes were reported as never bound. `backgroundThrottling: false` does not
  cover a never-*shown* window; only forcing a `capturePage` does.
- **Binding is not coverage.** The cloud pass bound all three of its programs while compositing exactly
  zero pixels: the slab sits at altitude 800 and the scene camera is pitched 30 degrees down, so no view
  ray ever reached it. `__lookUp` aims at the sky for that one check.
- **Scene construction must be seeded.** `FoliageLayer.pushInstance` draws yaw and scale from
  `Math.random`, so the same code built 250 differently-oriented props each run and the signature
  drifted by 4-6 of 128 values — in different cells every time, which reads exactly like a real
  regression. The full-scene block installs a seeded `Math.random` and restores it in a `finally`.

### New: a real-GPU parity harness

There is no headless GL today, and pixel parity across ~30 passes cannot be asserted any other way.

- Playwright + Chromium, booting the player build against a fixed set of fixture scenes.
- Each scene rendered twice — `?backend=webgl2` and `?backend=webgpu` — and diffed.
- **Also the regression gate for M0–M5**: render the fixtures before the refactor, store as golden, diff
  after. This is what makes "WebGL2 output unchanged" a checkable claim rather than a hope.
- Keep it out of vitest and out of the default CI job (it needs a GPU runner). Run locally or on a
  self-hosted runner.

### Manual smoke, per milestone

`npm run editor:dev`, open an example project from
[`editor/public/examples/`](editor/public/examples/), switch backends in the Renderer panel, watch the
Profiler panel pass list, capture a material thumbnail, enter Play mode.

---

## Risks

1. **`renderer.ts` is 5,417 lines in one file.** M4 and M5 touch 374 + 129 sites inside it. Either split
   it into pass modules first — a mechanical, independently-verifiable change — or accept a long-running
   branch with enormous diffs. Splitting first is the better trade.
2. **naga's GLSL frontend may not cover everything.** Probe in M3 before the rest is committed. The
   fallback for a gap is rewriting the specific shader construct: cheap if found early, expensive if
   found in month four.
3. **Three synchronous APIs break on WebGPU** — `new Renderer()` (device acquisition), `Shader.create()`
   (compile errors; the editor's custom-material UI surfaces the GL info log), and
   `screenshotOffscreen()` (readback). All three have editor callers.
4. **Float format audit.** [`renderer.ts:865`](src/graphics/renderer.ts#L865) hard-throws without
   `EXT_color_buffer_float`. Under WebGPU `rgba16float` is renderable by default, but `rgba32float`
   blending needs the `float32-blendable` feature. Every `precision: 'high'` framebuffer needs its real
   format pinned down — there are ~15 of them in the constructor.
5. **Bundle size.** `dist/cleo.js` is already 9.2 MB. Two backends plus (optionally) naga wasm makes it
   worse. Measure early; a per-backend dynamic `import()` split is the escape hatch.
6. **Effort.** This is a multi-month project at full parity. M0–M5 is roughly half the work and produces
   no user-visible change. Worth saying out loud before starting.
