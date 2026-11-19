# Sandbox (the locomotion example)

The Sandbox is a gray-box course with a Mixamo mannequin that moves the way Unreal's Advanced Locomotion System v4
does. It can:

- walk and jog in eight directions, facing the camera;
- sprint in any direction, facing where it runs;
- set off into a sprint, stop, and turn round, each with a clip of its own;
- lean its whole body into curves, and forward into a start;
- turn in place when you look away;
- look round at the camera standing still, its head first and its body after a second;
- jump, fall, and land soft or hard, a hard landing crouching where it came down, or rolling if it is still running;
- climb a flight of stairs at a stair pace, one step a tread, with stair clips that hand over in step with the walk;
- stand on a stair ramp or a slope without sliding down it.

Everything that is the character is one **Player** template, placed once; the sky is the **Environment** template
and the course the **Course** template.

Its feet stay planted and locked on ramps, stairs and bumps. To try it, open **Sandbox** from the example gallery
and press Play.

It uses only what the engine has:

- a **Character** and a **Controller**;
- one **Camera Rig**, with a script that frames it over the shoulder, and in third person while sprinting;
- three blend spaces (locomotion, the look-at, and the stairs, up and down) and one animator, its states in
  groups;
- foot placement and foot locking on the skeleton;
- one script on the Character, which handles input and writes the values the animator reads.

