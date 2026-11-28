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
| Wiggle | Feedback on a pose a worker step old, fast layers in the muscles' target, the animation's spin dropped | Latency-compensated reach, fast layers drawn but not followed, the spin kept |

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

The golden physics traces are unchanged: a world with no drives steps exactly as before.

## Sources

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
