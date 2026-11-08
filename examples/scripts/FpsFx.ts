import { Node } from 'cleo'

/**
 * FPS example — a fire-and-forget effect (muzzle flash, impact, blood). Attach to the root of an effect
 * template. On start it plays every Particle System child (a `burstCount` > 0 bursts that many instead),
 * fades every point light child over `lifetime`, and removes itself when that time is up.
 *
 * The look is the template's particle systems; this script only owns the lifetime.
 */
export default class FpsFxNode extends Node {
  public lifetime: number = 0.6
  /** Particles per child system on start. 0 leaves them to their own spawn rate and bursts. */
  public burstCount: number = 0
  /** Fade the lights to nothing over `lifetime` (a flash's light falls off fast: this squares it). */
  public lightFalloff: number = 2

  private _age: number = 0
  private _lights: any[] = []
  private _intensities: number[] = []

  onStart() {
    this._age = 0
    const walk = (node: Node) => {
      for (const child of node.children) {
        const c = child as any
        if (child.nodeType === 'particleSystem') {
          c.play?.()
          if (this.burstCount > 0) c.burst?.(this.burstCount)
        }
        if (child.nodeType === 'light' && c.light) {
          this._lights.push(c.light)
          this._intensities.push(c.light.intensity)
        }
        walk(child)
      }
    }
    walk(this)
  }

  onUpdate(delta: number) {
    this._age += delta
    const k = Math.pow(Math.max(0, 1 - this._age / Math.max(0.01, this.lifetime)), this.lightFalloff)
    for (let i = 0; i < this._lights.length; i++) this._lights[i].intensity = this._intensities[i] * k
    if (this._age >= this.lifetime) this.remove({ immediate: true })
  }
}