The character is one template, **Player** (`/Characters/Mannequin/Player.tpl`): the Collider, the Character and
its script, the Camera Rig and its script, the Mannequin and the Controller. The level is two more:
**Environment** (`/Level/Environment.tpl`: the sun, the sky atmosphere and the sky light) and **Course**
(`/Level/Course.tpl`: the merged Static Collision collider with every piece of the course, placed under that name,
and inside it the parts merged apart for their [collision layers](#collision-layers-stairs-bumps-and-pillars): the
feet's detail, the stairs' ramps and the pillars).
Each is placed once.

`tools/sandbox/` generates it from the clips in `build/LocomotionPack` (see `tools/sandbox/README.md`).

## Playing

| Action | Keyboard and mouse | Gamepad |
|---|---|---|
| Move (jog) | W A S D or the arrows | left stick, pushed all the way |
| Walk | hold Left Ctrl | left stick, pushed partway (or hold LB) |
| Sprint (any direction, facing it) | hold Left Shift | L3 |
| Jump | Space | A |
| Look | the mouse (click the view to capture it) | right stick |
| Zoom | the wheel | |

**The course.** You start facing +Z.

- **Ahead and to the right**:
  - two flights of stairs, with 15 cm and 20 cm risers;
  - four ramps at 10, 20, 30 and 40 degrees.

  Each one leads up to a 1.5 m platform you can drop off the far side of.
- **Ahead and to the left**:
  - a strip of tilted slabs to walk over: the feet climb onto them while the body keeps to the ground;
  - five platforms at 0.3, 0.6, 1.0, 2.0 and 3.5 m. Jump onto the low ones; the tall ones have a ramp behind them.

  A drop of about 2.6 m or more lands hard.
- **Behind**: a ramp up onto a 1 m block, a 2 m gap, and a second block, for a running jump.
- **Beside the start**: three pillars and a wall, for the camera. It sees through the pillars and pulls in for the
  wall.

### Collision layers: stairs, bumps and pillars

A capsule has no step-up, so a character climbs a flight of stairs on a ramp. Foot placement wants the real steps
under the feet, though, or each foot lands halfway up a tread. The Sandbox keeps the two apart with
[collision layers](physics.md#layers), named in its **Layers** (Options ▸ Project):

| Layer | On it | Collides with |
|---|---|---|
| 3 **See Through** | The three pillars | Every layer |
| 4 **No Camera** | The small props: small crates, barrels, balls and planks | Every layer |
| 5 **Character** | The player's capsule | Every layer but Foot Detail |
| 6 **Foot Detail** | A box per stair step, from the ground to its tread, with the stairs' mesh inside; and the bumps | Every layer |
| 7 **Stair Ramp** | A slab over each flight, from the ground half a tread before it to the landing's front edge | Character only |

What each layer is for:

- **The capsule** glides up the stairs' ramp, and walks on through the bumps at ground level. It does not collide
  with Foot Detail. Its ground probe reads the ramp too, so the climb follows the ramp's slope. It stands on the
  ramp without sliding down it: the Character's **Slope Limit** (45 degrees) holds it on ground up to that steep.
- **The script** knows a flight by its ramp: a ray down onto Stair Ramp alone (`stairsLayer`).
- **The feet** trace every layer but Stair Ramp (the skeleton's **Trace layers**, under Foot Placement). They land
  on the treads and climb onto the bumps, up to about 27 cm, and the knees bend for both.
- **Props** fall on the steps and the bumps. The ramp collides with the Character layer alone.
- **The camera rig** is **Blocked by** every layer but See Through, No Camera and Stair Ramp, and **Sees through**
  See Through:
  - it stops at the steps and the wall, never at the ramp;
  - the boom passes the pillars, and their meshes are dithered away where they stand between the camera and the
    player;
  - the boom passes the small props on No Camera, which are not cut.

## How it moves

| What you see | What does it |
|---|---|
| Walking and jogging relative to the camera, the body facing it, side-stepping and backpedalling | The Character (facing **Aim**, ALS's looking direction), driven by the Player Controller |
| Changing direction without coasting on, at full speed | The Character's **Turn Friction** (8, Unreal's ground friction) |
| Eight directions at a walk and a jog, the legs matching the speed and the way the body really goes | The **Locomotion** blend space: Direction (`moveDir`, read from the body's travel) x Speed (the body's speed) |
| Sprinting in any direction at 6.5 m/s, the body turned to where it runs | The script sets facing to **Velocity** while sprinting (ALS's velocity direction); the blend space has only a forward sprint |
| Setting off into a sprint | The **Start** state, the start clip sped up to the Character's acceleration |
| Stopping from a run, off whichever foot is swinging | The **Stop** and **StopMirror** states, picked by the run's phase |
| Reversing a sprint | The **RunTurnL/R** states: the running-turn clip's root motion turns the body |
| Leaning the whole body into a change of direction at a jog or a sprint, and forward into a start | Three additive **lean** layers |
| Turning in place when the camera swings more than 70 degrees away | The Character's turn request, and the turn clips' **root motion** |
| Jump, fall, soft and hard landings | The animator, from `isJumping`, `isGrounded`, `airTime` and `verticalSpeed` |
| Crouching through a hard landing where it came down, whatever the stick says | The hard landing's **root motion**, and its state's **hold** switch |
| Rolling out of a far fall while running, and running on | The **LandRoll** state, entered from the fall by the graph alone (`Running` and `Speed`) |
| Looking round at the camera standing still, before turning to it | The additive **Look** layer (a blend space of look poses), and the Character's turn delay |
| Feet on slopes, steps and bumps, held on the spot while the body turns over them | **Foot placement** (its **Trace layers**) and **foot locking** on the Mannequin skeleton |
| Slowing to a stair pace before the first riser, and climbing one step a tread, facing up the flight | The script's stair speeds and look-ahead, and facing **Velocity** on a flight |
| Climbing and descending stairs with stair clips, in step with the walk it came from | The **Stairs** state (the **Stairs** blend space, up and down), in the same **sync group** as Locomotion |
| Standing on a stair ramp or a slope without sliding down it | The Character's **Slope Limit** |

### The blend space

The rings of the blend space are the gaits:

- **Creep**: the walk clips at half speed, for a barely pushed stick;
- **Walk**;
- **Brisk**: the side walks, at the back diagonal's speed;
- **Jog**;
- **Sprint**: the sprint clip, played 1.26 times faster to cover 6.5 m/s.

Every sample sits at the speed the character travels when it plays. Each one plays at the rate that makes its feet
cover that ground, so the feet do not slide where a sample sits.

Every sample is phase-shifted so its right foot plants at phase 0. Every clip state enters the blend space at
phase 0, so the start, the running turn and the running landing each hand over on a right-foot plant of their own.
The legs carry straight on instead of swapping under the blend. (The right foot is the one the start's last stride
plants.)

- **Direction axis.** The Character's `moveDir` comes from where the body really travels (**Direction From:
  Velocity**), not from the stick. After a change of direction the velocity takes a moment to come round, and a
  blend that read the stick would already play the new direction while the body still went the old way, sliding
  the feet sideways. The direction is barely smoothed for the same reason (0.05 s, the axis 0.03 s, the weights
  0.04 s): every lag between the travel and the legs is foot slide.
- **Speed axis.** The blend space reads the body's speed from the physics (`GroundSpeed`), with almost no smoothing.
  The measured `planarSpeed` lags a body that is speeding up by about a metre a second, which slid the feet forward
  out of the start.
- **Going backwards.** Backwards is slower than forwards, because the backward clips cover less ground. So the
  script eases speed down when the input points back:
  - straight back, to `backScale`;
  - at 45 degrees off straight back, to `backDiagonalScale` (`walkBackDiagonalScale` when walking).
- **Back diagonals.** They have a clip of their own: the jog's, and its mirror. A strafe blended with a backpedal
  crosses the legs and slides the feet at nearly the travel speed; a real diagonal clip does not.
- **Forward diagonals.** These are blends of forward and the side, as most locomotion sets do.
- **Sprint ring.** It has the forward sprint only. A sprint always faces where it goes, so it never strafes.

### The animator

**Mannequin Locomotion** is a shared animator on the Mannequin skeleton. Its base layer has twenty-one states,
fifteen of them in five **groups**, so the graph shows Idle, Locomotion, Start and Stairs and five group nodes:

| Group | States | Its own transitions (from any of its states) |
|---|---|---|
| **Turning** | Turn90L/R, Turn180L/R | into the jump, into the fall, and off into Locomotion when the stick moves |
| **Stopping** | Stop, StopMirror | into the fall |
| **Running Turn** | RunTurnL/R | into the fall, to Idle when let go, back into Locomotion when the script lets go of `RunTurn` |
| **Air** | JumpStand, JumpRun, Fall, FallFar | |
| **Landing** | JumpLand, LandRun, LandSoft, LandHard, LandRoll | back into the fall |

Each state keeps the transitions only it has (a turn's way back to Idle as it ends, a stop's settle). Double-click a
group in the graph to see its states.

The states:

- **Idle** and **Locomotion** (the blend space).
- **Start**: entered from Idle when a sprint sets off within 45 degrees of where the body faces (`Sprinting`,
  `MoveAngle`, and `Speed` above 0.12 m/s, so pushing against a wall does not start it).
  - The clip's push-off fits an acceleration of about 5 m/s², and the body takes off at that rate (the script's
    `sprintTakeoff`), so the 0.8 s clip plays at its own speed. It starts as far in as the body has already got by
    the time the measured speed lets the state in.
  - Its travel is taken out as the body really covers it, so its feet hold the ground.
  - It hands over to Locomotion on its last right-foot plant, easing into the run over 0.3 s.
  - A walk, a jog, or a sprint set off backwards goes straight to Locomotion.
- **Stop** and **StopMirror**: from a run, when you let go.
  - They play the run-to-stop clip and its mirror, so the stop plants whichever foot is swinging. In the blend
    space's first half the left foot swings and **Stop** plays; in its second half **StopMirror** plays.
  - A sprint brakes through the blend space down to a jog first, so the clip is not slid on at sprint speed.
  - Each stop plants and settles, then cross-fades into Idle. If the camera is already round, it cross-fades
    straight into a turn in place instead.
  - The clip plants its feet sideways (46 degrees). That turn is root motion, so the capsule turns with it and the
    feet do not twist on the ground.
- **RunTurnL** and **RunTurnR**: entered while the script holds `RunTurn` at -1 or +1. They play the running-turn
  clip (and its mirror), which turns the body 180 degrees by root motion.
- **Turn90L/R** and **Turn180L/R**: entered on the Character's `turnRequest` (`Turn` equals 1, 2, -1 or -2), from
  Idle or out of a stop. They play to the end of their turn. Their root motion is on the **Pivot** joint above the
  hips, so the capsule turns and nothing else moves. From Idle they wait 0.4 s, so a blend into Idle is never cut.
- **JumpStand** and **JumpRun**: the jump clips from their take-off frame, timed to the physics arc, with no foot
  placement.
  - They land when `Jumping` goes false, never on `Grounded`, which still reads true just after take-off.
  - A jump that outlasts its clip (off a ledge) blends into the fall from the clip's last frames.
- **Fall** and **FallFar**: a fall becomes far once it falls faster than 6.2 m/s, decided in the air. Into the fall,
  every blend takes 0.35 to 0.4 s.
- **The landings**: every fall ends in a landing clip.
  - **LandHard** after a far fall;
  - **LandRun** when landing moving;
  - **LandSoft** otherwise;
  - **JumpLand** after a standing jump.

  Each plays through its impact (measured: the hips' lowest point, plus 0.1 s) before a move can take over.

  **LandRoll** takes over from a far fall when the player is still running (`Running`, and `Speed` above 1.5 m/s);
  standing, it lands hard. It plays *Falling To Roll* from touchdown, held in place so the body's own speed carries
  it through the roll, at the rate that makes the ground it rolls over a jog's (clamped to 1.6). It hands back to
  Locomotion as it gets up (the hips 60% of the way back up), or plays out into Idle if the stick is let go.

  **LandHard** crouches and stands up where it came down. Its travel is root motion, on the Pivot, and its state
  has **hold** on: the Character stops while it plays, whatever the stick says, and the clip alone moves it. It
  leaves for Locomotion once the stick is pushed and at least 0.6 s have passed.
- **Stairs**: up and down a flight; see [Stairs](#stairs).

**Look.** A fourth additive layer, **Look**, plays a 2D blend space of nine look poses: the trunk and head turned
up to 90 degrees either way and 45 up or down, spread up Spine, Spine1, Spine2, Neck and Head (the **Look** bone
mask) so the head looks the whole way. Its axes are `LookYaw` and `LookPitch` (where the camera faces, off the
body) and its weight is `LookWeight`, which the script raises while the character stands still.

**Lean.** Three **additive** layers, **Lean Left**, **Lean Right** and **Lean Forward**, play a lean clip at the weight
of `LeanLeft` / `LeanRight` / `LeanForward`. The generator makes the sideways clips as a runner banks: the whole body
tilts about the ground under the feet.

- The hips roll 10 degrees.
- The hips move over and down by what that roll swings the ankles out by, so the feet stay where they are.
- The feet roll back, so the soles stay flat.
- The spine leans a little further into the turn, and the neck and head come back a little toward level.

The forward clip puts weight into the step as the body sets off: 8 degrees forward, 4 of them a whole-body tilt about
the ankles (as above) and 4 in the spine, the head a little back. Half is in the spine because a start's feet are not
under its hips: a whole-body tilt about where the ankles stand at rest moves the planted foot as the lean comes in,
and 8 degrees of it doubled a sprint start's foot slide.

The layers play through the **Lean** bone mask: Hips, both legs, Spine, Spine1, Spine2, Neck and Head.

**Parameters.** Every parameter is **Linked**:

- the Character's `moveDir`, `turnRequest` and `isJumping`;
- the built-ins `planarSpeed`, `isGrounded`, `airTime`, `verticalSpeed` and `isDecelerating`;
- the script's fields `hasMoveInput`, `groundSpeed`, `running`, `sprinting`, `moveAngle`, `runTurn`, `leanLeft`,
  `leanRight`, `leanForward`, `lookYaw`, `lookPitch`, `lookWeight`, `footPlacement`, `onStairs`, `stairs` and
  `stairRate`.

Nothing sets a parameter from code, and no script names a clip or a state.

### Stairs

The pack's four stair clips (*Ascending Stairs*, *Running Ascending Stairs*, *Descending Stairs*, *Running
Descending Stairs*) are steep, slow stairs: about 23 cm a step, one step every 0.2 to 0.7 s. The generator reads
each with its rise kept and checks it first: its feet must step up (or down) at least 10 cm each step, and its last
frame must match its first. A clip that fails is left out with a warning, and its direction plays the walk blend
on the flight instead.

**The descents are rebuilt.** The two descending clips fail the check. In both files the feet stay at floor height
while the hips sink 48 cm and the knees fold, and the last frame does not match the first. The generator keeps what
they get right and rebuilds the legs (`tools/sandbox/descent.ts`):

- **Kept:** the hips stepping down, and the trunk, arms and head of a body going down stairs. Each of these is made
  to loop, its drift from first frame to last spread over the clip.
- **The steps:** the clip's own timing. The left foot lands where the clip's does, the right half a cycle later.
  Each foot stays planted for at most 62% of the cycle.
- **The feet:** each steps down two risers a cycle, one riser apart from the other. Planted, a foot stands still on
  its tread. Swinging, it lifts off at once, goes forward over the nose of the tread it leaves, and comes down two
  treads lower, toe first.
- **The legs:** two-bone IK sets the thighs and shins to reach those ankles, knees forward.

The rebuilt clips then pass the check, and go through the same steps as the climbs. Better descending clips that
pass the check on their own are used as they are: drop them into `build/LocomotionPack` under the same names and
rebuild (`tools/sandbox/README.md`).

How a stair clip is used:

- **In place.** Its rise comes out of the hips evenly, so the capsule climbs the ramp at an even pace and the hips
  keep their bob from step to step. The pose is set so the planted feet stand at sole height on average.
- **Its foot-lock windows** are found against each stance's own height, since the upper foot stands a riser above
  the lower one. Its state has **windows** on (`plantInWindows`): foot placement keeps a foot inside its window
  planted at any height. Without it, the upper foot would read as swinging and float over its tread.
- **The knees.** The pack's walking climb splays its knees: 23 cm apart on average, over hips 16 cm apart (the flat
  walk holds them 18). Each stair clip has its legs turned about the hip-ankle line, three quarters of the way to
  straight ahead (`alignKnees` in `tools/sandbox/legs.ts`, `STAIR_KNEE_IN`), the feet left where they were. Foot
  IK then bends the knees along that bend. Walking up a flight they come out 19 cm apart, 18 on the flat.
- **The pace.** Each clip plays 1.25 times faster than authored (`STAIR_RATE`), one step a 30 cm tread. That sets
  the pace: walking up 0.55 m/s, jogging up 1.25, walking down 0.8, jogging down 1.88. The script's four stair speeds
  (public) carry these numbers.
- **One blend space, Stairs.** It is 2D: Climb (the script's `Stairs`, +1 up and -1 down) by `GroundSpeed`. Up and
  down each have a creep (the walk at 0.6 of its pace), a walk and a run. Climb is smoothed over 0.15 s, so turning
  round on a flight blends the climb into the descent inside the blend space. Each sample is phase-shifted so its
  right foot plants at phase 0, as in Locomotion.
- **Sync group.** Locomotion and Stairs are in one sync group, **Gait**. A hand-over between them starts the state
  entered where the one left was in its stride, and the two cycle as one through the cross-fade: the foot that was
  planted stays planted.
- **`StairRate`.** While the body is still faster than the run's pace, the stair clips play faster by as much, so
  the steps keep up with it.

The transitions:

- **Locomotion to Stairs** when `Stairs` is not 0, and back when it is.
- **Idle, a turn or Start to Stairs** when it sets off up or down a flight.
- **Stairs to Idle** when it stops on the flight.
- **No start and no stop on a flight**: Idle to Start and Locomotion to Stop both wait for `OnStairs` to go false.

### The Character: turning without ice

Two Character settings keep a change of direction from reading as a slide on ice:

- **Turn Friction** 8 (`turnFriction`). The velocity turns toward the new direction and keeps its speed, a quarter
  turn mostly done in a quarter of a second. With the acceleration alone the velocity moves in a straight line to
  the new one: it takes half a second at a jog, the speed dips to 70% halfway, and meanwhile the body coasts on its
  old heading. A reversal is not turned but braked through, which the running turn and the stop expect.
- **Direction From: Velocity** (`moveDirSource`): see the blend space's Direction axis above.

### Foot placement and foot locking

The Mannequin's skeleton has foot placement: a ray per foot (on every layer but the stairs' ramps, see
[Collision layers](#collision-layers-stairs-bumps-and-pillars)), the pelvis lowered when a foot must reach down, and the foot rolled onto the slope. It also has **foot locking** (`footLock` 1). Foot locking holds the planted feet while
the camera turns the character as it moves, and through a quick change of direction.

- **When a foot plants: the clip's windows.** Every clip a locking state plays carries foot-lock windows, set by
  the generator with **Detect**. Each foot locks from the ball of the foot coming down until the heel has lifted
  3 cm, and then follows the clip through the push-off. The backward diagonals (JogBL/BR and their walk and creep
  copies) keep only the middle half of each window: their crossing steps fought a longer lock. Open a clip in the Clip Player to see them as **Lock L** /
  **Lock R** rows, and drag their ends to tune a clip
  ([Foot-lock windows](animation.md#foot-lock-windows)).
- **What is held.** The ball of the foot, on its spot. The foot keeps the heading it was planted with, up to 40
  degrees.
- **Blending.** A lock comes in over 0.08 s and goes out over 0.2 s, on the smooth curve (the skeleton's **Foot
  Placement** tab, **Blending**): a foot that plants mid-slide slows to a stop rather than stopping dead.
- **When it lets go.** Once its window ends, or once the body has left it more than 0.5 m behind.
- **Only while moving.** Idle and the four turns in place have their state's **lock** off, and their clips have no
  windows: a character standing still is not pinned, and a foot held as a run stops fades back to the animation.

Measured foot slide:

| Case | Foot slide | Without the lock / with the old controller |
|---|---|---|
| Walk, camera panning 75 degrees a second | 0.05 m/s | 0.15 m/s (no lock) |
| Jog, camera panning 75 degrees a second | 0.19 m/s | 0.28 m/s (no lock) |
| Jog, camera whipping 200 degrees a second | 0.38 m/s | 0.58 m/s (old controller) |
| Jog, forward to left | 0.06 m/s; speed kept at 90% or more; legs within 6 degrees of the travel on average | 0.76 m/s; speed dips to 71%; legs off by 22 degrees (old controller) |

And what the lock does to a leg in one frame, at most (the knee or the ankle, locked less unlocked): 3 cm jogging
left or right (it was 35: the knee pole flipped as a strafing knee swung out past sideways), 1.4 cm walking, 3.8 cm
setting off forward. Setting off, a foot the cross-fade out of Idle slides faster than 0.6 m/s is not caught
(**Catch below**), and a lock letting go never pulls the leg straight.

With the camera turning, most of what still slides is the push-off: past heel-off the foot follows the clip, and the
clip does not turn with the body. A window drawn longer, toward toe-off, holds it there too, at the cost of the
foot sticking to the floor.

### The script

`SandboxPlayer.ts` sits on the Character. Each frame, before the Character acts, it adjusts what the Controller asked
for:

- **The gait.** Walk scales speed down to the walk. A stick walks below `walkDeflection` and jogs above it. Sprint
  works in any direction with the stick all the way, and sets `sprinting`.
- **The rotation mode.**
  - At a walk and a jog, facing is **Aim**.
  - At a sprint, facing is **Velocity**.
  - After a sprint stops, facing is **None** until the camera swings more than `lookAroundAngle` (20 degrees). The
    body stays as it stopped rather than turning to the camera by itself.
- **The running turn.** When a sprint faster than `runTurnSpeed` is asked to go more than `runTurnAngle`
  (135 degrees) back, the script holds `runTurn`, with facing **None**, so the clip turns the body. It lets go once
  the body is within 30 degrees of the new way.
- **The lean.** The sideways acceleration in the body's frame, divided by `leanAcceleration` (4 m/s²). It fades in
  from a walk to a run and follows at `leanSpeed`, ALS's 4 per second.
- **The look-at.** `lookYaw` is the aim's yaw off the body (clamped to 90 degrees), `lookPitch` its pitch off
  `lookPitchRest` (the rig's resting 12 degrees, so the camera as it sits is a level look; clamped to 45), and
  `lookWeight` eases to 1 standing still and to 0 moving, at `lookSpeed`. The Look layer holds its blend space at
  speed 0, sampled half way into its poses: looping, it wrapped back to their first frame (rest) every 2 s and the
  head twitched toward centre.
- **The turn delay.** `turnDelay` (1 s, public: a character's own reaction time) is written to the Character's
  **Settle** each frame, and `farTurnShare` of it to **Settle past 135**: the camera must stay round that long before
  the body turns in place, so the head is seen to look first.
- **The sprint take-off.** Speeding up into a sprint from a standstill, or along the way it already goes, the
  Character accelerates at `sprintTakeoff` (5 m/s², the start clip's own) instead of its Acceleration (11.3).
  Braking, a reversal, a jog and a walk keep the Acceleration.
- **The forward lean.** The acceleration along the way the body faces, divided by `leanForwardAcceleration`
  (8 m/s²), forward only and on the ground only, followed at `leanForwardSpeed` (8 per second): full into a sprint
  start, about 0.6 into a jog start, gone once the speed is reached.
- **Backward speeds.** The speed shares described under the blend space.
- **`hasMoveInput`.** The Stop needs to know that the player let go, not merely that the body is slowing down.
- **`groundSpeed`.** The body's unsmoothed speed, for the blend space.
- **`footPlacement`.** The foot IK weight in Locomotion: full at a walk, 0.3 at a run. At a run the solver would
  otherwise pull the lower foot to the ground in the flight phase between strides. Locking is not weighted by it.
- **The stairs.**
  - **On a flight.** `onStairs` is a ray down onto the `stairsLayer` (Stair Ramp) under the body. It holds 0.15 s
    past the last hit, so the ramp's toe meeting the ground does not flicker it.
  - **Which way.** `stairs` is the climb under the travel (rise over run, from the ramp's normal): +1 up past 0.25,
    -1 down, 0 once under 0.15. Standing still on the flight it keeps the way it went.
  - **The pace.** On a flight, or with one ahead, the Character slows to the flight's pace: `stairUpWalkSpeed`,
    `stairUpRunSpeed`, `stairDownWalkSpeed` or `stairDownRunSpeed`, by the gait. It looks ahead only as far as
    braking to its own gait's pace takes, and brakes `stairBrake` (1.5) times harder than its Acceleration, so the
    slowing starts late and still reaches the pace by the first riser: about 0.5 m short of it from a jog, 1.2 m
    from a sprint. It never brakes at the sprint take-off.
  - **Facing.** Moving on a flight, facing is **Velocity**: the stair clips go forward only. Standing on one, facing
    is **None**: no turning in place on the steps.
  - **`stairRate`.** The stair clips' playback while the body is still faster than their pace.

**Public and private.** The attributes each character may want its own of are `public`: the backward speed
shares, `runTurnSpeed`, `turnDelay`, `sprintTakeoff`, where foot placement eases off (`walkFootSpeed`, `runFootSpeed`,
`runFootWeight`), the four stair speeds and `stairsLayer`.
Every copy of the Player template shows them, under the instance's Behaviors, and can set its own. How the behavior
feels (the stick, the lean, the running turn's angles and timing) is `private`, set once in the template.

### The camera

One **Camera Rig** follows the Mannequin and pulls in at walls; the Controller aims it. `SandboxCamera.ts` on it
frames it over the shoulder, and pulls out to third person while the character sprints (its script's `sprinting`,
read from the Character the rig belongs to), over `switchSeconds` (2 s), eased in and out both ways. No action
switches it.

- **Over the shoulder** (the default): `shoulderArm` 1.9 m back and `shoulderOffset` 0.5 m to the right.
- **Third person** (sprinting, and `sprintHold` 0.4 s after): `thirdPersonArm` 3.4 m back, orbiting `pivotHeight`
  1.45 m above the feet.

It eases the arm, the socket offset and the pivot height, and never touches where the camera looks: yaw and pitch
are the Controller's. The four framing distances are `public`, so each copy of the template can frame its own
character; `switchSeconds` and `sprintHold` are `private`. Under pointer lock the
engine drops the glitched mouse readings that used to swing the view round (see
[Input](../scripting/input.md)).

## Things to push

The **Props** node holds loose rigid bodies over the course, each a template (`/Level/Props`), each resting where
it is put and asleep until something touches it:

| Prop | Size | Mass |
|---|---|---|
| Small Crate | 0.5 m | 8 kg |
| Crate | 0.8 m | 25 kg |
| Large Crate | 1.2 m | 80 kg |
| Barrel | 0.6 x 0.9 m | 25 kg |
| Ball | 0.5 m | 3 kg, bouncy |
| Big Ball | 1 m | 8 kg |
| Plank | 2.4 x 0.1 x 0.3 m | 10 kg |

Crates and a barrel stand beside the start. There is a crate on the 1 m platform and balls on the 2 m one, to knock
off. Big balls sit on the 20 and 30 degree ramps' tops, to roll down them. A barrel lies at the foot of the 15 cm
stairs. Behind the wall there is a crate pyramid to topple, with barrels lying beside it. Large crates stand on the
open ground past the ramps, and planks lie by the gap.

The player pushes them through ordinary contacts: there is no push setting. The 75 kg capsule shoves a crate
easily and leans on a large one. Small props do not pull the camera in.

## Holding clips in place

The Character moves the body, so every clip's ground travel is taken out. The engine's in-place bake also takes the
yaw out of the hips. That tilts any clip whose pelvis twists while it bends (the hard landing, the stop, the jump):
the bend stays about the twisted axis and reads as a sideways lean.

So the generator leaves the rotation as authored and removes only the travel. Its build fails if a held clip leans
sideways differently from its source (`--report` prints it).

## Adding clips

Jog is the pack's running set. Drop a better clip into `build/LocomotionPack`, point its role in
`tools/sandbox/clips.ts` at it, and rebuild. Every speed, phase, cut, rate, plant and threshold is measured off the
clips, not typed in.

## Limits

- **No stride or orientation warping.** The forward diagonals are blends, and their feet slide more than the
  cardinal directions do (the test reports both).
- **Turns.** A turn turns by its clip, 90 or 180 degrees, so the body can stop up to 45 degrees off the camera.
- **Twisted endings.** The hard landing and the stop end with the pelvis twisted; the blend into Idle straightens it.
- **The hard landing's travel.** It carries the capsule about 0.3 m forward as it crouches and most of the way back
  as it stands, as the clip's hips do.
- **Locked feet at toe-off.** A jog's locked foot creeps a few centimetres at toe-off, where the leg is already
  straight and cannot reach back to the lock.
- **Blends between gaits.** A quick change from forward to sideways blends two clips whose feet do not plant
  together, so for a step the blend lifts a foot the lock was holding, and it slides back to the animation.
- **Running landings.** The running landing is the running jump's own last 0.3 s, so a landing at a run is brief.
- **The stair clips' steps.** The clips step 23 cm risers 24 cm apart, and the flights have 15 and 20 cm risers
  30 cm apart. Foot placement takes up the riser and foot locking the stride: a planted foot creeps 2 to 13 cm/s.
- **The rebuilt descents.** Their legs are IK on a schedule (see [Stairs](#stairs)), not motion capture. The knees
  bend deep, the trailing one most, because the clips' hips sink that low.
- **Where the feet land on the treads.** The climb steps one tread a step from wherever its stride met the flight;
  nothing matches the stride to the treads. From some run-ups (about one in eight walking up) each foot comes down
  on a riser's edge, its toe on the tread above, for the whole flight.
- **Slow stairs.** The pace is a real stair climb's, a third of the walk or the jog.
- **Teleports.** Moving the character with `teleport` reads, for a moment, as a burst of speed to the measured
  built-ins.
