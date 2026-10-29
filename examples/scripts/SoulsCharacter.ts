import { CharacterNode, Logger, Node, Shape, moveWorldDirection, resolveSocketOwner, setMoveWorld } from 'cleo'
import type { SocketName, TemplateName } from 'cleo'
import { clamp } from '@/Core/Scripts/SoulsMath'
import { bladeCapsule } from '@/Core/Scripts/SoulsHitbox'

/**
 * Hollow Keep — what every fighter is: the player, and each enemy type. A base script; the player
 * (SoulsPlayer) and the enemies (SoulsEnemy, then SoulsHollow, SoulsEliteKnight…) extend it, so each
 * owns its own health, defence and weapons as fields on its own node — no manager keeps them.
 *
 * ## Taking a hit
 *
 * `receiveHit(damage, poise, from)` is the ONE way damage arrives, from a blade (SoulsWeapon.strike), a
 * slam or a bolt alike. It runs the same steps for everyone and leaves the reaction to the subclass:
 *
 *   _canBeHit(damage)     false = it passes through (dead, rolling, roaring…)
 *   applyDefense          this character's own `defense` takes its share
 *   hp -= dealt, bleed
 *   _onHurt(dealt, from)  always — wake up, turn the health bar on, play a hurt sound
 *   hp <= 0 ? _die()      : _onDamaged(dealt, poise, from) — flinch, stagger, phase two
 *
 * `team` is what an attack reads to pick its targets: a player's blade hits `enemy` hurtboxes, an
 * enemy's hits `player` ones, so two enemies never cut each other down by accident.
 *
 * ## Weapons
 *
 * A character names its weapons by TEMPLATE in `weaponTemplates` (['Straight Sword', 'Greatsword']) and
 * spawns them on start under its `Weapons` group (or itself), attached to `weaponSocket`. The first is
 * equipped; `equipWeapon(i)` shows one and hides the rest. The weapon brings its own stats, hitbox and
 * moveset — see SoulsWeapon.
 *
 * `dropWeapon()` lets go of the held one: it leaves the hand for the world and becomes a physics body
 * (spheres along its blade), so it falls, rolls and can be kicked about. It still belongs to this
 * character, and goes when the character does (`_clearDroppedWeapons`, from the subclass's onDespawn).
 */
export default class SoulsCharacterNode extends CharacterNode {
  public displayName: string = 'Character'
  /** Which side attacks see this on: 'player' or 'enemy'. */
  public team: string = 'enemy'
  public maxHp: number = 100
  public hp: number = 100
  /** Fraction of incoming damage ignored, 0..0.9. */
  public defense: number = 0
  /** Collision-ish size, used by hit effects and lock-on height. */
  public bodyRadius: number = 0.4
  public bodyHeight: number = 1.8

  /** Weapon templates to spawn on start. The first is held. */
  public weaponTemplates: TemplateName[] = []
  /** Socket on this character's skeleton the weapons attach to. */
  public weaponSocket: SocketName = 'RightHand'
  /** Child group the weapons are spawned under (this node itself when there is none). */
  public weaponsGroup: string = 'Weapons'
  /** The held weapon's display name, for the HUD. */
  public weaponName: string = ''
  /** Let go of the held weapon on death, as a physics body (see dropWeapon). */
  public dropWeaponOnDeath: boolean = false
  /** The dropped weapon's mass, kg. */
  public droppedWeaponMass: number = 4
  /**
   * The steepest ground, in degrees, this character can walk UP. On anything steeper it can still move
   * across the slope or down it, but not climb (see limitClimb). The engine's own limit is 60°.
   */
  public maxWalkSlope: number = 45

  // ----- animation blending ------------------------------------------------------------------------
  /**
   * Seconds an attack takes to blend in over the locomotion under it, and to blend back out into idle or
   * the run at its end. Real seconds, whatever the attack's playback speed.
   */
  public attackBlendIn: number = 0.12
  public attackBlendOut: number = 0.35
  /** The same for every other one-shot: rolls, reactions, drinking, swaps. */
  public actionBlendIn: number = 0.1
  public actionBlendOut: number = 0.22

  // ----- wading ------------------------------------------------------------------------------------
  /**
   * The water zones this character is standing in: nodes whose trigger it is inside and that carry the
   * `isWater` variable (with an optional `waterSpeedScale`, 0..1). While in one it moves slower, and the
   * player cannot roll. Counted, not flagged, so two overlapping zones do not end on the first exit.
   */
  private _waterZones: Node[] = []

  // ----- runtime, read by others -------------------------------------------------------------------
  public isDead: boolean = false
  /**
   * Whether attacks can see this character at all. Off during i-frames, while dead, during a boss's
   * roar: every hitbox sweep and bolt passes straight through. See SoulsHitbox.
   */
  public hurtboxActive: boolean = true

  protected _gm: Node = null
  protected _weapons: Node[] = []
  protected _weaponIndex: number = 0
  protected _dropped: Node[] = []

  // =================================================================================================
  // Movement
  // =================================================================================================

