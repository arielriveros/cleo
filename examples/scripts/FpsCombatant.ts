import { CharacterNode, Logger } from 'cleo'
import type { Node, TemplateName } from 'cleo'
import { WEAPONS, aimDirection, canDamage, clamp, combatantOf, manager, rotationOntoNormal, spreadDirection } from './FpsShared'
import type { WeaponSpec } from './FpsShared'

/**
 * FPS example — what every fighter is: the player and each bot. A base script; FpsPlayer and FpsBot extend it.
 *
 * ## Taking a hit
 *
 * `receiveHit(damage, from, point, zone, dir)` is the one way damage arrives. It runs the same steps for
 * everyone and leaves the reaction to the subclass:
 *
 *   hp -= damage, then the blood at the point, then `onHurt`
 *   hp <= 0  ->  die(): the Game Manager is told (score, feed, respawn), then `onDeath` plays the end
 *
 * ## Shooting
 *
 * `fireHitscan` is the ONE bullet: a ray (with its spread), the first body it meets, the zone it struck (head
 * above `headLine` of the body's height), damage with falloff, and the effects — tracer, impact sparks, a
 * bullet hole on a wall, blood on a body. The player and the bots both shoot through it, so a bot's bullet
 * and the player's stop at the same things. A crouching body is only as tall as `crouchHeight`: a bullet
 * above it passes on, because the capsule underneath stays standing height.
 *
 * ## Teams
 *
 * `team` is just a string. The Game Manager (FpsGameManager) sets it from the match mode; with no manager in
 * the scene it is whatever the template says, and two combatants are hostile when their teams differ.
 */
export default class FpsCombatantNode extends CharacterNode {
  public displayName: string = 'Combatant'
  public team: string = 'red'
  public maxHp: number = 100
  public hp: number = 100
  /** Which WEAPONS entry this fighter uses. */
  public weapon: string = 'ak47'
  /** The template the Game Manager respawns this fighter from (blank: this node itself is reset instead). */
  public respawnTemplate: TemplateName = '' as TemplateName

  /** Damage multiplier for a head shot. */
  public headMultiplier: number = 2.2
  /** Height of the body standing and crouching, metres (hit zones, the eye, the target). */
  public standHeight: number = 1.78
  public crouchHeight: number = 1.2
  /** A hit above this share of the body's height is the head. */
  public headLine: number = 0.84

  // ----- effects: templates this fighter spawns --------------------------------------------------------
  public impactTemplate: TemplateName = 'FPS Impact' as TemplateName
  public bloodTemplate: TemplateName = 'FPS Blood Hit' as TemplateName
  public holeTemplate: TemplateName = 'FPS Bullet Hole' as TemplateName
  public tracerTemplate: TemplateName = 'FPS Tracer' as TemplateName

  // ----- runtime, read by others -----------------------------------------------------------------------
  public isDead: boolean = false
  public isCrouching: boolean = false
  public kills: number = 0
  public deaths: number = 0
  /** Where the last hit on this fighter came from (a world point), for the player's damage indicator. */
  public lastHitFrom: number[] = [0, 0, 0]
  public lastHitAt: number = -999
  /** The magazine, kept here so the HUD, the bots' reload and the manager's respawn all read one place. */
  public ammo: number = 30
  public reserve: number = 150

  protected _time: number = 0
  private _missing: Set<string> = new Set()

  // =================================================================================================
  // Lifecycle
  // =================================================================================================

  onStart() {
    this.setVariable('fpsCombatant', true, 'boolean', 'public')
    this.hp = this.maxHp
    this.isDead = false
    const spec = this.spec
    this.ammo = spec.mag
    this.reserve = spec.reserve
    manager()?.register?.(this)
  }

  onDespawn() {
    manager()?.unregister?.(this)
  }

  /** The current weapon's numbers. */
  public get spec(): WeaponSpec { return WEAPONS[this.weapon] ?? WEAPONS.ak47 }

  /** Height of the body now, metres. */
  public get bodyHeight(): number { return this.isCrouching ? this.crouchHeight : this.standHeight }

