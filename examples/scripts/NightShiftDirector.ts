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
  /**
   * Meter the frame and adapt the exposure, instead of holding the hand-set value.
   *
   * On, but on a SHORT LEASH. Auto-exposure normalises whatever it is shown toward middle grey — that
   * is its job — so left free it makes a night as bright as a dawn and the whole lighting ramp becomes
   * cosmetic. The band below is what keeps it a trim rather than the lighting.
   */
  public useAutoExposure: boolean = true
  /**
   * How far metering may move the picture, as EV100 clamps.
   *
   * READ THE UNITS BEFORE TOUCHING THESE. `exposure = REFERENCE_ILLUMINANCE / (1.2 * 2^EV)`, so EV and
   * brightness run in OPPOSITE directions and the numbers are not gentle:
   *
   *   EV 14.5 -> exposure 2.8      EV 15.3 -> 1.6 (this level's night)
   *   EV 16.5 -> exposure 0.7      EV  9   -> 128  <- eighty times the night, a white screen
   *
   * `exposureMinEV` is therefore a CEILING on brightness, and it is the one that matters here: metering
   * a dark night wants a low EV, so it sits on this floor all night. The engine's own default is 2.0 —
   * an exposure of 16384 — which is fine for a scene that really is that dark and catastrophic for one
   * that is merely meant to look it.
   *
   * The band brackets the authored exposures below, so the picture can never stray more than about a
   * stop either side of the look the level was tuned at. `tests/nightShift.test.ts` pins that.
   */
  public autoExposureMinEV: number = 14.5
  public autoExposureMaxEV: number = 16.5
  /**
   * Stops of artist trim on the metered result, ramped across the night — and this is what carries the
   * time of day now.
   *
   * With metering on, the manual exposure is ignored outright, so the dusk-to-dawn ramp cannot come from
   * it. Compensation can: the renderer SUBTRACTS it after the clamp, so a negative value raises the EV,
   * darkens the picture, and reaches past the band. Night sits a stop under whatever was metered; dawn
   * is neutral. The engine default is +1, which is a stop the wrong way for a night.
   */
  public nightExposureCompensation: number = -1
  public dayExposureCompensation: number = 0
  /** Adaptation rate. The engine defaults (3 up, 1 down) chase hard enough to be visible as a pump. */
  public autoExposureSpeed: number = 0.6
  /**
   * The hand-set exposure ramp. Only in force while `useAutoExposure` is off — the renderer applies the
   * manual value only then — but kept as the authored reference the EV band above is checked against.
   */
  public nightExposure: number = 1.6
  public dayExposure: number = 1.3

  // ----- shared placement service ---------------------------------------------------------------
  //
  // Both spawners need the same question answered — "give me a spot on walkable ground" — and one
  // script cannot import another, so the choice is one copy here or two copies there. It lives on the
  // director because that is already the node everything else looks up.

  /** Radius of the disc, centred on `spawnCenter`, that spawns are scattered over. */
  public spawnRadius: number = 70
  public spawnCenter: [number, number, number] = [0, 0, 0]
  /** Degrees. A surface steeper than this is a cliff, not somewhere to stand. */
  public maxSlope: number = 35
  /** The downward probe. `rayTop` must clear the highest ground in the level. */
  public rayTop: number = 200
  public rayBottom: number = -100
  /** Metres above the surface to drop the spawn, so it settles onto the ground rather than through it. */
  public spawnLift: number = 1.2
  /** How many random points to try before giving up for one call. */
  public placementTries: number = 24

  /** Points banked so far. */
  public score: number = 0
  /** Pickups collected so far. */
  public itemsFound: number = 0
  /** True once the level is over, either way. Gates the spawner and the clock. */
  public finished: boolean = false

  private _elapsed: number = 0
  private _sun: Node = null
  private _end: Node = null
  private _player: Node = null
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
    this._player = this.findNode('Playable')
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
        autoExposureEnabled: current.autoExposureEnabled,
        exposureCompensation: current.exposureCompensation,
        exposureMinEV: current.exposureMinEV,
        exposureMaxEV: current.exposureMaxEV,
        exposureSpeedUp: current.exposureSpeedUp,
        exposureSpeedDown: current.exposureSpeedDown,
      }
    }

    // Set ONCE, not per frame: the `autoExposureEnabled` setter re-seeds the adaptation from the
    // current picture as it flips on, so writing it every frame would keep nudging that seed.
    Game.updateRenderSettings({
      autoExposureEnabled: this.useAutoExposure,
      exposureMinEV: this.autoExposureMinEV,
      exposureMaxEV: this.autoExposureMaxEV,
      exposureSpeedUp: this.autoExposureSpeed,
      exposureSpeedDown: this.autoExposureSpeed,
    })

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
    // Exposure is a correction, not the lighting: leaning on it to carry a night flattens the contrast
    // between the lit and unlit parts of the scene and washes the whole frame out. The darkness comes
    // from `nightAmbient` and a sun under the horizon; these only keep it readable.
    //
    // Both exposure levers are written every frame because only one of them is live at a time and which
    // one depends on `useAutoExposure`: the renderer ignores the manual value while metering, and
    // ignores the compensation while not. Writing both means toggling that field mid-level does not
    // leave a stale trim behind.
    Game.updateRenderSettings({
      exposure: lerp(this.nightExposure, this.dayExposure, t),
      exposureCompensation: lerp(this.nightExposureCompensation, this.dayExposureCompensation, t),
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

  // ----- placement -------------------------------------------------------------------------------

  /**
   * A random spot on walkable ground, or null if none of `placementTries` attempts found one.
   *
   * Uniform over the disc: the radius is `R * sqrt(u)`, not `R * u`, which would pile two thirds of the
   * spawns into the middle third of the map.
   */
  public findGroundSpot(minPlayerDistance: number): number[] {
    const player = this._player ? this._player.worldPosition : null

    for (let i = 0; i < this.placementTries; i++) {
      const angle = Math.random() * Math.PI * 2
      const radius = this.spawnRadius * Math.sqrt(Math.random())
      const x = this.spawnCenter[0] + Math.sin(angle) * radius
      const z = this.spawnCenter[2] + Math.cos(angle) * radius

      const spot = this.groundAt(x, z)
      if (!spot) continue
      if (player && minPlayerDistance > 0
        && Math.hypot(spot[0] - player[0], spot[2] - player[2]) < minPlayerDistance) continue
      return spot
    }
    return null
  }

  /**
   * Drop a ray down the given column and return a standable point on the terrain, or null.
   *
   * Two rejections, and both matter:
   *
   * **Not the terrain.** The landscape registers its heightfield with the physics world directly, with
   * no owning node, so a hit that HAS a node came off something else — the house, a prop, another
   * spawn. A pickup on a roof you cannot climb is unreachable, and a zombie on one walks off the edge.
   * `hit.node === null` is the whole test.
   *
   * **Too steep.** The terrain has cliffs. `maxSlope` keeps spawns off the parts of it a character
   * would only slide down.
   */
  public groundAt(x: number, z: number): number[] {
    const physics = this.scene?.physics as any
    if (!physics || !physics.raycast) return null

    let hit = null
    try { hit = physics.raycast([x, this.rayTop, z], [x, this.rayBottom, z]) }
    catch { return null }
    if (!hit) return null
    if (hit.node) return null

    const up = physics.up ?? [0, 1, 0]
    const cos = clamp(hit.normal[0] * up[0] + hit.normal[1] * up[1] + hit.normal[2] * up[2], -1, 1)
    if (Math.acos(cos) * 180 / Math.PI > this.maxSlope) return null

    return [hit.point[0], hit.point[1] + this.spawnLift, hit.point[2]]
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
