import { Node, kelvinToRgb } from 'cleo'

/**
 * Valley — the time of day. Attach to a node named "Time of Day" (the fires look it up by that name).
 *
 * The sun crosses the sky once every `dayMinutes`: up in the east, over the south, down in the west, on the
 * path of a spring day at `latitude` (so a day is a little longer than the night). Everything that should
 * follow it does, every frame and smoothly:
 *
 *   - the sun's colour (warm and dim at the horizon, white at noon) and brightness;
 *   - the moon: below the horizon the renderer hands the key light to the moon, opposite the sun, at the
 *     sky's own `moonIlluminance` (lux). Nothing here sets it, so the editor's night is the game's;
 *   - the valley mist, thick at dawn and burning off by mid-morning, and the fog volumes (the pond's mist)
 *     with it: `fogNightScale` times as dense at night and at dawn;
 *   - the god rays, strongest with a low sun.
 *
 * What it does NOT touch is the camera or the lamps. Every light keeps its real value all day — the sun
 * its lux, a torch its lumens — and the scene's auto exposure adapts to whatever they add up to, as an eye
 * does: at noon a torch is lost in the sun, at midnight it carries the road. How dark the night is allowed
 * to look is the exposure's compensation curve (the Day–Night exposure preset), not a multiplier here.
 *
 * The ambient fill falls with the sun on its own (the Sky Light's night ambient). Light probes are
 * re-captured each time the sun has moved `probeDegrees`, so reflections keep up.
 */
export default class ValleyDayNightNode extends Node {
  /** The directional light that is the sun. */
  public sunName: string = 'Sun'
  /** Real minutes for a whole day and night. */
  public dayMinutes: number = 24
  /** The hour the valley opens at, 0-24. */
  public startHour: number = 9.5
  /** Latitude in degrees: with `declination`, how high the noon sun stands (90 - latitude + declination). */
  public latitude: number = 45
  /** The sun's declination in degrees: above 0, days are longer than nights. */
  public declination: number = 10
  /** The sun's illuminance (lux) once it is well up. */
  public sunLux: number = 79600
  /** The Sky Light's intensity at full night: the night sky lights the valley as well as the moon does. */
  public nightSkyLight: number = 0.4
  /** How many times denser the scene's fog volumes are at night and at dawn than by day. */
  public fogNightScale: number = 3
  /**
   * Degrees the sun moves between light-probe RELIGHTS. A relight lights each probe's captured scene again
   * (no geometry but the sun's shadow, spread over a few frames), so it can follow the sun closely.
   */
  public probeDegrees: number = 4
  /**
   * Whether the clock runs. A sequence that sets `hour` itself (the Valley Tour) turns this off while it does,
   * so the two never fight over the time; the sun, sky and fog still follow whatever `hour` is.
   */
  public running: boolean = true
  /**
   * How overcast the sky is, 0 clear .. 1 a storm's: the daylight goes grey (the sun's colour toward a flat
   * 6500 K), the mist and the fog volumes thicken, the god rays fade and the sky's fill dims. It never
   * touches the sun's lux, which would re-bake the sky; the clouds' own shadows darken the ground. A sequence
   * keys it with the clouds (the Valley Tour's weather), and since this script sets the fog, god rays and
   * sky fill every frame, this is the way to change them while it runs.
   */
  public overcast: number = 0
  /** Runtime: the hour now, 0-24. */
  public hour: number = 9.5
  /** Runtime: 0 by day, 1 at full night. */
  public nightFactor: number = 0

  private _sun: any = null
  private _sky: any = null
  private _skyLight: any = null
  private _skyLightIntensity: number = 1
  private _fog: { density: number, falloff: number, opacity: number } = null
  private _godRays: number = 0
  private _fogVolumes: { node: any, density: number }[] = []
  private _lastStep: number = NaN
  private _probeAt: number[] = null

  onStart() {
    this._sun = this.findNode(this.sunName)
    const scene: any = this.scene
    this._sky = scene?.skyAtmosphere ?? null
    this._skyLight = scene?.skyLight ?? null
    if (this._skyLight) this._skyLightIntensity = this._skyLight.intensity
    // Every fog volume at its daytime density, as authored.
    this._fogVolumes = [...(scene?.volumetricFogs ?? [])].map((node: any) => ({ node, density: node.density }))
    if (this._sky) {
      this._fog = { density: this._sky.fogDensity, falloff: this._sky.fogHeightFalloff, opacity: this._sky.fogMaxOpacity }
      this._godRays = this._sky.godRayExposure
    }
    this.hour = this.startHour
    this._apply(true)
  }

  onUpdate(delta: number) {
    if (this.running) this.hour = (this.hour + delta * 24 / Math.max(0.1, this.dayMinutes * 60)) % 24
    this._apply(false)
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
    const overcast = Math.min(1, Math.max(0, Number(this.overcast) || 0))

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
      // the sun out by itself, so the lux stays put there (the moon has its own).
      const clear = 2100 + 3300 * smooth(-2, 35, elevation)
      const kelvin = clear + (6500 - clear) * 0.8 * overcast
      light.color = kelvinToRgb(kelvin)
      light.intensity = elevation > 0 ? this.sunLux * (0.3 + 0.7 * day) : this.sunLux
    }
    if (this._sky) {
      // Mist: gathering before dawn, thickest as the sun clears the ridge, burnt off once it is 14° up; a
      // thinner one at dusk, and a veil all night.
      const low = smooth(-12, -2, elevation) * (1 - smooth(4, 14, elevation))
      const mist = Math.max(0.08 * this.nightFactor, low * (this.hour < 12 ? 1 : 0.15), 0.3 * overcast)
      if (this._fog) {
        this._sky.fogDensity = this._fog.density + (0.002 - this._fog.density) * mist
        this._sky.fogHeightFalloff = this._fog.falloff + (0.05 - this._fog.falloff) * mist
        this._sky.fogMaxOpacity = this._fog.opacity + (0.6 - this._fog.opacity) * mist
      }
      this._sky.godRayExposure = this._godRays * (1 + 1.4 * (1 - smooth(5, 30, elevation)) * (1 - this.nightFactor) - 0.4 * this.nightFactor)
        * (1 - 0.85 * overcast)
    }
    // The fog volumes: gathered all night and thickest at dawn, back to their daytime density by mid-morning.
    const dawn = smooth(-12, -2, elevation) * (1 - smooth(4, 14, elevation))
    const gathered = Math.max(this.nightFactor, dawn * (this.hour < 12 ? 1 : 0.4))
    for (const f of this._fogVolumes) f.node.density = f.density * (1 + (this.fogNightScale - 1) * gathered) * (1 + overcast)

    if (this._skyLight) this._skyLight.intensity = this._skyLightIntensity * (1 + (this.nightSkyLight - 1) * this.nightFactor) * (1 - 0.35 * overcast)

    // Light probes relit each time the sun has moved far enough (and right after a jump): their captured
    // scene lit again by the sun, sky and lights as they are now. A probe never captured is baked instead.
    if (force || !this._probeAt || Math.acos(Math.min(1, pos[0] * this._probeAt[0] + pos[1] * this._probeAt[1] + pos[2] * this._probeAt[2])) * 180 / Math.PI > this.probeDegrees) {
      this._probeAt = pos
      // A moment later: the sky re-bakes first, and the probes should see the new one.
      this.after(force ? 1.1 : 0.4, () => {
        for (const probe of (this.scene as any)?.lightProbes ?? []) (probe.relight ?? probe.bake)?.call(probe)
      })
    }
  }
}