  /** Where a bullet leaves from and a bot sees from: world position, metres above the feet. */
  public get eyeOffset(): number { return this.bodyHeight - 0.13 }

  /** Where other fighters aim: the chest. */
  public get chest(): number[] {
    const p = this.worldPosition
    return [p[0], p[1] + this.bodyHeight * 0.68, p[2]]
  }

  // =================================================================================================
  // Damage
  // =================================================================================================

  /**
   * Take a hit. `zone` is 'head' | 'body'. Returns true when it landed. A subclass reacts in `onHurt`; the
   * kill is `die`.
   */
  public receiveHit(damage: number, from: Node | null, point?: ArrayLike<number>, zone: string = 'body', dir?: ArrayLike<number>): boolean {
    if (this.isDead || damage <= 0) return false
    this.hp = Math.max(0, this.hp - damage)
    const f = (from as any)?.worldPosition
    if (f) { this.lastHitFrom = [f[0], f[1], f[2]]; this.lastHitAt = this._time }
    const at = point ? [point[0], point[1], point[2]] : this.chest
    this._blood(at, dir)
    this.onHurt(damage, from, zone)
    manager()?.onDamaged?.(this, from, damage, zone)
    if (this.hp <= 0) this.die(from, zone, dir)
    return true
  }

  /** Every landed hit, before the death check. */
  protected onHurt(damage: number, from: Node | null, zone: string): void {}

  public die(from: Node | null, zone: string = 'body', dir?: ArrayLike<number>): void {
    if (this.isDead) return
    this.isDead = true
    this.deaths++
    const killer = combatantOf(from)
    if (killer && killer !== this) killer.kills++
    manager()?.onKilled?.(this, killer, zone)
    this.onDeath(killer, zone, dir)
  }

  /** The end: play the animation, ragdoll, drop the weapon. */
  protected onDeath(killer: any, zone: string, dir?: ArrayLike<number>): void {}

  /** Full health and a full magazine, alive again (the manager moves the body). */
  public resetForRespawn(): void {
    this.hp = this.maxHp
    this.isDead = false
    this.isCrouching = false
    const spec = this.spec
    this.ammo = spec.mag
    this.reserve = spec.reserve
  }

  // =================================================================================================
  // Shooting
  // =================================================================================================

  /** Where the muzzle is, for the tracer and the flash (a subclass places it at its weapon). */
  protected muzzleWorld(origin: number[]): number[] { return origin }

