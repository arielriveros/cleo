import { Game, Logger, Node, REFERENCE_ILLUMINANCE, aimFromDirection, clamp, lerp } from 'cleo'

/**
 * Night Shift — the level director. Attach to an empty node named `GameManager` at the scene root.
 *
 * One authoritative clock, one score, one place that decides the level is over. Everything else in the
 * game reads this node: the HUD, the spawner, the pickups and the end screen all find it once in
 * `onStart` and cache it. Nothing calls `findNode` per frame.
 *
 * ## The night
 *
 * A level is a fixed span of real time mapped linearly onto a clock, so difficulty scales through spawn
 * rate alone and nothing feeds back into the clock:
 *
 *   t         = elapsed / levelSeconds        0..1
 *   clockHour = startHour + t * nightHours    22:00 -> 06:00
 *   elevation = lerp(nightElevation, dayElevation, t)
 *   isDay     = elevation >= 0
 *
 * ## Why the sun is stepped on a timer and not in onUpdate
 *
 * The sky atmosphere bakes six cube faces of raymarched scattering plus a mip chain whenever the sun
 * moves, and the ONLY throttle is angular — it re-bakes once the sun has rotated ~0.3 degrees. Writing
 * `sunDirection`, `sunColor`, `sunIntensity`, the sky node's `exposure` or `groundColor` sets the bake
 * flag UNCONDITIONALLY, and that check short-circuits ahead of the angular one, so touching any of them
 * every frame bakes every frame.
 *
 * So we never touch those setters. We rotate the scene's directional light, which `useSceneSun` reads,
 * and that path is the only one the angular epsilon actually guards. Stepping it on a coarse timer keeps
 * the re-bake to roughly once a second even on a short night.
 *
 * Sky ambient is a second trap: the spherical-harmonic projection decides it is stale by comparing
 * cubemap OBJECT IDENTITY, and the re-bake renders into the same texture — so indirect light would freeze
 * at the first sun position forever. `markDirty()` on its own slow cadence is what keeps night dark.
 *
 * Renderer exposure/saturation/vignette are a different surface from the sky node's `exposure` and cost
 * nothing, so the dusk-to-dawn mood rides those per frame.
 */
export default class NightShiftDirectorNode extends Node {
  /** Real seconds from dusk to dawn. The whole level. */
  public levelSeconds: number = 180
  /** Clock hour the night starts at. */
  public startHour: number = 22
  /** Hours of game time the night spans. 22:00 + 8 = 06:00. */
  public nightHours: number = 8
  /** Sun elevation in degrees at t=0. Well below the horizon. */
  public nightElevation: number = -25
  /** Sun elevation in degrees at t=1. */
  public dayElevation: number = 20
  /** Compass direction the sun rises from, in degrees. */
  public sunAzimuth: number = 95
  /**
   * Sun brightness in LUX. Lights are photometric: `DEFAULT_DIRECTIONAL_LUX` is 100000 and the
   * renderer's reference illuminance is 78643, so a value in the single digits is not "dim", it is
   * black. Real moonlight is under a lux and unplayable, so this is a stylised moon about two and a
   * half stops under daylight — still night once exposure and saturation come down with it.
   */
  public nightLux: number = 6000
  public dayLux: number = 100000
  /**
   * Ambient, as a FRACTION of the reference illuminance so these read as the fractions they are.
   *
   * `nightAmbient` is doing nearly all the work, and it has to. For most of the night the sun is BELOW
   * the horizon, and a directional light below the horizon has `N dot L < 0` on every upward-facing
   * surface — so the ground receives essentially nothing from it however high `nightLux` goes. Ambient
   * is omnidirectional and is what you actually see by until the sun crosses over near dawn.
   *
   * Turning the night up means turning THIS up, not `nightLux`. The engine's own default scene ambient
   * is 0.1 of the reference, so a night sitting at half that is dim without being unreadable.
   */
  public nightAmbient: number = 0.05
  public dayAmbient: number = 0.16
  /** How many pickups the level was authored with. The HUD shows `found / total`. */
  public itemsTotal: number = 12
  /** Which level this is. Raises the spawn rate; persisted across a Continue. */
  public level: number = 1
  /** Seconds between sun steps. Small enough to look continuous, large enough not to thrash the bake. */
  public sunStepSeconds: number = 0.25
  /** Seconds between sky-ambient refreshes. Does a GPU readback, so keep it slow. */
  public ambientStepSeconds: number = 2
  /** Name of the scene loaded by the Exit button. */
  public menuScene: string = 'Main Menu'
  /** Report the lighting state once on start. Cheap, and the first thing to read if the level is dark. */
  public logLighting: boolean = true

