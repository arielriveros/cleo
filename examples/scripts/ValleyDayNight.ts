import { Node, Game, REFERENCE_ILLUMINANCE, kelvinToRgb } from 'cleo'

/**
 * Valley — the time of day. Attach to a node named "Time of Day" (the fires look it up by that name).
 *
 * The sun crosses the sky once every `dayMinutes`: up in the east, over the south, down in the west, on the
 * path of a spring day at `latitude` (so a day is a little longer than the night). Everything that should
 * follow it does, every frame and smoothly:
 *
 *   - the sun's colour (warm and dim at the horizon, white at noon) and brightness;
 *   - the moon: below the horizon the renderer hands the key light to the moon, opposite the sun. Its light
 *     is the sun's times the sky's `moonlightIntensity`, set here so the moon gives `moonLux`;
 *   - the camera's exposure, from `dayEV` at noon through `duskEV` to `nightEV`: the eye adapting;
 *   - the valley mist, thick at dawn and burning off by mid-morning;
 *   - the god rays, strongest with a low sun;
 *   - `lampScale` / `lampRange`, read by every Fire Light (ValleyFireLight): torches carry the night.
 *
 * The ambient fill falls with the sun on its own (the Sky Light's night ambient). Light probes are
 * re-captured each time the sun has moved `probeDegrees`, so reflections keep up.
 *
 * Dying skips half a day: while YOU DIED is up the clock jumps `deathSkipHours`, and the player gets up in
 * the other half of the day. The hour survives a trip to the dungeon and back (through the scene doors).
 */
export default class ValleyDayNightNode extends Node {
  /** The directional light that is the sun. */
  public sunName: string = 'Sun'
  /** Real minutes for a whole day and night. */
  public dayMinutes: number = 24
  /** The hour the valley opens at, 0-24. */
  public startHour: number = 9.5
  /** Hours the clock jumps when the player dies. */
  public deathSkipHours: number = 12
  /** Seconds after death before the jump: once the banner is up. */
  public skipDelay: number = 1.8
  /** Latitude in degrees: with `declination`, how high the noon sun stands (90 - latitude + declination). */
  public latitude: number = 45
  /** The sun's declination in degrees: above 0, days are longer than nights. */
  public declination: number = 10
  /** The sun's illuminance (lux) once it is well up. */
  public sunLux: number = 79600
  /** The moon's illuminance (lux) at full night. */
  public moonLux: number = 1600
  /** Exposure value (EV100) with the sun well up, at the horizon, and at full night. */
  public dayEV: number = 15
  public duskEV: number = 14.2
  public nightEV: number = 13.4
  /**
   * What torches and lamps are multiplied by in daylight and at full night, and their range at night. The
   * fires are lit for the dungeon: by day a torch should light nothing, by night it lights the road.
   */
  public dayLampScale: number = 0.18
  public nightLampScale: number = 2.1
  public nightLampRange: number = 1.6
  /** The Sky Light's intensity at full night: the night sky lights the valley as well as the moon does. */
  public nightSkyLight: number = 0.4
  /** Degrees the sun moves between light-probe captures. */
  public probeDegrees: number = 12
  /** Runtime: the hour now, 0-24. */
  public hour: number = 9.5
  /** Runtime: 0 by day, 1 at full night. */
  public nightFactor: number = 0
  /** Runtime, for the Fire Light script. */
  public lampScale: number = 1
  public lampRange: number = 1

  private _sun: any = null
  private _sky: any = null
  private _skyLight: any = null
  private _skyLightIntensity: number = 1
  private _player: any = null
  private _wasDead: boolean = false
  private _fog: { density: number, falloff: number, opacity: number } = null
  private _godRays: number = 0
  private _lastEV: number = NaN
  private _lastStep: number = NaN
  private _probeAt: number[] = null

  onStart() {
    this._sun = this.findNode(this.sunName)
    this._player = this.findNode('Player')
    const scene: any = this.scene
    this._sky = scene?.skyAtmosphere ?? null
    this._skyLight = scene?.skyLight ?? null
    if (this._skyLight) this._skyLightIntensity = this._skyLight.intensity
    if (this._sky) {
      this._fog = { density: this._sky.fogDensity, falloff: this._sky.fogHeightFalloff, opacity: this._sky.fogMaxOpacity }
      this._godRays = this._sky.godRayExposure
    }
    // Back from the dungeon (a scene door brought the player here): the clock carries on where it was.
    const g = globalThis as any
    this.hour = g.__soulsArrival && typeof g.__valleyHour === 'number' ? g.__valleyHour : this.startHour
    this._apply(true)
  }

  onUpdate(delta: number) {
    this.hour = (this.hour + delta * 24 / Math.max(0.1, this.dayMinutes * 60)) % 24
    const dead = !!this._player?.isDead
    if (dead && !this._wasDead) this.after(this.skipDelay, () => { this.hour = (this.hour + this.deathSkipHours) % 24; this._apply(true) })
    this._wasDead = dead
    this._apply(false)
    ;(globalThis as any).__valleyHour = this.hour
  }

