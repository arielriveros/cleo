import { InputManager, Logger, Node } from 'cleo'

/**
 * Third-person orbit camera — attach to the "Camera Pivot" child of the Playable.
 *
 *   Playable
 *   └── Camera Pivot  ← this script (raise it to head height: the camera orbits around this point)
 *       └── Camera    ← pushed back to -Z; the pivot's rotation carries it around
 *
 * The pivot yaws and pitches; the Camera child inherits that and just sits at a distance behind. This works
 * because the Playable root never rotates (ThirdPersonPlayable turns the Model, not itself) — so this node's
 * local yaw is also its world yaw, which is exactly what the controller reads to decide "forward".
 */
export default class ThirdPersonCameraPivotNode extends Node {
  /** Degrees of rotation per pixel of mouse movement. */
  public lookSpeed: number = 0.15
  /** How far behind the pivot the camera sits. Mouse wheel zooms between min and max. */
  public distance: number = 5
  public minDistance: number = 2
  public maxDistance: number = 12
  public minPitch: number = -30
  public maxPitch: number = 70
  public zoomSpeed: number = 0.01

  private _yaw: number = 0
  private _pitch: number = 20

  onStart() {
    if (!this.children.some(child => child.nodeType === 'camera'))
      Logger.warn(`${this.name} has no Camera child — nothing will orbit`, 'Script')
    this._apply()
  }

  onUpdate(delta: number, time: number) {
    const input = InputManager.instance
    const mouse = input.mouse

    // Look while the pointer is locked, or while dragging with the left button. Play mode already enables
    // mouse capture, so a single left-click locks and frees the mouse up for full look control.
    if (!input.isPointerLocked && !mouse.buttons.Left) return

    // mouse.velocity is the pixels moved during THIS frame, so it must not be scaled by delta — that would
    // make sensitivity depend on the frame rate (a long frame already carries proportionally more pixels).
    this._yaw -= mouse.velocity[0] * this.lookSpeed
    this._pitch += mouse.velocity[1] * this.lookSpeed
    this._pitch = Math.max(this.minPitch, Math.min(this.maxPitch, this._pitch))

    if (mouse.wheel.deltaY !== 0 && input.isMouseOverCanvas()) {
      const next = this.distance + mouse.wheel.deltaY * this.zoomSpeed
      this.distance = Math.max(this.minDistance, Math.min(this.maxDistance, next))
    }

    this._apply()
  }

  /** Push the rig to the current yaw/pitch/distance. Rotations are DEGREES. */
  private _apply(): void {
    this.setRotation([this._pitch, this._yaw, 0])

    // Only Z is ours — the engine's forward is +Z, so the camera sits at -Z and looks back through the pivot.
    // X and Y stay exactly as authored in the editor: setZ leaves them alone, where setPosition would zero
    // out a shoulder offset or a raised camera every frame.
    const camera = this.children.find(child => child.nodeType === 'camera')
    if (camera) camera.setZ(-this.distance)
  }
}
