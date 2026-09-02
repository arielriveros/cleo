import { Input, Logger, Node } from 'cleo'
import type { ActionState } from 'cleo'

/**
 * Third-person STRAFE character controller — attach to the "Playable" root.
 *
 * Facing lives on the BODY (this node). While you hold a movement key the body turns to the camera's look
 * direction and the WASD direction relative to that facing chooses a strafe clip — press D looking north and
 * the character keeps facing north but side-steps east (the right-strafe animation). Let go and the body stops
 * turning, so the camera orbits freely around a still character; swing it far enough and a ROOT-MOTION turn
 * clip physically turns the body to catch up.
 *
 * The camera is NOT dragged when the body turns: a Camera Rig's yaw is its WORLD yaw — the rig cancels its
 * parent's rotation every frame (see CameraRigNode._applyRigTransform) — so its aim is independent of the
 * body underneath it. That is exactly why forward is read straight off the pivot's yaw, and why the body can
 * rotate freely without the script ever touching the camera.
 *
 * Expected hierarchy (Playable must be at the scene root — a body on a parented node is placed wrong):
 *
 *   Playable          ← this script, has the RigidBody. THIS is what turns to face the camera.
 *   ├── Model         ← animated mesh; no script. It inherits the body's facing (never rotated on its own).
 *   └── Camera Pivot  ← ThirdPersonCameraPivot.ts on a Camera Rig node
 *       └── Camera
 *
 * Required body setup on Playable (Physics panel): capsule collider · friction 0 · mass 1 ·
 * linearDamping 0–0.05 · linearConstraints [1, 1, 1] · angularConstraints [0, 0, 0]. The angular lock stops
 * the PHYSICS SOLVER from spinning the body; this script still rotates it directly, which the lock allows.
 *
 * The Model's Animator reads three fields off this node (Variable parameters → Parent): `moveDir` (strafe
 * angle, Field X), `isJumping`, `turnRequest` (which turn-in-place clip). Speed is read from the engine as
 * Built-in → Parent → `planarSpeed`. Enable **Root motion** on the four turn clips in the Animation editor's
 * Clips panel — that is what lets the turn animation drive the body. See the README for the full setup.
 */
export default class ThirdPersonPlayableNode extends Node {
  /**
   * Animator input (Field X): the travel direction relative to the way the BODY is facing, in DEGREES.
   * 0 = ahead (W), **-90 = strafe right (D), +90 = strafe left (A)**, ±180 = back (S) — counter-clockwise,
   * so it agrees exactly with the engine's own `planarAngle` and a field can bind to either. Includes the body's
   * catch-up offset while it is still turning to the camera, so the blend shows the right strafe even
   * mid-turn. Smoothed (see `directionSmoothing`) so the field probe glides rather than snapping.
   */
  protected moveDir: number = 0

  /** Animator input: true from take-off until the feet are back down. */
  protected isJumping: boolean = false

  /**
   * Animator input: which turn-in-place clip to play — 0 none, +1/+2 turn 90°/180° right, -1/-2 left. The
   * script holds the code while the turn clip's ROOT MOTION rotates the body and clears it to 0 once the body
   * has caught the camera, which returns the machine to Idle.
   */
  protected turnRequest: number = 0

  private walkSpeed: number = 1.5
  private runSpeed: number = 4
  /** Upward speed applied on jump. Height is speed²/(2·gravity) — mass-independent, unlike an impulse. */
  private jumpSpeed: number = 4
  /** How fast the BODY swings round to the camera's look direction while MOVING, in degrees per second.
   *  Turn-in-place (idle) is NOT driven by this — the root-motion turn clip rotates the body there. */
  private turnSpeed: number = 540
  /** How far (degrees) the camera may swing off the body before an idle turn-in-place fires. 90 keeps the
   *  camera free for a quarter-turn each way. */
  private turnThreshold: number = 90
  /** Damping time constant (seconds) for `moveDir`, so the blend-space Direction axis glides between strafes
   *  instead of snapping. 0 = instant. */
  private directionSmoothing: number = 0.12
  /** Name of the child that holds the camera; its yaw is the world look direction. Falls back to the child
   *  that contains the Camera if nothing matches. */
  protected pivotName: string = 'Camera Pivot'

