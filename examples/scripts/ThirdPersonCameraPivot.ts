import { CameraRigNode, Input } from 'cleo'

/**
 * Third-person orbit camera — attach to the "Camera Pivot" child of the Playable.
 *
 *   Playable
 *   └── Camera Pivot  ← this script, on a **Camera Rig** node (Add → Cameras → Camera Rig)
 *       └── Camera    ← the rig positions it; do not move it by hand
 *
 * This extends CameraRigNode, so the rig owns the camera behaviour and this script owns only the
 * input wiring. What used to be script fields now lives in the **Camera Rig** inspector:
 *
 *   Arm Length ............... how far behind the pivot the camera sits (was `distance`)
 *   Yaw / Pitch Sensitivity .. degrees per pixel of mouse movement (was `lookSpeed`)
 *   Pitch Min / Max .......... vertical limits (was minPitch/maxPitch; -30 / 70 suits third person)
 *   Collision ................ on by default, and new: the camera now pulls in at walls and terrain
 *
 * The rig has **no follow target**: with `follow` unset it treats its own authored position as the
 * pivot, so parenting it under the Playable is all that is needed to make it ride the character.
 * (Setting Follow to the Playable instead would add positional damping, but the rig would then have
 * to leave the hierarchy, and ThirdPersonPlayable finds the pivot among its own children.)
 *
 * Why the pivot can own its heading at all: the Playable root never rotates — ThirdPersonPlayable
 * turns the Model, not itself — so this node's local yaw is also its world yaw, which is what the
 * controller reads to decide "forward". It reads `this.yaw`, not `rotation[1]`: see _pivotYaw in
 * ThirdPersonPlayable for why the euler value is unusable past a quarter turn.
 */
export default class ThirdPersonCameraPivotNode extends CameraRigNode {
  /** Mouse-wheel zoom range, applied to the rig's Arm Length. */
  protected minDistance: number = 2
  protected maxDistance: number = 12
  protected zoomSpeed: number = 0.01

  onStart() {
    // Orbit mode means "yaw/pitch are whatever the script last set", so the rig will not fight the
    // input by recomputing the aim from a Look At target.
    this.aimMode = 'orbit'

    // The rig owns the camera child's entire local position (socket offset + arm), so a shoulder
    // offset authored by dragging the Camera in the viewport would be silently overwritten. Adopt it
    // as the rig's Socket Offset instead. Only X/Y are taken and Z is forced to 0 (Z is the arm's),
    // which makes this idempotent across reloads — re-reading an already-adopted offset is a no-op.
    // An offset already set in the inspector wins; this only rescues an un-migrated scene.
    const camera = this.children.find(child => child.nodeType === 'camera')
    const authored = camera ? camera.position : null
    const socketIsClear = Math.abs(this.socketOffset[0]) < 1e-3 && Math.abs(this.socketOffset[1]) < 1e-3
    if (authored && socketIsClear && (Math.abs(authored[0]) > 1e-3 || Math.abs(authored[1]) > 1e-3))
      this.socketOffset = [authored[0], authored[1], 0]

    this.armLength = Math.max(this.minDistance, Math.min(this.maxDistance, this.armLength))
  }

  onUpdate(delta: number, time: number) {
    // The `Look` action, not the mouse. Its default bindings already carry what this method used to
    // open with as an early return — "only while the pointer is locked, or while dragging with the left
    // button" is expressed as a MODIFIER on the pointer bindings — and they add a right thumbstick and
    // a touch drag for free. Rebinding any of that is now the player's business, not this script's.
    const look = Input.vector('Look')

    // `Look` is pixels (or stick deflection) for THIS frame, so it must not be scaled by delta — that
    // would make sensitivity depend on the frame rate, since a long frame already carries proportionally
    // more movement. addYaw/addPitch take exactly this kind of raw per-frame input and apply the rig's
    // sensitivity, inversion and clamping themselves.
    this.addYaw(-look[0])
    this.addPitch(look[1])

    // `Zoom` is bound to the wheel and to a pinch. It needs no "is the pointer over the canvas" check:
    // the wheel listener lives on the canvas, so an event the canvas never received never arrives here.
    const zoom = Input.value('Zoom')
    if (zoom !== 0) {
      const next = this.armLength + zoom * this.zoomSpeed
      this.armLength = Math.max(this.minDistance, Math.min(this.maxDistance, next))
    }

    // No _apply() any more. The rig writes its own rotation and the camera child's position in the
    // scene's late pass, which runs after every onUpdate — so it always acts on this frame's input,
    // and the camera can no longer lag the character by a frame.
  }
}
