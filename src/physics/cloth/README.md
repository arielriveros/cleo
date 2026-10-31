# Cloth simulation in Cleo: research and roadmap

This is an engineering note for whoever extends Cleo's cloth. It covers the cloth pipelines
production engines use, how each one fits Cleo's architecture, what phase 1 ships, and what the next two
phases would take.

It lives next to the solver rather than in `docs/`. Everything under `docs/**` is the user manual,
indexed into the editor's tooltips, and that index is not the place for design notes. The user-facing
reference is the **Cloth** entry in `docs/editor/node-inspector.md` and `ClothNode` in
`docs/reference/node-types.md`.

## 1. How cloth is simulated in games

### 1.1 Solvers

| Method | Idea | Strengths | Weaknesses |
|---|---|---|---|
| Mass–spring, explicit (Provot 1995) | Hooke springs on a particle grid, integrated forward | Trivial to write | Stiff springs need tiny steps or the cloth explodes; looks like rubber at game step sizes |
| Mass–spring, implicit (Baraff & Witkin 1998) | Backward Euler with a sparse linear solve per step | Unconditionally stable, the offline standard | One linear system per frame: costly, hard to parallelise, overdamped |
| **PBD** (Müller et al. 2007) | Predict positions, then project them onto constraints, and derive velocity from the change in position | Unconditionally stable, simple, collision is just another projection | Stiffness depends on iteration count and step size |
| **XPBD** (Macklin, Müller & Chentanez 2016) | PBD plus a compliance per constraint and a Lagrange multiplier | Stiffness in physical units and independent of iteration count and step | One extra float per constraint |
| **Small Steps** XPBD (Macklin et al. 2019) | Many substeps with one constraint iteration each | Converges stiffer and damps less than many iterations of one big step, for the same cost | Several broadphase and collision passes per frame |
| Projective Dynamics (Bouaziz et al. 2014) | Local/global alternation with a prefactored global matrix | Fast once factored, and robust | Refactor on topology change; needs a linear-algebra core |

**Current practice for game cloth is XPBD with substeps.** That covers Unreal's Chaos Cloth (PBD/XPBD
with long-range attachment), NVIDIA NvCloth and its successors, Unity's Magica Cloth 2, and most in-house
solvers.

### 1.2 Constraints that matter for game cloth

- **Stretch and shear.** Distance constraints on edges and cell diagonals.
- **Bending.**
  - Dihedral-angle constraints across shared edges are the accurate version.
  - Distance constraints that skip one particle are the cheap version. They are indistinguishable for
    hanging panels.
  - Isometric bending (Bergou 2006) is the robust option for large deformation.
- **Long-range attachments ("tethers").** Kim, Chentanez & Müller 2012. Each free particle may be no
  farther from its anchor than its rest geodesic distance. This is the single biggest quality win for
  capes: without it, a heavy cloth hanging from a moving pin stretches like rubber, because the pin's
  pull cannot travel to the hem in a few iterations.
- **Max-distance and backstop (skinned cloth).** Each simulated vertex may stray at most a painted
  distance from its skinned position, and never behind a backstop sphere. This is how Chaos Cloth and
  Magica keep a skirt from clipping through the legs without exact body collision.
- **Self-collision.** Expensive, and usually skipped for capes and flags. Used selectively for long
  skirts.

### 1.3 Collision

- **Proxies, not meshes.**
  - Capsules and spheres on the skeleton (Chaos, NvCloth, Magica).
  - Occasionally tapered capsules, convex hulls, or a body signed distance field (SDF).
- **Collision is a position projection** to the proxy's surface plus a thickness, followed by a
  tangential velocity damping for friction.
- **Continuous collision** is rarely needed at 60 Hz with substeps. Particles move millimetres per
  substep.
- **World collision** (a cape on a wall) is usually off, or limited to a ground plane, for cost.

### 1.4 Wind and aerodynamics

- The standard model applies drag and lift per triangle from the **relative** velocity between air and
  cloth. Drag is proportional to v_n·|v_n| (the velocity component along the triangle normal) times the
  triangle area.
