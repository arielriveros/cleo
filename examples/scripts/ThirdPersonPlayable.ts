import { InputManager, Logger, Node } from 'cleo'

/**
 * Third-person character controller — attach to the "Playable" root.
 *
 * Expected hierarchy (Playable must be at the scene root — a body on a parented node is placed wrong):
 *
 *   Playable          ← this script, has the RigidBody
 *   ├── Model         ← animated mesh; this script turns it to face travel
 *   └── Camera Pivot  ← ThirdPersonCameraPivot.ts
 *       └── Camera
 *
 * Required body setup on Playable (Physics panel):
 *   mass 1 · linearDamping 0–0.05 · linearConstraints [1, 1, 1] · angularConstraints [0, 0, 0]
 *
 * Both constraints matter. A locked linear axis (the old demo used [1, 1, 0]) silently kills movement along
 * it, because we drive velocity rather than teleporting. Locking angular stops physics from tipping or
 * spinning the root — which would drag the camera around with it, since the pivot is a child.
 *
 * The Model's Animator reads `moveSpeed` off this node: add a state-machine parameter of type Variable bound
 * to Parent → moveSpeed (number), then transition Idle→Walk above 0.1 and Walk→Run above 0.6.
 */
export default class ThirdPersonPlayableNode extends Node {
  /** Animator input: 0 idle, 0.5 walking, 1 running. Normalized so retuning the speeds below can't
   *  invalidate the animator's thresholds. */
  protected moveSpeed: number = 0

  /**
   * Animator input: true from take-off until the feet are back down. Bind an animator parameter to it
   * (variable → Parent → isJumping) and the Jump state lasts exactly as long as the character is airborne,
   * rather than as long as the clip happens to be. See the README for the state machine.
   */
  protected isJumping: boolean = false

  private walkSpeed: number = 1.5
  private runSpeed: number = 4
  /** Upward speed applied on jump. Height is speed²/(2·gravity) — mass-independent, unlike an impulse. */
  private jumpSpeed: number = 4
  /** How fast the mesh swings round to face the way it is moving, in degrees per second. */
  private turnSpeed: number = 540
  /** Name of the child that holds the camera; its yaw is what "forward" means for the player. Optional —
   *  if nothing matches, the child that contains the Camera is used instead. */
  protected pivotName: string = 'Camera Pivot'

  /** Seconds left in which the slope-follow must not touch Y, so it can't eat a jump. See onUpdate. */
  private _jumpCooldown: number = 0

  onStart() {
    if (!this.body) Logger.warn(`${this.name} has no rigid body — the controller cannot move it`, 'Script')

    // A locked linear axis silently eats all movement along it, because this controller drives velocity
    // instead of teleporting. The demo character ships with linearConstraints [1, 1, 0] — reuse that body and
    // W/S die while A/D still work, which reads as movement being broken in "some" directions only.
    const factor = this.body ? this.body.linearFactor : null
    if (factor && (factor.x === 0 || factor.y === 0 || factor.z === 0))
      Logger.warn(
        `${this.name} has linearConstraints [${factor.x}, ${factor.y}, ${factor.z}] — a 0 locks that axis and ` +
        `blocks movement along it. Set it to [1, 1, 1] in the Physics panel.`, 'Script')

    if (!this._findPivot())
      Logger.warn(
        `${this.name} has no camera pivot child — movement will follow the world +Z axis instead of the ` +
        `camera. Add the Camera Pivot as a child, or set pivotName to match it.`, 'Script')

    // registerKeyPress is edge-triggered, so holding Space cannot repeat the jump. One callback per key.
    InputManager.instance.registerKeyPress('Space', () => {
      if (!this.isGrounded) return
      const v = this.velocity
      this.velocity = [v[0], this.jumpSpeed, v[2]]
      this._jumpCooldown = 0.2
      this.isJumping = true
    })
  }

  onDespawn() {
    InputManager.instance.unregisterKeyPress('Space')
  }