  /**
   * Whether this character is wading: inside a water zone and, when the zone states its `waterLevel`,
   * with its feet below that level — a zone is a simple volume, the water's edge is wherever the ground
   * rises out of it.
   */
  public get inWater(): boolean { return this._wadingIn().length > 0 }

  private _wadingIn(): Node[] {
    const feet = this.worldPosition[1]
    return this._waterZones.filter(zone => {
      const level = Number((zone as any).getVariable?.('waterLevel'))
      return !Number.isFinite(level) || feet < level - 0.05
    })
  }

  /** The slowest speed multiplier among the water zones it is wading in (1 out of water). */
  public get waterSpeedScale(): number {
    let scale = 1
    for (const zone of this._wadingIn()) {
      const s = Number((zone as any).getVariable?.('waterSpeedScale'))
      scale = Math.min(scale, Number.isFinite(s) ? clamp(s, 0, 1) : 0.55)
    }
    return scale
  }

  onTriggerEnter(other: Node) {
    if ((other as any)?.getVariable?.('isWater') && !this._waterZones.includes(other)) this._waterZones.push(other)
    this._updateWading()
  }

  onTriggerExit(other: Node) {
    if (!this._waterZones.includes(other)) return
    this._waterZones = this._waterZones.filter(z => z !== other)
    this._updateWading()
  }

  /** Hooks for subclasses: wading begins, wading ends. */
  protected onEnterWater(): void {}
  protected onLeaveWater(): void {}

  private _wading: boolean = false
  /** Fire the wading hooks on a change — a zone edge crossed, or the feet going under or out of the water. */
  private _updateWading(): void {
    const now = this.inWater
    if (now === this._wading) return
    this._wading = now
    if (now) this.onEnterWater()
    else this.onLeaveWater()
  }

  /**
   * Slow this frame's move while wading. Call it LAST in onUpdate, beside limitClimb, so it also slows
   * what the state code drove itself (a lunge, a knockback) rather than only the stick.
   */
  protected applyWater(intent: any): void {
    this._updateWading()
    if (!intent || !this._wading) return
    intent.speedScale = clamp((intent.speedScale ?? 1) * this.waterSpeedScale, 0, 1)
  }

  /**
   * Take the uphill share out of this frame's move when the ground is steeper than `maxWalkSlope`. What is
   * left — across the slope, or down it — still goes through, so the character slides along a cliff foot
   * instead of sticking to it. Call it LAST in onUpdate, after everything that writes the intent.
   */
  protected limitClimb(intent: any): void {
    if (!intent || !(this.maxWalkSlope < 90) || !this.isGrounded) return
    const n = this.groundNormal
    if (n[1] >= Math.cos(this.maxWalkSlope * Math.PI / 180)) return
    const h = Math.hypot(n[0], n[2])
    if (h < 1e-4) return
    // The normal's horizontal part points DOWNHILL.
    const downX = n[0] / h, downZ = n[2] / h
    const move = moveWorldDirection([0, 0, 0] as any, intent)
    const along = move[0] * downX + move[2] * downZ
    if (along >= 0) return
    setMoveWorld(intent, move[0] - along * downX, move[2] - along * downZ)
  }

  // =================================================================================================
  // Damage
  // =================================================================================================

  /** Damage that survives this character's defence (0..0.9). Never below 1, so a hit always registers. */
  public applyDefense(raw: number): number {
    return Math.max(1, Math.round(raw * (1 - clamp(this.defense, 0, 0.9))))
  }

  /** Take a hit. Returns true when it landed. See "Taking a hit". */
  public receiveHit(damage: number, poiseDamage: number, from: Node): boolean {
    if (!this._canBeHit(damage)) return false
    const dealt = this.applyDefense(damage)
    this.hp = Math.max(0, this.hp - dealt)
    ;(this._gm as any)?.bleed?.(this, from, dealt)
    this._onHurt(dealt, from)
    if (this.hp <= 0) this._die()
    else this._onDamaged(dealt, poiseDamage, from)
    return true
  }

  /** Whether a hit of `damage` lands right now. */
  protected _canBeHit(damage: number): boolean {
    return !this.isDead && damage > 0
  }

  /** Every landed hit, before the death check. */
  protected _onHurt(dealt: number, from: Node): void {}

  /** A landed hit that did not kill. */
  protected _onDamaged(dealt: number, poiseDamage: number, from: Node): void {}

  protected _die(): void {
    this.isDead = true
  }

  // =================================================================================================
  // Weapons
  // =================================================================================================