  /** Seconds left in which the slope-follow must not touch Y, so it can't eat a jump. See onUpdate. */
  private _jumpCooldown: number = 0
  /** True while an idle turn-in-place is in progress (its root-motion clip is rotating the body). */
  private _turning: boolean = false
  /** The smoothed strafe angle actually published as `moveDir`. */
  private _smoothDir: number = 0

  onStart() {
    if (!this.body) Logger.warn(`${this.name} has no rigid body — the controller cannot move it`, 'Script')

    const factor = this.body ? this.body.linearFactor : null
    if (factor && (factor.x === 0 || factor.y === 0 || factor.z === 0))
      Logger.warn(
        `${this.name} has linearConstraints [${factor.x}, ${factor.y}, ${factor.z}] — a 0 locks that axis and ` +
        `blocks movement along it. Set it to [1, 1, 1] in the Physics panel.`, 'Script')

    if (!this._findPivot())
      Logger.warn(
        `${this.name} has no camera pivot child — movement and facing will follow the world +Z axis instead ` +
        `of the camera. Add the Camera Pivot as a child, or set pivotName to match it.`, 'Script')
  }

  // Jump is an ACTION, so it fires for Space, the pad's A button and the on-screen button alike — and
  // `state.started` is true on exactly the frame of the press, so holding it cannot repeat the jump.
  //
  // This replaces a registerKeyPress in onStart and its matching unregisterKeyPress in onDespawn. There
  // is nothing to unregister: the handler belongs to the node and goes away with it.
  onAction(action: string, state: ActionState) {
    if (action !== 'Jump' || !state.started) return
    if (!this.isGrounded) return
    const v = this.velocity
    this.velocity = [v[0], this.jumpSpeed, v[2]]
    this._jumpCooldown = 0.2
    this.isJumping = true
  }

