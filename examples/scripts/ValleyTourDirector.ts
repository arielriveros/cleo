import { SequenceNode } from 'cleo'
import type { SequenceScriptContext } from 'cleo'

/**
 * Valley — the tour's director: the script on the `Valley Tour` Sequence node. The tour's Script track calls its
 * methods over its sections (sequencer/types.ts ScriptSection), each with a SequenceScriptContext.
 *
 *   lightning   the storm's strikes: args [seed, strikes]
 *
 * LIGHTNING. Each strike is a few pulses a fraction of a second apart, each decaying over a tenth of a second,
 * from low in the clouds a few hundred metres off: an authored point light (`Lightning`, under the
 * Cinematic group) flashed to over half a trillion lumens (tens of thousands of lux on the ground, a storm's
 * daylight over again, for a fraction of a second, faster than the eye adapts), the clouds' ambient lit up with it. The schedule is drawn from the seed,
 * so where the timeline is decides the picture: a scrub or a seek shows the same flash a playback would. Never the sun: its change would relight the GI; the light is not baked, so neither the GI
 * nor the probes see it.
 */
export default class ValleyTourDirectorNode extends SequenceNode {
  /** The light the strikes flash, by name. */
  public lightningLight: string = 'Lightning'
  /** Lumens at a pulse's peak (written out in full: the editor's field reader takes no exponents). */
  public lightningLumens: number = 600000000000
  /** How much the clouds' ambient light rises at a peak, over its own. */
  public lightningClouds: number = 5

  private _light: any = null
  private _clouds: any = null
  private _ambient: number = 1
  private _strikes: { t: number, x: number, z: number, y: number }[] = []

  lightning(ctx: SequenceScriptContext) {
    if (ctx.phase === 'enter') {
      this._light = this.findNode(this.lightningLight)
      this._clouds = (this.scene as any)?.volumetricClouds ?? null
      this._ambient = this._clouds ? this._clouds.ambientIntensity : 1
      const [seed, strikes] = ctx.args as number[]
      this._strikes = this._schedule(Number(seed) || 1, Math.max(1, Number(strikes) || 6), ctx.duration)
    }
    const light = this._light
    if (ctx.phase === 'exit') {
      if (light?.light) light.light.intensity = 0
      if (this._clouds) this._clouds.ambientIntensity = this._ambient
      return
    }
    // The strike in charge: the last one started.
    let strike = null
    for (const s of this._strikes) if (s.t <= ctx.local) strike = s
    const flash = strike ? this._flash(ctx.local - strike.t) : 0
    if (light?.light) {
      light.light.intensity = this.lightningLumens * flash
      if (strike) {
        const eye = (this.scene as any)?.activeCamera?.worldPosition
        light.setPosition([(eye?.[0] ?? 0) + strike.x, strike.y, (eye?.[2] ?? 0) + strike.z])
      }
    }
    if (this._clouds) this._clouds.ambientIntensity = this._ambient * (1 + this.lightningClouds * flash)
  }

  /** `strikes` moments spread over `duration`, each with a spot in the clouds round the camera. */
  private _schedule(seed: number, strikes: number, duration: number) {
    let state = Math.floor(seed * 9301 + 49297) % 233280
    const rnd = () => { state = (state * 9301 + 49297) % 233280; return state / 233280 }
    const out: { t: number, x: number, z: number, y: number }[] = []
    for (let i = 0; i < strikes; i++) {
      const t = duration * (i + 0.15 + 0.7 * rnd()) / strikes
      const angle = rnd() * Math.PI * 2, distance = 100 + 200 * rnd()
      out.push({ t, x: Math.cos(angle) * distance, z: Math.sin(angle) * distance, y: 400 + 150 * rnd() })
    }
    return out
  }

  /** A strike's brightness `dt` seconds after it began: three pulses, each a fast rise and a 0.07 s decay, out by 0.5 s. */
  private _flash(dt: number): number {
    let f = 0
    for (const [at, peak] of [[0, 1], [0.09, 0.55], [0.22, 0.85]]) {
      const s = dt - at
      // Half a second on, a pulse is out (its tail would keep the light faintly on between strikes).
      if (s < 0 || s > 0.5) continue
      f = Math.max(f, peak * Math.min(1, s / 0.012) * Math.exp(-s / 0.07))
    }
    return f
  }
}

