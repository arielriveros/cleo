import { Node, Game, REFERENCE_ILLUMINANCE } from 'cleo'

/**
 * Valley — day and night trade places every time the player dies. Attach to any node in the scene.
 *
 * While YOU DIED is up, the Sun is turned to the other side of the sky: below the horizon the renderer
 * hands the key light to the moon, the sky re-bakes with stars, and the sky light dims the ambient by
 * itself (its `nightAmbient`). The player gets up in the other half of the day.
 *
 * Two things follow the flip by hand:
 *   - Exposure opens `nightStops` stops: the eye adapts. A physically dark exposure would make every
 *     unlit effect (flames, sparks, the moon disc) thousands of times too bright.
 *   - Every point and spot light, and every bonfire's lit intensity, is scaled by `nightLightScale`, so
 *     torches carry the night instead of disappearing under the moon. Day divides it back out.
 * The pond's probe is re-captured a moment later, so the water stops reflecting the other sky.
 */
export default class ValleyDayNightNode extends Node {
  /** The directional light that is the sun. */
  public sunName: string = 'Sun'
  /** Euler degrees of the sun at night; the day angle is the one the scene was saved with. */
  public nightSunRotation: number[] = [-38.2, -23.96, 0]
  /** Exposure value (EV100) by day. */
  public dayEV: number = 15
  /** How many stops brighter the camera exposes at night. */
  public nightStops: number = 2
  /**
   * What every point/spot light's intensity is multiplied by at night. Night exposure opens by two
   * stops (4x), so a 1000x multiplier made torches overwhelm the scene; 1.5x keeps them readable
   * without turning the night into a whiteout.
   */
  public nightLightScale: number = 1.5
  /** Seconds after death before the flip: once the banner is up. */
  public flipDelay: number = 1.8
  /** Seconds after the flip before light probes re-bake (the sky re-bakes first). */
  public probeDelay: number = 1.1
  /** Runtime state: true while it is night. */
  public isNight: boolean = false

  private _sun: Node = null
  private _player: Node = null
  private _dayRotation: number[] = [0, 0, 0]
  private _wasDead: boolean = false

  onStart() {
    this._sun = this.findNode(this.sunName)
    this._player = this.findNode('Player')
    if (this._sun) this._dayRotation = Array.from(this._sun.rotation)
  }

  onUpdate() {
    const dead = !!(this._player as any)?.isDead
    if (dead && !this._wasDead) this.after(this.flipDelay, () => this.flip())
    this._wasDead = dead
  }

  /** Swap day for night or night for day, now. */
  public flip(): void {
    this.isNight = !this.isNight
    const r = this.isNight ? this.nightSunRotation : this._dayRotation
    this._sun?.setRotation([r[0], r[1], r[2]] as any)

    const ev = this.dayEV - (this.isNight ? this.nightStops : 0)
    Game.updateRenderSettings({ exposure: REFERENCE_ILLUMINANCE / (1.2 * Math.pow(2, ev)) })

    const k = this.isNight ? this.nightLightScale : 1 / this.nightLightScale
    const scene: any = this.scene
    for (const node of scene?.lights ?? []) {
      const light = (node as any).light
      if (light && (node.type === 'point' || node.type === 'spotlight')) light.intensity *= k
    }
    for (const node of scene?.nodes ?? []) {
      const n = node as any
      if (n.isBonfire && typeof n.lightIntensity === 'number') n.lightIntensity *= k
    }
    this.after(this.probeDelay, () => { for (const probe of scene?.lightProbes ?? []) (probe as any).bake?.() })
  }
}
