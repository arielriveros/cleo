import { Node } from 'cleo'
import { attribute } from 'cleo/decorators'

/**
 * A Sandbox tracer: a glowing streak that flies from the muzzle to where the shot ended and is gone. Attach to the
 * root of the tracer's template (its streak a mesh along +Z, `trail` metres long, ending at the root); SandboxGun
 * instantiates it at the muzzle, turned along the shot, and sets `tracerLength`. The streak is shortened for a shot
 * shorter than it, and never flies past the shot's end.
 */
export default class SandboxTracerNode extends Node {
    /** Set by the gun: from the muzzle to the end of the shot, m. */
    public tracerLength: number = 0

    /** How fast the streak flies, m/s. */
    @attribute({ min: 10, max: 2000, step: 10 })
    public speed: number = 380

    /** The streak's length, m (its mesh's). */
    @attribute({ min: 0.1, max: 20, step: 0.1 })
    public trail: number = 5

    private _flown: number = 0
    private _start: number[] | null = null
    private _dir: number[] = [0, 0, 1]

    onUpdate(delta: number) {
        if (!this._start) {
            this.updateTransforms(this.parent ? this.parent.worldTransform : null)
            const p = this.worldPosition, f = this.worldForward
            this._start = [p[0], p[1], p[2]]
            this._dir = [f[0], f[1], f[2]]
            this.setScale([1, 1, Math.min(1, Math.max(0.05, this.tracerLength / Math.max(0.1, this.trail)))])
        }
        this._flown += this.speed * delta
        if (this._flown >= this.tracerLength + this.trail * 0.2) { this.remove({ immediate: true }); return }
        // The head of the streak at the root: it flies until its head reaches the end.
        const at = Math.min(this._flown, this.tracerLength)
        this.setWorldPosition([this._start[0] + this._dir[0] * at, this._start[1] + this._dir[1] * at, this._start[2] + this._dir[2] * at])
    }
}
