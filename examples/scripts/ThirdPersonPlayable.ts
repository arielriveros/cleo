import { CharacterNode, Logger } from 'cleo'
import type { ActionState } from 'cleo'

/**
 * Third-person STRAFE character — attach to the "Playable" root, on a **Character** node.
 *
 * Almost nothing is left in this file, and that is the point. Everything this script used to do —
 * camera-relative movement, the strafe angle, turning the body to the camera, turn-in-place, the jump,
 * slope projection — is now the Character node's own locomotion, tuned in its inspector and pinned by
 * `tests/locomotion.test.ts`. What used to be 150 lines of movement plus 40 lines of comment explaining
 * its sign conventions is now a node type.
 *
 * The bigger change is WHO drives it. This node no longer reads input at all: a **Controller** possesses
 * it and writes an intent each frame, from the player's actions or from a brain. That is why the same
 * character can be handed to an AI without forking anything.
 *
 * Expected hierarchy (Playable must be at the scene root — a body on a parented node is placed wrong):
 *
 *   Playable          <- THIS script, on a Character node. Has the RigidBody.
 *   |-- Model         <- animated mesh; no script. Inherits the body's facing.
 *   `-- Camera Pivot  <- ThirdPersonCameraPivot.ts on a Camera Rig node
 *       `-- Camera
 *   Controller        <- a Controller node possessing Playable. Source: Player.
 *
 * Required body setup on Playable (Physics panel): capsule collider, friction 0, mass 1,
 * linearDamping 0-0.05, linearConstraints [1, 1, 1], angularConstraints [0, 0, 0]. The angular lock stops
 * the PHYSICS SOLVER from spinning the body; locomotion still rotates it directly, which the lock allows.
 * The Character warns on spawn if any of that is missing.
 *
 * The Model's Animator reads three fields off this node (Variable parameters -> Parent): `moveDir`
 * (strafe angle, Field X), `isJumping`, `turnRequest` (which turn-in-place clip). Those are now fields on
 * the Character itself, with the same names, signs and meanings they always had - nothing in the
 * Animation editor needs re-authoring. Speed is read as Built-in -> Parent -> `planarSpeed`. Enable
 * **Root motion** on the four turn clips. See the README for the full setup.
 *
 * NEVER write `this.velocity` from a script on a Character: locomotion writes it every frame, and a
 * second writer produces a character that stutters. To influence movement, tune the inspector or write
 * the intent - `this.drive().speedScale = 0.5`.
 */
export default class ThirdPersonPlayableNode extends CharacterNode {
  /** Health, as an example of what a script on a Character IS for: game state, not movement. */
  public health: number = 100

  onStart() {
    Logger.log(this.name + ' ready', 'Script')
  }

  onAction(action: string, state: ActionState) {
    // `Jump` is handled by the Character itself - the Controller raises it as a buffered request and
    // locomotion consumes it, which is what gives it coyote time and jump buffering for free. This
    // handler is for the game's own verbs.
    if (action === 'Interact' && state.started) Logger.log(this.name + ' interacted', 'Script')
  }
}