  onUpdate(delta: number, time: number) {
    const input = InputManager.instance
    if (this._jumpCooldown > 0) this._jumpCooldown -= delta

    // Land only once the cooldown has run out. isGrounded allows ~0.1s of grace, so it is still true on the
    // frames right after take-off and would otherwise end the jump before the character had left the floor.
    if (this.isJumping && this._jumpCooldown <= 0 && this.isGrounded) this.isJumping = false

    // Move relative to where the camera looks. Take the pivot's yaw ANGLE rather than its worldForward:
    // forward must stay flat on XZ, or looking down would walk the character into the floor.
    const pivot = this._findPivot()
    const yaw = this._pivotYaw(pivot) * Math.PI / 180
    const forward = [Math.sin(yaw), 0, Math.cos(yaw)]
    const right = [Math.cos(yaw), 0, -Math.sin(yaw)]

    let axisForward = 0
    let axisRight = 0
    if (input.isKeyPressed('KeyW')) axisForward += 1
    if (input.isKeyPressed('KeyS')) axisForward -= 1
    if (input.isKeyPressed('KeyD')) axisRight -= 1 // right is cross(forward, up), which points -X at yaw 0
    if (input.isKeyPressed('KeyA')) axisRight += 1

    let dirX = forward[0] * axisForward + right[0] * axisRight
    let dirZ = forward[2] * axisForward + right[2] * axisRight
    const length = Math.hypot(dirX, dirZ)

    const running = input.isKeyPressed('ShiftLeft')
    const speed = running ? this.runSpeed : this.walkSpeed

    // Keep the vertical component: it belongs to gravity and the jump. Only steer the horizontal plane.
    const v = this.velocity
    if (length === 0) {
      this.velocity = [0, v[1], 0]
      this.moveSpeed = 0
      return
    }

    dirX /= length
    dirZ /= length
    this._faceDirection(dirX, dirZ, delta)

    // Travel ALONG the ground rather than horizontally through it: project the direction onto the surface.
    // On the flat this changes nothing (the normal is up), but on a slope a purely horizontal velocity either
    // grinds into the uphill face or sails off the downhill one — and going airborne is what made downhill
    // faster than uphill, since a body out of contact pays no friction.
    const n = this.groundNormal
    const into = dirX * n[0] + dirZ * n[2]
    let moveX = dirX - n[0] * into
    let moveY = -n[1] * into
    let moveZ = dirZ - n[2] * into
    const slopeLength = Math.hypot(moveX, moveY, moveZ)
    if (slopeLength > 0) { moveX /= slopeLength; moveY /= slopeLength; moveZ /= slopeLength }

    // Y is only ours while we are actually on the ground and not mid-jump. The cooldown is what protects the
    // jump: `moveY` would otherwise overwrite the impulse on the very next frame. Testing `v[1] > 0` instead
    // would not work — climbing a slope also drives Y positive.
    const follow = this.isGrounded && this._jumpCooldown <= 0
    this.velocity = follow
      ? [moveX * speed, moveY * speed, moveZ * speed]
      : [dirX * speed, v[1], dirZ * speed]
    this.moveSpeed = running ? 1 : 0.5
  }

  /**
   * The child whose yaw defines "forward". Prefers `pivotName`, but falls back to whichever child holds the
   * Camera, so renaming the pivot in the editor can't silently pin forward to the world +Z axis.
   *
   * Deliberately re-resolved each frame rather than cached in a field: a field holding a Node would be picked
   * up by the reflection system and serialized into scriptVars, which is circular. The scan is a handful of
   * children deep.
   */
  private _findPivot(): Node | null {
    const named = this.children.find(child => child.name === this.pivotName)
    if (named) return named
    return this.children.find(child => this._holdsCamera(child)) || null
  }

  /**
   * The pivot's heading in DEGREES.
   *
   * A Camera Rig pivot exposes `yaw` directly, and that is the value to use. Reading `rotation[1]`
   * off a rig would break past a quarter turn: the rig orients itself with a quaternion, and the
   * engine's euler decomposition (Rz·Ry·Rx) can only express |yaw| <= 90 — beyond that the excess
   * folds into pitch and roll, so a pivot turned 179° reads as 1° and the character walks backwards.
   *
   * Plain-Node pivots (the pre-rig version of ThirdPersonCameraPivot) set their euler directly, so
   * for those `rotation[1]` is still both correct and full-range.
   */
  private _pivotYaw(pivot: Node | null): number {
    if (!pivot) return 0
    const rigYaw = (pivot as any).yaw
    return typeof rigYaw === 'number' && isFinite(rigYaw) ? rigYaw : pivot.rotation[1]
  }

  private _holdsCamera(node: Node): boolean {
    if (node.nodeType === 'camera') return true
    return node.children.some(child => this._holdsCamera(child))
  }

  /**
   * Turn the mesh towards the direction of travel, at most turnSpeed per second.
   *
   * Only the Model child rotates — this node never does. That is what lets the Camera Pivot own its own
   * heading: as a child, any yaw here would be inherited and drag the camera round with the character.
   */
  private _faceDirection(dirX: number, dirZ: number, delta: number): void {
    const target = Math.atan2(dirX, dirZ) * 180 / Math.PI
    const maxStep = this.turnSpeed * delta

    for (const model of this.children.filter(child => child.nodeType === 'model')) {
      let angle = model.rotation[1]
      let difference = target - angle
      // Take the short way round, so turning from 179° to -179° is 2°, not 358°.
      while (difference > 180) difference -= 360
      while (difference < -180) difference += 360

      angle += Math.abs(difference) > maxStep ? Math.sign(difference) * maxStep : difference
      model.setRotation([0, angle, 0])
    }
  }
}
