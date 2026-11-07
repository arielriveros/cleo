import { Node } from 'cleo'

/**
 * Valley — a fire's light: torches, braziers, fire pits, candles, the bonfire. Attach to the fire's root;
 * it finds its parts by type, so any layout works:
 *
 *   Torch                 this script
 *   ├── Flame             animated sprite(s), following the Light
 *   ├── Embers            particle system(s), following the Light
 *   └── Light             point light, flickering
 *
 * - FLICKER is the engine's, not this script's: the light's own Flicker (PunctualLight.flickerAmount)
 *   wanders its intensity, and the flames and embers burn on the same beat through their Follow Light.
 *   Intensity only, so a shadowed torch keeps its cached shadow map.
 * - NO DAY AND NIGHT. The light keeps its real lumens around the clock; the camera's auto exposure is what
 *   makes it vanish in sunlight and carry the road at night.
 *
 * `lit` puts the fire out and lights it again: flames hidden, embers stopped, light off. The bonfire's
 * script drives it (its `Fire` child is one of these), so an unlit bonfire is a cold one.
 */
export default class ValleyFireLightNode extends Node {
  /** Burning or not. */
  public lit: boolean = true

  private _lights: { node: any, intensity: number }[] = []
  private _visuals: any[] = []
  private _shown: boolean = true

  onStart() {
    const walk = (n: any) => {
      const type = n.nodeType
      if (type === 'light' && n.light) this._lights.push({ node: n, intensity: n.light.intensity })
      else if (type === 'sprite' || type === 'animatedSprite' || type === 'particleSystem') this._visuals.push(n)
      for (const c of n.children ?? []) walk(c)
    }
    for (const c of this.children) walk(c)
  }

  onUpdate() {
    if (this.lit !== this._shown) this._show(this.lit)
  }

  private _show(lit: boolean): void {
    this._shown = lit
    for (const l of this._lights) l.node.light.intensity = lit ? l.intensity : 0
    for (const node of this._visuals) {
      if (node.nodeType === 'particleSystem') { if (lit) node.play?.(); else node.stop?.(true) }
      else node.visible = lit
    }
  }
}
