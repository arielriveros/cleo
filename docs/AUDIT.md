# Cleo Engine — Improvement Audit

Snapshot of the repo at `897982d` (main). ~43k lines of TS/TSX: 123 `.ts` engine files, 92 `.tsx` editor
files, 48 shader files.

Every claim marked **[verified]** was proven against the code during this audit — the reproduction is
noted inline. Everything else is a judgement call or a proposal, marked **[proposal]**. Findings are
ordered by expected payoff, not by area.

---

## P0 — Correctness bugs

### 1. Meshes over 65,535 vertices render as scrambled geometry, silently **[verified — FIXED, pending manual check]**

> **Fixed.** `src/graphics/indexFormat.ts` (new, pure) picks the index width from `max(indices)`;
> `mesh.ts` stores the chosen GL type (`_indexType`, plus `_lodTypes` per LOD level) and reads it at all
> three draw sites. 14 tests in `tests/indexFormat.test.ts`. Two traps found while fixing it, both
> recorded there: the threshold is `>= 65535` (65535 is WebGL2's primitive-restart index, so a
> 65536-vertex mesh would drop triangles touching its last vertex — the same silent symptom), and
> `maxIndex` must not use `Math.max(...indices)`, which throws `RangeError` at ~125k args, i.e. on
> exactly the meshes this targets. **Still needs the manual repro:** import a >65,535-vertex glTF.

The single highest-severity finding. `Mesh` always narrows indices to 16-bit and always draws with
`UNSIGNED_SHORT`:

