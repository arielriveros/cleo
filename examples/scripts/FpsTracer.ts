import { Node } from 'cleo'

/**
 * FPS example — a tracer round. The shooter instantiates one at the muzzle, turned along the shot, and sets
 * `tracerLength`, the distance to what the bullet hit. It is a thin glowing streak (the template's mesh,
 * along +Z) that flies from the muzzle to the hit at `speed` and is gone: the first `trail` metres of it
 * are the streak's own length, so it never stretches past the shot.
 */
export default class FpsTracerNode extends Node {
  /** Set by the shooter: distance from the muzzle to the end of the shot. */
  public tracerLength: number = 0
  public speed: number = 420
  /** Length of the streak, metres. */
  public trail: number = 6

  private _flown: number = 0
  private _start: number[] | null = null
  private _dir: number[] = [0, 0, 1]

  onUpdate(delta: number) {
    if (!this._start) {
      this.updateTransforms(this.parent ? this.parent.worldTransform : null)
      const p = this.worldPosition
      this._start = [p[0], p[1], p[2]]
      const f = this.worldForward
      this._dir = [f[0], f[1], f[2]]
      // The streak is shortened to the shot when the shot is shorter.
      const s = Math.min(1, Math.max(0.05, this.tracerLength / Math.max(1, this.trail)))
      this.setScale([1, 1, s])
    }
    this._flown += this.speed * delta
    const end = this.tracerLength
    if (this._flown >= end + this.trail * 0.2) { this.remove({ immediate: true }); return }
    const at = Math.min(this._flown, Math.max(0, end - this.trail * 0.5))
    this.setWorldPosition([this._start[0] + this._dir[0] * at, this._start[1] + this._dir[1] * at, this._start[2] + this._dir[2] * at])
  }
}
