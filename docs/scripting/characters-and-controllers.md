# Characters and controllers

*Unreleased — these node types landed after v1.1.2.4.*

Movement is split in two. A **Character** is a pawn: it turns an intent into velocity and facing and
never learns where the intent came from. A **Controller** is a driver: it possesses a character and
writes that intent each frame, from player input or from a brain.

The point of the split is that the same character can be handed to an AI without forking anything —
set the controller's source to AI and the same body walks itself with the same animations.

```
Playable            <- CharacterNode. Has the RigidBody. Must sit at the scene ROOT.
├── Model           <- the animated mesh; no script
├── Camera Pivot    <- CameraRigNode
│   └── Camera
└── Controller      <- ControllerNode, possessing Playable
```

## Possession

```ts
type Pawn = CharacterNode | CharacterBody2DNode
type Possessable = Pawn | VehicleNode
possess(node: Possessable | null): this        // last-possess-wins, warns when stealing
release(): this
get possessed: Possessable | null
get/set possessedId: string | null
```

A controller drives a 2D body (`CharacterBody2DNode`) exactly as it drives a Character — see
[2D pawns](#2d-pawns).

It drives a [Vehicle](../editor/vehicles.md) too, through the same intent: `move` x steers (+1 right), `move` y
drives (+1 forward; held against the way it rolls it brakes, then reverses), and `jumpHeld`, the jump button held,
holds the hand brake. Only a player source drives one (AI steering walks: an AI controller asks nothing of a
vehicle, and warns once, unless its `onThink` writes the intent). Possessing a car and releasing the character is
how a player gets into it: see the [Sandbox example](../editor/sandbox-example.md#the-car).

`possessedId` is remapped when a template is instantiated, so a spawned copy possesses **its own**
character rather than the template's. That is why the controller belongs *inside* the template, as a
child of the character — a controller left at the scene root keeps pointing at the id the character
used to have, and the copy silently stops moving.

> **Keep the controller as the last child.** With `aimSource: 'possessed'`, the controller finds the
> camera rig by walking the pawn's children depth-first and taking the first `CameraRigNode` it
> meets — a walk that includes the controller itself. Keeping the rig ahead of it means the rig is
> found at index 0.

## The intent

```ts
interface ControlIntent {
  move: [number, number]       // desired movement, in the basis below
  basisYaw: number             // the yaw `move` is expressed relative to
  aimYaw: number               // where to face, world degrees
  aimPitch: number             // where to look vertically, degrees, + down (as CameraRigNode)
  look: [number, number]       // this frame's look delta
  sprint: boolean
  crouch: boolean
  speedScale: number           // throttle, 0..1
  requests: Record<IntentRequest, number>
}

const INTENT_REQUESTS = ['jump', 'interact', 'primary', 'secondary']
```

A player Controller takes the aim from its camera rig as the rig stands once Look has steered it this frame:
`aimYaw` (and `basisYaw`) from its yaw, `aimPitch` from its pitch. A look-at reads both.

Requests are **buffered**, not booleans: each carries a time-to-live, which is what gives jump
buffering (press slightly early, still jump on landing) for free.

```ts
raiseRequest(out, kind, bufferSeconds)
isRequested(intent, kind): boolean
consumeRequest(intent, kind): boolean
decayRequests(intent, delta)
```

From a script on a character, `drive()` hands you a mutable intent and marks it fresh:

```ts
onUpdate() {
  if (this.isCrouching) this.drive().speedScale = 0.5
}
```

## Character tuning

The inspector's **Character** section sets these fields, in groups; the table below gives each one's
script name and default.

- **Speed** — **Walk** and **Run** speeds, **Acceleration** (`0` snaps to full speed; see
  [on slopes](#acceleration-on-slopes)), **Turn Friction**, **Air Control** and **Slope Limit**, the steepest
  ground the character stands on without sliding down it.
- **Facing** — **Aim** turns the body toward where the controller is looking (a strafe character),
  **Velocity** toward where it travels (a face-your-movement character), and **None** leaves rotation
  alone. **Turn Speed** is how fast the body swings while moving; **Direction Smooth** glides the
  blend-space direction axis.
- **Jump** — take-off **Speed**. **Coyote** keeps a jump working just after walking off an edge,
  **Buffer** keeps one pressed just before landing, and **Lockout** suppresses the ground projection
  right after take-off so it cannot flatten the jump.
- **Crouch** — the capsule's **Height** while the intent crouches, and the **Crouch speed** it moves at. See
  [Crouching](#crouching).
- **Advanced** — **Drive without a Controller** runs locomotion with nothing possessing the character.
  Off by default, so an unpossessed character is inert and cannot fight physics for its own velocity.

The **Turn in place** group is [below](#turn-in-place), and **Animator outputs** shows the
[four outputs](#animator-outputs) live while the scene runs.

| Field | Script name | Default | Meaning |
|---|---|---|---|
| **Walk** | `walkSpeed` | `1.5` | Units per second at a walk. |
| **Run** | `runSpeed` | `4` | Units per second while the controller sprints. |
| **Acceleration** | `acceleration` | `0` | Units/s^2, measured **along the ground**. `0` snaps to full speed, which is what a keyboard character usually wants; above `0` makes the `isAccelerating` / `isDecelerating` animation built-ins meaningful. See [on slopes](#acceleration-on-slopes). |
| **Turn Friction** | `turnFriction` | `0` | Per second: how fast a moving body's velocity turns toward a new direction, keeping its speed (Unreal's ground friction; 8 there). `0` leaves turning to Acceleration, which is slower and loses speed through the turn. A reversal is braked through, never turned. Needs an Acceleration. See [Turning](#turning). |
| **Air Control** | `airControl` | `1` | Steering while airborne, as the share of the gap to the steered velocity closed per **second**: `1` steers freely, `0` keeps the launch velocity, `0.5` halves the gap in a second at any frame rate. |
| **Slope Limit** | `slopeLimit` | `45` | Degrees: the steepest ground the character stands on without sliding down it. On ground up to this steep, gravity only presses it into the ground, so it stands still, sets off, brakes and climbs as on the flat. Steeper ground it slides down. `0` turns it off. See [on slopes](#acceleration-on-slopes). |
| **Face** | `facingMode` | `'aim'` | What the body turns toward: **Aim** (`'aim'`, a strafe character), **Velocity** (`'velocity'`, a face-your-movement character) or **None** (`'none'`, rotation left alone). |
| **Turn Speed** | `turnSpeed` | `540` | Degrees/s the body swings to the aim **while moving**. |
| **Direction Smooth** | `directionSmoothing` | `0.12` | Seconds the blend-space direction axis takes to glide. |
| **Direction From** | `moveDirSource` | `'input'` | What `moveDir`, the blend-space direction, reads: **Input**, the way the player pushes, or **Velocity**, the way the body really travels. See [Turning](#turning). |
| **Speed** | `jumpSpeed` | `4` | The jump's take-off speed, upward. |
| **Coyote** | `coyoteSeconds` | `0.12` | Seconds after walking off an edge that a jump still counts as from the ground. |
| **Buffer** | `jumpBufferSeconds` | `0.15` | Seconds a jump pressed just before landing is remembered for. |
| **Lockout** | `jumpLockoutSeconds` | `0.15` | Seconds after take-off the ground projection is suppressed, so it cannot flatten the jump. |
| **Height** | `crouchCapsuleHeight` | `0` | Metres: the Collider's capsule's whole height while the character crouches. `0`: it never crouches and its capsule never changes. |
| **Crouch speed** | `crouchSpeed` | `0.5` | Its speed crouching, as a share of the walk it would go at. A crouch never sprints. |
| **Drive without a Controller** | `driveWhenUnpossessed` | `false` | Run locomotion with nothing possessing this character. Off, an unpossessed character is inert and cannot fight physics for its own velocity. |

### Crouching

With a **Crouch** height set (`crouchCapsuleHeight`), a character crouches while its intent's `crouch` is on: the
first capsule of the Collider it stands in is shortened to that height, its feet where they were, it moves at
`crouchSpeed` of its walk and never sprints. It reads `crouched` true (bind it to a `Crouching` parameter). It
stands back up as soon as `crouch` goes off, but only where the standing capsule fits: under a low ceiling it
stays down until it walks out. A jump stands it up first, and is dropped where there is no room. The capsule is
rebuilt in one go on every physics backend, the physics worker included.

A player Controller sets `crouch` from its **Crouch** action (`crouchAction`): held, or with **Crouch toggles**
(`crouchToggle`) on, pressed once to crouch and again to stand, a sprint or a jump standing it up too.

### Turning

With an `acceleration`, the velocity has to catch up with a new direction, and two settings decide how that looks.

- **`turnFriction`** turns the velocity toward the input, keeping its speed: at 8 (Unreal's default ground
  friction), a quarter turn is mostly done in a quarter of a second. At 0, `acceleration` alone moves the velocity
  in a straight line to the new one. That is slower (half a second for a jog at 11 m/s^2), and the speed dips to
  70% halfway while the body coasts on its old heading, which reads as ice. A reversal (past 135 degrees) is never
  turned, only braked through, so a running turn or a stop still sees the body slow down first. It has no effect
  with `acceleration: 0`, which snaps.
- **`moveDirSource: 'velocity'`** makes `moveDir` the body's actual direction of travel instead of the input's. With
  `'input'`, a blend space plays the new direction the moment the stick moves, while the body is still travelling
  the old way, and the feet slide sideways until the velocity catches up. Below a tenth of the commanded speed (as
  it sets off, or at the zero of a reversal) the input stands in.

Both are off by default, which is the original behaviour.

### Turn-in-place

A standing character with `facingMode: 'aim'` does not rotate itself. When the aim gets more than
`turnThreshold` (**Threshold**) away from the body it raises a `turnRequest`, and the turn clip's
**root motion** rotates the body. The turn holds until the body is back within `turnReleaseAngle`
(**Release**): two angles rather than one, so a camera hovering on the threshold does not make the
turn chatter.

| Field | Script name | Default | Meaning |
|---|---|---|---|
| **Threshold** | `turnThreshold` | `90` | Aim-vs-body angle, in degrees, that triggers a turn in place. |
| **Release** | `turnReleaseAngle` | `10` | The deadzone, inside the threshold, at which the turn is done. |
| **Settle** | `turnSettleSeconds` | `0.12` | Seconds the aim must stay past the threshold before a 90° turn engages, up to 5 s, so a camera swept round to the back plays the 180 instead. Longer lets a look-at layer turn the head before the body follows. |
| **Settle past 135** | `turnSettleFarSeconds` | `0` | Seconds the aim must stay past 135° before the 180° turn engages; `0` engages it at once. |

- **The choice of clip waits for the aim to settle.** A camera swept round to the back crosses 90°
  long before it reaches 180°; picking the clip at that crossing would always play the 90. So a turn
  engages only once the aim has stayed past the threshold for `turnSettleSeconds` — or, past 135°, where
  it can only be the 180, for `turnSettleFarSeconds` (at once by default). `0` disables the wait. A
  character with a look-at layer waits longer (a second, say) so its head is seen to turn before its body.
- **The clip is chosen once**, when the turn engages, and held until it releases.
- **A turn releases** when the body is within `turnReleaseAngle` of the aim — or when it has
  **overshot** it, so a latched turn cannot keep rotating the body further away. If the aim is still
  past the threshold, a fresh turn engages towards it.
- **Moving cancels a turn.** The moment the character moves, `turnRequest` drops to `0` and the body
  swings to the aim at `turnSpeed`. Give each turn state a transition back to locomotion on the same
  speed gate Idle uses, ahead of its exit-time return, or the clip plays out under the walk and its
  root motion keeps rotating a body locomotion is already steering.

### `acceleration` on slopes

The ramp is measured along the ground plane and against the body's **real** velocity, not a remembered
command. Two consequences worth knowing before you tune it:

- **Anything that resists the body throttles the ramp**, because the gap it closes each frame is measured
  from what the body is actually doing. That is what lets knockback, a conveyor or a moving platform
  compose with locomotion instead of fighting it, and it is why a character in a crowd accelerates only as
  fast as the crowd allows.
- **On a slope, gravity does not pull against it** on ground up to `slopeLimit` (45 degrees). A
  character is authored `friction: 0`, the usual choice since it owns its own speed. So every physics
  substep would integrate all of gravity into it, and the solver takes back only the part pressing into
  the ground. The part along the ground would be left over, at `g*sin(slope)`: a character standing on a
  ramp would creep down it, brake going down at `acceleration - g*sin(slope)`, and climb at that rate too,
  stalling when `acceleration` is below it.
- **The slope hold.** While the character stands on walkable ground no steeper than its limit, and is not
  taking off, the physics step gives it a force against gravity's pull along that ground. Gravity then only
  presses it into the ground. It stands still on a ramp, and starts, brakes and climbs at `acceleration` as
  on the flat, on every physics backend and in the physics worker. On steeper ground, and with
  `slopeLimit: 0`, gravity's pull along the slope comes back, and `acceleration` must outpull it.

## Animator outputs

A character publishes four fields for its animator to read, shown live in the inspector
while the scene runs. Bind one from an animator parameter of type **Variable** whose node reference
is the character (**Parent**, from a model that is its child).

They are **plain fields, not getters**, because the animator's variable binding uses an own-property
check that a prototype getter fails.

| Field | Meaning |
|---|---|
| `moveDir` | Strafe angle relative to facing: `0` ahead, **`-90` right**, **`+90` left**, `±180` back. |
| `isJumping` | True from take-off until the feet land. |
| `turnRequest` | Turn clip selector: `0` none, `±1` 90°, `±2` 180°. |
| `crouched` | True while it crouches (see [Crouching](#crouching)). |

Speed is not among them — read it as the built-in `planarSpeed`, which is **measured**, so a
character jammed against a wall reads 0 and drops to idle instead of running on the spot.

> ### `turnRequest` has the opposite sign to `moveDir`
>
> `moveDir` is an angle and follows the engine's counter-clockwise convention. `turnRequest` is a
> **clip selector**: wire `Turn90R` / `Turn180R` to the *positive* side. Wired the other way, the
> turn clip's root motion drives the body away from the camera and the turn never completes.

## Sign conventions

Angles are counter-clockwise, because yaw is `atan2(x, z)`: with forward `+Z` and up `+Y`, a
character's right is `forward × up = −X`, so turning right is a **negative** rotation.

| Input | `moveDir` |
|---|---|
| Forward (W) | `0` |
| Right (D) | `−90` |
| Left (A) | `+90` |
| Back (S) | `±180` |

Some engines label strafe-right `+90`. This one cannot, without contradicting the yaw every other
angle uses. Getting it backwards is easy to miss, because forward and backward still look correct.

## Writing a script on a character

Keep it to game state. Movement belongs to the node.

```ts
import { CharacterNode, Logger } from 'cleo'
import type { ActionState } from 'cleo'

export default class PlayerNode extends CharacterNode {
  public maxHealth: number = 100
  public health: number = 100

  onStart() {
    this.setVariable('isPlayer', true, 'boolean', 'public')
  }

  onAction(action: string, state: ActionState) {
    // Jump is handled by the Character itself — the Controller raises it as a buffered request
    // and locomotion consumes it, which is what gives it coyote time. This is for your own verbs.
    if (action === 'Interact' && state.started) this.interact()
  }

  public damage(amount: number): boolean {
    this.health = Math.max(0, this.health - amount)
    return this.health <= 0
  }
}
```

> **Never write `this.velocity` on a Character.** Locomotion writes it every frame; a second writer
> produces a character that stutters. Influence movement through the inspector's tuning or through
> `this.drive()`.
>
> Engine work on these nodes lives in `update()`, and your work in `onUpdate()`. They are separate
> deliberately: a script's methods are installed as own properties on the node, so a script method
> named `update` would shadow the engine's.

## 2D pawns

A `CharacterBody2DNode` is the 2D pawn: it walks or flies, runs and jumps from an intent, with coyote
time and a jump buffer, and a Controller possesses it the same way. Put the controller last among its
children, as in 3D:

```
Player              <- CharacterBody2DNode (its script: the game's moves)
├── Sprite          <- AnimatedSpriteNode, its state machine reading the body
├── Sword           <- TriggerNode (a 2D trigger in a 2D scene)
└── Player Controller  <- ControllerNode, Source: Player, possessing Player
```

**The 2D intent is in world axes.** `move[0]` is +x (right), `move[1]` is +y (up): a flier climbs with
it, and a walker holding it down with a jump drops through a one-way platform. `basisYaw`, the aim and
the look mean nothing to a 2D body, so a player controller reads its Move stick straight into it.
`setMove2D(intent, x, y)` writes one. Sprint picks the run speed; `speedScale` throttles; a raised `jump`
request jumps.

**A game's own moves go in `onMove2D`.** The engine walks and jumps the body; a dash, a double jump, a
wall jump or a jump cut is the game's, as a roll or a sprint is over a 3D Character. The handler runs every
physics substep (1/120 s or shorter), after the body's contacts are known and before the engine steers,
so a move lasts the same time at any frame rate:

```ts
export default class Hero extends CharacterBody2DNode {
  public hasDoubleJump = true
  private _airJumps = 0

  onMove2D(dt: number, substep: number): boolean {
    if (this.isGrounded) this._airJumps = this.hasDoubleJump ? 1 : 0
    // A press the engine's own jump cannot take (in the air): this game's double jump.
    if (this.jumpRequested && !this.canJump && this._airJumps > 0) {
      this.consumeJump()
      this._airJumps--
      this.velocity2D[1] = this.jumpSpeed * 0.9
    }
    return false   // true would own this substep: no engine steering or jump, your velocity2D stands
  }
}
```

Return `true` to own the substep — gravity (times `gravityScale`) and collision still run, so a dash sets
`gravityScale = 0` for its length. `maxFallSpeed` is writable too (a wall slide). The body publishes what
a script or a sprite's state machine reads: `isGrounded`, `onWall` (-1, 0, 1), `facing`, `canJump`,
`jumpRequested`, `isJumping`, `justJumped`, `justLanded`, and the measured-motion builtins (`planarSpeed` is
|vx| for a walker). Duskwell's warrior (`examples/duskwell/Assets/Characters/Warrior/Scripts/DuskPlayer.ts`) is the full set: double jump,
dash, wall slide and wall jump, jump cut, knock-back.

## Camera rigs

A third-person pivot must be a `CameraRigNode`, not a plain empty node.

A rig publishes its yaw as a **world** yaw and cancels its parent's rotation every frame. That is
what stops the camera being dragged around when the body turns underneath it — the aim you set with
the mouse is held no matter how the body spins.

```ts
import { CameraRigNode, Input } from 'cleo'

export default class CameraPivotNode extends CameraRigNode {
  public minDistance: number = 1.5
  public maxDistance: number = 8
  public zoomSpeed: number = 0.6

  onUpdate(delta: number) {
    const zoom = Input.value('Zoom')
    if (zoom !== 0) {
      this.armLength = Math.min(this.maxDistance,
                       Math.max(this.minDistance, this.armLength - zoom * this.zoomSpeed))
    }
  }
}
```

Most of what used to be script on a pivot is now rig inspector fields — arm length, sensitivity,
pitch limits, socket offset, and collision (the camera pulls in at walls instead of clipping
through).

> The rig **rewrites the Camera child's whole local position every frame**. A shoulder offset must
> go on the rig's `socketOffset`, never on the camera itself, or it is overwritten.
>
> The rig runs in the scene's late pass, after every `onUpdate`, so a rig-driven camera cannot trail
> its target by a frame the way a script-driven pivot did.

## The pure control layer

If you want to build your own movement rather than use `CharacterNode`, the pieces it is made of
are exported and are pure functions with no DOM and no engine dependency:

```ts
// Intent
createIntent() ; clearIntent(out) ; applyPlayerReading(out, reading, basisYaw, jumpBufferSeconds)
forwardFromYaw(yaw) ; rightFromYaw(yaw) ; moveWorldDirection(...) ; setMoveWorld(...)
shortestAngle(from, to)

// Locomotion
LOCOMOTION_DEFAULTS ; locomotionTuning(over?) ; createLocomotionState()
stepLocomotion(intent, sense, tuning, state): LocomotionOutput
// -> { velocity, yaw | null, moveDir, isJumping, turnRequest, jumped, next }

// Steering
STEERING_DEFAULTS ; steeringTuning(over?) ; createSteeringState(seed?)
seek ; flee ; arrive ; pursue ; followTarget ; wander
separate ; align ; cohere ; avoidObstacles ; blendSteering ; intentFromDesired
```

`stepLocomotion` is pinned by the engine's own tests, so building on it is safer than
reimplementing the same arithmetic.

## See also

[AI](ai.md) · [Motion and physics](motion-and-physics.md) · [Animation](animation.md) · [Third-person character example](third-person-character.md)
