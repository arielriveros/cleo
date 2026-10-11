import { Node } from 'cleo'

/**
 * Hollow Keep — a fire-and-forget effect. Attach to the root of an effect template (hit spark, bolt
 * impact, slam dust). On start it bursts every Particle System child, fades every point light child over
 * `lifetime`, and removes itself when that time is up.
 *
 * Swap the look by editing the template's particle systems; this script only owns the lifetime.
 */
export default class SoulsFxNode extends Node {
  public lifetime: number = 1.2
  /** Particles per child system on start. 0 leaves them to their own spawn rate / bursts. */
  public burstCount: number = 0

  private _age: number = 0
  private _lights: any[] = []
  private _intensities: number[] = []

  onStart() {
    this._age = 0
    const walk = (node: Node) => {
      for (const child of node.children) {
        const c = child as any
        if (child.nodeType === 'particleSystem') {
          // play(), not restart(): a fresh instance is already playing if its system plays on start,
          // and a restart would clear and prewarm it a second time on its first frame.
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
    const k = Math.max(0, 1 - this._age / Math.max(0.01, this.lifetime))
    for (let i = 0; i < this._lights.length; i++) this._lights[i].intensity = this._intensities[i] * k
    if (this._age >= this.lifetime) this.remove()
  }
}
