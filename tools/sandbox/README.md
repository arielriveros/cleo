# Sandbox tooling

The example in `applications/editor/public/examples/sandbox` is generated. The bundle there is output; the files
listed below are the source of truth. The example's guide is `docs/editor/sandbox-example.md`.

To build it:

```
node --max-old-space-size=8192 tools/sandbox/prepare.mjs                  # the FBX files, once (and when they change)
npx vite-node --config vitest.config.ts tools/sandbox/build.ts --report   # what was measured, nothing written
npx vite-node --config vitest.config.ts tools/sandbox/build.ts
npx vite-node --config vitest.config.ts tools/sandbox/build.ts --out <folder>   # elsewhere: while a dev server
                                                                            # watches the examples, then copy what changed
npm --prefix applications/editor run examples:list
npx vitest run tests/sandboxProject.test.ts --project engine
```

The files:

- **`car.ts`**: the car, `build/car/dirty_car.glb`, read in metres at `CAR_FIT`'s size (as tight round the seated
  clips as the cabin allows) and mirrored to left-hand drive: its body, its windows, its four wheels cut apart, its
  lamps, and where the Seat, the Enter Point and the Exit Point go (from the car clips' root motion, the driver's back
  against the backrest). `build.ts` makes the Car template of it: its chassis one convex hull of the body and the
  windows, each wheel's mesh right under its Wheel node, and its head, tail and reverse lights.
- **`build.ts`** also lays out the world round the course: the Environment (sun, sky, sky light, sunset clouds), the
  open Ocean, a one-layer GI Volume over the floor, a Light Probe over everything, the Game Manager
  (`examples/scripts/SandboxGameManager.ts`: the light setups on 1, 2, 3) and its HUD, and the render settings'
  exposure (`EXPOSURE`: a low floor and one compensation curve for the day, the dusk and the night).
- **`prepare.mjs`** (plain Node, assimp). It reads `build/LocomotionPack/Mannequin.fbx` and builds a skin in metres,
  with a weightless **Pivot** joint above the hips, a welded mesh and its maps at half size. It retargets every
  other `.fbx` onto that skin, keeping each clip's travel, and three holds of Mixamo's Pro Rifle Pack
  (`build/fps_prepared/pack`, as `tools/fps` unpacked `build/Pro Rifle Pack.zip`: `idle`, `idle aiming` and
  `sprint forward`, written as `Rifle <name>`). It writes `build/sandbox_prepared/` (gitignored), and converts only
  what changed.
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
  - The stair clips are checked first (`stairCheck`: their feet step up or down at least 10 cm each step, and the
    last frame matches the first); one that fails is left out with a warning, and its direction plays the walk
    blend. A descent role marked `repair` that fails has its legs rebuilt first (**`descent.ts`**): the trunk looped,
    the feet stepping down two risers a cycle on the clip's own timing, the legs solved by two-bone IK. The pack's
    two descents need it. Every stair clip then has its knees turned toward straight ahead about the hip-ankle
    line (**`legs.ts`** `alignKnees`, `STAIR_KNEE_IN`; the feet stay where they are), and `--report` prints each
    one's knee spacing before and after. A passing one loses its rise from the hips, evenly, and is set so its planted feet stand at sole height
    on average. Its foot-lock windows are found on the source, rise kept, against each stance's own height
    (`ground: 'stance'`). The walk gets a creep copy at `STAIR_CREEP` of its pace.
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
  states (Turning, Stopping, Running Turn, Air, Landing, Car): the transitions a group's states share are written
  once, from the group. Its forks (`FORKS`: Take Off, Pick Turn, Pick Stop, Settle, Pick Run Turn) write a choice
  several states share once, as the fork's ways out, each the entry of its group but Settle. `--inputs <checkout>`
  reads `build/` from another checkout, for a second worktree. `lookField` is the Look layer's blend space. `stairsField` is the flights' (2D: Climb, up
  +1 and down -1, by speed), each sample at `STAIR_RATE` and one tread a step (`stairPaces`, which also gives the
  script its stair speeds). Its Stairs state is in the **Gait** sync group with Locomotion, so they hand over in
  step.
