import { Node } from 'cleo'

/**
 * Valley — a fire's light: torches, braziers, fire pits, candles, the bonfire. Attach to the fire's root;
 * it finds its parts by type, so any layout works:
 *
 *   Torch                 this script
 *   ├── Flame             animated sprite(s)
 *   ├── Embers            particle system(s)
 *   └── Light             point light: flickers
 *
 * - FLICKER. The light's intensity wanders by `flicker`: three waves at unrelated rates, so it never
 *   visibly repeats. Only the intensity: a light that MOVED would make the renderer redraw its shadow map
 *   every frame instead of keeping it.
 * - NO DAY AND NIGHT. The light keeps its real lumens around the clock; the camera's auto exposure is what
 *   makes it vanish in sunlight and carry the road at night.
 *
 * The flames and embers keep a sane brightness under any exposure on their own (their Exposure weight).
 *
 * `lit` puts the fire out and lights it again: flames hidden, embers stopped, light off. The bonfire's
 * script drives it (its `Fire` child is one of these), so an unlit bonfire is a cold one.
 */
export default class ValleyFireLightNode extends Node {
  /** Burning or not. */
  public lit: boolean = true
  /** How far the light's intensity wanders, as a fraction of it. */
  public flicker: number = 0.18
  /** How fast it wanders. */
  public flickerSpeed: number = 7

  private _lights: { node: any, intensity: number }[] = []
  private _visuals: any[] = []
  private _phase: number = 0
  private _t: number = 0
  private _shown: boolean = true

  onStart() {
    this._phase = Math.random() * 100
    const walk = (n: any) => {
      const type = n.nodeType
      if (type === 'light' && n.light) this._lights.push({ node: n, intensity: n.light.intensity })
      else if (type === 'sprite' || type === 'animatedSprite' || type === 'particleSystem') this._visuals.push(n)
      for (const c of n.children ?? []) walk(c)
    }
    for (const c of this.children) walk(c)
  }

  onUpdate(delta: number) {
    if (this.lit !== this._shown) this._show(this.lit)
    if (!this.lit) return
    this._t += delta
    const t = this._t * this.flickerSpeed + this._phase
    const wave = Math.sin(t) * 0.55 + Math.sin(t * 2.37 + 1.3) * 0.3 + Math.sin(t * 5.91 + 4.1) * 0.15
    for (const l of this._lights) l.node.light.intensity = l.intensity * (1 + this.flicker * wave)
  }

  private _show(lit: boolean): void {
    this._shown = lit
    for (const l of this._lights) if (!lit) l.node.light.intensity = 0
    for (const node of this._visuals) {
      if (node.nodeType === 'particleSystem') { if (lit) node.play?.(); else node.stop?.(true) }
      else node.visible = lit
    }
  }
}
