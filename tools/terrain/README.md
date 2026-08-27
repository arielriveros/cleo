# Building the "Realistic Landscape" example

Turns the raw source art in `examples/assets/terrain/` into the example project shipped at
`editor/public/examples/realistic-landscape/`.

```
npm run build:dev            # the engine bundle the builder drives
npm run terrain:decimate     # stage 1 — reduce the art
npm run build:landscape      # stage 2 — build, verify and zip the project
npm --prefix editor run examples:add -- <the .zip> --slug realistic-landscape \
    --name "Realistic Landscape" --description "…"
```

`examples/assets/terrain/` is **gitignored** (`.gitignore:5`), so the inputs are local-only — a fresh
checkout cannot rebuild this. That is fine and deliberate: what ships is the built example folder
under `editor/public/examples/`, and nobody has to reproduce it to use it. The art is Poly Haven
(`grass_medium_02`, `rock_moss_set_02`, `searsia_burchellii`, `pine_tree_01`) plus ambientCG
`Ground103`.

On Windows, `npm run build:landscape` needs `ELECTRON_RUN_AS_NODE` **unset** — with it set, the
`electron` binary starts as plain Node, `require('electron')` fails and the script dies before it
opens a window.

## Why there are two stages, and why the second one is Electron

Most of the source art IS used as authored. The grass clumps (714-2,489 tris), the rocks
(7,894-9,826) and the small searsia (44,516) go through untouched at LOD0; the extra LOD levels below
them are additions, not replacements. Only two assets are reduced, and only one of them is not a
judgement call.

`pine_tree_01.bin` is **948 MB** and its three variants are 6.9M / 4.2M / 6.0M triangles, because Poly
Haven models pine needles as geometry rather than as alpha cards. Measured, loading it raw through the
engine in this same Electron harness:

| | |
| --- | --- |
| fetch the 948 MB buffer | 4 s, 983 MB heap |
| parse all three variants (17.18M tris) | +6 s, **3.15 GB heap** |
| first 60 frames with ONE variant on screen | **385 s** (GPU upload stalls) |
| steady state, that one tree alone in the scene | **24.5 ms/frame** |

So it is not impossible — it is one tree, at 41 fps, after six and a half minutes and 3 GB of heap, in
a scene containing nothing else. This example carries ~130 pines alongside 162k other instances, and
its whole bundle is 46 MB against the ~240 MB a single raw variant would occupy in `assets.bin`. Stage
1 is plain Node so it can stream that buffer through ranged reads instead of holding it.

Stage 2 runs the **real `dist/cleo.js`** in a real GPU process, the same way `tools/harness/` does.
Models come back through `GLTFLoader`, materials through `Material.PBR`, the terrain through
`Terrain.deserialize`, the node tree through `Scene.serialize()`. The alternative — hand-writing scene
JSON — drifts from the parser the editor actually runs, and the failure mode is a project that imports
with pieces silently missing. Building it live also lets the builder render what it just made and
refuse to emit a scene that draws nothing.

## Stage 1 — `decimateTrees.mjs`

Two reduction operators, chosen per primitive by what the geometry *is*:

| Operator | For | How |
| --- | --- | --- |
| `cluster` | connected surfaces — a trunk, a rock | grid vertex clustering, bisected on the cell size to hit a triangle target |
| `thin` | a soup of separate islands — needles, leaves, blades | label connected components, keep a spatially even subset in Morton order, budgeted in **triangles** |

`thin` also takes a **fatten** factor that scales each surviving island about its own centroid. Two
percent of a pine's needles is a bare tree and the budget cannot go much higher, so making the
survivors bigger is what buys the canopy back: at 2.4x, a fiftieth of the needles covers roughly a
third of the original area. Up close the needles are visibly coarse. That is the honest trade, and it
is why the factor is per LOD level rather than global.

`KHR_texture_transform` is baked into the UVs on the way through — the engine's glTF loader does not
implement it, and `pine_tree_01_bark` carries a transform large enough to smear the trunk without it.

Output: `<tmp>/cleo-terrain-build/`, ~375k triangles across 33 meshes, plus the textures.

## Stage 2 — `buildLandscape.js` + `../harness/pages/landscape/index.html`

The page builds the scene; the driver drives it, checks it, and writes the archive.

