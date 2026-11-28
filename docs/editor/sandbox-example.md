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
- stand on a stair ramp or a slope without sliding down it;
- crouch and walk crouched in eight directions, its capsule shorter, standing up only where there is room
  (see [Crouching](#crouching));
- get into a car by its door, drive it, and get out again (see [The car](#the-car));
- carry Firing Line's pistol, AK-47 rifle and SAPS-12 shotgun, and move with each on motion capture made for it:
  the rifle's walks, jogs, sprint, crouch, turns and jumps, the pistol's walks, jogs, kneel and jumps (see
  [Moving armed](#moving-armed));
- aim them where the camera looks, fire them, the body taking each shot's recoil, and reload them, their shots
  raycasts that push what they hit (see [The weapons](#the-weapons));
- switch to first person and back: Firing Line's viewmodels and its shooter's mechanics, the body still casting its
  shadow (see [First person](#first-person));
- share the course with people on the same body: six blue **civilians** who wander it, stop to look at things, look
  at you and move on, and run from shots and from the car, and four red **enemies** who patrol it in pairs with
  rifles, shoot you on sight and take cover when shot at. Every one of them reacts with its whole body when it is
  shot or run over, and gets up again (see [The NPCs](#the-npcs)).

The body every character has is one **Sandbox Character** template; the player is its **Player** variant, placed
once, and the people are its **Civilian** and **Enemy** variants. The sky is the **Environment** template, the
course the **Course** template, and the car the **Car** template.

The course stands on an open **Ocean** whose surface is 2 m under the ground. It starts at dusk: the sun 9 degrees
under the horizon, under sunset clouds (the Environment's Volumetric Clouds, the Sunset preset with more and
smaller clouds). The bounced light on the course is a **GI Volume** over the whole floor, one layer of probes 2 m
up, 20 by 20 (captured when the scene opens), and a **Light Probe** over the whole scene gives the reflections,
and the light over the platforms' tops where the GI Volume ends.

**Light setups.** The **Game Manager** node's script (SandboxGameManager) switches three: **1** day, **2** the
dusk, **3** night (the d-pad's left, up and right on a pad). A setup is where the sun is; the sky, the clouds, the
moon, the Sky Light, the GI Volume and the Light Probe follow it, and the eye adapts. How dark the dusk and the
night look is the project's exposure compensation curve, set once in the render settings rather than by the
script. The scene's **HUD** (its Controls panel, top left) says which setup is on and lists the keys. The setup is the script's
`setup` field, an `@observable` one: setting it sends the event `sandbox:LightSetup`, which the HUD line answers.
Another script can follow the light the same way, with `@onEvent('sandbox:LightSetup')` (see
[Events](../scripting/events.md)).

Its feet stay planted and locked on ramps, stairs and bumps. To try it, open **Sandbox** from the example gallery
and press Play.

It uses only what the engine has:

- a **Character** and a **Controller**;
- one **Camera Rig**, with a script that frames it over the shoulder, and in third person while sprinting;
- blend spaces (locomotion unarmed, with the rifle and with the pistol, each crouched too, the look-at, the stairs,
  up and down, and each weapon's carry and aim) and one animator, its states in groups, an armed variant beside each
  state a weapon has clips for, and a layer for each weapon;
- foot placement and foot locking on the skeleton;
- one script on the Character, which handles input and writes the values the animator reads.

The body is one template, **Sandbox Character** (`/Characters/Mannequin/Sandbox Character.tpl`): the Collider, the
Character and its script (`SandboxCharacter`), the Mannequin, the weapons in its hands and their sounds. On its own it
stands idle. The player is its variant **Player** (`/Characters/Mannequin/Player.tpl`): the Character's script is
`SandboxPlayer` (input on top of the body's), and it adds the Camera Rig and its script, the Controller, and its own
**HUD** (a screen canvas: the crosshair, the ammunition and the reload, so every copy of the Player brings and drives
its own). An edit to the base (a weapon's grip, the Mannequin's machine) reaches the Player and every NPC. The level is
two more:
**Environment** (`/Level/Environment.tpl`: the sun, the sky atmosphere and the sky light) and **Course**
(`/Level/Course.tpl`: the merged Static Collision collider with every piece of the course, placed under that name,
and inside it the parts merged apart for their [collision layers](#collision-layers-stairs-bumps-and-pillars): the
feet's detail, the stairs' ramps and the pillars).
Each is placed once.

It is edited in the desktop editor, as the project folder `examples/sandbox`
([examples/README.md](../../examples/README.md)). Its clips are Mixamo's: the **Locomotion Pack** unarmed; the
**Rifle 8-Way Locomotion Pack**, the **Pistol Handgun Locomotion Pack**, the **Shooter Pack** and the **Slim Shooter
Pack** armed; *Crouch To Stand* and *Shooting* on their own.

## Playing

| Action | Keyboard and mouse | Gamepad |
|---|---|---|
| Move (jog) | W A S D or the arrows | left stick, pushed all the way |
| Walk | hold Left Ctrl | left stick, pushed partway (or hold LB) |
| Sprint (any direction, facing it) | hold Left Shift | hold A |
| Jump | Space | X |
| Look | the mouse (click the view to capture it) | right stick (twice the engine default's rate) |
| Get into the car, or out of it | E, by the driver's door | Y |
| Day, dusk, night | 1, 2, 3 | d-pad left, up, right |
| Next weapon (pistol, rifle, shotgun, none) | Q, or the wheel (back: the last one) | RB |
| Aim | hold the right mouse button | hold LT |
| Fire | the left mouse button (hold for the rifle) | RT |
| Reload | R | B |
| Crouch, or stand up | C | right stick click |
| First person, or third | V | d-pad down |
| Trip over, or be shoved back off balance (see [Reactions](#reactions)) | T, G | |

In the car, the **Drive** action drives and steers: W forward, S brakes, then reverses, A and D steer; on a gamepad
the right trigger drives on and the left one brakes, then reverses (both analog), and the left stick steers (its up
and down do nothing here). Space (X) holds the hand brake, and Look (the mouse, the right stick) turns the camera,
which swings back behind the car when you leave it alone.

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
- **To the left, past the pillars**: the car, parked facing +X, its driver's door toward the pillars, with forty
  metres of open ground ahead of it. A low barrier runs round the edge of the ground.

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
| Moving with a weapon on that weapon's own clips: walking, jogging, sprinting, crouching, turning, jumping | The states' **armed variants** (Rifle Locomotion, Pistol Idle, ...), picked by the script's `stance` (see [Moving armed](#moving-armed)) |
| Taking a weapon out or putting it away mid-stride without missing a step | A 0.25 s cross-fade between a state and its variant, the two in one **sync group** |
| Sprinting in any direction at 6.5 m/s, the body turned to where it runs | The script sets facing to **Velocity** while sprinting (ALS's velocity direction); the blend space has only a forward sprint |
| Setting off into a sprint | The **Start** state, the start clip sped up to the Character's acceleration |
| Stopping from a run, off whichever foot is swinging | The **Stop** and **StopMirror** states, picked by the run's phase |
| Reversing a sprint | The **RunTurnL/R** states: the running-turn clip's root motion turns the body |
| Leaning the whole body into a change of direction at a jog or a sprint, and forward into a start | Three additive **lean** layers |
| Turning in place when the camera swings more than 70 degrees away | The Character's turn request, and the turn clips' **root motion** |
| Jump, fall, soft and hard landings | The animator, from `isJumping`, `isGrounded`, `airTime` and `verticalSpeed` |
| A jump on the move going the way it flies, not the way the camera looks | The script turns the body to the jump's velocity through the flight (facing **None** meanwhile; ALS's in-air rotation) |
| Crouching through a hard landing where it came down, whatever the stick says | The hard landing's **root motion**, and its state's **hold** switch |
| Rolling out of a far fall while running, and running on | The **LandRoll** state, entered from the fall by the graph alone (`Running` and `Speed`) |
| Looking round at the camera standing still, before turning to it | The additive **Look** layer (a blend space of look poses), and the Character's turn delay |
| Looking round crouched with the head alone | The additive **Look Head** layer, which takes over from Look while crouched |
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

**Mannequin Locomotion** is a shared animator on the Mannequin skeleton. Its base layer has fifty states, all but
Start and Stairs in nine **groups**, so the graph shows Start, Stairs and nine group nodes. Twenty of the
states are the [armed variants](#moving-armed) of the others. Nineteen [forks](animation.md#forks) untangle what is
left: a choice several states make the same way is written once, as a fork's ways out, and each of those states has
one line to it.

| Group | Entered through | Its states | Its own transitions (from any of its states) |
|---|---|---|---|
| **Standing** | **Pick Idle**: the idle of the stance | Idle, Pistol Idle, Rifle Idle | |
| **Moving** | **Pick Locomotion**: the locomotion of the stance | Locomotion, Pistol Locomotion, Rifle Locomotion | |
| **Turning** | **Pick Turn**: the turn in place the script's `Turn` asks for (a quarter turn then through **Pick Turn90L/R**, by stance) | Turn90L/R, Turn180L/R, Rifle Turn90L/R | into the air, onto a flight, and off into Locomotion when the stick moves |
| **Stopping** | **Pick Stop**: the stop that plants the foot that is swinging (by the run's phase) | Stop, StopMirror, and the **Settle** fork | into the air |
| **Running Turn** | **Pick Run Turn**: left or right, by `RunTurn` | RunTurnL/R | into the air, to Idle when let go, back into Locomotion when the script lets go of `RunTurn` |
| **Air** | **Take Off**: a running jump at a run's speed, else a standing jump, or off a ledge a fall (each through its **Pick** fork, by stance) | JumpStand, JumpRun, Fall, FallFar, and the pistol's and rifle's | |
| **Landing** | its landings, from Air (JumpLand and LandRun through their **Pick** forks) | JumpLand, LandRun, LandSoft, LandHard, LandRoll, and the pistol's and rifle's JumpLand and LandRun | into Idle once a landing has played out, and into the air |
| **Car** | its triggers (no fork) | CarEnter, CarDrive, CarExit | |
| **Crouching** | **Crouch Down**: the pistol kneels when it stands still, else **Pick Crouch** | Crouch, Pistol Crouch, Rifle Crouch, the crouched quarter turns, Pistol KneelDown/KneelUp, CrouchStand | standing up, into the air |

So every grounded state has ONE way into the air, a line into Air, and Take Off picks the jump or the fall: 22
transitions became 11. A stop settles through **Settle**: into Turning when a turn in place is asked for (Pick Turn
picks which), else into Idle. Every way into Idle or Locomotion is a line to **Pick Idle** or **Pick Locomotion**,
which goes on to the stance's variant. In all the base layer has 196 transitions: 22 of them change stance between a
state and its variants, 21 are the Pick forks' ways out, and each variant keeps the transitions of the state it
stands in for.

Each state keeps the transitions only it has (a turn's way back to Idle as it ends, a landing's way into the run).
Double-click a group in the graph to see its states and forks.

The states:

- **Idle** and **Locomotion** (the blend space), and their armed variants (see [Moving armed](#moving-armed)).
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
body) and its weight is `LookWeight`, which the script raises while the character stands still. Crouched, the
**Look Head** layer after it takes its weight (`LookHeadWeight`) and turns the head alone (see
[Crouching](#crouching)).

**Lean.** Three **additive** layers, **Lean Left**, **Lean Right** and **Lean Forward**, play a lean clip at the weight
of `LeanLeft` / `LeanRight` / `LeanForward`. The sideways clips are made as a runner banks: the whole body
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
Descending Stairs*) are steep, slow stairs: about 23 cm a step, one step every 0.2 to 0.7 s. Each was read with
its rise kept and checked first: its feet must step up (or down) at least 10 cm each step, and its last frame must
match its first. A direction with no clip that passes plays the walk blend on the flight instead.

**The descents are rebuilt.** The two descending clips fail the check. In both files the feet stay at floor height
while the hips sink 48 cm and the knees fold, and the last frame does not match the first. The shipped descents
keep what they get right, with the legs rebuilt:

- **Kept:** the hips stepping down, and the trunk, arms and head of a body going down stairs. Each of these is made
  to loop, its drift from first frame to last spread over the clip.
- **The steps:** the clip's own timing. The left foot lands where the clip's does, the right half a cycle later.
  Each foot stays planted for at most 62% of the cycle.
- **The feet:** each steps down two risers a cycle, one riser apart from the other. Planted, a foot stands still on
  its tread. Swinging, it lifts off at once, goes forward over the nose of the tread it leaves, and comes down two
  treads lower, toe first.
- **The legs:** two-bone IK sets the thighs and shins to reach those ankles, knees forward.

The rebuilt clips then pass the check, and go through the same steps as the climbs. A better descending clip can
replace one: import it in the editor and put it in the Stairs blend space in its place.

How a stair clip is used:

- **In place.** Its rise comes out of the hips evenly, so the capsule climbs the ramp at an even pace and the hips
  keep their bob from step to step. The pose is set so the planted feet stand at sole height on average.
- **Its foot-lock windows** are found against each stance's own height, since the upper foot stands a riser above
  the lower one. Its state has **windows** on (`plantInWindows`): foot placement keeps a foot inside its window
  planted at any height. Without it, the upper foot would read as swinging and float over its tread.
- **The knees.** The pack's walking climb splays its knees: 23 cm apart on average, over hips 16 cm apart (the flat
  walk holds them 18). Each stair clip has its legs turned about the hip-ankle line, three quarters of the way to
  straight ahead, the feet left where they were. Foot
  IK then bends the knees along that bend. Walking up a flight they come out 19 cm apart, 18 on the flat.
- **The pace.** Each clip plays 1.25 times faster than authored, one step a 30 cm tread. That sets
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
  **Detect**. Each foot locks from the ball of the foot coming down until the heel has lifted
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

The Character's script is two classes. `SandboxCharacter.ts` is the body every Sandbox character shares: everything
below, the weapons' stance, aim and fire, the car and the reactions. It asks its subclass what it wants (to walk, to
aim, to fire, to reload, which weapon, where its shot comes from and goes) and does nothing on its own.
`SandboxPlayer.ts`, the Player's, extends it and answers from the input and the camera; it also owns the camera, first
person and its viewmodels, the depth of field and the HUD. The NPCs' scripts answer from their brains (see
[The NPCs](#the-npcs)). Each frame, before the Character acts, the body adjusts what the Controller asked for:

- **The gait.** Walk scales speed down to the walk. A stick walks below `walkDeflection` and jogs above it. Sprint
  works in any direction with the stick all the way, and sets `sprinting`.
- **The rotation mode.**
  - At a walk and a jog, facing is **Aim**.
  - At a sprint, facing is **Velocity**.
  - After a sprint stops, facing is **None** until the camera swings more than `lookAroundAngle` (20 degrees). The
    body stays as it stopped rather than turning to the camera by itself.
  - In a jump taken off faster than `jumpTurnSpeed` (1 m/s), facing is **None** and the script turns the body
    toward the jump's own velocity at the Character's turn speed, as **Velocity** turns it on the stairs: a jump
    off a strafe or a backpedal flies facing forward, whatever the stick and the camera do in the air. Once down,
    facing is **Aim** again. A standing jump keeps facing as it stood.
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

- **Aiming** (its script's `aiming`): `aimArm` 1.25 m back and `aimShoulderOffset` 0.6 m to the right, in over
  `aimSeconds` (0.25 s), on top of whichever of the two framings it is in.

- **Crouched** (the Character's `crouched`): it orbits `crouchDrop` (0.45 m) lower, over `crouchSeconds` (0.25 s).
- **First person** (the script's `firstPerson`): see [First person](#first-person).

It eases the arm, the socket offset and the pivot height, and never touches where the camera looks: yaw and pitch
are the Controller's. The six framing distances are `public`, so each copy of the template can frame its own
character; `switchSeconds`, `sprintHold` and `aimSeconds` are `private`. Under pointer lock the
engine drops the glitched mouse readings that used to swing the view round (see
[Input](../scripting/input.md)).

## The car

A car to get into and drive, on the [vehicle simulation](vehicles.md) with the **Car** preset's settings, laid out
on the model's own wheels. Everything that is the car is one template, **Car** (`/Vehicles/Car/Car.tpl`):

```
Car                 the chassis: a Collider with mass (1200 kg), one convex hull of the body and the windows (its
│                   Meshes: Car Body, not the wheels), on the Vehicle layer; SandboxCar
├─ Car Body         the Car Body model: the body, and the windows (blended, so a node of their own)
├─ Lights           Headlight L/R (spot lights), Tail Light L/R (red), Reverse Light L/R (white)
├─ Vehicle          the Car preset: an engine and a five-speed automatic, rear-wheel drive; Parked until driven
│  └─ Wheels        Wheel FL, FR, RL, RR, each turning the wheel's mesh right under it
├─ Seat             where the driver sits; Enter Point (where getting in starts) and Exit Point (where it ends)
├─ Door Zone        a box by the driver's door: Interact there gets in
├─ Camera Target    what the car's camera follows
├─ Car Camera Rig   SandboxCarCamera; its camera off until someone drives
└─ Car Controller   a player Controller, possessing nothing until someone gets in
```

**Getting in.** Stand by the driver's door and press Interact (E). The Player gives up its own Controller, takes its
body out of the physics world ([Turning a body off](../scripting/motion-and-physics.md#turning-a-body-off-for-a-while))
and moves under the Seat, turned the way it faces (a character's facing is its Character's own turn, which the
Collider takes over for the ride); it fires its animator's `EnterCar` trigger and steps onto the Enter Point while
the clip reaches for the door, so it gets in straight however it stood. The clip's root motion carries it from there into the seat: its walk in and its quarter turn
both move the Character. The car's Controller possesses the Vehicle (the switch in possession), and the car's camera
takes the view from exactly where the Player's camera was, then eases out to a chase framing. The car stays Parked
until the driver is seated, then the Driving loop plays.

**Bailing out.** Press Interact while the car goes faster than SandboxCar's **Bail Speed** (6 m/s, about 22 km/h)
and the driver is thrown out of its door at the car's speed instead: out of the seat at once, its body its
[reactions'](reactions.md) (it leaves with the car's velocity, passes clear of the car for a moment, braces, tumbles,
comes to rest and gets up). Its own Controller and camera have it again at once; the empty car brakes to a stop.

**Getting out.** Press Interact again. A moving car first brakes to a stop (it is Parked). If the Exit Point beside
the door is clear, the Player fires `ExitCar`, and the clip's root motion carries it out to the Exit Point while
the car's camera eases back toward the Player's. Once it is on its feet, back in the animator's Idle, its body is put
back in the world on the ground, it takes its own Controller back, and its camera takes the view, looking where the
car's camera looked.

**The lamps.** The car's script switches its lights. An empty car's are off. With someone in it the headlights
are on (spot lights ahead and a little down, casting shadows) and the tail lights glow red; they light up in full
while the car brakes, which includes S held against the way it rolls and the stop before getting out. The
reverse lights come on in reverse. Each light gives the brightness it is set to when on (the tail lights: braking),
so they are tuned on the lights themselves; SandboxCar's **Tail Share** sets the tail lights' glow when not
braking. The Sandbox is set at dusk, the sun 9 degrees under the horizon, so they show.

**The clips** are Mixamo's: getting in and out have their ground travel
and their yaw moved onto the Pivot joint, as root motion, and driving is held in place; each is placed so the next
starts in the pose the last one ends in (the Mixamo driving loop sits 22 cm lower than the end of getting in). The
clips sit the hips about 20 cm higher than this car's cushion, so getting in lowers them the rest of the way as it
sits down, and getting out raises them as it stands up. The Seat, the Enter Point and the Exit Point are worked out
from the clips' root motion, so the seated hips land on the cushion, the driver's back against the seat's backrest.
That is 18 cm further back than the clips' hands reach the steering wheel from, so the hands fall short of it.

**The model** is "Dirty car" by 3D Error 404 (CC-BY-4.0, Sketchfab), scaled to 0.83 of its own size, 5 m long: as
tight round a seated driver as it goes, the head just under the roof. It is
mirrored to left-hand drive, since the Mixamo clips get in on the driver's left.

What the car does not do yet: the doors do not open (the character passes through the door), the hands do not
reach the steering wheel (the clips are for a seat further forward; no hand IK), the driver does not lean or turn
the wheel with the steering, and the seated feet go through the floor (no leg IK).

## Reactions

The mannequin reacts with its whole body, with the [reactions](reactions.md) of its skeleton: the Mannequin rig's
**Default** set (its **Reactions** tab), the same for the player and every NPC:

- **T** trips it: the player's script fires the animator's **Trip** trigger, and the graph's Ragdoll state takes its
  feet from under it; it falls forward onto its hands, lies a moment and gets up.
- **G** shoves it back: it steps to stay up, short quick steps on legs of its own, and keeps its control; shoved too
  hard for its steps, it falls.
- **Bailing out** of the car at speed (above) throws it out to tumble along the ground.
- **A shot** that strikes a character (its capsule, or a limb of a body already reacting) is its reactions'
  (SandboxGun hands it to `physics.applyHit`), on the limb the shot meets: a sway of the upper body on whatever it is
  doing (a free hand to the wound; a hand on a weapon stays there), a stumble for a heavy round in the trunk, a
  stagger, or a fall, by how hard it lands and how many land at once; and by where it lands (the head snaps, the
  chest turns and bows in pain, the gut folds, a hit from behind arches the back, an arm goes loose and turns the
  trunk, a leg gives and it steps on it). Shoot an NPC to see it. The player is not moved by shots at all (its `reactsToShots` is false): an enemy's rounds hit it, and it plays
  on.
- **The car** hitting a character faster than its **Knock Speed** (2.5 m/s, closing) throws it (`struckByVehicle`,
  the reactions' `impact`): the legs are taken out first and the body pivots over the bonnet, its knees and hips
  bent and its arms up round its head, and it rolls when it lands.

On its feet (a flinch, a stumble, a stagger) a character keeps its control: it goes on walking, aiming and firing,
its legs on their animation and its weapon in hand, while its upper body sways and a shove carries it. Off its feet
(it falls, lies or gets up) the stick does nothing and the weapon is put away; foot placement, foot locking and the
support hand's IK fade out while the body has it and back in after (on its feet they stay on). Nothing in the Sandbox has health: a body that falls always gets up. Off
its feet it is alive: it braces as it falls, tucks when thrown from the car, and lies in the pose it came to rest
in. Lying on its front or side it rolls onto its back, then gets up on Mixamo's *Stand Up* (the set's **Get up**
clip, in `/Characters/Mannequin/Animation/Clips/Get Up`), joined where the body in it starts to rise: the clip
lies still 1.4 s first, which the character skips. The clip is turned to lie the way the body lies, and the skin
blends from the body onto it before it plays, so the body does not turn round to meet it. A hit while it gets up
knocks it back down (or off balance, if it was nearly up).

The course's surfaces have a friction of 0.7, so a falling body grips the ground and rolls; the props keep their own
0.3 (a pair of surfaces takes the smaller), so they slide as before.

### In the animator graph

The body's falls are wired in the animator, with no script ([Ragdoll and Get Up states](animation.md#ragdoll-and-get-up-states)):

- the base layer's **Down** group holds a **Ragdoll** state (Starts: Trip; entered on the **Trip** trigger, or from
  Any State, first, on **Ragdolled**: a hit's fall, a shove, the car) and a **Get Up** state (*Stand Up* on its back,
  *Getting Up* on its front). Ragdoll goes to Get Up on **CanGetUp**, and Get Up back to **Pick Idle** near its end;
- the [reaction effects](animation.md#reaction-effects): the car's states take no hits (**React: None**), the crouched
  ones are braced (**Force ×0.6**, **Shove ×0.5**), and a weapon layer's carry, crouch and sprint keep the gun hand
  on its grip (**Hands: Right busy**; **Both busy** while reloading).

### Hit reactions

A **Hit Reaction** layer (additive, over the **Hit** bone mask: spine, neck, head, shoulders, arms and forearms) flinches
on every hit a character takes: its **Hit** state is entered on the **Hit** trigger (set to fire on **Each hit**) and
plays the **Hit Reactions** blend space over **HitAngle** (where the hit came from) and **HitHeight** (how high it
landed), back to **Off** near its end. Its weight is **HasControl**, so it rests while the body is down.

Its eight flinches (Hit Front, Back, Left, Right, and the four Hit Head ones) were made in Cleo Creator's
[Motion](../creator/motion.md#additive-clips) tool on its mannequin: each starts and ends on the neutral pose, throws
the chest (or the head) away from the hit at 0.08 s, overshoots a little at 0.26 s and settles by 0.6 s. They sync into
`/Creator/Motion` and are linked to the Mannequin rig (retargeted by name, through the **Creator Mannequin** rig in
`/Characters/Mannequin/Animation/Clips/Hit`). Their documents, with the script that wrote them, are in
`build/creator/hit-reactions` (Assets ▸ Import in the Creator opens one).

### In pain

An NPC staggered or knocked down is **hurt** for twelve seconds (its brain's **Health** layer, below): its left hand
holds its chest and its trunk bows a little over it, whatever else it is doing. Two layers of the animator do it,
above every other, weighted by **Pain** (the character's `painWeight`: its `hurt` field, which the brain sets, eased
in and out over 0.4 s so the pose never pops). **Pain Hold** (override, over the **Pain Arm** mask: the left
shoulder, arm, forearm and hand) plays the *Pain Hold* clip, the hand on the chest with a slow breath in it, and
**Pain Arch** (additive, over **Pain Spine**: the spine, the neck and the head) bows the trunk over it, the head
kept up. Hurt, an enemy carries its pistol: its left hand lets go of it for the chest (SandboxCharacter's
`supportHand` follows `hurt`), so it fires one-handed. Both clips were made in Cleo Creator's Motion tool on its
mannequin as the flinches above were (in `/Creator/Motion`); their documents are in `build/creator/pain`.

## The NPCs

The people share the player's body: each is a variant of **Sandbox Character** (`/Characters/NPCs`), with the same
Mannequin, machine, clips and reactions, its own material, and an **AI Controller** under its Character for a brain.
They are placed under the scene's **NPCs** node: six **Civilian**s over the map and four **Enemy**s, two by the
pillars and two by the crates.

**The brains.** What an NPC is doing, and when it changes, is its AI Controller's **AI Brain**: **Civilian Brain** and
**Enemy Brain** in `/Characters/NPCs/AI`, behaviour machines you open and edit in their AI Brain tab like any other.
Each state sets the controller's goal (stand, walk the nav mesh to a point, walk toward the player, keep away from
it), and each transition is a condition on the brain's parameters: the controller's senses of the player (**In
Sight**, **Distance**, **Since Seen**; the player on foot is the blackboard's `target`) and what the NPC's script
measures (**Knocked**, **At Goal**, **Stuck**, **Restless** for a state whose time is up, the ages of a shot or a
danger, the enemy's cover cues). The distances and times they compare against are the brain's. The scripts do what a
graph cannot: on entering a state they choose where to go and how long to stay, and while in it how fast to go,
whether to crouch, where to look, and, for an enemy, the aim and the trigger.

| Civilian Brain | Goal | Leaves for |
|---|---|---|
| **wait** (entry) | stand | **roam** when its wait is over (3 to 8 s); **watch** with the player in sight within 6 m, not stared at for 20 s |
| **roam** | the nav mesh to a point | **wait** there (or stuck); **watch** as from wait |
| **watch** | stand | **roam** after a few seconds, or with the player past 9.6 m or driving |
| **alert** | stand | **flee** after **Alert Seconds** if the shot was within 22 m, else **roam** |
| **flee** | the nav mesh to a point | **cower** once there with the danger 7 s old |
| **cower** | stand | **roam** after 2 to 4 s |
| **knocked** | stand | **flee** once its reactions let it go |

A danger (a near miss after its startle, a hit, a car) sends a civilian to **flee** from any state, a shot heard
(after its startle) to **alert** from wait, roam and watch, and a knock-down to **knocked** from anywhere.

| Enemy Brain | Goal | Leaves for |
|---|---|---|
| **patrol** (entry) | the nav mesh to its route's next point | **look** there; **alert** on a noise |
| **look** | stand | **patrol** after 1.5 to 3.5 s |
| **alert** | stand | **search** after a second |
| **engage** | the script's (it stands and side-steps) | **close in** past 22 m, **back off** under 8 m, **search** with the player unseen 1.5 s |
| **close in** | the nav mesh toward the player | **engage** under 18 m |
| **back off** | away from the player | **engage** past 11 m |
| **cover** | the nav mesh to the spot it picked | **in cover** there; **engage** with no cover to be had, or stuck |
| **in cover** | stand, crouched | **peek** after 1.5 to 3 s, not reloading; **cover** again if the shooter can see it |
| **peek** | stand, firing | **in cover** after 1.2 to 2 s; **engage** after three |
| **search** | the nav mesh to where the player was last seen | **scan** there; **return** if stuck or after 20 s |
| **scan** | stand, looking round | **return** after 6 s |
| **return** | the nav mesh to its route | **patrol** |
| **knocked** | stand | **cover** once its reactions let it go |
| **car engage** | a strafe round the car (**Auto**: off its path), keeping 9 m | **engage** once the player is out of the car, **search** with it unseen 2 s |

The player in sight sends an enemy that is going about its patrol (patrol, look, alert, search, scan, return) to
**engage**, or, driving, from any of its fighting states to **car engage**; being hit, or nearly hit twice, sends it to
**cover** from anywhere.

**Layers.** Beside its states both brains run a **Health** layer: **Fine**, and **Hurt** on **Knock** (a trigger on
the reactions' `knockCount`: each stagger and each fall from its feet), back to Fine after 12 s in Hurt (**Hurt For**:
the layer's time; another knock starts it over). Hurt outputs `hurt` (the pain pose). The enemy's also runs a
**Weapon** layer, whose states output its `preferredWeapon`: **Rifle** (the entry), **Shotgun** with the player within
3 m (back past 4 m), and **Pistol** while it is hurt, whatever the distance.

**The classes.** `SandboxNpc.ts` (`/Characters/NPCs/Scripts`) extends SandboxCharacter with what both kinds need:

- **Moving.** On entering a state, `goTo(point, gait)` sends it there (the brain's state walks the nav mesh to the
  AI Controller's `goalPoint`; it is **At Goal** once within reach), `stop()` stands, and the state sets how long it
  lasts. `moveWorld(x, z, gait)` steps the body itself (a strafe, a dodge), `face` and `lookAt` turn the head, and the
  body past its turn delay, `crouch` crouches. It writes the Controller's intent each frame: the pace (walk, jog or
  sprint), the crouch and where it looks.
- **Senses.** Sight is its AI Controller's perception (range, cone and reaction time from its **Senses**
  attributes), of the character whose `team` is the player's. A shot fired within **Hearing** (35 m) is heard, one
  whose line passes within **Near Miss** (2.5 m) nearly hit it, one that struck it hit it; a car bearing down on it
  warns it (the car's `dodgeVehicle`) and it steps off the car's line at a sprint, unless its brain is already
  fighting the car (an enemy's **car engage**). Each comes to its subclass as a threat. The player at the wheel is
  still an enemy's target (its `fightsDrivers`); a civilian's only on foot.
- **Knock-downs.** One round is a flinch. Hits add up (**Stagger Shock**, **Knockdown Shock**, fading by half every
  **Shock Half Life**): past the first it staggers, past the second, or hit in the legs running, it falls.
- **It never dies.** Its health is kept full, a body lying longer than **Down Seconds** is got up, and one reacting
  longer than **Stuck Seconds** is put back on its feet (a get-up under way does not count: its clip plays out). While it is off its feet the brain is **knocked**; a flinch
  or a stagger it stays up through keeps the brain where it was (it goes on patrolling, fighting or fleeing).

`SandboxCivilian.ts` (blue) waits at a **Look Point**, its head sweeping round what is there, then walks 10 to 40 m
off to somewhere else, often another Look Point. The player close by and in sight, on foot, is looked at for
**Watch Min** to **Watch Max** seconds. It is an ordinary person, slow to react: it notices someone after **Notice
Seconds** (0.9 s), and answers a shot heard or one that nearly hit it after a startle (**Startle Min** to **Startle
Max**, 0.4 to 0.8 s). A shot heard makes it look toward it for **Alert Seconds**, then run if it was close or walk
off quicker; a near miss, a hit or a car sends it sprinting away from the danger (**Flee Min** to **Flee Max** m),
somewhere reachable and not past it, on to somewhere farther while the danger is fresh, and it crouches there facing
the danger before it calms down. Once up after a fall, it runs.

`SandboxEnemy.ts` (red) carries its **Preferred Weapon** (the rifle) from the start, at the low ready.

- **Patrol.** It walks the nav mesh route nearest where it was placed (or the one its **Route** names), stopping at
  each point to look round. Two placed within 10 m of each other patrol as a pair: one leads, the other keeps behind
  it to the right.
- **Engage.** The player in sight: it aims, fires in bursts, keeps between 8 and 22 m (its brain's **close in** and
  **back off**), side-steps now and then, and holds fire with someone else in the line. It aims worse far away and
  at a moving target, and better the longer it holds the player in its sights. It tells its partner.
- **Cover.** Hit, or nearly hit twice: it sprints to the best spot the shooter cannot see (a **Cover Point** within
  15 m, or a ring of probes round it; hidden for a crouched head and a shoulder's width to either side, reachable
  without a long way round, not taken by another enemy), crouches, reloads, and stands up to fire a burst now and
  then. After a few, or once the spot is seen, it moves.
- **Search** where the player was last seen, then **return** to its route.
- **The car.** The player driving, in sight (seen through the car): it steps off the car's path, the side away from
  where the car is going, keeping 9 m, facing the cabin and firing at it.

Its magazine is topped up from a reserve that never runs out. Its rounds hit the player but do not move it, and the
player has no health.

**The points.** Under the scene's **NPC Points**: nodes named `Look Point ...` (what there is to look at: the props,
the stairs, the balls, the car, the crates) and `Cover Point ...` (where to crouch: by the pillars, the wall, the
crates and the barrels). The scripts find them by name, anywhere in the scene.

**The nav mesh.** The scene's **NavMesh** node covers the ground (an agent radius of 0.35 m, slopes up to 35
degrees, steps up to 0.35 m), baked from the course, and holds the two routes, **Patrol Pillars** and
**Patrol Crates**. Re-bake it (the NavMesh node's **Bake**) after changing the course.

**The car** lets only the player drive it (`canDrive`: an NPC by the door is not let in), knocks down whoever it hits
fast enough, and warns whoever is ahead of it within **Warn Seconds** of its travel.

**To add one,** place a copy of the **Civilian** or **Enemy** template on the nav mesh (under NPCs, to keep them
together). An enemy patrols the route nearest it: add a route to the NavMesh node, or name one in its **Route**. A
new kind of NPC is a variant of Sandbox Character with an AI Brain of its own on its AI Controller, and a script
that extends `SandboxNpc`: `enterState` and `inState` for what each of the brain's states does, and getters for
anything the brain should read (a parameter whose source is **Builtin** names one).

## The weapons

Three weapons, Firing Line's: its pistol, its AK-47 rifle and its SAPS-12 shotgun, carried in the right hand.
**Q** (RB on a pad) takes out the pistol, then the rifle, then the shotgun, then puts it away; the mouse wheel goes
the same way round, or back. Not aimed, the weapon is held at the **low ready**, its muzzle at the ground ahead.
Holding the **right mouse button** aims it (LT). Aiming, the character faces the camera and strafes, turns in place
as soon as the camera is 45 degrees round (`aimTurnThreshold`), and the camera moves in over the shoulder and zooms in,
with a hard depth of field (see [Aiming in third person](#aiming-in-third-person)). Sprinting carries the weapon as
the sprint clip does; getting into the car puts it away. In first person they are Firing Line's viewmodels instead (see [First person](#first-person)):
the same weapons, the same magazines.

```
Player
├─ Camera Rig
│  └─ Camera
│     └─ Viewmodels       first person: the Pistol, AK-47 and SAPS-12 Viewmodels, each with its Muzzle
├─ ...
├─ Mannequin
├─ Weapons
│  ├─ Pistol Grip         on the Mannequin's Pistol Grip socket: the Pistol model, and its Muzzle
│  ├─ Rifle Grip          on the Rifle Grip socket: the Rifle model, and its Muzzle
│  └─ Shotgun Grip        on the Shotgun Grip socket: the Shotgun model, and its Muzzle
├─ Sounds                 ShotPistol, ShotRifle, ShotShotgun
└─ HUD                    the Player's own screen canvas: Crosshair (a dot and four ticks), Ammunition, Reloading
```

**On the hand.** Each weapon hangs on a socket of its own on the right hand (`Pistol Grip`, `Rifle Grip`,
`Shotgun Grip`, on the Mannequin rig, shown with their weapon in the animation editors). The socket's frame is the
weapon's: its grip at the origin, its bore along +Z, the line every aim is built on. Under it the weapon's model sits
unturned, so its barrel is where the aim points; it is only moved, to put its grip in the fist (the Rifle's node
sits 3 cm back and 1.4 cm to the left). A **Muzzle** node marks the end of the model's bore, for whatever fires it.
The script shows the one in the hands and hides the others.

The grips are fitted to the motion capture's right fist: the rifle's bore runs along the line the clips hold their
rifle on (from the right fist to the left, averaged over the walks, the runs and the aim), turned 8.8 degrees as the
rifle was set in the hand in the editor; the long guns' aims are turned onto it. The AK-47's pistol grip sits further
behind its trigger than Mixamo's rifle's did, so the rifle is moved forward in the hand until its grip is in the fist
(the index finger lies along the frame), and the aiming idles' right hand is moved back by as much: aimed, the rifle
is where it was, its butt at the shoulder. Three more sockets on the right hand, **Pistol Support**, **Rifle Support** and **Shotgun
Support**, mark where the left hand holds each weapon: the pistol's grip from below, the AK-47's handguard, the
SAPS-12's pump. The left hand goes there by IK (see the layers below), whatever the clip's own left hand did.

**The models.** The third person's weapons are Firing Line's viewmodels' own: each one's weapon parts (not the
arms, not the shotgun's ejected shell), as its viewmodel's Idle clip holds them, laid out in weapon space. The grip
is the middle of the part the viewmodel's right fist closes round, on the weapon's midplane; the bore is the
weapon's own (its rig's weapon bone). They wear the viewmodels' materials, which cast shadows (a viewmodel never
does, whatever its material says). The pistol is 27 cm long, the AK-47 87 cm, the SAPS-12 84 cm.

**The poses.** The aim's directions are POSES, in a Pose asset per weapon set (**Pistol Poses**, and **Rifle
Poses**, which the shotgun shares, in `/Characters/Mannequin/Animation/Weapons`), editable in the editor (see
[Editing a pose](animation.md#editing-a-pose)):

- **Aim**: the motion capture's own aiming idle (the Shooter pack's for the rifle, the pistol pack's idle for the
  pistol), its first frame, turned so the bore looks along the camera's ray.
- **Aim Left 45 Up 30** and the rest, 25 in all: the aim's directions, each a [variant](animation.md#variants) of
  **Aim** that stores only what it changes from it: Spine1 and Spine2 turn by the direction, so the arms, the
  weapon and the head go round with the chest.
- **Low Ready**: a variant of **Aim** too, the weapon lowered (the rifle 40 degrees, its butt kept in the shoulder;
  the pistol 45, about the shoulders), both hands moved onto it by IK with the elbows where the wrists bend least,
  and the head up off the sights, looking ahead. The pistol's right elbow is the exception: where the wrist bends
  least it lies across the chest, so it hangs instead, as low as it goes with the hands on the gun (21 cm under the
  shoulder, 7 cm further out); and its left elbow is held 5 cm further off the torso than the least bend puts it, no
  higher, so it is out at the side rather than against the belly. Each arm bends as the Mannequin's does: the upper arm turned about itself until the
  elbow bends on its own hinge (the one the motion capture's elbows bend on), the forearm turned about itself so the
  hand sits on it as it does in the aim, the wrist untwisted. It stores the arms, the neck and the head.
- **Reload** (the pistol's): the pistol brought up in front of the chest, the magazine toward the left hand. The long
  guns reload on the Slim Shooter pack's clip.

Edit **Aim** and every aim direction, and the low ready, moves with it; edit one direction and only it changes.

**The layers.** Each weapon has an override layer, **Pistol**, **Rifle** and **Shotgun**, which holds the spine,
the head and both arms with their fingers (the **Pistol** and **Rifle** bone masks). Its weight is the script's
(`pistolWeight`, `rifleWeight`, `shotgunWeight`): one at a time, faded out and in over `equipSeconds` (0.3 s). The
support arm is the weapon's hold, never the body's under it: with the right arm alone, the pistol's left arm was
whatever the legs' clip had (a strafe, a turn in place), the low ready's difference added to it, and its elbow
snapped across the chest as that clip changed.

- **Carry** plays the set's aiming idle (**Rifle Aim**, which the shotgun shares; **Handgun Idle**) at every gait
  but the sprint, standing, walking and jogging, over whatever the legs do; the **Lowered** layer turns it
  muzzle-down. So the arms hold the weapon steady against the chest at every gait, as a low ready is held.
- **Crouch** does the same crouched.
- **Sprint** plays the sprint's arms, in step with the legs (the **Gait** sync group): the rifle pack's sprint for the
  long guns (**Rifle Sprint Arms**, its loop started on the right foot's plant as the legs' sample is), and for the
  pistol **Handgun Sprint**: the Locomotion Pack's sprint, the left arm pumping free, the right one-handed by the hip,
  its muzzle down and forward, swinging with 30% of the sprint's own arm swing.
- **Aim** and **Crouch Aim** play the aim, standing and crouched (the Shooter pack's rifle aiming idle, the Rifle
  8-Way pack's crouching aim, the pistol pack's idle).
- **Reload** plays the Slim Shooter pack's reload for the rifle and the shotgun, at the rate that fits it to the
  gun's `reloadSeconds`, and holds the pistol's Reload pose, while the script reloads (its `reloading`, the
  animator's **Reloading**).
- They are **Steady** (see [Steady holds](animation.md#steady-holds)): the chest keeps the clip's own turn over the
  hips, whatever the legs do. Carrying, crouched and sprinting, at 0.5, it keeps half the hips' sway; aiming, at 1,
  none, so the weapon stays on target. The legs are never touched, so foot placement and foot locking work as they do
  unarmed.
- **Hand IK** keeps the left hand on the weapon: on the weapon's support socket (**Pistol Support**, **Rifle
  Support**, **Shotgun Support**), whatever the layers above do to the right arm, so the hand is on these models
  whatever weapon Mixamo's actor held. The pistol's lets go at a sprint: its weight is `supportHand`, which the
  script eases to 0 over the 0.3 s the arms take to go over to the sprint's.

**The low ready.** The **Lowered** layer is additive, over the **Lowered** bone mask (both arms, the neck and the
head). It plays the set's **Low Ready** pose (**Pistol**, or **Rifle** for both long guns, picked by Stance) at the
weight `loweredWeight`: the weapon layer's weight times one less the aim's. So the weapon is held at the low ready
whenever it is not aimed, and aiming lifts the very hold it was lowered from, over the aim's 0.15 s: the bore is on the
camera's line within a quarter of a second of pressing Aim. A shot from the hip aims first, so it lifts the weapon too.
The layer goes to its empty **Off** while the body sprints or reloads (the sprint's and the reload's own holds).

**The aim.** **Pistol Aim**, **Rifle Aim** and **Shotgun Aim** are additive layers like the **Look** layer: each a
blend space of the 25 aim directions (**Pistol Aim Offset**; **Rifle Aim Offset**, which the shotgun shares) over
the aim's yaw off the body (`aimYaw`, -90 to 90) and its pitch (`aimPitch`, -60 to 60, the camera's own). Each adds
what its direction changes from **Aim**: the upper chest turns, carrying the arms, the weapon and the head with it.
Their weight is the aim's (`aimSeconds`, 0.15 s) times the weapon's. Aiming, the Look layer is off: the aim turns
the head.

### Moving armed

With a weapon out, the body moves on that weapon's motion capture, not on the unarmed walk with the arms held over
it. Each state a weapon set has clips for has an **armed variant** beside it, in the same group: **Pistol Idle** and
**Rifle Idle** beside Idle, **Pistol Locomotion** and **Rifle Locomotion** beside Locomotion, and so on. The script's
`stance` (the animator's **Stance**) says which: 0 unarmed, 1 the pistol, 2 the rifle, which the shotgun shares.

| | Unarmed | Pistol | Rifle and shotgun |
|---|---|---|---|
| Standing | Idle | the pistol pack's idle | the rifle pack's idle |
| Walk and jog, 8 directions | the Locomotion Pack | the pistol pack's walk back and sideways, its run and run back; the rifle pack's legs for the rest (the diagonals, the walk forward, the jog sideways), always under the pistol's arms | the rifle pack's walks and runs; the Shooter pack's slow walk forward and back for a barely pushed stick |
| Sprint | the Locomotion Pack | the Locomotion Pack's sprint, the pistol one-handed | the rifle pack's sprint |
| Crouched | Crouch (see [Crouching](#crouching)) | the pistol pack's kneel, the rifle pack's crouch walks | the rifle pack's crouch idle and crouch walks |
| Quarter turns in place, standing and crouched | the Locomotion Pack (crouched: combined) | the unarmed ones, the pistol's arms | the rifle pack's |
| Jumps | the Locomotion Pack | the pistol pack's, standing and running | the rifle pack's jump up, loop and down; the Shooter pack's jump forward running |
| Aim | | the pistol pack's idle (its two-handed hold is an aim) | the Shooter pack's aiming idle; the rifle pack's crouching aim |
| Not aimed | | the aim, at the low ready (the Lowered layer) | the aim, at the low ready (the Lowered layer) |
| Fire | | *Shooting*'s first shot | the Slim Shooter pack's firing rifle |
| Reload | | the Reload pose | the Slim Shooter pack's reloading |

- **Routing.** Every way into a state that has variants goes through a **Pick** fork (Pick Idle, Pick Locomotion,
  Pick Crouch, Pick Turn90L, ...), whose ways out test Stance. So a variant needs no copy of the lines into its state,
  and each variant keeps the lines out of the state it stands in for.
- **Changing stance.** Between a state and its variants, a Stance change is a 0.25 s cross-fade (0.3 s standing). The
  locomotion and crouch variants share their unarmed state's sync group (**Gait**, **Crouch**), so a weapon taken out
  mid-stride carries the stride on in the new set, the feet in step. The script changes `stance` once the weapon
  coming up is halfway in the hands, and keeps it between two weapons, so a swap is one cross-fade.
- **Gaits.** The armed blend spaces (**Rifle Locomotion**, **Pistol Locomotion**, **Rifle Crouch**, **Pistol
  Crouch**) put every clip at the Locomotion rings' speeds (creep 0.8 m/s, walk 1.6, jog 4.19, sprint 6.5,
  crouched 1.51), each played at the rate that makes its feet cover that ground. The rifle pack moves as fast every
  way, so with a long gun out the script slows nothing going backwards; the pistol's backpedal and diagonals are
  0.7 and 0.85 of the speed, as its clips are.
- **What the clips were given.** Every cycle is in place with only its average travel taken out, phase-shifted so its
  right foot plants at phase 0 (as the unarmed set), and carries its foot-lock windows. Where a clip's feet drift on
  the ground through a plant, the stance foot is pinned by leg IK (two-bone, the toe held where it planted), so
  every direction at a walk and a jog stays within the unarmed set's foot-slide limits (the tests'). The rifle pack's jog back-right drifts
  too far for that; the legs of its jog back-left, mirrored, play in its place, under the true clip's arms. The turns'
  yaw is root motion on the Pivot, as the unarmed turns'.
- **Kneeling with the pistol.** Crouching standing still with the pistol out kneels down through the pistol pack's
  *stand to kneel* (**Pistol KneelDown**), and standing up from the kneel gets up through *kneel to stand*
  (**Pistol KneelUp**). On the move, a crouch is a cross-fade.

### Aiming in third person

Holding Aim in third person (`aimingDown`: not a shot from the hip, which only raises the weapon) does three things
over the camera's `aimSeconds`:

- **The lens narrows** from the third person's 60 degrees to the Camera Rig script's `aimFov` (45): SandboxCamera's
  `zoomMix`.
- **The mouse slows with it** (the camera's `zoomSensitivity`, the tangent of the half angles' ratio), so the view
  turns as fast on the screen as it did.
- **A hard depth of field comes on**, focused where the crosshair points (the camera's ray, the character's own
  body ignored; nothing hit, `dofFarFocus`): the aperture `aimDofAperture` (1.2), blur up to `aimDofMaxBlur` (32 px),
  a sharp band `aimDofRange` (1 m) deep round the target. Nothing nearer is kept sharp, so the character in front of
  the camera blurs too and only what the crosshair is on stays sharp. It goes off when Aim is let go.

The crosshair's spread is drawn at the lens it is seen through, so its ticks stay on the shot's cone as it zooms.

### Firing

**The weapons' numbers are Firing Line's** (its `FpsShared` table), set on each holder's SandboxGun in the Player
template:

| | Pistol | AK-47 | SAPS-12 |
|---|---|---|---|
| Rounds a minute | 380, a pull each | 600, held | 76, a pull each, pumped |
| Magazine, reserve | 12, 84 | 30, 150 | 6, 36 |
| Pellets | 1 | 1 | 9 |
| Spread from the hip, aimed (degrees) | 1.6, 0.25 | 2.6, 0.4 | 4.2, 2.6 |
| Recoil up, aside (degrees) | 1.5, 0.45 | 1.1, 0.5 | 4.2, 0.9 |
| Reach (m) | 140 | 220 | 60 |

**The trigger.** Fire (the left mouse button, RT) shoots the weapon in the hands, a round off its magazine a shot.
Fired from the hip in third person, the weapon comes up first (it aims), and stays up `fireAimHold` (0.6 s) after
the last shot: a pull made while it comes up fires as soon as it is up (`pullBuffer`, 0.35 s). A sprint, a reload,
the car and a weapon coming into the hands hold fire.

**Ammunition.** Each gun keeps its magazine and its reserve (`ammo`, `reserve`), so a weapon put away and taken out
again is as it was left. **R** (B on a pad) reloads, and so does a pull on an empty magazine: the weapon layer's
Reload plays for the gun's `reloadSeconds` (in first person, the viewmodel's reload clips), and near its end the
magazine fills from the reserve. Out of the reserve, the weapon is dry until the scene starts again: the Sandbox has no pickups yet.
The Player's HUD (its own canvas, in the Player template) shows them: **Ammunition**, bottom right, the magazine, the
reserve and the weapon's name; **Reloading** under the crosshair while it reloads. The script finds them under its
own node (`@child('HUD/Ammo')`), never the scene's, so a second Player drives its own.

**A shot is a raycast per pellet** (`examples/sandbox/Assets/Weapons/Scripts/SandboxGun.ts`, on each weapon's grip
holder), each its own way inside the spread. In third person a pellet is two raycasts:

1. From the camera through the crosshair, the middle of the screen, up to the weapon's reach: what the player aims
   at.
2. From the Muzzle to that point: what the bullet meets on its way there. A corner the camera sees past but the gun
   does not stops the shot.

In first person the camera's alone, as Firing Line fires. None meets the shooter's own body, the trigger zones or
the **Stair Ramp** layer (`passThroughLayers`: the ramps are there to be walked on, not seen), so a shot hits the
steps.

**What a hit does.** A dynamic body hit takes an `impulse` along the shot at the point it was hit (14 N·s from the
pistol, 18 from the AK-47, 27 shared by the shotgun's pellets, a few times a real bullet's), so a crate shoves and
tips, a barrel rolls, a ball flies; no hit speeds anything up by more than `maxPushSpeed` (2.5 m/s), so a 3 kg ball
is not shot off the course. Every hit sprays sparks and dust (**Bullet Impact**) and, on anything but a character,
leaves a hole (**Bullet Hole**, a decal that fades after 40 s), which moves with the body it is on. A character gets
the sparks and no hole, and no decal lands on one at all: the three Mannequin materials have **Receive decals** off
(see [Models and materials](models-and-materials.md#sections)), so a hole in the ground at a character's feet stops at
its shoes. The shot draws a **Tracer** from the
muzzle and, in third person, a **Muzzle Flash** (particles and a point light) and the weapon's shot (its cue in the
Player's **Sounds**); in first person the viewmodel's fire clip does both, through its animator's Event Actions.
Each shot cue has 16 [voices](audio.md#overlap) (a new shot steals the quietest), half a semitone of random pitch
and a tenth of random volume, so a held AK-47 rings on without cutting its 4.5 s shot short or repeating one sound.
These four are templates in `/Weapons/Effects`, each with its own script (`SandboxShotFx`, `SandboxBulletHole`,
`SandboxTracer`); the flash and the impact are the Firing Line's effects. Their glows (the flash, the sparks) take
only a tenth of the camera's exposure (`exposureWeight` 0.1): the Sandbox goes from day to night, and a glow tuned
for one blazes white in the other. Their smoke and dust are lit, and exposed like the scene. Each gun keeps its last
`maxHoles` (60) holes. Firing Line has one shot recorded: the three weapons fire it.

**Spread** is Firing Line's: a cone round the crosshair, from the hip spread to the aimed one as the weapon aims,
half again moving (2.2 times at a sprint), 0.7 times crouched, 2.5 times in the air, and wider the longer it fires
(bloom: an eighth of the hip spread a shot, up to 1.6 times it, settling at 5 degrees a second). The Player's HUD's
**Crosshair** shows it: a dot and four ticks, as far out as the shot spreads, shown with a weapon out and brighter
aimed (in first person, gone down the sights of a weapon with sights to look down).

**Recoil.** Each shot kicks the camera up and a little aside (the weapon's recoil, a quarter less crouched and a
third less down the sights) and shakes it (the shotgun hard); 70% of the pitch comes back (`recoilRecovery`), faster
the more is left, so a held AK-47 climbs. In third person the body takes the shot too: the gun's `fireTrigger`
(**PistolFire**, **RifleFire**, **ShotgunFire**) is raised on the animator by name, and the additive **Recoil**
layer (the arms, the chest and the head) plays that weapon's fire clip over whatever the body is doing: the Slim
Shooter pack's *firing rifle* for the rifle (played at 0.7 for the shotgun's slower shove), *Shooting*'s first shot
for the pistol. The state is entered on its trigger (no lines), and plays out back to the layer's empty **Off**.

**Every shot is an event.** The gun tells each shot as `weapon:Shot`, dispatched at its grip:
`{ gun, hit, hits, recoil }` (`hits`: every pellet's). It bubbles up to the character holding it, where
SandboxPlayer's `@eventListener('weapon:Shot')` applies the recoil. A script anywhere can hear every shot with
`@onEvent('weapon:Shot')`, for a hit marker, a sound or a score, without the gun knowing about it. The weapon in
the hands is the player's `weapon` field. Setting it sends `weapon:Equipped` (the weapon, and the one before),
which shows that weapon's model in the hand. See [Events](../scripting/events.md).

What the weapons do not do yet: nothing in the Sandbox takes damage (each gun's `damage` is kept for the game modes
to come), and there is no draw or holster animation in third person (the arms move straight into the hold and the
weapon appears in the hand).

## First person

**V** (the d-pad's down on a pad) switches to first person and back. The Camera Rig folds in to the character's
eyes over `viewSeconds` (0.3 s): no arm, no shoulder offset, `eyeHeight` over the feet (`eyeStand` 1.62 m, or
`eyeCrouch` 1.1 m crouched, eased), no follow damping and no collision (the camera is inside the capsule), the pitch
free to 85 degrees up and down, and Firing Line's lens: 78 degrees, 5 more at a sprint.

**The body** stays: once the camera is in at the head, the Mannequin and the weapon in its hands are drawn into the
shadows alone ([`Node.shadowOnly`](../scripting/node-api.md#shadow-only)). No camera sees them, but they keep
animating and their shadow stays on the ground. The body faces the camera at once, standing still too (no turn in
place), and sprints only ahead (within `sprintAngle`, 50 degrees). In the car it is third person whatever you
chose: the car's camera sees the driver.

**The viewmodels** are Firing Line's: the arms and each weapon, with their own clips and animators (Idle, Walk, Run,
IdleAim, WalkAim, and the one-shots Equip, Fire, AimFire, Reload, and the shotgun's Pump, ReloadStart and ReloadEnd),
in `/Weapons/Viewmodels`. They hang under the camera, drawn as viewmodels: through a 58 degree lens
(`viewmodelFov`), and pulled clear of a wall in front of the camera (`viewmodelReach`). The one of the weapon in the
hands shows; its animator is told whether the body moves, sprints or aims (Moving, Sprinting, Aim), and the script
fires its one-shots: Equip as it comes up (it fires once that is over), Fire or AimFire a shot, the shotgun's Pump
after, Reload (the shotgun's three in turn, the shells loaded near the end of the middle one).

**Aiming down the sights** (hold Aim): the lens narrows to the weapon's (`aimFov`: 62 degrees the pistol and the
shotgun, 52 the AK-47), the mouse slows to `adsSensitivity` (0.55) of itself, the body walks at the weapon's
`aimMove`, the background softens with depth of field focused where the crosshair points (the weapon, nearer than
`dofNearCutoff`, stays sharp), and the crosshair goes for the sights. The shotgun has no aim clips: its whole
viewmodel comes in to the sights instead (`aimOffset`).

## Crouching

**C** (the right stick's click) crouches, and again stands up: the Controller's **Crouch** action with
`crouchToggle` on. A sprint or a jump stands it up too. The Character shortens its capsule to its
`crouchCapsuleHeight` (1.2 m), feet kept, and moves at `crouchSpeed` of its jog (1.5 m/s); it stands back up only
where the full capsule fits, so under something low it stays down until it walks out, and a jump there is dropped
(see [Crouching](../scripting/characters-and-controllers.md#crouching)). The animator reads the Character's
`crouched` (**Crouching**).

**Crouch Locomotion** is the unarmed crouch's blend space (an idle and the walk in eight directions, over the
walk's axes); the base layer's **Crouch** plays it, and **CrouchTurn90L** and **CrouchTurn90R** turn in place (their
turn on the Pivot, as root motion). With a weapon out, **Rifle Crouch** and **Pistol Crouch** take over, and the
rifle's quarter turns are its own (see [Moving armed](#moving-armed)). They are the **Crouching** group: Idle,
Locomotion and Stairs crouch when Crouching comes on, through **Crouch Down** (where the pistol kneels when it stands
still), and Crouch stands up into Idle when it goes off.

**The unarmed crouch is combined.** Mixamo has no unarmed crouch walk in the packs the Sandbox uses (its *Crouch
Walking* holds a rifle), so each unarmed crouch clip is two:

- the hips and the legs of the rifle pack's crouch clip of that direction (its idle, its walk, its turn), so the
  stride, the plants and the foot locks are motion capture;
- above the hips, the crouched upper body of *Crouch To Stand*, the moment its hips rise through the crouch walk's
  height (the hands off the ground, the head up), held, its spine rocking with the rifle clip's spine so the chest
  still breathes and sways with the stride.

**Standing up** from the unarmed crouch, standing still, plays *Crouch To Stand*'s rise (**CrouchStand**) into Idle;
on the move, or with a weapon out (but the pistol's kneel), it is a cross-fade.

**Looking round crouched** turns the head alone. The **Look Head** layer (additive, the **Head** bone mask: the neck and
the head) plays the **Head Look** blend space, the Look blend space's nine directions on clips of their own
(**HeadLookC** to **HeadLookDR**): each look pose's head turn, 85% of it (up to 76 degrees round, 38 up or down),
on the neck (40%) and the head (60%). The script hands the look-at's weight from Look (`lookWeight`) to Look Head
(`lookHeadWeight`) over a quarter of a second as the body crouches, and back as it stands, so the crouched trunk
stays as the crouch holds it while the head follows the camera.

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

So the shipped clips keep the rotation as authored, with only the travel removed.

## Adding clips

Jog is the pack's running set. A better clip goes in through the editor: import it into the project, take its ground
travel out as above, set its foot-lock windows (**Detect**), and put it in its blend space or state in place of the one
it replaces. An armed clip goes in its weapon set's blend space or variant state, under the set's name (`Rifle ...`,
`Handgun ...`); a state that has no variant yet gets one by adding a state to its group and a way out of its **Pick**
fork on Stance.

## Limits

- **The NPCs** have no health and do not die, and no hearing but of shots: footsteps and the car's engine go
  unheard. Their sight is the AI Controller's, a ray to each character every few frames, so a crowd costs. A cover
  spot is good against one shooter only, and the probes find none where the course has nothing to crouch behind.

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
- **States with no armed clips.** The start, the stops, the turn round, the running turns, the stairs, the soft,
  hard and rolling landings and the car have no armed variant: the weapon layer holds the set's arms over the
  unarmed legs, and the chest follows those clips' hips, so the weapon tilts with them for as long as they play.
- **The pistol's gaps.** The pistol pack has no sprint, no diagonal walks, no crouch walk and no turns in place: the
  pistol sprints on the unarmed sprint, and the rifle pack's legs and the unarmed turns play under the pistol's arms
  for the rest.
- **The unarmed crouch** is combined from two clips (see [Crouching](#crouching)), not captured as one.
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
