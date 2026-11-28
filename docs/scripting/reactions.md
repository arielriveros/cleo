# Reactions

A character's reactions are its whole-body response to the world: a flinch and a hand on the wound when it is
shot, a stagger when it is shoved, bent knees off a ledge, arms round the head down a flight of stairs, a roll
away from a car it bailed out of, and getting up afterwards. They run on a **powered ragdoll**, physics bodies
whose joints have muscles pulling toward the animation the character was playing. How a skeleton reacts is
authored in the rig editor's [Reactions tab](../editor/reactions.md); this page is what a script can ask of it.

## Getting a character's reactions

```ts
const reactions = this.reactions                          // on a CharacterNode script: its model's
const reactions = model.reactions                         // on a ModelNode
const reactions = this.scene.physics.reactionsOf(model)   // the same, from anywhere
const reactions = this.scene.physics.reactionsFor(node)   // a Character, its model, a ragdoll body or capsule
```

While a character is on its feet (`reactions.hasControl`: flinching or staggering, not `isDown`) it keeps its
Collider and its control: a script goes on moving, aiming and firing it. Off its feet `isDown` is true and
`hasControl` false, until a get-up is quite over: its clip played out and the skin back on the animation (the
`recover` that follows `getUp`), so a brain or a stick does not walk the body out of it. `reactions.busyHands = { L, R }` tells it
which hands hold something and must not leave it for a wound (null, the default: both while the animator's
support-hand IK holds a weapon in two hands).