  /** Spawn every weapon in `weaponTemplates` into the hand, and hold the first. */
  protected _spawnWeapons(): void {
    // Immediate: a weapon swap or a re-spawn must not leave the old blade dissolving in the hand.
    for (const w of this._weapons) { try { w.remove({ immediate: true }) } catch { /* already gone */ } }
    this._weapons = []
    // A list; a comma-separated string is still read, as scenes saved before the field was a list hold one.
    const raw: unknown = this.weaponTemplates
    const names = (Array.isArray(raw) ? raw.map(String) : String(raw ?? '').split(','))
      .map(s => s.trim()).filter(Boolean)
    const parent = this.getChildByName(this.weaponsGroup)[0] ?? this
    for (const name of names) {
      const weapon = this.scene?.instantiate(name, { parent })
      if (!weapon) continue   // instantiate has logged the missing template
      if (!(weapon as any).isWeapon) {
        Logger.warn('Hollow Keep: "' + name + '" is not a weapon template (its root has no SoulsWeapon script).', 'Script')
        weapon.remove({ immediate: true })
        continue
      }
      weapon.attachToSocket('parent', this.weaponSocket)
      this._weapons.push(weapon)
    }
    // Said once, here, rather than discovered as "attacks do no damage": the weapon can only be held by a
    // hand this character's own model has. Humanoid rigs get RightHand/LeftHand without authoring.
    const first = this._weapons[0]
    if (first && !resolveSocketOwner(first, { target: 'parent', socket: this.weaponSocket }, id => this.scene?.getNodeById(id) ?? null))
      Logger.warn('Hollow Keep: "' + this.name + '"\'s model has no "' + this.weaponSocket + '" socket, so it cannot hold its weapon. '
        + 'Add a socket with that name on its hand bone in the rig editor (or set weaponSocket to one it has).', 'Script')
    if (names.length && !this._weapons.length)
      Logger.warn('Hollow Keep: "' + this.name + '" has no usable weapon among "' + names.join(', ') + '".', 'Script')
    this.equipWeapon(0)
  }

  /** Every weapon this character carries, in `weaponTemplates` order. */
  public weapons(): Node[] { return this._weapons }

  /** The weapon in hand (a SoulsWeapon node), or null. */
  public currentWeapon(): Node { return this._weapons[this._weaponIndex] ?? null }

  /**
   * Let go of the held weapon. It is moved to the scene root where it is (a dropped weapon belongs to the
   * world, not to whoever let go of it), detached from the hand, and given a dynamic body made of spheres
   * along its blade hitbox. Not solid to the camera. Returns the weapon, or null with none held.
   */
  public dropWeapon(): Node {
    const weapon = this.currentWeapon()
    const root = this.scene?.root
    if (!weapon || !root) return null
    const blade = bladeCapsule(weapon)
    const at = Array.from(weapon.worldPosition), q = Array.from(weapon.worldQuaternion)
    weapon.detachFromSocket()
    root.addChild(weapon)
    weapon.setPosition([at[0], at[1], at[2]])
    weapon.setQuaternion(q as any)
    weapon.updateTransforms?.()
    const body: any = weapon.setBody(this.droppedWeaponMass, 0.05, 0.3, undefined, undefined, 0.8, 0.1, true, false)
    const points = blade
      ? [blade.a, [(blade.a[0] + blade.b[0]) / 2, (blade.a[1] + blade.b[1]) / 2, (blade.a[2] + blade.b[2]) / 2], blade.b]
      : [at]
    const radius = Math.max(0.04, blade?.radius ?? 0.08)
    for (const p of points) body.attachShape(Shape.Sphere(radius), toLocal(q, at, p))
    body.recenterMass?.()
    this._weapons = this._weapons.filter(w => w !== weapon)
    this._dropped.push(weapon)
    this.weaponName = ''
    return weapon
  }

  /** Every weapon this character has dropped, still lying about. */
  public droppedWeapons(): Node[] { return this._dropped }

  /** Remove the weapons this character dropped. Called when the character itself goes. */
  protected _clearDroppedWeapons(): void {
    for (const w of this._dropped) { try { w.remove() } catch { /* already gone */ } }
    this._dropped = []
  }

  /** Hold weapon `index`: it shows, the others hide. */
  public equipWeapon(index: number): void {
    this._weaponIndex = Math.max(0, Math.min(index, this._weapons.length - 1))
    this._weapons.forEach((w, i) => { if (w.visible !== (i === this._weaponIndex)) w.visible = i === this._weaponIndex })
    this.weaponName = (this.currentWeapon() as any)?.displayName ?? ''
  }
}

/** `p` (world) in the frame of a node at `at` with rotation `q` — the inverse rotation of p − at. */
function toLocal(q: ArrayLike<number>, at: ArrayLike<number>, p: ArrayLike<number>): [number, number, number] {
  const v = [p[0] - at[0], p[1] - at[1], p[2] - at[2]]
  // Rotate by the conjugate (-x, -y, -z, w): v' = v + 2w(c×v) + 2c×(c×v), with c = -q.xyz.
  const cx = -q[0], cy = -q[1], cz = -q[2], w = q[3]
  const tx = 2 * (cy * v[2] - cz * v[1]), ty = 2 * (cz * v[0] - cx * v[2]), tz = 2 * (cx * v[1] - cy * v[0])
  return [v[0] + w * tx + (cy * tz - cz * ty), v[1] + w * ty + (cz * tx - cx * tz), v[2] + w * tz + (cx * ty - cy * tx)]
}