  /**
   * Fire one shot (all of a shotgun's pellets) from `origin` along `dir` with `coneDeg` of spread. Returns the
   * damage it dealt and whether it killed anyone. `damageScale` lets a bot's skill dull the weapon.
   */
  protected fireHitscan(origin: number[], dir: ArrayLike<number>, coneDeg: number, damageScale: number = 1)
    : { dealt: number, hits: number, headshot: boolean, killed: boolean } {
    const spec = this.spec
    const physics = this.scene?.physics as any
    const out = { dealt: 0, hits: 0, headshot: false, killed: false }
    if (!physics) return out
    const muzzle = this.muzzleWorld(origin)
    const per = new Map<any, { damage: number, zone: string, point: number[] }>()
    const pellets = Math.max(1, spec.pellets)
    manager()?.makeNoise?.(origin, spec.key === 'pistol' ? 38 : 60, this)

    for (let i = 0; i < pellets; i++) {
      const d = spreadDirection(dir, i === 0 && pellets === 1 ? coneDeg : coneDeg)
      let from = origin
      let ignore: any = null
      let hit: any = null
      for (let pass = 0; pass < 3; pass++) {
        const to = [from[0] + d[0] * spec.range, from[1] + d[1] * spec.range, from[2] + d[2] * spec.range]
        hit = physics.raycast(from, to, {
          reject: (owner: Node | null) => {
            const c = combatantOf(owner)
            return c === this || (ignore !== null && c === ignore)
          },
        })
        const victim = hit ? combatantOf(hit.node) : null
        // A crouching body is shorter than its capsule: a bullet above it goes on past.
        if (victim && victim.isCrouching && hit.point[1] - victim.worldPosition[1] > victim.crouchHeight + 0.02) {
          ignore = victim
          from = [hit.point[0] + d[0] * 0.02, hit.point[1] + d[1] * 0.02, hit.point[2] + d[2] * 0.02]
          continue
        }
        break
      }
      if (!hit) { this._tracer(muzzle, [origin[0] + d[0] * 80, origin[1] + d[1] * 80, origin[2] + d[2] * 80]); continue }
      this._tracer(muzzle, hit.point)
      const victim = combatantOf(hit.node)
      if (victim && !victim.isDead && canDamage(this, victim)) {
        const height = victim.bodyHeight
        const rel = (hit.point[1] - victim.worldPosition[1]) / Math.max(0.5, height)
        const zone = rel >= victim.headLine ? 'head' : 'body'
        const t = clamp(hit.distance / Math.max(1, spec.falloffRange), 0, 1)
        const dmg = spec.damage * (1 + (spec.falloff - 1) * t) * (zone === 'head' ? this.headMultiplier : 1) * damageScale
        const e = per.get(victim) ?? { damage: 0, zone: 'body', point: hit.point }
        e.damage += dmg
        if (zone === 'head') e.zone = 'head'
        e.point = hit.point
        per.set(victim, e)
        out.hits++
      } else if (victim && victim.isDead) {
        this._impact(hit, true)
      } else if (!victim) {
        this._impact(hit, false)
      } else {
        // A teammate (no friendly fire): the bullet stops, with the blood of a hit but no damage.
        this._blood(hit.point, d)
      }
    }
    for (const [victim, e] of per) {
      const wasDead = victim.isDead
      victim.receiveHit(e.damage, this, e.point, e.zone, dir)
      out.dealt += e.damage
      if (e.zone === 'head') out.headshot = true
      if (!wasDead && victim.isDead) out.killed = true
    }
    return out
  }

  // =================================================================================================
  // Effects
  // =================================================================================================

  /** Spawn an effect template, or nothing (quietly, once) when the scene has no such template. */
  protected spawnFx(template: string, position: ArrayLike<number>, rotation?: number[], parent?: Node): Node | null {
    if (!template || this._missing.has(template)) return null
    const scene = this.scene as any
    if (!scene?.getTemplate?.(template)) {
      this._missing.add(template)
      Logger.warn(`FPS: no "${template}" template, so that effect is skipped`, 'Script')
      return null
    }
    return scene.instantiate(template, { position: [position[0], position[1], position[2]], ...(rotation ? { rotation } : {}), ...(parent ? { parent } : {}) })
  }

  private _impact(hit: any, onCorpse: boolean): void {
    const n = hit.normal
    const rot = rotationOntoNormal(n)
    const at = [hit.point[0] + n[0] * 0.015, hit.point[1] + n[1] * 0.015, hit.point[2] + n[2] * 0.015]
    this.spawnFx(this.impactTemplate, at, rot)
    if (!onCorpse) {
      const decal = this.spawnFx(this.holeTemplate, at, [rot[0], rot[1], Math.random() * 360])
      if (decal) manager()?.registerDecal?.(decal)
    }
  }

  private _blood(point: ArrayLike<number>, dir?: ArrayLike<number>): void {
    const yaw = dir ? Math.atan2(dir[0], dir[2]) * 180 / Math.PI : 0
    this.spawnFx(this.bloodTemplate, point, [0, yaw, 0])
  }

  private _tracer(from: number[], to: number[]): void {
    const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2]
    const len = Math.hypot(dx, dy, dz)
    if (len < 3) return
    const node: any = this.spawnFx(this.tracerTemplate, from, [Math.atan2(-dy, Math.hypot(dx, dz)) * 180 / Math.PI, Math.atan2(dx, dz) * 180 / Math.PI, 0])
    if (node) { node.setVariable?.('tracerLength', len, 'number', 'public'); node.tracerLength = len }
  }

  /** Direction a camera rig at (yaw, pitch) looks along, handy for subclasses. */
  protected aim(yaw: number, pitch: number): number[] { return aimDirection(yaw, pitch) }
}