  onUpdate(delta: number, time: number) {
    if (this._jumpCooldown > 0) this._jumpCooldown -= delta
    if (this.isJumping && this._jumpCooldown <= 0 && this.isGrounded) this.isJumping = false

    const pivot = this._findPivot()
    const bodyYaw = this._bodyYaw()

    // World look direction = the Camera Rig's yaw, which IS its world yaw (the rig cancels its parent's
    // rotation), so it needs no correction for the body turning underneath it. This is "forward" for movement
    // and the target the body turns to face while moving.
    const worldAim = pivot ? this._pivotYaw(pivot) : bodyYaw
    const yawRad = worldAim * Math.PI / 180
    const forward = [Math.sin(yawRad), 0, Math.cos(yawRad)]
    // The character's RIGHT is `forward x up`, which is -X at yaw 0 — NOT +X. This used to hold +X under the
    // name `right`, with the D/A keys negated to cancel it out. Movement came out correct, but `moveDir`
    // below was computed from the axis rather than from the travel direction, so it reported the mirror image
    // of where the character was actually going — and any blend space bound to the engine's own `planarAngle`
    // instead played the opposite strafe.
    const right = [-Math.cos(yawRad), 0, Math.sin(yawRad)]

    // One action instead of four key reads. `Move` arrives already composed and normalized, whether it
    // came from WASD, the arrow keys, a thumbstick or the on-screen joystick.
    const move = Input.vector('Move')
    const axisRight = move[0]
    const axisForward = move[1]

    // ANALOG-aware: `magnitude` is how far the stick is actually pushed, and it scales the speed below.
    // A keyboard always produces 1 here, so digital movement is unchanged.
    const magnitude = Math.hypot(axisRight, axisForward)
    const moving = magnitude > 1e-3
    const v = this.velocity

    if (!moving) {
      // Idle: no horizontal drift, camera free. Fire a turn-in-place once it has swung past the threshold;
      // the root-motion clip does the rotating, so the script only manages `turnRequest`.
      this.velocity = [0, v[1], 0]
      this._updateTurnInPlace(worldAim, bodyYaw)
      return
    }

    // Moving cancels any turn-in-place — the body is about to face the camera under the moving turn instead.
    this._turning = false
    this.turnRequest = 0

    // Strafe angle for the field: intent relative to the body's CURRENT facing (which may still be catching
    // up to the aim). `atan2(-axisRight, axisForward)` is the intent relative to the aim; add the aim→body
    // offset to make it relative to the body. Smoothed so the probe glides between strafes.
    //
    // NEGATED because angles here are counter-clockwise, matching the engine's yaw (`atan2(x, z)`): moving
    // RIGHT is a clockwise offset from forward and so reads NEGATIVE. This now agrees exactly with the
    // built-in `planarAngle`, which measures the same thing from the body's actual travel — so a field can be
    // bound to either without its strafes mirroring. Verify with: W → 0, D → -90, A → +90, S → 180.
    const intent = Math.atan2(-axisRight, axisForward) * 180 / Math.PI
    const target = this._shortestAngle(intent + this._shortestAngle(worldAim - bodyYaw))
    const a = this.directionSmoothing > 0 ? 1 - Math.exp(-delta / this.directionSmoothing) : 1
    this._smoothDir = this._shortestAngle(this._smoothDir + this._shortestAngle(target - this._smoothDir) * a)
    this.moveDir = this._smoothDir

    // Turn the BODY toward the look direction. The camera is unaffected — the rig's aim is its own world yaw,
    // independent of the body — so there is nothing to compensate.
    this._faceBodyToYaw(worldAim, this.turnSpeed, delta)

    // World-space travel direction, camera-relative — the velocity math is unchanged from a face-your-movement
    // controller; only the facing differs.
    let dirX = forward[0] * axisForward + right[0] * axisRight
    let dirZ = forward[2] * axisForward + right[2] * axisRight
    // GUARDED, and the guard matters twice over. Standing still makes `length` zero, and the unguarded
    // division this replaces produced a NaN velocity. And with an analog stick `length` is the stick's
    // own deflection, so dividing by it would stretch a gentle push to a full sprint — the analog range
    // has to come back through `magnitude` on the speed instead, never through the direction.
    const length = Math.hypot(dirX, dirZ)
    if (length > 1e-6) { dirX /= length; dirZ /= length }

    const running = Input.pressed('Sprint')
    const speed = (running ? this.runSpeed : this.walkSpeed) * Math.min(1, magnitude)

    // Travel ALONG the ground rather than horizontally through it: project onto the surface.
    const n = this.groundNormal
    const into = dirX * n[0] + dirZ * n[2]
    let moveX = dirX - n[0] * into
    let moveY = -n[1] * into
    let moveZ = dirZ - n[2] * into
    const slopeLength = Math.hypot(moveX, moveY, moveZ)
    if (slopeLength > 0) { moveX /= slopeLength; moveY /= slopeLength; moveZ /= slopeLength }

    const follow = this.isGrounded && this._jumpCooldown <= 0
    this.velocity = follow
      ? [moveX * speed, moveY * speed, moveZ * speed]
      : [dirX * speed, v[1], dirZ * speed]
  }