- A triangle edge-on to the flow catches nothing. That is what makes a flag ripple instead of standing
  rigid.
- Gusts come from a noise field scrolled along the wind direction. Cleo already has one for foliage.

### 1.5 Where the simulation runs

- **CPU.** One solver per cloth, a few hundred particles. Deterministic and easy to debug. Fine for a
  hero cape and a dozen flags.
- **GPU compute.** Many or large cloths.
  - Constraints need graph colouring, or a Jacobi update with averaging, because parallel Gauss–Seidel
    races.
  - Positions are written straight into the vertex buffer the draw reads.
- **Skinned-cloth blending.** On a character, the cloth mesh is part of the skinned mesh. A painted
  weight blends each vertex between its skinned position (weight 0) and its simulated position
  (weight 1).
  - The shadow and velocity passes need the same blended positions.
  - The velocity pass also needs the previous frame's positions for motion vectors.

## 2. What Cleo has to build on

| Need | What exists | Where |
|---|---|---|
| Skinned pose | GPU linear-blend skinning. The animator's final bone matrices are available on the CPU | `chunks/skinnedVertex.wgsl`; `Animator.getFinalBoneMatrices()`; `Renderer._uploadBoneMatrices` |
| CPU skinning | **None.** No CPU path skins a vertex today | Phase 2 needs one for pinned or blended vertices |
| Rewriting a mesh's vertices each frame | `Mesh.updateVertexData` (a fixed-size `writeBuffer`; terrain sculpting uses it) | `src/graphics/mesh.ts` |
| Compute writing a vertex buffer | A `STORAGE \| VERTEX` buffer written by compute and read as instance data | `src/graphics/foliageGpuCulling.ts` |
| Compute on WebGL2 | Ping-pong between RGBA32F render targets (the GPU particles' fallback) | `particleRenderer.ts` `_stepRaster` |
| Body proxies | The ragdoll's per-bone capsules, posed from the live animation without physics bodies | `ragdollLayout` / `ragdollPartPose` in `src/physics/ragdollProfile.ts` |
| World proxies | Analytic colliders packed for the GPU, and `overlap*` queries | `src/particles/particleColliders.ts`; `PhysicsSystem.overlapCapsule` |
| Wind | `WindNode` (direction, strength, gusts), the gust noise, and `ForceFieldNode` | `windNode.ts`; `chunks/foliageWind.wgsl`; `forceFieldNode.ts` |
| Timing | The scene's late pass, after animation and the socket followers | `Scene.update` |

## 3. Phase 1 (shipped): ClothNode, CPU XPBD

**Files**
- `src/physics/cloth/xpbdCloth.ts`: the solver. It is pure: flat arrays and no engine types.
- `src/core/scene/nodes/clothNode.ts`: the node.
- `tests/xpbdCloth.test.ts` and `tests/clothNode.test.ts`.

The solver is mesh-generic (`new XpbdCloth({ positions, pinned, mass, triangles, links? })`, with
`XpbdCloth.grid` for a panel), so phase 2 reuses it unchanged.

**Solver**
- Small-steps XPBD: 10 substeps of one iteration each, at a fixed 60 Hz.
- Constraints: stretch and shear distance constraints, skip-one bending, and tethers to the nearest
  pinned particle.
- Collision: capsule and sphere projection with a thickness, and friction as tangential damping.
- Wind: per-triangle drag on the relative velocity. The gust noise is ported from the foliage shader so
  cloth and grass catch the same gusts.

**Node**
- A `ModelNode` subclass with its own node type, `'cloth'`. It draws, shadows, picks and takes a material
  like any model. Its grid mesh is rebuilt from options and never serialized.
- **Held edge.** It follows the node, or rides a bone of the character it hangs from (`bone: 'chest'`).
  - The pins are captured in the bone's skinning frame when the simulation starts, and carried by
    `ownerWorld × finalBoneMatrix` every frame.
  - This is exactly how a fully weighted vertex is skinned, so it needs no per-rig bone axes.
- **Body collision.** The owner's ragdoll capsules (`effectiveRagdollProfile`), posed each frame.
- **Updates.** The scene steps every cloth after the socket pass (`Scene.update`, `sceneStats.clothMs`).
  It runs only while playing; authoring shows the rest shape.

**Known gaps, in order of how much you'll notice them**
1. **No motion vectors for the cloth's own deformation.** The object-velocity pass sees only the node's
   transform, so a whipping cape smears slightly under TAA and motion blur. The fix is a
   previous-positions vertex stream, which phase 2 needs anyway.
2. **No world collision.** A cape passes through a wall the knight backs into. Projecting against a
   ground plane, and against `overlapCapsule` hits near the owner, is cheap and the next step.
3. **The bending model** is skip-one distance. That is fine for capes and flags, but too soft for stiff
   leather.

**Cost.** A Valley flag is 14 × 9 = 126 particles and about 500 constraints; ten substeps at 60 Hz is a
fraction of a millisecond. The Performance panel shows cloth under **Scene › cloth**.

## 4. Phase 2 (shipped): cloth parts of a skinned mesh

**What it does.** Parts of a character's own mesh — the Valley knight's surcoat skirt, from its one
non-metallic material — swing with the body.

**Files**
- `src/physics/cloth/skinnedClothData.ts`: the data, `AnimatedModel.skinnedCloth`. It lists the vertices,
  a 0..1 weight for each, the `maxDistance` and the material settings, and is serialized with the model.
- `src/physics/cloth/skinnedCloth.ts`: the runtime.
- `src/physics/cloth/bodyColliders.ts`: the body's ragdoll capsules, shared with `ClothNode`.
- `tests/skinnedCloth.test.ts`.

**How it works**
1. **Particles.** The listed vertices are welded by bind position, because a UV seam must not split a
   point. The solver gets the mesh's own triangles among them: edges for stretch, opposite corners across
   shared edges for bend.
2. **Driving.** Each frame, CPU skinning puts every particle where the skin wants it (Σ wᵢ·boneᵢ, with
   the same normalised weights the GPU uses). A max-distance constraint then allows `weight ×
   maxDistance` of slack. Weight ~0 is sewn on (pinned), which replaces tethers.
3. **Drawing, with no new shader.** The GPU still skins every vertex. Each simulated vertex is written
   back as the bind-space position that its own blended bone matrix carries to the simulated one,
   `inverse(Σ wᵢ·boneᵢ) · inverse(nodeWorld) · p`, and likewise for its normal.
   - Only the cloth's vertex range is re-uploaded (`Mesh.updateVertexRange`).
   - Shadows, the depth prepass and selection see the cloth for free.
   - Leaving play re-uploads the bind range.
4. **Updates.** The scene steps skinned cloth with the `ClothNode`s (`ModelNode.stepSkinnedCloth`).

**Keeping it off the armour.** Two things, both computed by the generator (`tools/exampleKit/clothFit.mjs`):
- **A backstop.** Each particle has an outward direction, radial from its dominant joint's bone (else away
  from the nearest fitted capsule), and may sink no farther than one uniform `backstop` (2 cm) behind
  where the skin holds it, along that direction.
  - Per-vertex distances (`backstops`, still read when present) were dropped from the generator:
    neighbours with 3 mm and 30 cm limits were dragged apart, which showed as spikes.
  - Each substep ends with one more pass over the distance links, after the max-distance, backstop and
    collision projections, so the links win last and no edge is left stretched.
  - A welded particle writes back to EVERY vertex at its position, listed or not, so a UV seam never
    cracks open.