  /** Where the sun is at `hour`: [east, up, south] as a unit vector (the engine's +X, +Y, +Z). */
  public sunPosition(hour: number = this.hour): [number, number, number] {
    const H = (hour - 12) / 24 * Math.PI * 2
    const L = this.latitude * Math.PI / 180, d = this.declination * Math.PI / 180
    const east = -Math.cos(d) * Math.sin(H)
    const north = Math.cos(L) * Math.sin(d) - Math.sin(L) * Math.cos(d) * Math.cos(H)
    const up = Math.sin(L) * Math.sin(d) + Math.cos(L) * Math.cos(d) * Math.cos(H)
    return [east, up, -north]
  }

  private _apply(force: boolean): void {
    const pos = this.sunPosition()
    const elevation = Math.asin(Math.max(-1, Math.min(1, pos[1]))) * 180 / Math.PI
    const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
    // 0 with the sun 2° up, 1 once it is 10° down: the light the renderer's own night factor follows.
    this.nightFactor = 1 - smooth(-10, 2, elevation)
    const day = smooth(0, 25, elevation)

    // The sun, in steps of half a degree: each step re-bakes the sky, so they should not come every frame
    // (at the default day length, one every two seconds).
    const step = Math.round(Math.atan2(pos[0], pos[2]) * 360 / Math.PI) * 1000 + Math.round(elevation * 2)
    if (this._sun && (force || step !== this._lastStep)) {
      this._lastStep = step
      const travel = [-pos[0], -pos[1], -pos[2]]
      const pitch = Math.asin(-travel[1]) * 180 / Math.PI
      const yaw = Math.atan2(travel[0], travel[2]) * 180 / Math.PI
      this._sun.setRotation([pitch, yaw, 0])
    }
    const light = this._sun?.light
    if (light) {
      // Warm and dim near the horizon, white and full once it is high. Below the horizon the renderer fades
      // the sun out by itself, so the lux stays put there: the moon is a fraction of it.
      const kelvin = 2100 + 3300 * smooth(-2, 35, elevation)
      light.color = kelvinToRgb(kelvin)
      light.intensity = elevation > 0 ? this.sunLux * (0.3 + 0.7 * day) : this.sunLux
    }
    if (this._sky) {
      this._sky.moonlightIntensity = Math.min(1, this.moonLux / Math.max(1, this.sunLux))
      // Mist: gathering before dawn, thickest as the sun clears the ridge, burnt off once it is 14° up; a
      // thinner one at dusk, and a veil all night.
      const low = smooth(-12, -2, elevation) * (1 - smooth(4, 14, elevation))
      const mist = Math.max(0.08 * this.nightFactor, low * (this.hour < 12 ? 1 : 0.15))
      if (this._fog) {
        this._sky.fogDensity = this._fog.density + (0.006 - this._fog.density) * mist
        this._sky.fogHeightFalloff = this._fog.falloff + (0.05 - this._fog.falloff) * mist
        this._sky.fogMaxOpacity = this._fog.opacity + (0.85 - this._fog.opacity) * mist
      }
      this._sky.godRayExposure = this._godRays * (1 + 1.4 * (1 - smooth(5, 30, elevation)) * (1 - this.nightFactor) - 0.4 * this.nightFactor)
    }

    // Exposure: dayEV -> duskEV as the sun comes down to the horizon, -> nightEV as night falls.
    const ev = this.nightEV + (this.duskEV - this.nightEV) * (1 - this.nightFactor) + (this.dayEV - this.duskEV) * day
    if (force || !(Math.abs(ev - this._lastEV) < 0.01)) {
      this._lastEV = ev
      Game.updateRenderSettings({ exposure: REFERENCE_ILLUMINANCE / (1.2 * Math.pow(2, ev)) })
    }

    if (this._skyLight) this._skyLight.intensity = this._skyLightIntensity * (1 + (this.nightSkyLight - 1) * this.nightFactor)
    this.lampScale = this.dayLampScale + (this.nightLampScale - this.dayLampScale) * this.nightFactor
    this.lampRange = 1 + (this.nightLampRange - 1) * this.nightFactor

    // Light probes, each time the sun has moved far enough (and right after a jump).
    if (force || !this._probeAt || Math.acos(Math.min(1, pos[0] * this._probeAt[0] + pos[1] * this._probeAt[1] + pos[2] * this._probeAt[2])) * 180 / Math.PI > this.probeDegrees) {
      this._probeAt = pos
      // A moment later: the sky re-bakes first, and the probes should see the new one.
      this.after(force ? 1.1 : 0.4, () => { for (const probe of (this.scene as any)?.lightProbes ?? []) probe.bake?.() })
    }
  }
}
