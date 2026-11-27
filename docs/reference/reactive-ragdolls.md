# Reactive ragdolls

How the engine's reactions ([editor](../editor/reactions.md), [scripting](../scripting/reactions.md)) work, the
systems they are modelled on, and where the code is. A reactive ragdoll is a physics body whose joints have
muscles: it falls, tumbles and lands as physics says, but it tries, the way a person does, to stay up, to
break its fall and to protect its head. Reactions run on the Jolt backend only (`capabilities.reactions`; see
[Physics backends](physics-backends.md#joint-drives)).

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