Each is a `ReactionController`, or `null` when the model has no skeleton a powered ragdoll fits (see
[What you need](../editor/reactions.md#what-you-need)), its reactions are turned **Off**, outside Play, or when the
game does not run on the Jolt physics backend ([reactions are Jolt's](../editor/reactions.md#physics-backends);
`physics.reactionsSupported` says which). One
exists per model, made the first time it is asked for; a character that is not reacting costs nothing.

## Hits from a gun

`physics.applyHit` sends a ray's hit to whatever it struck: the reactions of a character it hit (its capsule,
or a limb of a body already reacting), or an impulse on any other body.

```ts
import { CharacterNode } from 'cleo'

export default class Gun extends CharacterNode {
  fire(from: [number, number, number], dir: [number, number, number]) {   // dir: unit length
    const to: [number, number, number] = [from[0] + dir[0] * 100, from[1] + dir[1] * 100, from[2] + dir[2] * 100]
    const hit = this.scene.physics.raycast(from, to, { ignore: this.body })
    if (!hit) return
    // 12 N·s at the point the ray struck: a reacting body takes it on the limb hit, a crate is knocked.
    this.scene.physics.applyHit(hit, dir, 12, { damage: 0.25 })
  }
}
```

A character that is still on its animation has no bodies yet, so the ray strikes its capsule; the reactions
find the limb the ray would have struck on the animated pose (`partByRay`) and the hit lands there.
A ray that strikes a reacting body reports it: `hit.ragdoll` and `hit.part` (its index in `ragdoll.parts`).
Its `hit.node` is `null`, like terrain's, so a test for terrain should check `!hit.ragdoll` too.

## Asking for a reaction

| Call | What it does |
|---|---|
| `hit({ point?, direction?, impulse?, part?, damage? })` | A hit, `impulse` N·s along `direction` (world) at `point`. Small hits flinch, one in the trunk past **Stumble at** stumbles a step or two, harder ones stagger, the hardest knock it down (the set's [thresholds](../editor/reactions.md#thresholds)). Getting up, any hit that counts knocks it back. `part` by index, name (`'Forearm L'`) or role (`'foreArm.L'`); default the part nearest `point`. `damage` takes that much of its health (0..1); at 0 it dies. |
| `push(velocity, part?)` | A shove: every part (or one) gets this change of velocity (m/s, world). |
| `impact({ velocity, point? })` | Struck by a vehicle going `velocity` (m/s, world): the legs are taken out at its speed and the trunk thrown less and upward, so the body pivots over it, bracing as it goes (the [Struck](../editor/reactions.md#struck) behaviour). `point`: where it was struck, for the wound. |
| `trip()` | The feet stop, the body goes on: it falls forward. |
| `fall()` | Falls now, moving as it was (a floor giving way, stepping off a ledge). |
| `bail({ velocity, exitDirection?, vehicle? })` | Thrown from a vehicle moving at `velocity`, out along `exitDirection`, passing clear of `vehicle` (anything with a `body`) for a moment. |
| `knockOut(seconds = 4)` | Falls limp and lies there for `seconds` before it can get up. |
| `kill()` | Falls limp and stays down. |
| `getUp()` | Gets up now, if it is down and alive; lying on its front or side it rolls onto its back first (the set's [Roll over](../editor/reactions.md#roll-over)). While the animator's graph holds the body in a [Ragdoll state](../editor/animation.md#ragdoll-and-get-up-states) it asks the graph instead: `canGetUp` turns true, and the graph's way into its Get Up state rises. |
| `reset()` | Back on its animation at once, wherever the body is (a respawn). |
| `useSet(name)` | Switches to another of the skeleton's reaction sets, by id or name. |
| `setStrength(v)` | Multiplies every muscle from now on (1 normal). |

```ts
// A car hits a pedestrian going carVelocity (m/s): legs first, over the bonnet, braced.
pedestrian.reactions?.impact({ velocity: carVelocity })

// Out of the driver's door at speed: `car` is the vehicle's node, carLeft its left in the world.
this.reactions?.bail({ velocity: carVelocity, exitDirection: carLeft, vehicle: car })
```

## Reading it

| Member | What it is |
|---|---|
| `state` | `'animated'`, `'hitReact'`, `'stagger'`, `'falling'`, `'tumble'`, `'down'`, `'getUp'`, `'recover'` or `'dead'` (see [How a reaction runs](../editor/reactions.md#how-a-reaction-runs)). |
| `stateTime` | Seconds in the current state. |
| `reacting` | Anything but `'animated'`. |
| `isDown` | Off its feet: falling, tumbling, down, getting up or dead. |
| `ragdolled` | The body is the physics': falling, tumbling, lying or dead (not getting up). |
| `canGetUp` | Lying still and alive, ready to rise (or asked to by `getUp()`), on its back if it had to roll over first. |
| `faceUp` | Lying (or falling) face up: its hips and chest together. |
| `lying` | Off its feet, how it lies: `1` on its back, `-1` on its front, `0` on its side (0 on its feet). |
| `balance` | The steps it is taking to stay up in a stagger, or took in its last: `steps`, `stepLengths` (m), `swinging` (`'L'`, `'R'` or null), `outcome` and, if it fell, `gaveUp` (`'steps'`, `'capture'`, `'height'`, `'tilt'`, `'air'`, `'time'`). Null before its first stagger. |
| `knockCount` | Times it has been knocked off balance: each stagger, and each fall from its feet. |
| `pain` | How much it hurts now, 0 to 1: each wound's, by how bad it was, rising over 0.2 s and easing off over seconds. |
| `rollingOver` | Rolling onto its back to get up. |
| `hitCount`, `hitAngle`, `hitHeight`, `hitStrength` | The hits taken so far, and the last one's side (degrees from the facing, counter-clockwise: `0` front, `+90` its left), height up the body (`0`–`1`) and strength (`0`–`1`). The animator's [reaction parameters](../editor/animation.md#reaction-parameters) read these. |
| `alive`, `health` | Whether it can still get up, and its health 0..1 (settable). |
| `wounds` | Where it was hit: part, point and normal in the part's frame, impulse, when, and the hand that holds it. |
| `behaviours` | The behaviours running now, by id, and how strongly (0..1). |
| `sensors` | What the body measures: `com`, `velocity`, `speed`, `uprightness`, `grounded`, `airTime`, `fallHeight`, `impactSpeed`, `terrain` (`'flat'`, `'slope'`, `'stairs'`, `'ledge'`), `impact` (where and when a fall will land), `capture` (the capture point) and `support` (the feet's polygon). |
| `ragdoll` | The powered ragdoll while a reaction runs, else `null`: `ragdoll.parts` lists its bodies, names and regions. |
| `set` | The reaction set it runs (its numbers can be changed in place for this character alone). |

While it is off its feet its Collider is off and follows its hips, so a camera following the character
follows the body. A player script should ignore input while `reactions.reacting` is true.

## Events

Each step of a reaction fires a `reaction:*` event at the model, which bubbles to its Character and every
node above, so a script on the Character hears its own model's:

```ts
import { CharacterNode, Logger } from 'cleo'
import { eventListener } from 'cleo/decorators'

export default class Dummy extends CharacterNode {
  private alert = false

  @eventListener('reaction:Hit') hit(info) { Logger.log(`hit in the ${info.partName}`, 'Dummy') }
  @eventListener('reaction:Died') died() { this.after(6, () => this.reactions?.reset()) }   // up again
  @eventListener('reaction:GotUp') up() { this.alert = true }
}
```

| Event | When |
|---|---|
| `Started` | A reaction begins (it was on its animation). |
| `Hit` | A hit lands: `part`, `partName` (the part it struck, a leg's included), `impulse`, `point`, `zone` (`'head'`, `'chest'`, `'gut'`, `'back'`, `'arm'` or `'leg'`). |
| `Stagger` | It is knocked off balance and steps to stay up. |
| `Fell` | It comes off its feet: `fallHeight` so far. |
| `Landed` | It hits the ground: `impactSpeed`, `fallHeight`. |
| `Down` | It is lying on the ground: `faceUp`, `lying`. |
| `Settled` | It has come to rest: `faceUp`, `lying`. |
| `GettingUp` | It starts getting up: `faceUp`, `lying`. |
| `GotUp` | It is back on its animation after getting up. |
| `Recovered` | It is back on its animation without having fallen (a flinch, a stagger it stood through). |
| `Died` | It was killed (`kill()`, or a hit that took its last health). |

Every event's payload is a `ReactionEventInfo`: `{ event, state, from, node, controller, ... }`.

## Per-character settings

What a character's Properties set ([This character](../editor/node-inspector.md#this-character)), stored in
`model.ragdollConfig.reactions` and read when a reaction starts:

```ts
model.ragdollConfig = { ...model.ragdollConfig, reactions: { set: 'Tough', strength: 1.2, health: 1, getUp: true } }
```

| Key | What it is |
|---|---|
| `set` | Which of the skeleton's sets, by id or name. Absent: the skeleton's default. |
| `strength` | Multiplies every muscle. |
| `health` | Health 0..1 each reaction starts with. |
| `getUp` | `false`: a reaction that ends on the ground stays there. |
| `enabled` | `false`: no reactions at all; hits push its capsule and `startRagdoll` falls limp, as before. |

## Lower level

A powered ragdoll can be driven by hand: `physics.startRagdoll(model, { mode: 'powered' })` makes one whose
joints have muscles, and `Ragdoll` then has:

| Member | What it does |
|---|---|
| `parts` | Every body: `{ index, name, role, region, side, body, parent, children, joint, hinge, mass, radius, halfLength }`. |
| `setMuscle(part, drive \| null)` | A part's muscle: `{ frequency, damping, maxTorque, gravityCompensation? }` (Hz, ratio, N·m). |
| `setTarget(part, qRel)` | The rotation it reaches for, relative to its parent part. |
| `readMuscle(part)` | Last step's torque, saturation and angle still to go. |
| `setPin(part, pin \| null)` / `setPinTarget(part, pose)` | A string pulling the part toward a world pose. |
| `setMapping(part, w)` | How much of the part the skin draws from the body (1) or from the animation (0). |
| `followAnimation(muscle, pin)` | Every muscle (`muscle`, or `null` to keep them) reaching for the animation the animator plays now, every part pinned to it by `pin` (`null`: no pins). |

The physics world underneath has the same as joint drives and body pins
([Physics backends](../reference/physics-backends.md#joint-drives)).

## See also

[Reactions (editor)](../editor/reactions.md) · [Reactive ragdolls reference](../reference/reactive-ragdolls.md) · [Motion and physics](motion-and-physics.md) · [Events](events.md)