  /** Points banked so far. */
  public score: number = 0
  /** Pickups collected so far. */
  public itemsFound: number = 0
  /** True once the level is over, either way. Gates the spawner and the clock. */
  public finished: boolean = false

  private _elapsed: number = 0
  private _sun: Node = null
  private _end: Node = null
  private _restoreRender: any = null

  onStart() {
    // The level number survives Game.loadScene, which resets every script. localStorage is the only
    // thing that does — the alternative is one scene per level.
    try {
      const saved = parseInt(window.localStorage.getItem('nightShift.level') || '', 10)
      if (isFinite(saved) && saved > 0) this.level = saved
    } catch { /* private mode, or no DOM — the default level stands */ }

    this._sun = this.findNode('Sun')
    this._end = this.findNode('EndScreen')
    if (!this._sun) Logger.warn('Night Shift: no node named "Sun" — the sky will not move.', 'Script')

    // Render settings live on the RENDERER, not the scene — one global the editor viewport shares with
    // Play. Ramping them without putting them back leaves the editor stuck at whatever the level last
    // looked like, which reads as "the scene went dark after I played it once".
    const current = Game.getRenderSettings()
    if (current) {
      this._restoreRender = {
        exposure: current.exposure,
        saturation: current.saturation,
        vignetteStrength: current.vignetteStrength,
      }
    }

    this._applySun()
    if (this.logLighting) this._reportLighting()
    this.every(this.sunStepSeconds, () => this._applySun())
    this.every(this.ambientStepSeconds, () => this.scene?.skyLight?.markDirty())
  }

  onUpdate(delta: number, time: number) {
    if (this.finished) return

    this._elapsed += delta
    const t = this.progress

    // Free every frame: none of these touch the sky node, so none of them can trigger a re-bake.
    //
    // Exposure OPENS at night and stops down toward dawn, the way a camera would — but only slightly.
    // Exposure is a correction, not the lighting: leaning on it to carry a night flattens the contrast
    // between the lit and unlit parts of the scene and washes the whole frame out. The darkness comes
    // from `nightAmbient` and a sun under the horizon; this just keeps it readable.
    Game.updateRenderSettings({
      exposure: lerp(1.6, 1.3, t),
      saturation: lerp(0.55, 1.0, t),
      vignetteStrength: lerp(0.4, 0.15, t),
    })

    if (t >= 1) this.endLevel(true)
  }

  /**
   * One line describing everything that decides how bright the level is.
   *
   * A dark scene has several possible causes that all look identical from the outside — an intensity in
   * the wrong unit, an ambient that is being overridden, an exposure running the wrong way — so this
   * prints the actual numbers rather than leaving it to be guessed at.
   *
   * `probes` is the one to watch: a light probe REPLACES the scene ambient for every pixel inside its
   * volume, so any non-zero count means `ambient` below is not what is lighting the player.
   */
  private _reportLighting(): void {
    const light = (this._sun as any)?.light
    const ambient = this.scene?.ambientLight
    Logger.info(
      'Night Shift lighting: elevation ' + this.sunElevation.toFixed(1) + ' deg'
      + ' | sun ' + (light ? Math.round(light.intensity) + ' lux' : 'NO SUN NODE')
      + ' | ambient ' + (ambient ? Math.round(Math.max(ambient[0], ambient[1], ambient[2])) + ' lux' : 'unset')
      + ' | exposure ' + (Game.getRenderSettings()?.exposure ?? '?')
      + ' | probes ' + (this.scene?.lightProbes?.size ?? 0)
      + ' | skyLight ' + (this.scene?.skyLight ? this.scene.skyLight.intensity.toFixed(2) : 'none'),
      'Script')
  }

