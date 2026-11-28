# Reactive ragdolls

How the engine's reactions ([editor](../editor/reactions.md), [scripting](../scripting/reactions.md)) work, the
systems they are modelled on, and where the code is. A reactive ragdoll is a physics body whose joints have
muscles: it falls, tumbles and lands as physics says, but it tries, the way a person does, to stay up, to
break its fall and to protect its head. Reactions run on the Jolt backend only (`capabilities.reactions`; see
[Physics backends](physics-backends.md#joint-drives)).

On its feet a reaction is physical animation (Unreal's Physical Animation component, RootMotion's PuppetMaster):
the legs and hips kinematic on the animation (`Ragdoll.setKinematic`, moved by velocity each step to the
animation's pose a frame on), the upper body dynamic on firm muscles whose targets carry the animation's spin
(`ReactionBody.spin`, measured between frames; Jolt's motors in position-and-velocity mode), drawn against the
hips as animated that frame (`PhysicsMappingSource.anchorPart`). A stagger steps on dynamic legs
(`physics/reactive/balancer.ts`: capture-point steps aimed 0.2 s ahead, at most 0.40 m, tiring ×0.7 a step after the
second, a StayUpright-style push on the trunk), the capsule following the body (`CharacterNode.followBody`). The
character keeps its control (`ReactionController.hasControl`).

## Background

### Euphoria

NaturalMotion's Euphoria, used by Rockstar from GTA IV on, is the best-known system of this kind. What its
public message set (exposed to GTA V scripts and documented by the ScriptHookVDotNet project) shows of it:

- **Muscles.** Every joint is an angular spring-damper toward a target. Stiffness is given as a natural
  frequency in rad/s, typically 6 to 16 (12 by default); damping as a ratio, 1 critical. Global messages scale
  them all: `setStiffness`, `setMuscleStiffness`, `setCharacterStrength`, `setCharacterHealth`.
- **Behaviours.** About 84 of them (`catchFall`, `rollDownStairs`, `highFall`, `bodyBalance`, `staggerFall`,
  `shot`, `bodyWrithe`, …), each limited to a mask of body parts (`fb` the full body, `ub` the upper,
  `la` the left arm…), running together in priority order. Behaviours start others: `shot` leads to
  `catchFall` or `rollDownStairs`; `highFall` to a windmill and pedal, then `catchFall` or a foetal curl.
- **Reflexes are targets.** A behaviour does not apply forces; it moves the muscles' targets. `catchFall`
  predicts where the body will land about half a second ahead and sends the hands there, one after the
  other, softening on contact; a landing bends the knees about 0.3 s before impact and gives up below an
  uprightness of 0.9; a wound is held by the hand after 0.2 s, for about 2 s, while the upper body's
  stiffness drops and comes back over 0.4 s; the head tucks its chin with the neck at stiffness 14.

Defaults worth reusing came from it: `catchFall` arms 15, torso 9, legs 6; `highFall` body 11 and limbs
7.9 rad/s; `rollDownStairs` stiffness 11, damping 1.4, force 0.6; `staggerFall` legs 13 falling to 8, ×0.7
per step; `bodyWrithe` 13, damping 0.5, period 1 s. The engine gives stiffness in Hz: rad/s ÷ 2π.

### PuppetMaster

Root Motion's PuppetMaster (Unity) drives a ragdoll "puppet" from an animated "target" skeleton:

- **Muscles** are slerp drives toward the target's local rotations.
- **Pins** are an unphysical world-space force toward the target's pose, which keeps a hit character on its
  feet. A collision takes pin weight away (by "collision resistance") and it comes back at about 1/s.
- **Mapping weight** is how much the drawn skeleton follows the puppet or the animation.
- A part that drifts further than a "knock-out distance" from its target unpins the character, which falls.
  It gets up once the hips move slower than 0.3 m/s, face up or face down, blending to the animation over
  0.2 s.

### Unreal Engine

Unreal's Physical Animation component gives each body orientation, position and velocity strengths with a
maximum force and torque, in the joint's frame (a muscle) or the world's (a pin), applied to a bone and
everything below it. UE5's Physics Control expresses strength in Hz with a damping ratio and takes the
skeletal animation as the target. *Star Wars Jedi: Fallen Order* added a constraint from the hips to the
animation and dropped to a free ragdoll once the hips strayed too far.

### Control

- **Gains from frequency.** With Ω = 2πf and damping ratio ζ, stiffness k = I·Ω² and damping c = 2ζIΩ:
  numbers that mean the same on any mass.
- **Stable springs.** An implicit (stable PD) update, `ω' = (ω + h·Ω²·e) / (1 + 2ζΩh + Ω²h²)`, cannot blow up
  at any stiffness; it is the soft-constraint maths of Jolt's and Rapier's motors.
- **Gravity feed-forward.** Each joint adds the weight it holds up times its lever, so a soft muscle does not
  sag.
- **Balance.** SIMBICON's foot placement and the **capture point**, `x_cp = x_com + v·√(h/g)`: the point a body
  must step to in order to stop. Step there, or fall.
- **Building the body** (Catto, GDC 2012; Jolt's `Stabilize`): uniform density, child-to-parent mass ratios
  kept within bounds, fat shapes, the hand-off velocity taken from two animation frames, and depenetration at
  spawn.

## What makes a reaction convincing

What shipped games and the literature do about the things that most often make a reactive ragdoll look wrong, with
the numbers they use. Euphoria's parameter names and defaults are the library defaults (the GTA V message set as its
helpers document it); the shipped values are tuned per situation and not public. NaturalMotion's stiffness reads as
an angular frequency in rad/s, critically damped at damping 1: Euphoria characters run soft but critically damped,
about 1–2.5 Hz (stiffness 6–16 is f = k/2π, 0.95–2.5 Hz), where Jolt's motors take Hz and a damping ratio.

### Limbs that wiggle

- Euphoria puts the visible jerk of a hit in the **spine and neck, not the arms**: its shot snap acts on the spine
  and neck only (SnapMag 0.4, UnSnapRatio 0.7, as torques), and a chest hit adds a short spine torque (ShockSpin
  50–90, decaying ×4).
- A bullet is **shaped**, not an instant point impulse (ConfigureBullets): spread over 0.1 s along the spine, a share
  of it applied to the whole body as one rigid body (rbRatio 0.5), and a counter-push on the pelvis 33 ms later
  (counterImpulseMag 0.5). Its "looseness fix" applies only the centre impulse and the spine's twist.
- **Every arm has a job** after a hit: reach for the wound, brace, point the gun, fling. Arms left tracking a walk's
  swing after a hit is what reads as wobble. Stiffness: body 11, arms 10, neck 14 (stiffer than the body); damping 1.
- PuppetMaster's anti-wobble is world-space **pins** on top of the muscles (pinWeight 1, pinPow 4), hits lowering the
  pins locally and the pins coming back at a set speed; internal collisions off while pinned.
- Unreal: ramp a physical-animation profile's strength from 0 to 1 rather than editing it; don't apply local physical
  animation to a body with no physical parent (the pelvis).

### Balance steps

- Euphoria's balancer aims each step at where the body will be a short time ahead (predictionTime 0.2 s; its
  StaggerFall 0.1 s: "larger values give fewer, bigger steps"), steps 0.1 m high on legs of stiffness 12 (about
  1.9 Hz), re-steps when the feet are too far apart (legsApartRestep 0.2) or together, weakens the legs step by step
  (×0.7 per step after the second) and slumps after about four steps (NumStepsTillSlump 4), giving up below
  giveUpHeight 0.5.
- The capture point x + v·√(z/g) is about v·0.3 s for a 0.9 m pelvis: aiming short of it gives several short steps
  instead of one long one (Pratt, Carff, Drakunov, Goswami 2006). SIMBICON aims the swing hip at d·0.5 + v·0.2 with
  states of about 0.3 s.
- People react in about 82 ms, shift weight by 130–138 ms and put the first foot down at 164–192 ms; a first step of
  0.84–1.03 m only follows an extreme lean of 30°.
- GTA V and RDR2 end a stagger they survived with a short recovery clip matched to the stance (narrow, wide, left,
  centre, right).
- A stagger that moves the character's capsule under its ordinary walk takes the walk's strides (0.8–1.5 m): that is
  the "steps too far apart" look.

### A body that looks dead

- Euphoria never drops a living body's muscles to zero: catching a fall arms 15, torso 9, legs 6; a high fall, a
  smart fall and a foetal curl 9–11; rolling down stairs 11, each with the head looking. A death relaxes the upper body
  over 2 s and the legs over 0.4 s, so the legs buckle first. Its BodyRelax at 50 is only half relaxed.
- PuppetMaster keeps 30% muscle strength when knocked out, and its fall behaviour blends a writhe clip and a
  catch-fall clip by the pelvis's height and fall speed, so the body always follows a living pose.
- CryEngine's "fall and play" keeps the ragdoll stiff: with few contacts it follows a falling animation, on the ground
  the first frame of the stand-up clip that matches best; going limp is a separate call.
- GTA V and RDR2 pose the hands during a ragdoll (fist, grab, flat on the floor, flailing).

### Pain

- Euphoria's "conscious pain": a lean of the spine up over 0.2 s, held, back over 1.5 s; the head looks at the wound
  for 0.3–0.8 s; the hand reaches it after 0.2 s and holds it 2 s. A gut shot folds (spine bend 2, hips 1, for 2 s);
  one from behind arches (spine 4, for 0.7 s, no step for 0.3 s).
- GTA V and RDR2 add directional additive flinches, an injured stance, injured locomotion and get-ups, and writhing on
  the ground.
- People's startle response comes in 72–109 ms and their corrective response at about 300 ms.

### A hit that depends on where it lands

- An **arm**: the arm goes loose for a quarter second, the hips turn (hipYaw 0.8) and a step turns with it; the other
  hand reaches for it.
- A **leg**: the leg weakens (legInjury 0.3, for 0.4 s), the knee gives at 0.3 s, the character limps; a hard one
  folds it to its knees after about 0.7 s of trying to stand, arms out.
- The **chest**: a spin and the pain lean; the **gut**: a fold; the **back**: an arch; the **head**: the neck loose
  (stiffness 14 ramping back over 0.4 s) and a snap.
- The Last of Us Part II stuns on a leg hit and split the thigh into two capsules so knee hits count as leg hits;
  RDR2 keeps injured-left-leg, injured-right-leg and injured-torso states, each with its own locomotion, aim,
  flinches and recoveries; CryEngine picks a reaction from a table by body part, shot origin, movement and stance.

### Getting up

- GTA V and RDR2 classify the lying pose (front, back, either hip, arms down, left side, right side) and roll a body
  lying on its side or front onto its back first, then rise in stages (to the knees or seated, then to the feet).
- Unreal's ALS reads face up from the pelvis's roll and turns the target yaw by 180° when face up; a pose snapshot
  blends into the get-up.
- Start the get-up when the body has stopped rolling (Euphoria: roll speed under 0.2 for 0.5 s), not after a fixed
  wait (PuppetMaster's default 5 s getUpDelay is a leftover of that).
- Join the get-up clip at the frame that matches the lying pose (EA's patent US10388053 scores candidate start frames
  against the ragdoll's pose), not at a first frame that may lie still for seconds.
- A robust facing test: the belly normal averaged over pelvis and chest against up; above +0.35 face up, below −0.35
  face down, between them on its side; with hysteresis.

### Falling from a vehicle

- GTA V plays a jump-out clip, then its falling behaviours: catch the fall 0.3 s before impact, curl into a foetal
  shape when it cannot land upright (below uprightness 0.9), arms up to land, roll on landing, head kept off the
  ground; a fall under 15 m/s counts as recoverable.
- A parachute landing fall: feet and knees together, knees bent, chin tucked, elbows in, roll through five points of
  contact. Jumping from a car: away from it at an angle, chin to chest, limbs in, land on a shoulder and roll.
- In a real fall the arms go out by reflex; the wrists land about 38 ms before the pelvis.

### What Cleo changes for it (2026-11-27)

| The look | What it was | The change |
|---|---|---|
| Dead bodies | Off its feet every muscle aimed at where the body already was (`hold`), and a behaviour's offset on that ran away | Muscles follow a reference pose (the pose it fell in, a clip, a brace), firm with damping 1, never below 0.3 while alive; relax only once still |
| Bail and falls | A brief stiff spine and a runaway arm | Tuck in flight, arms toward the ground 0.3 s before it, roll on landing, head protected |
| Steps too far apart | A shove on the capsule under the walk's strides | A balancer: short steps (0.25 s, at most 0.40 m) aimed 0.2 s ahead, legs weakening per step, a fall after four |
| One hit for all | A kick of at most 1.2 m/s anywhere; a leg's hit put on the chest | Shaped impulses and a reaction per zone: head, chest, gut, back, arm, leg |
| No pain | A 0.25 s weakness; the wound forgotten after 2.3 s | A pain lean, the head looking at the wound, the hand holding it 2 s, wounds kept by severity, hurt values for the graphs |
| Wrong get-up | The face-down slot held a clip that starts on its back; *Stand Up* lies 1.4 s before it rises | Lying classes, a roll onto the back, the clip joined where it starts to rise |
| Wiggle | Feedback on a pose a worker step old, the animation's spin dropped | Latency-compensated reach, the spin kept (fast layers were still in the muscles' target: see the next section) |

## Muscles and a nervous system (2026-11-28)

Endorphin and Euphoria are sold as simulating "the body, its muscles and the motor nervous system that drives
them". What is public of how, and what Cleo does with it. Arms still wiggled after gunshots and balance was still
poor after the round above; the causes found in Cleo are listed with each part.

### Muscles

- **Euphoria's muscle** is an angular spring-damper on every joint, mass-normalised: stiffness reads as a natural
  frequency (default 12, range 6 to 16, about 1 to 2.5 Hz), damping as a ratio (1 critical; soft limits keep 0.9 to
  1.1). Gravity compensation is part of it (`activePose.useGravityCompensation`, the balancer's
  `opposeGravityLegs`/`opposeGravityAnkles`). `setMuscleStiffness` (default 1, 0 to 20) is a separate, undocumented
  impedance knob. Per behaviour: `shot` body 11, arms 10, neck 14; `pointGun` arms 14; `bodyBalance` arms 9.
- **The chain.** PhysX articulations, the engine Euphoria shipped on, size a joint drive's spring from the whole
  chain; an ordinary joint "using just the mass of the two bodies connected". That is most likely what morpheme's
  *drive compensation* amounts to (its node docs are not public). Cleo's drives were sized from a limb against its
  parent part alone: in a chain whose parents are held by muscles of their own, an elbow asked for damping 1 got
  about 0.6, a shoulder about 0.8, and a hit set the arm ringing. A drive now names its chain
  (`DriveRecord.chain`, a ragdoll's parts), and its spring meets what it holds up against the rest of the body.
- **Looseness.** A bullet adds looseness to the struck part (1 per bullet), which recovers over 0.4 s from a floor
  of 0.1: a second round on a weak arm keeps it weak rather than restarting its ramp from nothing. Bullets are
  scaled by balance state (both feet, one, airborne).
- **What muscles reach for.** Euphoria's targets settle (`spineBlendZero`: the spine eased toward its neutral pose),
  the animation's own angular velocity is scaled down (`angVelScale`), and arms are never left fighting their joint
  limits (soft limits; targets kept inside them with a margin) or each other (self-avoidance; PuppetMaster turns
  internal collisions off while pinned). Cleo's muscles were reaching for the whole drawn pose, a weapon's recoil
  and a flinch clip in it, with that pose's frame-to-frame jerk fed forward as a velocity twice over: a 0.1 rad
  recoil step became a 0.47 rad spike in an arm's target.
- **Stable springs.** Stable PD (Tan, Liu, Turk 2011) solves a spring against the next step's state, so high gains
  stay stable at a large time step; Jolt's motors are springs solved the same implicit way (Catto 2011), joint by
  joint (not the whole body's mass matrix).

### A nervous system

- **Behaviours ask, limbs decide.** NaturalMotion's patent US9449416 (Chapman) describes behaviours ("abilities":
  balance, hazard protection, wound response, pointing, looking) sending requests to one controller per limb type
  (arm, leg, spine, head): desired positions, orientations and velocities with weights and gains, combined as a
  weighted combination and solved by IK, in a reference character scaled by mass, length and the time it takes to
  fall its own height. US20110267356 (Rennuit) adds compensating wrenches: what pushes one part pushes another
  back, so the net force on the body is about nothing.
- **Endorphin** began as Torsten Reil's evolved neural controllers (Reil and Husbands 2002: a 10-neuron recurrent
  network driving PD "torsional springs" toward target angles, at 50 Hz); what shipped are timed, sensor-driven
  behaviours. Joints a behaviour does not drive hold their pose ("leg and torso stiffness", default 0.5), and it
  steps at 120 Hz.
- **Timing in a body.** A muscle activates in about 10 ms and lets go in about 40 ms (Millard 2013). A stretch
  reflex answers in 20 to 45 ms, a long-latency one in 50 to 100 ms, anything deliberate in 150 ms or more (Kurtzer
  2015). A startle runs down the body: blink 20 to 40 ms, neck 75 to 120, shoulders 100 to 120, arms 125 to 195.
- **Bracing.** Co-contraction makes a joint stiffer without turning it (Hogan 1984), and it is how a body braces
  rather than by quicker reflexes, whose delays make a limb shake (Milner 1995).

### Balance

- **Euphoria's balancer** aims each step where the centre of mass will be (`predictionTime` 0.2 s, the hip 0.3 s),
  re-steps when the feet end too wide (hip width plus 0.2 m), grips with its feet (friction 2.25 against 0.75
  elsewhere), compensates gravity in hips, knees and ankles, leans at the hips and ankles before it steps, puts its
  arms out on a push or a fast turn (`bodyBalance`: 1.2 rad/s) and windmills them (`armsWindmill`), helps itself with
  small conditional forces (`stayUpright`, `resistAcc`: a cheat it admits to) only while a foot can support them,
  and fails on purpose (an abort lean, a give-up height, its legs weakening ×0.7 per step).
- **The literature.** SIMBICON (Yin 2007) tracks the torso in the world through the stance hip; Coros et al. 2010
  compensate gravity with virtual forces through the legs' Jacobian transpose ("allows significantly lower gains")
  and place the foot from an inverted pendulum. Tried in Cleo as torques at the joints alone (no outside force), the
  planted legs' virtual force and the hips' trunk control made the body fall from shoves it otherwise steps out of:
  the joint-space controller fights the stepping's targets without a whole-body solve. The joint feed-forward
  torques it needs stay in the physics layer (`PhysicsWorld.setJointTarget`'s `torque`), for a controller that does.

### What Cleo changes for it

| The fault | What it was | The change |
|---|---|---|
| Arms ring after a hit while firing | Muscles reached for the drawn pose, recoil and flinch in it, its jerk fed forward twice | A layer can be **drawn over the body** (`AnimationLayer.body: 'overlay'`): the muscles reach for the pose without it, the layer drawn over the simulated body. The spin they follow is smoothed and scaled (**Follow spin** 0.6), led once (the motor's own lead, at most 0.3 rad) |
| Busy arms shear at the shoulder | A hand on a weapon drawn 30% simulated in the world against a chest drawn wholly simulated | The skin drawn parents first: a part is blended against its parent as drawn |
| Under-damped arms | Springs sized against the parent part alone | Sized against the rest of the body (`DriveRecord.chain`) |
| Elbows press their stops | Off-hinge animation (a forearm's roll) on a 2° cone, its swing spring sized by the roll axis; twist measured from the bind pose | Knee and elbow targets turned about their hinge alone, 3° inside its range; a narrow cone's swing sized by its smaller axis; twist measured from the joint's own zero |
| Hands and arms chatter on the body | Self-collision in weapon poses | Arms and hands pass through the body while it stands (back 0.5 s after it leaves its feet) |
| Gains jump | Weakness and tracking switched in a frame | A nervous system (`nerves.ts`): every gain moves with a muscle's time constants (15 ms up, 50 ms down), the upper body tenses after a hit from 35 ms (**Tense**), the head turns at 0.1 s, the pain lean at 0.15 s, the hand at 0.18 s |
| Weakness restarts per bullet | Each wound its own ramp | Looseness per part, adding up and wearing off over **Recover in**, never below **Weakest** |
| Staggers fall to a moderate shove | The swing foot always the one farther from the capture point, never crossing: a push to the side shuffled the wrong foot; a shove counted twice; a walk's arm swing in the upper body; planted legs as soft as a hanging one; the Mannequin's thighs able to extend only 5° | The foot that best catches it steps (crossing by up to 8 cm); one shove; the upper body held as shoved; planted legs sized to the weight they carry (`JointDrive.inertia`); feet gripping at 2; **Arms out**; the Mannequin's thighs remade (58°, 32° forward) |

With them, the procedural humanoid stays up to a 145 N·s shove in every direction in one or two short steps
(`tests/reactionBalance.test.ts`), and an arm's ringing after a chest hit while a recoil fires drops by about two
thirds with the recoil drawn over the body (`tests/reactionWiggle.test.ts`).

## How Cleo maps them

| Idea | In Cleo |
|---|---|
| Muscles (Euphoria), slerp drives (PuppetMaster) | Joint drives in the physics layer: `PhysicsWorld.setJointDrive` / `setJointTarget` |
| Pins | Body pins: `PhysicsWorld.setBodyPin` / `setBodyPinTarget`, the **Strings** of a set |
| Mapping weight | The animator's physics mapping: `Animator.enablePhysicsMapping`, `Ragdoll.setMapping` |
| Behaviours with masks | `physics/reactive/behaviours.ts`, each moving the parts of its regions |
| The task layer | `ReactionController`'s states: animated, hitReact, stagger, falling, tumble, down, getUp, recover, dead |
| Message parameters | The spec tables of `reactionSet.ts`: defaults, the tolerant parse, the editor's sliders and these docs |
| Animation as input | The animator keeps playing under the body; its pose is what the muscles reach for, and behaviours edit it |

## The frame

Inline (physics on the main thread):

1. `PhysicsSystem.update` asks every reacting controller for its targets (`_preStep`). It composes the
   animation's pose (from the last frame) with the running behaviours by weight, and sends the muscles' targets
   and gains and the strings to the world.
2. The world steps. Jolt applies the drives through its motors, solved with the joints
   ([Physics backends](physics-backends.md#joint-drives)).
3. After the step (`_postStep`) the controller measures the body (`BodySensors`: centre of mass, uprightness,
   contacts, support polygon and capture point, a ballistic sweep for the coming impact, the terrain under it),
   moves between states, and fires `reaction:*` events.
4. Scripts run; `ModelNode.update` poses the animation (the target) and then draws the skin from the bodies,
   blended per part by mapping weight.

With the physics worker, step 1 happens in `endFrame` before the step is sent, and the drives travel with the
step ([Physics threading](physics-threading.md#joint-drives)).

The ragdoll exists only while a reaction runs: it is made from the pose the character holds when something
happens to it, and taken away once it is back on its animation.

## Code

| Where | What |
|---|---|
| `src/physics/pal/drive/driveSolver.ts` | The shared drive and pin solver, and the motor velocity the native motors aim for |
| `src/physics/pal/drive/driveCopy.ts` | Copying drives and pins into the physics worker |
| `src/physics/pal/cannon/cannonMotors.ts`, `matchedConeTwist.ts` | cannon's native muscles, and its twist measured from the joint's own pose |
| `src/physics/pal/jolt/joltWorld.ts` | Jolt's native motors |
| `src/physics/ragdoll.ts` | The powered ragdoll: parts, muscles, strings, mapping |
| `src/animation/animator.ts` | Physics mapping: the target pose kept, the skin drawn from the bodies |
| `src/physics/reactive/reactionSet.ts` | Reaction sets: the spec tables, presets and the parse |
| `src/physics/reactive/bodySensors.ts` | What the body measures each step |
| `src/physics/reactive/reactionBody.ts` | Targets per part: blending, reaching (two-bone IK), looking, bending, poses |
| `src/physics/reactive/behaviours.ts` | The behaviours and the stepping balance |
| `src/physics/reactive/reactionController.ts` | The states, the Collider hand-off, get-up, events, the script API |
| `src/physics/reactive/balancer.ts` | The stagger's steps: which foot, where, planted legs on the weight they carry, the helping hand |
| `src/physics/reactive/nerves.ts` | Between the behaviours and the muscles: tension after a hit, gains moving with a muscle's time constants |
| `applications/editor/src/features/rig/reactions/` | The Reactions tab, the test bench and its timeline |

## What the tests hold

`tests/pal/drives.test.ts` holds the drives on every backend (see
[Physics backends](physics-backends.md#joint-drives)); `tests/poweredRagdoll.test.ts` holds a powered ragdoll
standing on its animation and its mapping on every backend; `tests/reactions.test.ts` runs the reactions on a
procedural humanoid on Jolt, inline and in the worker, and checks that cannon and Rapier give none:

| Scenario | Held to |
|---|---|
| A small hit | flinches, then is back on its animation (Hit, Started, Recovered) |
| Shot in the forearm | the arm comes in and the other hand holds the wound |
| Tripped forward | the hands reach the ground before the head; it lies down and gets up |
| Off a 3 m ledge | the knees bend before the feet land |
| A push sweep | steps never fewer for a harder push, stays up below the fall threshold, falls above it |
| Down a flight of stairs | a hand stays near the head as it tumbles |
| Bailing out at 10 m/s | tumbles, comes to rest and gets up, with no NaN |
| Killed | falls limp and never gets up |
| With the physics worker | trips, lies and gets up as it does inline |
| Shot in the chest while a recoil fires (`reactionWiggle.test.ts`) | with the recoil drawn over the body, the arms ring less than half as much, the elbow does not reverse more than 3 times a second, the chest still sways |
| Shoved forward, back, left and right, 60 to 145 N·s (`reactionBalance.test.ts`) | stays up to 120 N·s, in steps no longer than 0.46 m; falls only after stepping |

The golden physics traces are unchanged: a world with no drives steps exactly as before.

## Sources

Muscles and a nervous system (2026-11-28):

- GTA V's NaturalMotion messages: the ScriptHookVDotNet docs (one page a message, such as
  [ShotHelper](https://nitanmarcel.github.io/shvdn-docs.github.io/class_g_t_a_1_1_natural_motion_1_1_shot_helper.html))
  and [alexguirre's message list](https://gist.github.com/alexguirre/915f90002f44622e09dc5c793c18b3ef).
- [The endorphin user guide](https://pdfcoffee.com/endorphin-user-guide-pdf-free.html); Torsten Reil on
  [morpheme 2.0](https://www.gamedeveloper.com/programming/q-a-naturalmotion-s-reil-on-the-evolution-of-morpheme);
  Reil and Husbands, [Evolution of central pattern generators for bipedal walking](https://users.sussex.ac.uk/~philh/pubs/reilhusbandsIEEE.pdf) (2002).
- NaturalMotion patents [US20130222433 / US9449416](https://patents.google.com/patent/US20130222433) (behaviours,
  limb controllers, weighted requests) and US20110267356 (implicit and explicit control, compensating wrenches).
- [PhysX articulations](https://archive.docs.nvidia.com/gameworks/content/gameworkslibrary/physx/guide/3.3.4/Manual/Articulations.html):
  drives sized from the whole chain.
- Tan, Liu, Turk, [Stable proportional-derivative controllers](https://www.jie-tan.net/project/spd.pdf) (2011);
  Coros, Beaudoin, van de Panne, [Generalized biped walking control](https://www.cs.ubc.ca/~van/papers/2010-TOG-gbwc/paper.pdf) (2010);
  Yin, Loken, van de Panne, [SIMBICON](https://www.cs.ubc.ca/~van/papers/2007-siggraph-simbicon.pdf) (2007).
- Muscle timing: Millard et al. (2013), [Flexing computational muscle](https://pmc.ncbi.nlm.nih.gov/articles/PMC3705831);
  reflex latencies: Kurtzer (2015), [Long-latency reflexes](https://www.frontiersin.org/journals/integrative-neuroscience/articles/10.3389/fnint.2014.00099/full);
  the [startle response](https://en.wikipedia.org/wiki/Startle_response); co-contraction: Hogan (1984), Milner (1995).
- [PuppetMaster](http://root-motion.com/puppetmasterdox/html/class_root_motion_1_1_dynamics_1_1_puppet_master.html)
  (internal collisions off while pinned).

Earlier rounds:

- ScriptHookVDotNet's NaturalMotion helpers (the GTA V message set and its defaults):
  [CatchFallHelper](https://nitanmarcel.github.io/scripthookvdotnet/scripting_v2/GTA.NaturalMotion.CatchFallHelper.html),
  [RollDownStairsHelper](https://nitanmarcel.github.io/scripthookvdotnet/scripting_v2/GTA.NaturalMotion.RollDownStairsHelper.html),
  [SetFallingReactionHelper](https://nitanmarcel.github.io/scripthookvdotnet/scripting_v2/GTA.NaturalMotion.SetFallingReactionHelper.html),
  [the namespace](https://nitanmarcel.github.io/shvdn-docs.github.io/namespace_g_t_a_1_1_natural_motion.html);
  and [a parsed list of the behaviours and their parameters](https://gist.github.com/alexguirre/915f90002f44622e09dc5c793c18b3ef).
- [PuppetMaster documentation](http://root-motion.com/puppetmasterdox/html/).
- Unreal Engine: [FPhysicalAnimationData](https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/FPhysicalAnimationData),
  [PhysicsControlData](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/PhysicsControlData);
  [Leveraging physical animation to sell Force powers in Jedi: Fallen Order](https://gamedeveloper.com/programming/leveraging-physical-animation-to-sell-force-powers-in-i-jedi-fallen-order-i-).
- [Wobbledoll: developing an advanced full-body ragdoll system](https://80.lv/articles/wobbledoll-developing-an-advanced-full-body-ragdoll-system/) (80.lv).
- Erin Catto, [Ragdolls](https://box2d.org/files/ErinCatto_Ragdolls_GDC2012.pdf), GDC 2012.
- Tan, Liu and Turk, [Stable Proportional-Derivative Controllers](https://faculty.cc.gatech.edu/~turk/my_papers/stable_pd.pdf).
- Yin, Loken and van de Panne, [SIMBICON: Simple Biped Locomotion Control](https://www.cs.ubc.ca/~van/papers/2007-siggraph-simbicon.pdf), SIGGRAPH 2007.
- Coros, Beaudoin and van de Panne, [Generalized Biped Walking Control](https://www.cs.ubc.ca/~van/papers/2010-TOG-gbwc/paper.pdf), SIGGRAPH 2010.
- Faloutsos, van de Panne and Terzopoulos, [Composable Controllers for Physics-Based Character Animation](https://www.cs.ubc.ca/~van/papers/2000-siggraph-interactive.pdf), SIGGRAPH 2001.
- [Jolt Physics](https://github.com/jrouwe/JoltPhysics): [SwingTwistConstraint](https://jrouwe.github.io/JoltPhysics/class_swing_twist_constraint.html) and its ragdoll samples.
- Shot, balance and fall behaviours with their defaults: [ShotHelper](https://docs.ragecoop.com/SHVDN/GTA.NaturalMotion.ShotHelper.html),
  [ShotSnapHelper](https://docs.ragecoop.com/SHVDN/GTA.NaturalMotion.ShotSnapHelper.html),
  [ShotShockSpinHelper](https://docs.ragecoop.com/SHVDN/GTA.NaturalMotion.ShotShockSpinHelper.html),
  [ShotInGutsHelper](https://docs.ragecoop.com/SHVDN/GTA.NaturalMotion.ShotInGutsHelper.html),
  [ShotFromBehindHelper](https://docs.ragecoop.com/SHVDN/GTA.NaturalMotion.ShotFromBehindHelper.html),
  [ShotFallToKneesHelper](https://docs.ragecoop.com/SHVDN/GTA.NaturalMotion.ShotFallToKneesHelper.html),
  [ShotHeadLookHelper](https://docs.ragecoop.com/SHVDN/GTA.NaturalMotion.ShotHeadLookHelper.html),
  [StaggerFallHelper](https://docs.ragecoop.com/SHVDN/GTA.NaturalMotion.StaggerFallHelper.html),
  [SmartFallHelper](https://docs.ragecoop.com/SHVDN/GTA.NaturalMotion.SmartFallHelper.html),
  [HighFallHelper](https://docs.ragecoop.com/SHVDN/GTA.NaturalMotion.HighFallHelper.html),
  [BodyFoetalHelper](https://docs.ragecoop.com/SHVDN/GTA.NaturalMotion.BodyFoetalHelper.html),
  [BodyRollUpHelper](https://docs.ragecoop.com/SHVDN/GTA.NaturalMotion.BodyRollUpHelper.html).
- PuppetMaster: [BehaviourPuppet](http://www.root-motion.com/puppetmasterdox/html/page10.html),
  [BehaviourFall](http://www.root-motion.com/puppetmasterdox/html/page11.html),
  [MuscleHit](http://www.root-motion.com/puppetmasterdox/html/struct_root_motion_1_1_dynamics_1_1_muscle_hit.html).
- CryEngine: [Fall and Play](https://www.cryengine.com/docs/static/engines/cryengine-3/categories/1638401/pages/1048781),
  [hit reactions](https://www.cryengine.com/docs/static/engines/cryengine-3/categories/1638401/pages/1933363).
- Unreal: [ALS Community](https://github.com/dyanikoglu/ALS-Community) (its get-up and facing test),
  [physics-driven animation](https://dev.epicgames.com/documentation/en-us/unreal-engine/physics-driven-animation-in-unreal-engine).
- Derek Mattson, [A Second Shot](https://media.gdcvault.com/gdc2024/Slides/GDC+slide+presentations/Mattson_Derek_ASecondShot_Notes.pdf) (The Last of Us Part II's hit zones), GDC 2024.
- Pratt, Carff, Drakunov and Goswami, [Capture Point](https://cs.utexas.edu/~shivaram/readings/b2hd-PrattCDG2006.html), 2006.
- [Stepping responses after a lean-and-release](https://media.isbweb.org/images/conf/2005/abstracts/0401.pdf) (ISB 2005); [protective responses in falls](https://frontiersin.org/articles/10.3389/fneur.2018.00986/full).
- EA, [US10388053B1](https://patents.google.com/patent/US10388053B1/en): choosing where a get-up joins a ragdoll's pose.
- [Parachute landing fall](https://en.wikipedia.org/wiki/Parachute_landing_fall).
