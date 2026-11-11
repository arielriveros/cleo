import { CameraRigNode, Input } from 'cleo'

/**
 * Valley — a free-flying camera for looking round the scenery in Play. Attach to a Camera Rig with a
 * Camera child. The rig follows nothing and has no arm, so its own position is the eye; this script moves
 * it and turns its aim.
 *
 *   Move        W A S D / left stick         along the view, so looking down and pressing W dives
 *   Look        mouse (click to capture) or left-drag / right stick
 *   Ascend      Space or E / right bumper    straight up, whatever the view
 *   Descend     C or Q / left bumper
 *   Sprint      Shift / left stick press     `sprintScale` times faster
 *   Fly Speed   mouse wheel                  steps the cruising speed between `minSpeed` and `maxSpeed`
 *
 * The camera eases into and out of motion (`smoothing`) and never goes below the landscape plus
 * `groundClearance`, so it skims the ground rather than diving under it.
 */
export default class ValleyFlyCameraNode extends CameraRigNode {
  /** Cruising speed, metres per second. */
  public speed: number = 8
  /** Slowest and fastest cruising speed the wheel can set. */
  public minSpeed: number = 1
  public maxSpeed: number = 80
  /** Multiplier while Sprint is held. */
  public sprintScale: number = 4
  /** Seconds to reach the speed being asked for. 0 is instant. */
  public smoothing: number = 0.15
  /** Metres kept between the eye and the landscape below. */
  public groundClearance: number = 1.2

  private _velocity: number[] = [0, 0, 0]

  onUpdate(delta: number) {
    if (delta <= 0) return
    // A mouse delta is already per frame; a stick is a held rate, scaled to feel the same at any frame rate.
    const look = Input.vector('Look')
    const k = Input.device('Look') === 'gamepadAxis' ? delta * 60 : 1
    if (look[0] !== 0 || look[1] !== 0) {
      this.addYaw(-look[0] * k)
      this.addPitch(look[1] * k)
    }

    const wheel = Input.value('Fly Speed')
    if (wheel !== 0) this.speed = Math.min(this.maxSpeed, Math.max(this.minSpeed, this.speed * (wheel < 0 ? 1.2 : 1 / 1.2)))

    // The view direction (yaw counter-clockwise from +Z, pitch positive looking down) and its right, -X at yaw 0.
    const yaw = this.yaw * Math.PI / 180, pitch = this.pitch * Math.PI / 180
    const cp = Math.cos(pitch)
    const fx = Math.sin(yaw) * cp, fy = -Math.sin(pitch), fz = Math.cos(yaw) * cp
    const rx = -Math.cos(yaw), rz = Math.sin(yaw)

    const move = Input.vector('Move')
    const lift = (Input.pressed('Ascend') ? 1 : 0) - (Input.pressed('Descend') ? 1 : 0)
    const s = this.speed * (Input.pressed('Sprint') ? this.sprintScale : 1)
    const want = [
      (fx * move[1] + rx * move[0]) * s,
      (fy * move[1] + lift) * s,
      (fz * move[1] + rz * move[0]) * s,
    ]
    const a = this.smoothing > 0 ? 1 - Math.exp(-delta / this.smoothing) : 1
    const v = this._velocity
    for (let i = 0; i < 3; i++) v[i] += (want[i] - v[i]) * a

    const p = this.position
    const next = [p[0] + v[0] * delta, p[1] + v[1] * delta, p[2] + v[2] * delta]
    const floor = this._groundAt(next[0], next[2]) + this.groundClearance
    if (next[1] < floor) {
      next[1] = floor
      if (v[1] < 0) v[1] = 0
    }
    this.setPosition(next as any)
  }

  /** The highest landscape under (x, z), world height; -Infinity where there is none. */
  private _groundAt(x: number, z: number): number {
    let best = -Infinity
    const landscapes: any = (this.scene as any)?.landscapes
    if (!landscapes) return best
    for (const l of landscapes) {
      const o = l.worldPosition
      const terrain = l.terrain
      if (!terrain) continue
      best = Math.max(best, o[1] + terrain.heightAt(x - o[0], z - o[2]))
    }
    return best
  }
}
