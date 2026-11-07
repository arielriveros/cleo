import { Node } from 'cleo'

/**
 * Valley — a fire's light: torches, braziers, fire pits, candles, the bonfire. Attach to the fire's root;
 * it finds its parts by type, so any layout works:
 *
 *   Torch                 this script
 *   ├── Flame             animated sprite(s), following the Light
 *   ├── Ignition          optional: an animated sprite played ONCE as the fire is lit (the bonfire's)
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
 *
 * LIGHTING IT, when the fire has an `Ignition` sprite (a non-looping flipbook of the fire catching, baked
 * with the FX Creator): the ignition plays from its first frame, the light flares up with it and settles,
 * the embers start at once, the smoke thickens over the whole of it, and the burning flames fade in over
 * its last `ignitionBlend` seconds while the ignition fades out, so the flare settles into the loop. A
 * fire that STARTS lit (a torch, a bonfire already lit when the scene opens) just burns.
 */
export default class ValleyFireLightNode extends Node {
  /** Burning or not. */
  public lit: boolean = true
  /** Seconds, at the end of the ignition, over which the burning flames take over from it. */
  public ignitionBlend: number = 0.5
  /** The light's peak as the fire catches, over its full intensity. */
  public ignitionFlare: number = 1.4
  /** Seconds into the ignition the flare peaks. */
  public ignitionFlareTime: number = 0.25

  private _lights: { node: any, intensity: number }[] = []
  private _visuals: any[] = []
  private _sprites: { node: any, opacity: number, smoke: boolean }[] = []
  private _ignition: any = null
  private _shown: boolean = true
  /** Seconds into the ignition, or -1 when none is playing. */
  private _igniting: number = -1
  private _ignitionLength: number = 0

  onStart() {
    const walk = (n: any) => {
      const type = n.nodeType
      if (type === 'light' && n.light) this._lights.push({ node: n, intensity: n.light.intensity })
      else if (type === 'animatedSprite' && n.name === 'Ignition') this._ignition = n
      else if (type === 'sprite' || type === 'animatedSprite' || type === 'particleSystem') {
        this._visuals.push(n)
        if (n.sprite) this._sprites.push({ node: n, opacity: n.sprite.opacity, smoke: n.name === 'Smoke' })
      }
      for (const c of n.children ?? []) walk(c)
    }
    for (const c of this.children) walk(c)
    if (this._ignition) {
      this._ignition.visible = false
      const frames = this._ignition.frames?.length ?? 0
      this._ignitionLength = frames > 0 ? frames / Math.max(1e-3, this._ignition.fps ?? 30) : 0
    }
  }

  onUpdate(delta: number) {
    if (this.lit !== this._shown) {
      // Lit from out: the fire catches. Put out, or lit with no ignition sprite: it just changes.
      const catches = this.lit && !this._shown && this._ignition && this._ignitionLength > 0
      this._show(this.lit)
      if (catches) this._ignite()
      else this._endIgnition()
    }
    if (this._igniting >= 0) this._stepIgnition(delta)
  }

  private _show(lit: boolean): void {
    this._shown = lit
    for (const l of this._lights) l.node.light.intensity = lit ? l.intensity : 0
    for (const node of this._visuals) {
      if (node.nodeType === 'particleSystem') { if (lit) node.play?.(); else node.stop?.(true) }
      else node.visible = lit
    }
  }

  private _ignite(): void {
    this._igniting = 0
    const ignition = this._ignition
    ignition.reset?.()
    ignition.currentFrame = 0
    ignition.sprite.opacity = 1
    ignition.visible = true
    this._stepIgnition(0)
  }

  private _stepIgnition(delta: number): void {
    const t = (this._igniting += delta)
    const length = this._ignitionLength
    if (t >= length) { this._endIgnition(); return }
    // The burning flames take over across the last `ignitionBlend` seconds; the smoke builds all along.
    const blend = Math.min(Math.max(0.05, this.ignitionBlend), length)
    const handover = Math.min(1, Math.max(0, (t - (length - blend)) / blend))
    const build = t / length
    for (const s of this._sprites) s.node.sprite.opacity = s.opacity * (s.smoke ? build : handover)
    this._ignition.sprite.opacity = 1 - handover
    // The light: up to the flare at `ignitionFlareTime`, then down to its full intensity by the end.
    const peak = Math.max(1e-3, Math.min(this.ignitionFlareTime, length * 0.5))
    const scale = t < peak
      ? this.ignitionFlare * smooth(t / peak)
      : 1 + (this.ignitionFlare - 1) * (1 - smooth((t - peak) / Math.max(1e-3, length - peak)))
    for (const l of this._lights) l.node.light.intensity = l.intensity * scale
  }

  /** The ignition over (or cut short): the fire as it burns, the ignition hidden for next time. */
  private _endIgnition(): void {
    if (this._igniting < 0) return
    this._igniting = -1
    for (const s of this._sprites) s.node.sprite.opacity = s.opacity
    if (this._ignition) this._ignition.visible = false
    if (this._shown) for (const l of this._lights) l.node.light.intensity = l.intensity
  }
}

/** Smoothstep on 0..1. */
function smooth(x: number): number {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}