  /**
   * Idle turn-in-place: decide WHICH turn clip should play and hold its code until the body has caught the
   * camera. It does not rotate anything — the turn clip's root motion rotates the body, and the counter-
   * rotation at the top of onUpdate keeps the camera still while it does. Hysteresis (fire at the threshold,
   * clear near 0) stops it chattering when the camera hovers at the threshold.
   */
  private _updateTurnInPlace(worldAim: number, bodyYaw: number): void {
    const diff = this._shortestAngle(worldAim - bodyYaw)
    if (!this._turning) {
      if (Math.abs(diff) < this.turnThreshold) return
      this._turning = true
      const magnitude180 = Math.abs(diff) >= 135
      // A POSITIVE diff needs a LEFT turn, so it asks for the left clip (a negative turnRequest).
      //
      // Work it through, because the intuition goes the other way: forward at yaw θ is `(sin θ, 0, cos θ)`,
      // so raising θ swings forward from +Z toward +X — and the character's right is `forward x up` = -X.
      // +X is therefore its LEFT, and `diff = aim - body > 0` means "increase yaw", i.e. turn left.
      //
      // Getting this backwards does not merely play the wrong clip: the turn clip's root motion then rotates
      // the body AWAY from the camera, so `diff` grows instead of shrinking and the `|diff| < 10` release
      // below never fires. The body keeps being driven round while the root motion's translation feeds
      // planarSpeed, which trips the Idle->Locomotion gate, which cancels the turn, which lets it start
      // again — a state ping-pong on one side of centre only.
      //
      // Note the sign here is the OPPOSITE of `moveDir`'s. That is deliberate: `moveDir` is an ANGLE and
      // follows the engine's counter-clockwise convention (right is -90), while `turnRequest` is a clip
      // SELECTOR whose contract, set by the README, is "+1/+2 right, -1/-2 left".
      const side = diff > 0 ? -1 : 1
      this.turnRequest = side * (magnitude180 ? 2 : 1)
    } else if (Math.abs(diff) < 10) {
      // The root motion has brought the body within a few degrees of the aim — end the turn.
      this._turning = false
      this.turnRequest = 0
    }
  }

  /**
   * Rotate the body toward `targetYaw` at most `speed` deg this frame, pushing the rotation into the physics
   * body (setRotation does that).
   *
   * Writes the yaw with setRotation, which is full-range on the way IN (fromEuler) — only READING rotation[1]
   * folds past ±90°, and this never does: body yaw is read through worldForward (see _bodyYaw).
   */
  private _faceBodyToYaw(targetYaw: number, speed: number, delta: number): void {
    const cur = this._bodyYaw()
    const diff = this._shortestAngle(targetYaw - cur)
    const maxStep = speed * delta
    const step = Math.abs(diff) > maxStep ? Math.sign(diff) * maxStep : diff
    this.setRotation([0, this._shortestAngle(cur + step), 0])
  }

  /** This body's world yaw in DEGREES, read from worldForward so it is full-range (never rotation[1]). */
  private _bodyYaw(): number {
    const f = this.worldForward
    return Math.atan2(f[0], f[2]) * 180 / Math.PI
  }

  /**
   * The child whose yaw contributes the look direction. Prefers `pivotName`, falls back to whichever child
   * holds the Camera. Re-resolved each frame rather than cached in a field: a field holding a Node would be
   * picked up by the reflection system and serialized into scriptVars, which is circular.
   */
  private _findPivot(): Node | null {
    const named = this.children.find(child => child.name === this.pivotName)
    if (named) return named
    return this.children.find(child => this._holdsCamera(child)) || null
  }

  /**
   * The pivot's WORLD heading in degrees. A Camera Rig exposes `yaw`, which is its world yaw (it cancels its
   * parent's rotation), so it is directly the look direction. Reading `rotation[1]` off a rig folds past a
   * quarter turn (the euler decomposition can only express |yaw| ≤ 90). Plain-Node pivots set their euler
   * directly, so `rotation[1]` is the fallback for those.
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

  /** Signed shortest angular distance in degrees, in (-180, 180]. Doubles as a wrap for a single angle. */
  private _shortestAngle(a: number): number {
    let d = a % 360
    if (d > 180) d -= 360
    if (d < -180) d += 360
    return d
  }
}