- **Two ground surfaces.** `Ground103` is brown SOIL, not grass; `Ground110` (gravel/scree) is the
  rocky slope and, at half the tiling, the creek bed. The soil layers carry a MILD green tint. An early
  build tinted them hard green to fake ground cover and the terrain read as a flat green field, so they
  then shipped untinted — and past the foliage cull the vista was beige under pale fog with no green
  anywhere. The tint is the middle of those two: soil still shows between the clumps up close, and the
  meadow still reads as meadow at the horizon.
- **Grass is MESH, with a card impostor past 30 m.** Not the other way round. It used to be five
  standalone billboard rules at 11.3 instances/m² against four mesh rules at 0.38, both starting at
  distance 0 — so what the camera stood in was a field of flat quads with a few clumps scattered over
  them. Foliage has no NEAR cut (only `cullDistance` and the LOD bands), so a standalone card rule is
  visible at arm's length by construction. Reached instead through `FoliageLayer.billboardDistance`,
  the same cards cannot be: the layer draws the mesh inside 30 m and the crossed quad past it, out to
  a 70 m cull.

  Cost is not the reason it was ever the other way. All the grass together — meshes inside 18 m plus
  cards inside 38 m — was ~0.4M triangles of a 7.2M peak. The trees are the cost; pine LOD0 alone is
  262,988 triangles. Grass gets **three** mesh levels (714-2,489 / ~380 / ~100) because ring area grows
  with the square of the radius: the 14-30 m band holds four times the clumps of 6-14 m and would cost
  more than LOD0 and LOD1 together if it ran on LOD1.

  **The scale-units trap, twice.** An instance carries one uniform scale and the two representations
  read it differently: on the mesh it MULTIPLIES the authored size, on a unit quad it IS the size in
  metres. The mesh rules had inherited the cards' 0.85-1.6 while the clumps are 12-40 cm authored and
  differ 2.6x between variants — so the ground cover was 10-25 cm and invisible, and the frame stats
  could not show it because every triangle was still being submitted. Scale is now DERIVED from each
  prototype's measured geometry height and gated on the resulting world height. Fixing that then
  exposed the same trap from the other side: those derived scales (2.2-4.5 for the smallest clump) were
  also being applied to a 1x1 impostor quad, turning it into a 2-4 m card and putting a wall of grass
  at the hand-off distance. `crossQuadGeometry` now takes a size and `_applyMeshPrototype` passes the
  prototype's authored footprint, so one scale means one thing.

  An impostor must also be no sparser than the mesh level before it. A first pass gave LOD2 a
  120-triangle budget and it came out THINNER than the 4-triangle card that replaces it, so the chain
  ran dense mesh, bald mesh, full card and the bald ring read as bare ground with a wall behind it.

  One rule per PROTOTYPE across the whole terrain — a/c/e on the meadow, d on the forest floor, b in
  the creek bed. A prototype named on two layers becomes two `FoliageLayer`s carrying two copies of its
  geometry in the scene blob. (`grass_medium_02_b` was staged, shipped in the model library, and
  referenced by no rule at all until the gates started checking.)
- **Alpha cutout.** The leaves are alpha CARDS: sampling each primitive's UVs against its atlas shows
  62.6% of the searsia leaves' rendered surface landing on background, 34.0% of the twigs, 16.6% of the
  grass and 13.8% of the pine needles — against 0.0% for every bark and trunk. The engine had no cutout
  path for PBR at all (`alphaCutoff` was declared in the glTF loader and read by nothing), so the cards
  were drawn whole. It has one now, and the builder authors the alpha the source lacks.

  Which materials get a cutoff is **measured, not listed**: `backgroundFraction` samples each
  primitive's UVs against the diffuse's coverage mask and enables masking past 5%. That is what
  correctly excludes the rocks — their atlas has 22% background but their closed meshes never sample
  it, and a cutout there would punch holes rather than cut leaves.

  **Mind the V flip.** `GLTFLoader` stores `1 - v` (gltfLoader.ts:615) and the upload flips the texture
  again, so the two cancel at draw time — but reading the image directly cancels nothing, and the row
  wanted is `(1 - v) * (h - 1)`. Backwards it samples the MIRROR image, which on a mostly-black atlas
  still reads as "lots of background" and confirms the wrong answer rather than failing: it put the
  searsia leaves at 95% against a true 62.6%, and flipped two rock LODs from 0% to 100%. Every LOD of
  one material must reach the same verdict — they share a texture and a UV layout — so the build gates
  on that, which is what the mirrored version could not satisfy.
