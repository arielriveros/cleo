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
possess(node: CharacterNode | null): this      // last-possess-wins, warns when stealing
release(): this
get possessed: CharacterNode | null
get/set possessedId: string | null
```

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
  aimYaw: number
  aimPitch: number
  look: [number, number]       // this frame's look delta
  sprint: boolean
  crouch: boolean
  speedScale: number           // throttle, 0..1
  requests: Record<IntentRequest, number>
}

const INTENT_REQUESTS = ['jump', 'interact', 'primary', 'secondary']
```

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

| Field | Default | |
|---|---|---|
| `walkSpeed` | `1.5` | |
| `runSpeed` | `4` | |
| `jumpSpeed` | `4` | |
| `turnSpeed` | `540` | Degrees/s the body swings to the aim **while moving**. |
| `turnThreshold` | `90` | Aim-vs-body angle that triggers a turn-in-place. |
| `turnReleaseAngle` | `10` | Deadzone at which the turn is considered done. |
| `directionSmoothing` | `0.12` | Seconds the blend-space direction axis takes to glide. |
| `acceleration` | `0` | `0` reaches commanded speed immediately. |
| `airControl` | `1` | |
| `coyoteSeconds` | `0.12` | |
| `jumpBufferSeconds` | `0.15` | |
| `jumpLockoutSeconds` | `0.15` | |
| `facingMode` | `'aim'` | `'aim' \| 'velocity' \| 'none'`. |
| `driveWhenUnpossessed` | `false` | |

## The three animator outputs

A character publishes exactly three fields for its animator to read. They are **plain fields, not
getters**, because the animator's variable binding uses an own-property check that a prototype
getter fails.

| Field | Meaning |
|---|---|
| `moveDir` | Strafe angle relative to facing: `0` ahead, **`-90` right**, **`+90` left**, `±180` back. |
| `isJumping` | True from take-off until the feet land. |
| `turnRequest` | Turn clip selector: `0` none, `±1` 90°, `±2` 180°. |

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

[AI](ai.md) · [Motion and physics](motion-and-physics.md) · [Animation](animation.md) · [Third-person character example](../../examples/scripts/README.md)