- **`weapons/`**: the pistol and the rifle.
  - **`models.ts`** reads `build/low-poly_g40.glb` and `build/low-poly_m4a1.glb` (TastyTony, CC-BY-4.0) at their
    rest pose into weapon space: the grip at the origin (`gripBox`, `fistY`: read off a side render of each), the bore
    along +Z, scaled to the real length; and the points the hands and the eye use (support, muzzle, butt, sights).
  - **`poses.ts`** holds them: the right hand's grip off the rifle pack's aim (one socket per weapon on the right
    hand), the stances (`stanceSpecs`: carry, aim, sprint), each solved by two-bone IK onto the placed weapon, and
    the aim poses (`aimPose`: the aim stance turned, the chest taking part, the arms the rest).
  - **`fx.ts`**: the shots' effects as data: the muzzle flash's and the impact's particle systems (the Firing Line's
    emitters), the bullet hole's texture (`bulletHolePng`) and the tracer's streak; `build.ts` makes them the
    `/Weapons/Effects` templates, each with its script, and puts SandboxGun (`examples/scripts/SandboxGun.ts`) on each
    weapon's grip holder with its handling (`GUN_VARS`).
  - **`layers.ts`** (`weaponPoses`) turns the stances into POSES: per weapon Carry, Aim and Sprint (the bones they
    hold and the standing reference's Hips, as deltas from rest), and the 5 x 5 aim directions as variants of Aim
    (what each changes from it). `build.ts` writes them as the **Pistol Poses** and **Rifle Poses** assets, which the
    editor's pose mode edits; `machine.ts` holds them: `poseField` (the Carry and Sprint poses over the walk's axes),
    `aimField` (the aim's directions), the layers at `WEAPON_STEADY` and with hand IK. `--report` prints each
    stance's hands, butt and wrists, and how near each aim direction's bore is to its aim.
- **`level.ts`**: the course, and its props (`props()`, `PROP_KINDS`: loose rigid bodies, each resting where it is put; `build.ts` makes every repeated one a template with `templatizeScene`). `build.ts` folds the course's colliders into Static Collision colliders with the engine's
  merge pass, one per collision layer: the course, and inside it the feet's detail (Foot Detail: the stairs' steps and
  the bumps), the ramps the capsule climbs over the stairs (Stair Ramp) and the pillars (See Through, which the
  camera sees through). The layers are named in `libraries/projectSettings.json`. `build.ts` also sets the sprint speed (`TUNING.sprint`), switches on foot locking for the rig with
  its blending, and makes three templates with one instance each (`templatizeSubtree`): **Player**, **Environment**
  (the sun, sky atmosphere and sky light under one root) and **Course** (the merged Static Collision, templatized
  after the merge, which leaves a template instance alone).
- **`inputMap.ts`**: the default input map (without Fire), plus Walk, Interact, Drive (the car's Controller reads it:
  the triggers are the pedals) and the light setups; the pad's Jump on X, Sprint on A, its look at `PAD_LOOK_RATE`
  times the default's.
- **`environment.json`**: the sky, sun, sky light and render settings the scene starts with.

After changing any `examples/scripts/Sandbox*.ts`, run the build again: the scene and the templates embed the
scripts' source (the Sandbox suite checks they match).

The scripts talk through events (docs/scripting/events.md):
- SandboxGun dispatches `weapon:Shot` at its grip, and SandboxPlayer's `@eventListener` takes the recoil from it.
- SandboxPlayer's `@observable` `weapon` sends `weapon:Equipped`, which shows the weapon in the hand.
- SandboxGameManager's `@observable` `setup` sends `sandbox:LightSetup`, which the HUD line answers.
- SandboxPlayer fires its car triggers through `@animTrigger` methods (sent down to the Mannequin's animator), and
  stands up when the animator says `animation:TriggerEnded` for the exit trigger.