- **Albedo lift.** The pine bark and trunk maps are 4.6% and 3.4% linear reflectance — darker than
  asphalt, against 20.1% for the soil they stand on and 10-15% for real pine bark. `ALBEDO_LIFT` is a
  documented per-material `baseColor` multiplier that puts them in a plausible range. A grade, stated
  in the open rather than hidden in an exposure.
- **Atlas fill.** Every foliage atlas is cut-outs on a pure black background — 89% of the grass sheet,
  61% of the searsia leaves, 29% of the pine needles, and the gaps between the rock UV islands — and
  the alpha that was meant to discard it does not exist, because these ship as JPEG. Mip-mapping
  averages the black in, so the 1x1 mip of the grass sheet was `[15,15,10]` when the mean of its actual
  blades is `[139,138,95]`: at range the foliage WAS black. The background is filled with the
  surrounding real content (pull-push, see below) before the texture is registered.

- **Terrain** — a seeded Perlin + ridged-multifractal heightfield with a valley cut through it. The
  splat is painted from the same height and slope fields, with thresholds set as **percentiles** so
  every paint layer gets real coverage whatever the noise did. (Absolute thresholds were tried and
  gave the rocky layer 0% of the map.)
- **Foliage** — 18 scattered layers off four terrain materials. `generateFoliageEverywhere` rejects
  candidates that do not land on their own layer, so each rule's authored density is divided by that
  layer's measured coverage to make the number mean what it says.
- **The vantage point is chosen, not authored** — the highest standable cell in a ring, on a layer
  that carries ground cover, aimed at the valley. Flattening a patch to stand on was worse: it fell
  below the low-ground percentile and painted as creek dirt.
- **Format 2.** A foliage prototype's geometry appears in the model library, in the terrain material's
  rule, in the scene's copy of that rule, and again in the scattered layer. Written as format 1 that
  is four full copies of every vertex — ~360 MB of JSON. `packBundleAssets` (loaded from the editor's
  own source through sucrase) content-interns them into one `assets.bin`, and the bundle lands at
  ~46 MB.

### What the driver checks

Every run gates on: frames rendering, triangles submitted, the sun above the horizon, four terrain
layers with material and coverage, the camera standing on a layer with cover, foliage scattered with
its LOD levels intact, every model non-empty, the probe baked, a non-blank cover image — and then two
round trips. The scene JSON is re-parsed into a fresh `Scene` and rendered (the same work the editor
does on open), and the finished `.zip` is re-read through the editor's own `readBundle`.

Diagnostic captures land in `tools/harness/shots/`: `landscape.png` (the cover), plus overhead and
ground-level angles. Judging a landscape from one frame is guesswork — that ambiguity cost several
rebuilds before the angles were added.

## Filling a cut-out atlas: two wrong answers first

Both of these are worth recording, because each looked right and made things worse.

1. **Nearest-neighbour flood** (jump flooding). The textbook answer, and exactly wrong here: the
   nearest real texel to a background texel is by definition an EDGE texel, and edge texels are the
   anti-aliased rim blended toward the black background. Flooding from them spreads the darkness. It
   moved the grass atlas's 1x1 mip from `[15,15,10]` only as far as `[50,45,29]`.
2. **Pull-push averaging** — what ships. Pull builds a pyramid where each level sums colour and
   coverage from the four texels below, so a level's colour/weight is the mean of the real content
   under it; push walks back down filling any texel with no coverage from its parent's mean. Near a
   blade the fill is that blade's colour, far from everything it is the atlas average. It is the mip
   chain's own arithmetic run backwards, which is the thing being fixed. Grass 1x1: `[155,146,109]`.

The seed mask is also **eroded by one texel** first, so the dark anti-aliased rim is neither a source
of colour nor left in place — that rim is literally the "black edges around every leaf".

## Composing the grass cards

The atlas is 10 individual blades on black. `bladeIslands` labels them, decides which end is the root
(the wider one — get it wrong and the tuft is planted tip-down), and sorts them by greenness: ordered
by area alone the pale dry straws dominate and the field comes out looking dead. Each card takes 11
blades, one straw and the rest green, fanned ±35° about their bases along the bottom edge.

Four constraints come from the billboard path itself:

- The quad's `v = 0` is at its BASE and the texture upload flips Y, so **roots go at the bottom of the
  image**.