  /** 0 at dusk, 1 at dawn. */
  public get progress(): number {
    return clamp(this._elapsed / Math.max(0.001, this.levelSeconds), 0, 1)
  }

  /** The clock as `HH:MM`, wrapping past midnight. */
  public get clockText(): string {
    const hour = this.startHour + this.progress * this.nightHours
    const h = Math.floor(hour) % 24
    const m = Math.floor((hour - Math.floor(hour)) * 60)
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m
  }

  /** Sun elevation in degrees. Negative is below the horizon. */
  public get sunElevation(): number {
    return lerp(this.nightElevation, this.dayElevation, this.progress)
  }

  /**
   * True once the sun is above the horizon. The spawner stops and every zombie catches fire on it.
   *
   * DERIVED from the clock, deliberately, rather than stamped by `_applySun`. Stamping it there would
   * make a gameplay rule depend on a rendering node existing: rename or delete the Sun light and the
   * night would never end, the zombies would never burn, and nothing would say why.
   */
  public get isDay(): boolean {
    return this.sunElevation >= 0
  }

  onDespawn() {
    // Play has stopped. Hand the viewport back the look it had before this level started.
    if (this._restoreRender) Game.updateRenderSettings(this._restoreRender)
  }

  public addScore(points: number): void {
    this.score += points
    this.itemsFound++
  }

  /**
   * End the level. `won` picks the panel's wording and which button the player gets.
   *
   * Pausing freezes every `onUpdate` and the health bar's smoothing but NOT the UI layout pass, and
   * button clicks arrive through the DOM rather than the node loop — so the panel still lays out and
   * still responds while the game behind it is stopped.
   */
  public endLevel(won: boolean): void {
    if (this.finished) return
    this.finished = true

    try {
      window.localStorage.setItem('nightShift.level', String(won ? this.level + 1 : this.level))
    } catch { /* nothing to persist to; Continue will restart at level 1 */ }

    const end = this._end as any
    if (end && end.showResult) end.showResult(won, this.itemsFound, this.itemsTotal, this.score, this.level)
    else Logger.warn('Night Shift: no EndScreen in the scene, so the level just stops.', 'Script')

    Game.pause()
  }

  /**
   * Point the directional light along the sun's travel.
   *
   * `aimFromDirection` is the inverse of the engine's euler-to-forward mapping, so feeding it the
   * direction light TRAVELS (the negated direction toward the sun) and writing the result as
   * `[pitch, yaw, 0]` round-trips exactly. Reading `rotation[1]` back would not — the decomposition
   * cannot express a yaw past a quarter turn.
   */
  private _applySun(): void {
    if (this.finished || !this._sun) return

    const elevation = this.sunElevation
    const e = elevation * Math.PI / 180
    const a = this.sunAzimuth * Math.PI / 180
    // Direction TOWARD the sun; the light travels the other way.
    const toSun: [number, number, number] = [Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)]
    const aim = aimFromDirection([-toSun[0], -toSun[1], -toSun[2]] as any)
    this._sun.setRotation([aim.pitch, aim.yaw, 0])

    // Colour and brightness are on the LIGHT, not the sky node, so they are free of the bake.
    const light = (this._sun as any).light
    if (!light) return
    const day = clamp((elevation + 6) / 12, 0, 1)
    light.intensity = lerp(this.nightLux, this.dayLux, day)
    light.color = [lerp(0.42, 1, day), lerp(0.5, 0.96, day), lerp(0.85, 0.86, day)]

    // Ambient is in LUX too. Leaving the scene's value unset gives the engine's own
    // DEFAULT_SCENE_AMBIENT_LUX (a tenth of the reference); writing a raw 0.06 gives darkness.
    if (this.scene) {
      const ambient = lerp(this.nightAmbient, this.dayAmbient, day) * REFERENCE_ILLUMINANCE
      this.scene.ambientLight = [ambient * 0.82, ambient * 0.9, ambient * 1.15]
    }

    const sky = this.scene?.skyLight
    if (sky) sky.intensity = lerp(0.35, 1, day)
  }
}