- **Armour capsules.** One per hip, spine and leg bone, fitted along the principal axis of that bone's
  share of the other materials. Each is cut down so no cloth vertex RESTS inside it, which would shove it
  out every frame.
  - A single capsule fits a limb's plates and fits a flared fauld badly.
  - The ragdoll capsules stand in only when no fitted ones are given.

**Which pieces, and how free.** Pieces are connected components of the cloth material. Only those carried
mostly by hip, spine and leg bones are candidates; gloves, sleeves and the hood stay skinned.
- A big piece hangs from its top: it is sewn along its top eighth, plus wherever it touches something in
  its upper third. Contact lower down holds nothing.
  - A piece in contact almost everywhere (the loops wrapped over the knight's belt plates) is held by its
    top band alone, or it would never fall.
- A small piece (under 12 cm across: a patch, a stitch) that is mostly within 8 mm of something is lying
  on it, and stays skinned. A small piece with less contact dangles from its nearest approach.
- The weight rises from 0 at the nearest sewn vertex to 1 at the piece's farthest point.
- **Weight.** `mass` (kg) sets how much the wind moves it, and `gravityScale` how hard it falls and
  settles. The knight's cloth is 3 kg at 1.5 gravities: heavy wool.

**Authoring.** The model tab's **Cloth** section paints the weights on the mesh (editor:
`features/models/ClothPaintSection.tsx`, `ClothBrush.tsx`, `ClothWeightOverlay.tsx`; the pure half is
`clothPaint.ts`: paint, erase, smooth, fill a piece or a material, twins always painted together) and
sets the simulation settings, with a Preview that sways the model. `tools/exampleKit/clothFit.mjs` can still
compute a starting point from a mesh. The Valley example no longer ships any cloth (its knight and flags
were removed 2026-10-31); the figures below were measured on them.