- The sampler wraps `repeat` over UVs of exactly 0..1, so the card keeps a **transparent border**.
- Mipmapping averages alpha, and an alpha-tested blade thins and then vanishes as its mips fall under
  0.5. The card's alpha is **widened by a texel** to buy back about one level.
- Mipmapping averages RGB too, and `clearRect` leaves RGB 0 wherever no blade was drawn — with
  `widenAlpha` then growing alpha over exactly those black texels. So the composited card gets the same
  **pull-push fill** the source atlas gets, or every mip level darkens the blades. A card is only ever
  seen past 30 m now, which is several mips down: precisely where it matters most.

And the quad is 1×1 with its base at y=0, so a rule's `minScale`/`maxScale` IS the tuft's height in
metres. The first pass ran 0.7–1.7 and planted a field of head-high reeds.

## The pipeline's real ceiling is the JSON intermediate

Geometry serializes as decimals at roughly 370 bytes a triangle, and a foliage prototype is embedded
**four times** — the model library, the terrain material asset, the scene's copy of that material on
the layer, and the scattered layer. V8 refuses a string past ~512 MB, so the scene piece is what caps
this build, long before disk or GPU. Three things follow, all of them load-bearing:

- `stripTangentFrames` drops tangents and bitangents at the serialization boundary. They are 6 of the
  14 floats a vertex costs and `Geometry`'s constructor recomputes them, so this is derived data being
  stored. It has to run at the boundary, not when the rules are built: the scattered layer
  re-serializes from LIVE `Model` objects whose geometry has already recomputed them.
- **One rule per prototype across the whole terrain.** A prototype named by rules on two layers becomes
  two `FoliageLayer`s, and its geometry is embedded four more times.
- The builder logs a per-piece size table and a scene breakdown. A `RangeError: Invalid string length`
  is not a bug to route around — it is the budget telling you the number.

## Two more things that read as hangs

- **The engine loop never stops.** `CleoEngine`'s `_gameLoop` re-registers itself from inside its own
  rAF callback, so at this scene's cost the renderer saturates the main thread and the driver's
  `executeJavaScript` is simply never scheduled. One build sat "stuck" for forty minutes at 52 seconds
  of CPU. `window.__quiesce()` swaps in an empty scene before the transfer.
- **The round trip costs a second complete copy** of the terrain, on the heap and on the GPU. Run
  inline it turned into a timeout; it is now deferred until the driver asks, after the screenshots,
  and the page disposes the original scene first.

## The frame budget is calibrated, not guessed

14.2M triangles took the GPU process down — `exit_code=34`, a driver reset — and that failure does not
announce itself. A lost context makes `gl.createTexture()` return null, so the next texture throws
"used after destroy" from a handle that was never created, and every `capturePage` comes back blank.
Both symptoms point anywhere except the cause. 10.0M ran clean through the whole build including the
second terrain the round trip allocates, so the gate sits at 11M, the page listens for
`webglcontextlost` and names it, and captures retry.

The lever that moves it is the **cull distance**, because the foliage shadow pass culls cells against
that same camera distance rather than against the cascade — so shortening it cuts the colour pass and
all three cascades together.

## Two traps worth remembering

- **`CleoEngine._paused` defaults to `true`**, and `Scene.update` gates `node.update()` on it.
  `CameraNode.update` is what copies the node's world transform onto the `Camera` the renderer draws
  with, so a paused engine renders every frame from a camera still at the origin — here, underneath
  the terrain, looking sideways at its edge. Frame stats and frustum culling both looked healthy
  throughout, because they are computed from that same stale camera. Only the picture was wrong.
- **A clustering pass that welds distant vertices leaves the triangle COUNT correct.** Putting UVs in
  the cluster key to preserve seams made every interior vertex distinct too, so nothing merged, the
  cell-size bisection ran away chasing a reduction it could never reach, and the fallback ran at a
  4-metre cell. The pine shipped as black sails with exactly the 104,981 triangles it was asked for.
  The seam test is now a neighbourhood scaled by the cell size and the mesh's own UV density, and
  `reduce()` fails the build if a clustering pass stretches the longest edge more than 4x.
- **`renderer.screenshotOffscreen` is the wrong tool for a scene cover.** It is the asset-thumbnail
  path: it skips the sky, the clouds and the god rays and keys alpha off scene depth, so a landscape
  comes back as black silhouettes on transparency. The cover is a capture of the window instead.