- [mesh.ts:40](../src/graphics/mesh.ts#L40), [mesh.ts:86](../src/graphics/mesh.ts#L86),
  [mesh.ts:113](../src/graphics/mesh.ts#L113) — `gl.bufferData(..., new Uint16Array(indices), ...)`
- [mesh.ts:138](../src/graphics/mesh.ts#L138), [mesh.ts:146](../src/graphics/mesh.ts#L146),
  [mesh.ts:159](../src/graphics/mesh.ts#L159) — `gl.drawElements(mode, count, gl.UNSIGNED_SHORT, 0)`

Meanwhile the glTF loader correctly decodes 32-bit indices
([gltfLoader.ts:369](../src/graphics/utils/gltfLoader.ts#L369) returns a `Uint32Array`). So a compliant
`.gltf` with a >65k-vertex primitive is read correctly and then destroyed on upload.

`new Uint16Array([70000, 65536])` yields `[4464, 0]` — JS wraps silently, with no throw and no warning.
There is no guard anywhere in `mesh.ts`. The user-visible symptom is a model that imports "successfully"
and draws as a spray of wrong triangles, with nothing in the console to explain it.

WebGL2 supports `UNSIGNED_INT` indices natively (no extension needed — it was `OES_element_index_uint`
in WebGL1 and is core in WebGL2), so the fix is cheap:

- Pick the index type from the vertex count: `Uint32Array`/`gl.UNSIGNED_INT` above 65,535, else keep
  `Uint16Array` to avoid doubling index memory on the common small-mesh path.
- Store the chosen type on the mesh and pass it to every `drawElements`/`drawElementsInstanced`.
- Add a hard guard so a future regression throws loudly rather than corrupting geometry.

This deserves a regression test at the `Mesh` level; the truncation itself is already covered by a
plain-JS assertion and needs no GL context.

### 2. No delta clamping — a backgrounded tab teleports the game **[verified — FIXED, pending manual check]**

> **Fixed.** `MAX_DELTA = 0.333` (Unity's `maximumDeltaTime` default) clamps the delta at source in
> `engine.ts`, and `run()` now resets `_lastTimestamp` so the construct→run gap is no longer charged to
> frame one. `editor/.../uiRuntime.ts` had the same bug in its own rAF loop and got the same clamp;
> `AnimationPlayer.tsx:76` already clamped and was left alone. No `visibilitychange` listener — see the
> reasoning at `MAX_DELTA`. Known interaction, documented at the constant: physics absorbs at most
> `5 × 1/60 = 0.083s` per frame, so a recovery frame advances scripts ~4× further than the simulation for
> one frame. **Still needs the manual repro:** `this.every(1, ...)`, tab out 30s, expect one tick.

[engine.ts:108-127](../src/core/engine.ts#L108-L127) feeds the raw wall-clock delta into the frame:

```ts
const deltaTime = (currentTimestamp - this._lastTimestamp) / 1000;
if (!this._paused) { this._physicsSystem.update(deltaTime); this._timeSinceStart += deltaTime * 1000; }
if (this._scene) { this._scene.update(deltaTime, this._timeSinceStart, this._paused); ... }
```

`grep` confirms there is no `Math.min` clamp on delta and no `visibilitychange`/`blur` handling anywhere
in `src/`. Two concrete consequences:

- **Tab-out.** `requestAnimationFrame` stops firing when the tab is hidden. On return, `deltaTime` is the
  entire away duration — potentially minutes. Every script doing the documented, correct thing
  (`this.addX(speed * delta)`) integrates one enormous step and teleports across the map.
- **First frame.** `_lastTimestamp` is initialized at *construction*
  ([engine.ts:25](../src/core/engine.ts#L25)), not at `run()`. Any asset loading between the two is
  charged to frame one's delta.

Physics is *accidentally* protected: `world.step(1/60, deltaTime, 5)` caps at 5 substeps, so the
simulation degrades to slow-motion rather than exploding. Scripts and `_timeSinceStart` have no such
protection. The standard fix is to clamp (`Math.min(delta, 0.1)`) and reset `_lastTimestamp` on
`visibilitychange`.

Worth noting what is already *right* here: the fixed-timestep-physics/variable-render split at
[physicsSystem.ts:67](../src/physics/physicsSystem.ts#L67) is exactly the pattern Gaffer's "Fix Your
Timestep!" prescribes and that Unity/Unreal/Godot use. The `1/60` internal step with catch-up substeps is
correct and deliberate. Only the clamp is missing.

### 3. GPU resources are allocated and never released **[verified]**

17 `gl.create*` call sites against 3 `gl.delete*` call sites:

| Resource | created | deleted |
|---|---|---|
| Buffer | 9 | 2 |
| Shader | 2 | **0** |
| Framebuffer | 2 | **0** |
| VertexArray | 1 | **0** |
| Texture | 1 | 1 |
| Renderbuffer | 1 | **0** |
| Program | 1 | **0** |

The only releases are [mesh.ts:107](../src/graphics/mesh.ts#L107) (stale LOD buffers),
[renderer.ts:872](../src/graphics/renderer.ts#L872) (foliage buffers) and
[texture.ts:290](../src/graphics/texture.ts#L290). Shader programs, framebuffers, VAOs and renderbuffers
are never freed at all, and only 2 of 9 buffer allocations have a matching free.

This matters far more for the **editor** than for a shipped game: a game allocates once and exits, but the
editor loads and unloads scenes, rebuilds terrain chunks, recompiles custom shaders and re-imports meshes
in a single long-lived context. Every one of those leaks GPU memory until the tab dies or the context is
lost. It also explains any "editor gets slower the longer it runs" behaviour.

The engine has no disposal protocol at all: only `Ragdoll.destroy()` and `Terrain.dispose()` exist
across the whole codebase. **[proposal]** Introduce a `dispose()` convention on every GL-owning class
(`Mesh`, `Shader`, `Framebuffer`, `Texture`, `Material`), have `Scene` cascade it on unload, and treat
"allocates a GL object without a matching delete" as a review error.

---

## P1 — Safety net (partly addressed in this pass)

### 4. There were no tests at all — now there are 34 **[done]**

The repo had zero tests, no runner, and CI that only deploys to Firebase. Standing up a safety net was a
precondition for any large refactor, so this pass added:

- `vitest` + [vitest.config.ts](../vitest.config.ts), scoped deliberately to the **pure** core — no DOM,
  no GL, no fixtures.
- 34 tests across [tests/](../tests/): `base64` (round-trips, the 32KB chunk boundary that exists to dodge
  the `apply` arg limit), `rayTriangleIntersection` (hit distance, two-sidedness, parallel/behind
  rejection, non-unit direction scaling), and `convexHull` (the containment invariant at every quality
  level, plane budgets, degenerate input).
- `npm test`, `npm run test:watch`, `npm run typecheck`.

The convex-hull suite asserts the invariant the half-space carve exists to guarantee — every input point
stays inside the hull — which is precisely the property whose violation shows up as objects sinking
through their own collider. It includes a negative control proving the containment helper can actually
fail, so a bug that made it vacuously true can't silently disarm the suite.

**[proposal]** Next testing targets, in order: `Mesh` index-width selection (once fixed), `frustum`
culling, `raycaster`, `animationRetarget` (`remapAnimationToSkin` is pure and intricate), and the
`animator`'s condition-group evaluation (AND/OR gates are easy to regress and impossible to eyeball).

### 5. `strict` is off, but the debt is only ~43 real errors **[verified]**

[tsconfig.json](../tsconfig.json) enables only `noImplicitAny`. Full `strict` produces 55 errors — but
**12 are phantom**: `TS2550` was just `target: es6` (= ES2015) not knowing `Array.prototype.includes`.
That has been fixed in this pass by declaring `"lib": ["es2020", "dom"]` separately from the emit target
— zero code change, zero emit change, 12 errors gone. Typecheck and the webpack build are both verified
clean afterwards.

> **DONE.** `strictNullChecks` and `strictPropertyInitialization` are both on, and the engine typechecks
> clean. Editor is back to its 1 pre-existing unrelated error. See the findings below — the flags paid for
> themselves on day one.

**This number was measured wrong twice; the final answer is 32.** Worth recording precisely, because the
mistake is easy to repeat:

- **`strictNullChecks` alone: 32 errors / 7 files** — `textureManager.ts` 10, `body.ts` 7, `texture.ts` 6,
  `physicsSystem.ts` 4, `loader.ts` 2, `node.ts` 2, `scene.ts` 1.
- **`+ strictPropertyInitialization`: 36 / 8 files.** The 4 extra are the `TS2564`s
  (`Scene._cameras`, `Renderer._viewport`, `Renderer._activeCamera`, `gltfLoader.gltf`) — a *separate*
  flag, which is why they are not part of a strict-null count.
- **Full `strict`: 40.** The remaining 4 come from unrelated flags and are a separate argument.

**Two measurement traps, both of which bit this audit:**
1. *Probe location.* A probe tsconfig placed in a scratch directory cannot resolve the project's
   `node_modules`/`@types`, which invents a `TS7016` (`events`) and a `TS2580` (`require`) that are not
   real. This is what produced the earlier bogus "34 / 9". **Probe by `extends`-ing the real tsconfig from
   a file inside the project directory.**
2. *Flag interaction.* `strictNullChecks` *without* `noImplicitAny` reports **51** — more than full
   `strict` — because an empty `[]` infers `never[]` instead of an evolving `any[]`, yielding 18 bogus
   `not assignable to parameter of type 'never'` errors. The root tsconfig already sets
   `noImplicitAny: true`, so they never occur in practice.

**Risk correction:** an earlier draft warned that widening `dist/**/*.d.ts` could break end users' scripts.
**It cannot.** Monaco sets `strictNullChecks: false`
([monacoSetup.ts:35](../editor/src/features/nodeInspector/scriptEditor/monacoSetup.ts#L35)), so a widened
declaration changes hover text only. The real exposure was editor code, which consumes the same tree at
`strict: true` — and that was verified by diffing the emitted `.d.ts` before/after rather than reasoning
about it. Exactly 5 declaration files changed: `body` (a non-exported interface — inert), `texture`
(`CubemapFaces` tightened), `textureManager` (honest return types), `scene` (`activeCamera`), `node`
(`setTrigger`).

### What the flags actually found

Two real bugs, neither of which any test or reviewer had caught:

- **`TextureManager.addTexture` returned the wrong variable** — `return id` where it meant
  `return identifier`. Called without an id it stored the texture under a generated uuid and returned
  `undefined`, so the caller could never look it up again. Masked only because both existing callers
  happen to pass an id. Verified by re-introducing it: the checker reports
  `TS2322: Type 'string | undefined' is not assignable to type 'string'`.
- **`Scene`'s constructor initialized every node set except `_cameras`** — found immediately by
  `strictPropertyInitialization`. Dormant only by accident: `_dirty` starts `true`, so the sole reader
  (`activeCamera`) always triggers the traversal that lazily creates the set first.

And one lying signature: **`Scene.activeCamera` was typed `CameraNode` while falling through to
`undefined`**. Now `CameraNode | undefined`. That exposed 3 genuinely unguarded editor call sites
(`AnimationSkeletonTool.tsx`, `EngineContext.tsx`, `PositionGizmo.tsx`) — real latent crashes, all now
guarded.

Honest accounting of the rest: **24 of the 32 were dead optional markers** — `BodyConfig.position?` where
both callers always pass a value, `CubemapFaces`'s `| null` that no producer ever assigns. And
`strictPropertyInitialization` required 3 definite-assignment assertions (`Renderer._viewport`,
`Renderer._activeCamera`, `GLTFLoader.gltf`), which are genuinely deferred assignment — the intended use of
`!`, not null-suppression.

### 6. No linter, no formatter, no CI correctness gate **[verified — gate now DONE]**

No ESLint, Prettier, Biome or EditorConfig anywhere. The two `.github/workflows/` files are both Firebase
hosting deploys — nothing runs `tsc`, and until this pass there was nothing to run.

> **Done (engine).** `.github/workflows/ci.yml` runs `npm ci → typecheck → test` on push-to-main and on
> every PR. Deliberately no build step: both are independent of `dist/` (typecheck is `--noEmit`, tests are
> pure), and a fast gate is a gate that survives. Node is pinned via a new `.nvmrc` (`22`) + `engines`,
> replacing the deploy workflows' reliance on whatever `ubuntu-latest` ships. No fork gate — this job uses
> no secrets, which closes the hole where fork PRs ran no checks at all. `npm ci` verified via dry-run.

**[proposal]** Two follow-ups. **Editor typecheck** is the significant one: the editor is *never*
typechecked (webpack uses babel, which strips types without checking) despite `strict: true`. It currently
has exactly one error — `TS1501` in `publish/externalizeAssets.ts:29`, a dotAll regex needing
`target >= es2018` while `editor/tsconfig.json` says `ES6`; bumping the editor target to `ES2020` fixes it
(`lib` is already `ESNext`, and `noEmit: true` means babel ignores `target`). Deferred only to avoid
gating in-flight editor work. A formatter is a bigger cultural call (it will produce one enormous diff),
so it is worth deciding deliberately rather than drifting into it.

---

## P2 — Documentation

### 7. JSDoc: 1,172 undocumented public members; the important ones are now done **[partly done]**

Measured properly rather than guessed. `tools/jsdoc-gaps.mjs` (added this pass, `npm run jsdoc:gaps`)
parses the emitted `.d.ts` tree — the true public surface, and exactly what Monaco reads for hover in the
script editor — and reports members with no leading JSDoc. It excludes vendor code and skips
`protected`/`private`/underscore members, which is what takes the raw 2,683 down to a meaningful 1,172.

An important framing point: **blanket coverage would make hover worse, not better.** `/** The position. */`
above `position: vec3` is pure noise. Good JSDoc here carries what the type cannot — units, coordinate
space, aliasing, lifetime, and the traps. That is what this pass wrote, concentrating on `Node`, the class
every script touches:

- The six lifecycle hooks (`onStart`/`onSpawn`/`onUpdate`/`onCollision`/`onTrigger`/`onDespawn`),
  including the verified re-parenting semantics — `addChild` passes `reparent: true`, so re-parenting
  fires `onSpawn` but **not** `onDespawn`.
- The live-reference traps, which are invisible in the signature and silently corrupt state:
  `position`/`rotation`/`quaternion`/`scale` return the node's **internal** vectors, so
  `node.position[0] += 1` skips `_updateTranslationMatrix()` and never reaches the physics body, leaving
  node and collider disagreeing about where the object is. The four `world*` getters return the **live
  cache**, rewritten in place.
- `setBody`, with units and the real combine rules — verified against
  [physicsSystem.ts:170-187](../src/physics/physicsSystem.ts#L170-L187): friction combines with `min` (the
  *slipperier* surface wins) and restitution with `max` (the *bouncier* wins). Both are genuinely
  surprising and neither is discoverable from the signature.

Verified that the comments survive into `dist/**/*.d.ts` — which is the whole reason
`removeComments: false` is set.

**[proposal]** Continue in descending script-visibility order: `Scene`, `InputManager`, `Camera`,
`Animator`, `Body`/`Trigger`. `Renderer` (84 gaps) is largely internal and should be near-last despite
its size. Skip trivial accessors deliberately, and track the number with `npm run jsdoc:gaps`.

Credit where due: the *internal* commenting in this codebase is genuinely excellent — `isGrounded`,
`groundNormal`, `velocity`, the `_updateWorldCache` non-uniform-scale explanation and the `GROUND_GRACE`
rationale are better than most commercial engines manage. The gap is almost entirely that good `//`
comments get dropped by the compiler while JSDoc reaches the user.

---

## P3 — Rendering & performance

### 8. No Uniform Buffer Objects **[verified]**

`grep` finds no `UNIFORM_BUFFER`, `bindBufferBase` or `uniformBlockBinding` in `src/`. UBOs are a WebGL2
core feature and the standard way to share per-frame data (view/projection matrices, camera position,
light arrays) across every shader with one upload instead of N `uniform*` calls per program per frame.

**[proposal]** A `PerFrame` uniform block is the highest-leverage version and a contained change. Caveat
worth respecting: Safari has known UBO overhead, so this should be measured, not assumed.

### 9. What the renderer already does well **[verified]**

Stated explicitly so it doesn't get "optimized" by generic advice:

- **Instancing is used** — `drawElementsInstanced` / `vertexAttribDivisor`
  ([mesh.ts:159-306](../src/graphics/mesh.ts#L159)), which is what makes the foliage system viable.
- **Draw calls are sorted to batch state** — by shader at
  [renderer.ts:833](../src/graphics/renderer.ts#L833), with separate depth-sorted transparent queues.
- **VAOs are used**, which is the recommended way to cut attribute setup overhead.
- **Frustum culling** with a lazily-cached world bounding sphere per node, invalidated on transform
  change rather than recomputed per frame.
- `renderStats.ts` already tracks draw calls and instanced draws — the instrumentation for measuring any
  of the above is present.

### 10. Deferred renderer is at its sampler budget **[proposal]**

Per the project's own notes, probe volumes occupy 2 deferred slots against a 15/16 sampler budget. That
ceiling will keep forcing awkward trade-offs as features land. Worth planning a texture-array or atlas
consolidation before the next feature needs a slot, rather than at the moment it does.

---

## P4 — Architecture

### 11. `renderer.ts` is 3,432 lines and `node.ts` is 3,124 **[verified]**

The two largest files by a wide margin. `renderer.ts` holds the forward path, the deferred path, shadows,
post-processing, god rays, motion blur, clouds, sky, sprites, foliage and picking. `node.ts` holds the
base `Node` plus every specialized subclass (`ModelNode`, `LightNode`, `LodGroupNode`,
`VolumetricCloudsNode`, `SkyAtmosphereNode`, …) and the scripting data-access layer.

**[proposal]** The natural seam in `renderer.ts` is a **render-graph / pass-list**: each pass declares its
inputs, outputs and enable condition, and the renderer becomes a scheduler over a pass array. That
directly serves the "WebGPU behind a feature flag" trajectory the industry is on — a pass list is
portable, a 3,400-line hand-rolled sequence is not. For `node.ts`, the mechanical split is one file per
node type under `core/scene/nodes/`, keeping the barrel export identical.

Neither should be attempted before `strictNullChecks` is on and the test net is broader. Both are
mechanical-but-wide changes that a type checker makes dramatically safer.

### 12. `EngineContext.tsx` is 3,013 lines **[verified]**

The editor's god-context, and the largest single file in the editor by 5×. It is the natural consequence
of a context that owns engine lifecycle, selection, scene mutation, asset state and mode switching at
once.

**[proposal]** Split by concern into separate providers (engine/runtime, selection, assets, modes). Each
becomes independently testable and stops re-rendering consumers that don't care. This is the editor's
single biggest maintainability lever.

### 13. Scene graph vs ECS **[proposal — recommendation: stay]**

Worth addressing explicitly since it is the question every engine post asks. Cleo is a pointer-based scene
graph with behaviour on nodes. The industry has moved toward ECS (Unity DOTS, Unreal, Bevy), and the
honest tradeoff is: ECS traversal wins on flat hierarchies and cache locality; pointer-based trees win on
deep hierarchies and attach/detach cost; most contemporary engines run **both**, using a scene graph for
transform hierarchy and ECS for behaviour iteration.

**Recommendation: do not migrate.** Cleo's scripting model, serialization, editor inspector and node
variables are all built on node identity. An ECS rewrite would touch every one of those for a cache win
that a WebGL2 engine — which is draw-call and fill-rate bound, not iteration bound — will not notice. The
`renderStats` counters would show it if it were otherwise. This is a case where the popular architecture is
the wrong one for the constraints.

### 14. Smaller structural items **[verified]**

- **202 uses of `any`** in `src/`. `Node.serialize(): Promise<any>` and `static parse(parent, json: any)`
  are the load-bearing ones — the serialization format is entirely untyped, which is exactly where a typo
  becomes a silent data-loss bug. A `SerializedNode` interface would pay for itself.
- **10 TODO/FIXME/HACK.** Four are the same note — "Move this to a LightManager class"
  ([scene.ts](../src/core/scene/scene.ts) ×4) — which is the codebase asking for a specific refactor in
  four places. [scene.ts:216](../src/core/scene/scene.ts#L216) ("This seems unoptimized, TODO: Fix later")
  is worth profiling rather than guessing at.
- **55 raw `console.*` calls** in `src/` (excluding `logger.ts`, which legitimately wraps `console`)
  despite a real `Logger` existing that the editor console panel consumes. These bypass the panel, so
  anything they report is invisible to a user working in the editor. Concentrated in
  [animator.ts](../src/graphics/animator.ts) (15), [assimpLoader.ts](../src/graphics/utils/assimpLoader.ts)
  (10) and [textureManager.ts](../src/graphics/systems/textureManager.ts) (6) — i.e. exactly the import
  and animation paths where a user most needs to see what went wrong.
- **Empty catch blocks** at [renderer.ts:2404](../src/graphics/renderer.ts#L2404) and four sites in
  [inputManager.ts](../src/input/inputManager.ts). The pointer-lock ones are defensible (the API rejects
  for benign reasons); `renderer.ts:2404` swallowing silently is not.
- **`Node.setBody` does not support child nodes** — the `TODO` at
  [node.ts:1336](../src/core/scene/node.ts#L1336). Now documented as a known limitation rather than a
  silent surprise, but it is a real gap: a body on a child node ignores its parent's transform.

---

## P5 — Completing the features that already exist

Ordered by "how close is this to done, and how much does finishing it matter". These are **[proposal]**
throughout.

**Physics**
- *Continuous collision detection.* cannon-es is discrete: a fast projectile tunnels through thin
  geometry. A raycast-swept fallback for fast bodies is the usual mitigation and the most likely
  "physics feels broken" report you'll get.
- *Layers / collision masks.* cannon supports `collisionFilterGroup`/`Mask`; exposing them in the editor
  is small and unlocks a category of gameplay (player-only triggers, ghost bodies, ignore-self).
- *No convex/trimesh narrowphase* (already noted in `convexHull.ts`) — worth surfacing in the editor as a
  warning when a user gives a concave collider to a dynamic body, rather than letting it silently not
  collide.
- *Physics off the main thread.* Per the project's own worker analysis, this is the ranked candidate; the
  tuple-array transferable issue is the known blocker.

**Animation**
- *Root motion.* The state machine, blending, events, retargeting and ragdoll are all there; root motion
  is the conspicuous absence for character work.
- *Blend trees / 2D blend spaces.* The graph does states and transitions; a locomotion blend space
  (speed × direction) is the usual next primitive.
- *IK* (two-bone, foot placement). The skeleton, joint overlay and ragdoll infrastructure already exist,
  which is most of the hard part — foot IK on the terrain is the obvious payoff.
- *Animation compression.* `AnimationCompatibility`/`HierarchyMismatch` types suggest retargeting is
  mature; sampled-curve compression matters once real animation sets ship.

**Terrain**
- *Holes / caves.* Heightfields can't express them; a stencil-mask channel is the standard trick and
  unlocks tunnels and doorways.
- *Runtime streaming.* Chunks and LOD exist; streaming them by distance is what makes large worlds viable.
- *Erosion / procedural generation* in the sculpt toolset.
- *Terrain-as-mesh export* for cases the heightfield can't serve.

**Rendering**
- *TAA.* Motion blur already computes velocity buffers, which is the expensive precondition — TAA is
  unusually cheap to add from here and would do more for image quality than any other single pass.
- *SSAO/GTAO.* The deferred G-buffer is already present; contact shadows are the biggest remaining
  "looks flat" gap.
- *Decals.* Deferred renderers make these natural, and they're a large authoring win.
- *Screen-space reflections*, to complement the existing probes.
- *WebGPU path behind a flag.* This is where the industry is; the render-graph refactor (#11) is the
  precondition, and doing them in the wrong order means doing the work twice.

**Editor / tooling**
- *Undo/redo.* If it isn't comprehensive, it is the single highest-value editor feature — nothing else
  changes user confidence as much.
- *Play-mode state isolation.* The classic editor trap: entering play must not mutate the authored scene.
- *In-editor profiler.* `renderStats` already collects the data; a frame-time/draw-call graph would make
  every performance conversation concrete instead of anecdotal.
- *Prefab/template nesting and overrides*, if the template system doesn't yet nest.
- *Asset hot-reload* on external file change.
- *Multi-select + multi-edit* in the inspector.

**Scripting**
- *Script debugging.* Source maps through the sucrase compile step, so breakpoints land on the user's
  actual source.
- *Typed scene queries* — `findNode` returning `Node | null` rather than `any`.
- *A script lifecycle for `onFixedUpdate`*, matching the fixed physics step — currently scripts only get
  variable-rate `onUpdate`, which is the wrong clock for physics-coupled logic (and, given #2, an
  unclamped one).

---

## Suggested order

Tranche 1 — **done**, pending the two manual repros:

1. ~~Fix the index-width bug (#1)~~ — done. Needs the manual >65k-vertex glTF import check.
2. ~~Clamp delta (#2)~~ — done, in both the engine loop and `uiRuntime`. Needs the manual tab-out check.
3. ~~Add the CI gate (#6)~~ — done, engine-only.

Tranche 2 — **done**, pending manual checks:

4. ~~`strictNullChecks` + `strictPropertyInitialization` (#5)~~ — done. 36 errors fixed by narrowing, no
   null-suppressing `!`. Found 2 real bugs (see above). `.d.ts` delta measured, not assumed.

Tranche 3 — next, in this order:

5. **Editor typecheck in CI (#6 follow-up)** — one line plus an `ES6`→`ES2020` target bump. Still deferred
   only because it would gate in-flight editor work; babel never typechecks the editor, so this gate is the
   only automated thing that can catch a `.d.ts` regression. Tranche 2 ran it manually instead.
6. **Establish the `dispose()` protocol (#3)** — start with `Shader`/`Framebuffer`/`VAO`, which have no
   releases at all. `CleoEngine.setScene` is the seam all five scene-swap paths funnel through.
7. **Then** refactor: `renderer.ts` to a pass list (#11), `EngineContext.tsx` by concern (#12).

Steps 1-4 were all small, and together they turn "43k lines with no net" into something a large refactor
can actually be attempted against.

---

## Appendix — other findings recorded along the way

- **`Texture.create(null)` on a cubemap target threw a `TypeError`** — the null path existed only on the
  `TEXTURE_2D` branch, but `new Skybox(null)` reaches the cubemap branch and `Skybox` is public API whose
  parameter openly accepts `null`. `strictNullChecks` could *not* catch this: an `as CubemapFaces` cast
  hid it. **Fixed** in tranche 2 by allocating six empty faces, mirroring what the 2D branch already does
  for render targets — a no-op would have left the texture incomplete, a subtler failure than the crash.
  Behavioural, and unverifiable by any automated check here (no GL context in tests).
- **`Geometry.vertexCount` returns `positions.length * 3`** — the float count, not the vertex count.
  Latent: currently unreachable because every geometry is indexed, so the `drawArrays` fallback that
  consumes it never runs. Worth its own small fix, and a live trap for anyone sizing anything from it.
- **`CleoEngine.shutdown()` does not cancel its `requestAnimationFrame` and is never called anywhere.**
  Combined with `_initialize()` leaking a `resize` listener, this is why tranche 1 preferred a delta clamp
  over a `visibilitychange` listener — the engine has no working teardown to hang one on.

---

## Sources

- [Fix Your Timestep! — Gaffer On Games](https://gafferongames.com/post/fix_your_timestep/)
- [WebGL best practices — MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices)
- [WebGL2 Optimization: Instanced Drawing — WebGL2 Fundamentals](https://webgl2fundamentals.org/webgl/lessons/webgl-instanced-drawing.html)
- [WebGL Performance — Wonderland Engine](https://wonderlandengine.com/about/webgl-performance/)
- [Entity-Component System — Wicked Engine](https://wickedengine.net/2019/09/entity-component-system/)
- [Scene graphs in an Entity-Component Framework — GameDev.net](https://www.gamedev.net/forums/topic/681592-scene-graphs-in-an-entity-component-framework/)
- [Best practices of optimizing game performance with WebGL — Gamedev.js](https://gamedevjs.com/articles/best-practices-of-optimizing-game-performance-with-webgl/)
- [WebGL2: dynamic uniform buffer usage — webgl-dev-list](https://groups.google.com/g/webgl-dev-list/c/-Wt6WF9vS4o)