**Cost.** The knight's cloth is 1576 vertices (skirt, the hoop round the thighs, the belt loops, knee pieces; fewer particles after welding) at 10 substeps. Measured on
a comparable 840-particle sheet, the solver costs about 1–3 ms a frame, depending on how many body
capsules are in reach. It is fine for the player, not for a crowd: phase 3.

**Gaps**
- Motion vectors still come from the bones alone. A fast swing smears slightly under TAA.
- Tangents keep their bind values. The normal map is a little off on a strongly folded hem.
- Weights cannot come in with an import yet (a vertex-colour channel would be the way).

## 5. Phase 3: GPU solver

**Goal:** many cloths (flags across a city, NPC capes), or one large one.

- **WebGPU**
  - Compute XPBD over storage buffers: positions, previous positions, inverse masses, and constraints
    batched by graph colour so each batch is race-free.
  - One dispatch per colour per substep.
  - Positions are written to a `STORAGE | VERTEX` buffer the draw reads directly, following
    `foliageGpuCulling.ts`.
- **WebGL2**
  - Particles in RGBA32F textures, with ping-pong passes per colour, like the particle fallback.
  - Jacobi with averaging is simpler here than colouring.
- **Collision:** body capsules packed like `packParticleColliders` (16 floats each, up to about 16 per
  cloth).
- **Readback:** none in the normal case. A cloth that gameplay must query reads back asynchronously, a
  frame late.
- **Risk:** the main one is determinism across backends, which matters for replays but not for capes.

## 6. Recommendation

Phases 1 and 2 are in. Next, in order:
1. A previous-positions stream for the cloth vertices, so motion vectors include the simulation.
2. Ground-plane and nearby-world collision.
3. A weight brush for skinned cloth.

Phase 3, the GPU solver, waits until a scene needs dozens of cloths.

## References

- Provot, *Deformation constraints in a mass-spring model to describe rigid cloth behaviour*, 1995.
- Baraff & Witkin, *Large steps in cloth simulation*, SIGGRAPH 1998.
- Müller, Heidelberger, Hennix & Ratcliff, *Position Based Dynamics*, 2007.
- Kim, Chentanez & Müller, *Long Range Attachments — A Method to Simulate Inextensible Clothing in
  Computer Games*, SCA 2012.
- Bouaziz et al., *Projective Dynamics*, SIGGRAPH 2014.
- Macklin, Müller & Chentanez, *XPBD: Position-Based Simulation of Compliant Constrained Dynamics*, MIG 2016.
- Macklin, Storey, Lu, Terdiman, Chentanez, Jeschke & Müller, *Small Steps in Physics Simulation*, SCA 2019.
- Unreal Engine *Chaos Cloth* documentation; NVIDIA *NvCloth*; Magica Soft *Magica Cloth 2*.
