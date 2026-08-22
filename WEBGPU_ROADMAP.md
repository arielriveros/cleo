# WebGPU as a secondary backend — roadmap

> Status: proposed, not started. Written 2026-08-21 against commit `5d2516e`.
> File paths and counts below are from that snapshot; re-measure before relying on them.

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

### M4 — `UniformSet` + bind groups

- Implement the std140 CPU-buffer `UniformSet`. Reflection comes from `getActiveUniform` (WebGL2) and
  from naga's reflection output (WebGPU). Wire `ShaderManager.setUniform` through it.
- Regroup uniforms by frequency per the table in §2.
- Retire `_textureSlot()`'s fixed slots in favour of bind-group entries. The WebGL2 backend keeps
  assigning units internally, but nothing above the RHI knows about "unit 15" any more.
- Bone matrices → storage buffer on WebGPU, uniform array on WebGL2.

### M5 — Pipeline state objects

- Collapse `GLState.enable/disable/cullFace/depthMask` plus `_applyCull` and `_restoreDefaultBlend` into
  immutable `RenderPipeline` descriptors, cached by descriptor hash. The WebGL2 backend translates a
  pipeline bind into the deduped state calls it already makes.
- The largest `renderer.ts` diff of the project (~129 `GLState` sites). Consider splitting `renderer.ts`
  into pass modules first — see Risks.

### M6 — WebGPU first light

- `rhi/webgpu/`: device + swap chain (`canvas.getContext('webgpu')`,
  `configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode })`), buffers,
  textures, samplers, pipeline cache, bind-group cache, command encoder.
- Target: geometry pass → deferred lighting → present. One scene, PBR, no shadows. This validates the
  RHI before parity work begins.

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

## Verification

### Existing gates — must stay green through every milestone

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs `npm run typecheck` + `npm test` for the
engine, then `npm run build:dev` + editor `npm run typecheck`. The editor builds with babel-loader, so
`tsc --noEmit` is the **only** type check that ever runs against editor code — never skip it.

### Unit tests (vitest, DOM-free — keep the existing policy)

RHI format / enum mapping tables, `VertexBufferLayout` descriptors, std140 packing offsets, WGSL
translation snapshots, `RenderPassDescriptor` construction. Extend the source-text contract-test style
already used by [`tests/bloom.test.ts`](tests/bloom.test.ts) and
[`tests/shaderShadowContract.test.ts`](tests/shaderShadowContract.test.ts).

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
