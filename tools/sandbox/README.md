# Sandbox tooling

The example in `applications/editor/public/examples/sandbox` is generated. The bundle there is output; the files
listed below are the source of truth. The example's guide is `docs/editor/sandbox-example.md`.

To build it:

```
node --max-old-space-size=8192 tools/sandbox/prepare.mjs                  # the FBX files, once (and when they change)
npx vite-node --config vitest.config.ts tools/sandbox/build.ts --report   # what was measured, nothing written
npx vite-node --config vitest.config.ts tools/sandbox/build.ts
npm --prefix applications/editor run examples:list
npx vitest run tests/sandboxProject.test.ts --project engine
```

The files:

- **`prepare.mjs`** (plain Node, assimp). It reads `build/LocomotionPack/Mannequin.fbx` and builds a skin in metres,
  with a weightless **Pivot** joint above the hips, a welded mesh and its maps at half size. It retargets every
  other `.fbx` onto that skin, keeping each clip's travel. It writes `build/sandbox_prepared/` (gitignored), and
  converts only what changed.
- **`clips.ts`**: which file plays what (`ROLES`), and how each kind of clip is conditioned.
  - Locomotion cycles lose only their AVERAGE travel. Pinning the hips instead turns the in-stride surge into foot
    slide.
  - The turns, the running turn and the stop have their yaw moved onto the Pivot, as root motion. The stop also gets
    a mirror, so it can plant either foot.
  - The start loses the travel the body makes as it accelerates into the sprint.
  - The hard landing's travel moves onto the Pivot, as root motion (`travelToPivot`): its state holds the
    Character still, so the clip alone moves it.
  - The landing roll is held in place from touchdown (the body's speed carries it), with its hand-over to the run
    measured where it gets up (`rollHandOver`) and its rate fitted to a jog.
  - Jump clips are cut at take-off and touchdown, with their ballistic rise taken out.
  - Nothing takes the yaw out of the hips. The engine's `bakeInPlace` does, and it tilts clips that twist while they
    bend.

  It also makes the nine look poses (`lookClip`, `LOOK_SAMPLES`, the `LOOK_BONES` mask) and the three lean clips (sideways, and forward: `LEAN_FORWARD_DEGREES`, `LEAN_FORWARD_HIPS_DEGREES` of
  it a whole-body tilt), and the `LEAN_BONES` mask that goes with them. Last, it gives every clip a locking state
  plays its foot-lock windows (`detectFootLockWindows`, heel lift `FOOT_LOCK_HEEL_LIFT`), on the clip as it will
  play; the backward diagonals keep `BACK_DIAGONAL_LOCK` of each (`shrinkFootLockSpans`). The `--report` prints them
  as shares of each clip.
- **`measure.ts`**, reading the posed skeleton:
  - speed and direction;
  - foot-strike phase, and every foot plant in a one-shot (`plants`);
  - airborne spans and landing impact times;
  - turn angle and the start's acceleration;
  - the sideways lean in the body's own frame (the build's no-tilt check).
- **`machine.ts`**: the blend space and the state machine, as data, built from the measurements. Its
  `machineTimings` decides:
  - the blend space's phase-0 foot;
  - where each clip hands over (on a plant of that foot);
  - which stop plays in which half of the stride;
  - each stop's settle and each landing's impact.

  It also sets the start's entry gate and how far into the start clip the Start state begins, and groups the
  states (Turning, Stopping, Running Turn, Air, Landing): the transitions a group's states share are written once,
  from the group. `lookField` is the Look layer's blend space.
- **`level.ts`**: the course, and its props (`props()`, `PROP_KINDS`: loose rigid bodies, each resting where it is put; `build.ts` makes every repeated one a template with `templatizeScene`). `build.ts` folds the course's colliders into one Static Collision with the engine's
  merge pass. `build.ts` also sets the sprint speed (`TUNING.sprint`), switches on foot locking for the rig with
  its blending, and makes three templates with one instance each (`templatizeSubtree`): **Player**, **Environment**
  (the sun, sky atmosphere and sky light under one root) and **Course** (the merged Static Collision, templatized
  after the merge, which leaves a template instance alone).
- **`inputMap.ts`**: the default input map, plus Walk.
- **`environment.json`**: the sky, sun, sky light and render settings the scene starts with.

After changing `examples/scripts/SandboxPlayer.ts` or `SandboxCamera.ts`, run the build again: the scene embeds the
scripts' source.
