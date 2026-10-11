import { Input, Logger, Node } from 'cleo'
import { angleDiff, clamp, forwardYaw, num, planarDistance, yawTo } from './SoulsMath'

/**
 * Hollow Keep — the game manager. Attach to an empty node named `GameManager` at the scene root.
 *
 * The hub of the demo. The engine has no gameplay event bus, so every gameplay object finds this node
 * once in `onStart` and talks to it through plain method calls (shared PURE helpers live in the
 * SoulsMath module instead, which every script imports):
 *
 *   enemies        registerEnemy / unregisterEnemy        (SoulsEnemy)
 *   interactables  registerInteractable / unregister...   (bonfire, pickups, lever, signs, fog gate...)
 *   spawn points   registerSpawn                          (SoulsEnemySpawn)
 *
 * UI never gets called; it POLLS public fields here and on the player every frame.
 *
 * ## The rules live here too
 *
 * Every number the game is balanced on — HP per Vigor, the attack-rating formula, the level cost — is a
 * method on this class, so there is exactly one copy and its tuning fields are editable on the node.
 * They are ordinary instance methods that read nothing from `this` except tuning fields: a class script
 * is never constructed and its STATIC members never reach the node. Tests call them on
 * `new SoulsGameManagerNode('GameManager')`.
 *
 * ## Game flow it owns
 *
 *   rest(bonfire)          heal, refill flasks, respawn the non-boss enemies, set the respawn point
 *   onPlayerDied()         drop a bloodstain, YOU DIED, then respawnAtBonfire()
 *   startBossFight(gate)   wake the boss, show its bar, start the music
 *   onBossDefeated(boss)   dissolve the fog, banner, reward
 *
 * ## Sounds and effects
 *
 * `sfx('Swing')` plays the SoundNode of that name under the scene's `Sounds` group; `fx('Hit Spark', p)`
 * instantiates a template at a point. Both are silent no-ops when the node or template is missing, so a
 * level with no audio assigned yet plays exactly the same — just quietly. See SOULS_DEMO.md for the list.
 */
export default class SoulsGameManagerNode extends Node {
  // ----- balance: player stats -------------------------------------------------------------------
  /** HP at Vigor 10. Each point to 30 adds `hpPerVigor`, then the curve flattens (see hpForVigor). */
  public baseHp: number = 400
  public hpPerVigor: number = 30
  /** Stamina at Endurance 10, plus `staminaPerEndurance` per point to 40. */
  public baseStamina: number = 90
  public staminaPerEndurance: number = 3
  /** Attack-rating multiplier applied when a weapon's STR or DEX requirement is not met. */
  public unmetRequirementPenalty: number = 0.6

  // ----- flow -------------------------------------------------------------------------------------
  /** Seconds between the killing blow and the YOU DIED banner. */
  public deathBannerDelay: number = 1.2
  /** Seconds between the killing blow and the respawn at the bonfire. */
  public respawnDelay: number = 5
  /** Template instantiated where the player died, carrying their souls. */
  public bloodstainTemplate: string = 'Bloodstain'
  /** Effect template spawned on every successful melee hit. */
  public hitSparkTemplate: string = 'Hit Spark'

  // ----- blood (see bleed) -------------------------------------------------------------------------
  /** Off, no blood at all: no spray and no decals. */
  public bloodEnabled: boolean = true
  /** Droplets thrown off a wound (particles). */
  public bloodSprayTemplate: string = 'Blood Spray'
  /** The pool decal left under a wounded body. */
  public bloodSplatTemplate: string = 'Blood Splat'
  /** The spatter decal thrown along the blow. */
  public bloodDropsTemplate: string = 'Blood Drops'
  /** Blood decals alive at once. The oldest goes first, so a long fight cannot pile up draws. */
  public maxBloodDecals: number = 24
  /** Damage that leaves a full-size splat; less shrinks it, more grows it (0.6x to 1.6x). */
  public bloodReferenceDamage: number = 120
  /** Name of the group whose SoundNode children `sfx()` plays. */
  public soundsGroup: string = 'Sounds'
  /** Name of the reward pickup revealed once the boss falls. */
  public bossRewardName: string = 'Boss Reward'
  /** Name of the lore message revealed once the boss falls. */
  public bossEpilogueName: string = 'Epilogue Message'
  /** Log a one-off warning when the project's input map lacks the souls actions. */
  public checkInputMap: boolean = true

  // ----- runtime state (read by the HUD) -----------------------------------------------------------
  public bossActive: boolean = false
  public bossDefeated: boolean = false
  public bossName: string = ''
  public bossHp: number = 0
  public bossMaxHp: number = 1

  private _player: Node = null
  private _hud: Node = null
  private _banner: Node = null
  private _menu: Node = null
  private _lockOn: Node = null
  private _sounds: Node = null
  private _enemies: Node[] = []
  private _interactables: Node[] = []
  private _spawns: Node[] = []
  private _bonfires: Node[] = []
  private _restBonfire: Node = null
  private _respawnPoint: number[] = null
  private _respawnYaw: number = 0
  private _bloodstain: Node = null
  private _bloodDecals: Node[] = []
  private _boss: Node = null
  private _fogGate: Node = null
  private _dying: boolean = false

  onStart() {
    this._player = this.findNode('Player')
    this._hud = this.findNode('HUD')
    this._banner = this.findNode('Banner')
    this._menu = this.findNode('BonfireMenu')
    this._sounds = this.findNode(this.soundsGroup)
    if (this._player) {
      const p = this._player.worldPosition
      this._respawnPoint = [p[0], p[1], p[2]]
      const f = this._player.worldForward
      this._respawnYaw = Math.atan2(f[0], f[2]) * 180 / Math.PI
    }
    if (this.checkInputMap) this._checkInputMap()
  }

  // =================================================================================================
  // Rules — pure functions of their arguments and the tuning fields above
  // =================================================================================================

  /** Max HP for a Vigor value. Steep to 30, gentler to 40, then a trickle. */
  public hpForVigor(vigor: number): number {
    const v = Math.max(10, vigor)
    return Math.round(this.baseHp + this.hpPerVigor * Math.min(v - 10, 20)
      + 12 * clamp(v - 30, 0, 10) + 5 * Math.max(v - 40, 0))
  }

  /** Max stamina for an Endurance value. */
  public staminaForEndurance(endurance: number): number {
    const e = Math.max(10, endurance)
    return Math.round(this.baseStamina + this.staminaPerEndurance * Math.min(e - 10, 30) + Math.max(e - 40, 0))
  }

  /**
   * How much a stat adds to a weapon that scales with it fully: 0 at 10, 0.6 at 30, 0.9 at 50, then a
   * quarter of a percent per point. Soft caps are the whole reason a build has to choose.
   */
  public statBonus(stat: number): number {
    if (stat <= 10) return 0
    if (stat <= 30) return (stat - 10) / 20 * 0.6
    if (stat <= 50) return 0.6 + (stat - 30) / 20 * 0.3
    return 0.9 + (stat - 50) * 0.0025
  }

  /**
   * A weapon's attack rating for the given stats.
   *
   *   AR = baseDamage × (1 + strScaling·bonus(STR) + dexScaling·bonus(DEX))
   *
   * times `unmetRequirementPenalty` when either requirement is not met.
   */
  public attackRating(weapon: any, strength: number, dexterity: number): number {
    if (!weapon) return 0
    const base = num(weapon.baseDamage, 0)
    let ar = base * (1 + num(weapon.strScaling, 0) * this.statBonus(strength)
      + num(weapon.dexScaling, 0) * this.statBonus(dexterity))
    if (strength < num(weapon.strRequirement, 0) || dexterity < num(weapon.dexRequirement, 0))
      ar *= this.unmetRequirementPenalty
    return Math.round(ar)
  }

  /** Souls needed to go from `level` to `level + 1`. */
  public levelCost(level: number): number {
    const l = Math.max(1, level) - 1
    return Math.round(400 + 120 * l + 4 * l * l)
  }

  /** Character level from the four stats: 1 + every point spent above 10. */
  public levelFor(vigor: number, endurance: number, strength: number, dexterity: number): number {
    return 1 + (vigor - 10) + (endurance - 10) + (strength - 10) + (dexterity - 10)
  }

  /** Damage that survives a defence fraction (0..0.9). Never below 1, so a hit always registers. */
  public applyDefense(raw: number, defense: number): number {
    return Math.max(1, Math.round(raw * (1 - clamp(defense, 0, 0.9))))
  }

  /** True when `to` is within `arcDeg` (the FULL cone) of a body at `from` facing `yawDeg`. */
  public inArc(from: ArrayLike<number>, yawDeg: number, to: ArrayLike<number>, arcDeg: number): boolean {
    if (arcDeg >= 360) return true
    const yaw = yawTo(from, to)
    return Math.abs(angleDiff(yaw, yawDeg)) <= arcDeg / 2
  }

  /**
   * Choose an enemy's next attack.
   *
   * Eligible: off cooldown, `minRange <= distance <= maxRange`, and allowed in this `phase` (an attack's
   * `phase` is the phase it UNLOCKS at — 0 and 1 mean always, 2 means only once the boss has turned).
   * The same attack twice in a row is avoided whenever anything else qualifies. Then weighted random.
   *
   * `attacks` are plain records (or SoulsEnemyAttack nodes) and `cooldowns` maps name -> seconds left,
   * so the choice is testable with no scene at all.
   */
  public pickEnemyAttack(attacks: any[], distance: number, phase: number, lastName: string,
    cooldowns: any, random: number): any {
    const ok = (a: any) => (num(a.phase, 0) <= Math.max(1, phase))
      && distance >= num(a.minRange, 0) && distance <= num(a.maxRange, 3)
      && !(cooldowns && cooldowns[a.name] > 0)
    let pool = attacks.filter(ok)
    if (pool.length > 1) {
      const fresh = pool.filter(a => a.name !== lastName)
      if (fresh.length) pool = fresh
    }
    if (!pool.length) return null
    const total = pool.reduce((s, a) => s + Math.max(0.0001, num(a.weight, 1)), 0)
    let pick = clamp(random, 0, 0.999999) * total
    for (const a of pool) {
      pick -= Math.max(0.0001, num(a.weight, 1))
      if (pick <= 0) return a
    }
    return pool[pool.length - 1]
  }

  /**
   * Order lock-on candidates: smallest angle off the camera's forward first, distance breaking ties in
   * 10-degree buckets so two enemies side by side resolve to the nearer.
   */
  public rankLockTargets(origin: ArrayLike<number>, yawDeg: number, candidates: any[], maxRange: number): any[] {
    return candidates
      .map(c => ({ c, d: planarDistance(origin, c.position), a: Math.abs(angleDiff(yawTo(origin, c.position), yawDeg)) }))
      .filter(x => x.d <= maxRange)
      .sort((x, y) => (Math.floor(x.a / 10) - Math.floor(y.a / 10)) || (x.d - y.d))
      .map(x => x.c)
  }

  // =================================================================================================
  // Registries
  // =================================================================================================

  public registerEnemy(enemy: Node): void { if (enemy && !this._enemies.includes(enemy)) this._enemies.push(enemy) }
  public unregisterEnemy(enemy: Node): void { this._enemies = this._enemies.filter(e => e !== enemy) }
  /** Every enemy that is spawned and not dead. */
  public liveEnemies(): Node[] { return this._enemies.filter(e => e && (e as any).spawned !== false && !(e as any).isDead) }

  public registerInteractable(node: Node): void {
    if (node && !this._interactables.includes(node)) this._interactables.push(node)
    if (node && (node as any).isBonfire && !this._bonfires.includes(node)) this._bonfires.push(node)
    if (node && (node as any).isFogGate) this._fogGate = node
  }
  public unregisterInteractable(node: Node): void { this._interactables = this._interactables.filter(n => n !== node) }
  public interactables(): Node[] { return this._interactables }

  public registerSpawn(spawn: Node): void { if (spawn && !this._spawns.includes(spawn)) this._spawns.push(spawn) }

  public get player(): Node { return this._player }
  public get boss(): Node { return this._boss }

  // =================================================================================================
  // Combat
  // =================================================================================================

  /**
   * The player's swing connecting, at the move's `hit` event. Every live enemy inside the move's range
   * and arc takes the hit. Returns how many were hit.
   */
  public resolvePlayerHit(player: Node, move: any, weapon: any): number {
    if (!player || !move) return 0
    const p = player as any
    const from = player.worldPosition
    const yaw = forwardYaw(player)
    const ar = this.attackRating(weapon, num(p.strength, 10), num(p.dexterity, 10))
    const range = num(move.range, 2.2)
    const arc = num(move.arcDeg, 120)
    let hits = 0
    for (const enemy of this.liveEnemies()) {
      const e = enemy as any
      const to = enemy.worldPosition
      const reach = range + num(e.bodyRadius, 0.4)
      if (planarDistance(from, to) > reach || Math.abs(to[1] - from[1]) > 2.5 + num(e.bodyHeight, 1.8)) continue
      if (!this.inArc(from, yaw, to, arc)) continue
      const damage = Math.round(ar * num(move.damageMul, 1))
      const poise = num(weapon?.poiseDamage, 15) * num(move.poiseMul, 1)
      if (e.receiveHit && e.receiveHit(damage, poise, player)) {
        hits++
        this.fx(this.hitSparkTemplate, [to[0], to[1] + num(e.bodyHeight, 1.8) * 0.6, to[2]])
      }
    }
    if (hits) this.sfx('Hit')
    return hits
  }

  /**
   * An enemy's swing connecting. Range and arc are re-checked at the contact frame, so a roll or a step
   * back during the wind-up genuinely avoids it. `aoeRadius > 0` makes it a ground slam: everything
   * inside the radius is hit regardless of facing. Returns true if the player took damage.
   */
  public resolveEnemyHit(enemy: Node, attack: any): boolean {
    const player = this._player as any
    if (!enemy || !attack || !player || player.isDead) return false
    const from = enemy.worldPosition
    const to = this._player.worldPosition
    const aoe = num(attack.aoeRadius, 0)
    const reach = aoe > 0 ? aoe : num(attack.hitRange, 2.2) + 0.3
    if (planarDistance(from, to) > reach) return false
    if (Math.abs(to[1] - from[1]) > 3) return false
    if (aoe <= 0 && !this.inArc(from, forwardYaw(enemy), to, num(attack.arcDeg, 100))) return false
    return !!player.receiveDamage?.(num(attack.damage, 50), num(attack.poiseDamage, 20), enemy)
  }

  public awardSouls(amount: number): void {
    const player = this._player as any
    if (player?.addSouls) player.addSouls(amount)
  }

  /** An enemy reached 0 HP. Bosses route on to `onBossDefeated`. */
  public onEnemyKilled(enemy: Node): void {
    const e = enemy as any
    this.awardSouls(num(e.soulsReward, 0))
    this._lockOnNode()?.onTargetDied?.(enemy)
    if (e.isBoss) this.onBossDefeated(enemy)
  }

  // =================================================================================================
  // Bonfires, death and respawn
  // =================================================================================================

  public lightBonfire(bonfire: Node): void {
    this.showBanner('BONFIRE LIT', 'gold')
    this.sfx('Bonfire Lit')
    this._setRespawn(bonfire)
  }

  /**
   * Rest at a bonfire: the souls checkpoint. Heals and refills, respawns every enemy that is not a
   * defeated boss, makes this bonfire the respawn point, and opens the level-up menu.
   */
  public rest(bonfire: Node): void {
    const player = this._player as any
    if (!player) return
    this._setRespawn(bonfire)
    player.restoreAll?.()
    this.respawnEnemies(false)
    this._lockOnNode()?.unlock?.()
    this.sfx('Rest')
    ;(this._menu as any)?.open?.(this, player, bonfire)
  }

  /** Called by the menu when the player stands up again. */
  public leaveBonfire(): void {
    (this._player as any)?.standUp?.()
  }

  public onPlayerDied(player: Node): void {
    if (this._dying) return
    this._dying = true
    const p = player as any
    this._lockOnNode()?.unlock?.()

    // The souls go into the ground where you fell — at the last SAFE spot if you fell off the world.
    const at = p.lastSafePosition ?? player.worldPosition
    this.dropBloodstain(at, num(p.souls, 0))
    p.souls = 0

    this.after(this.deathBannerDelay, () => {
      this.showBanner('YOU DIED', 'red')
      this.sfx('Death')
    })
    this.after(this.respawnDelay, () => this.respawnAtBonfire())
  }

  /** A new stain replaces the old one, and the souls in the old one are gone for good. */
  public dropBloodstain(at: ArrayLike<number>, souls: number): void {
    if (this._bloodstain) {
      try { this._bloodstain.remove() } catch { /* already gone */ }
      this._bloodstain = null
    }
    if (souls <= 0) return
    const stain = this.scene?.instantiate(this.bloodstainTemplate, { position: [at[0], at[1], at[2]] })
    if (!stain) return
    ;(stain as any).souls = souls
    this._bloodstain = stain
  }

  /** The stain was touched. Clears our handle so a later death does not try to remove it. */
  public onBloodstainRecovered(stain: Node): void {
    if (this._bloodstain === stain) this._bloodstain = null
  }

  public get bloodstain(): Node { return this._bloodstain }

  public respawnAtBonfire(): void {
    const player = this._player as any
    this._dying = false
    if (!player) return
    this._resetBossFight()
    this.respawnEnemies(false)
    const at = this._respawnPoint ?? [0, 0, 0]
    player.respawnAt?.(at, this._respawnYaw)
    ;(this._banner as any)?.hideBanner?.()
  }

  /** Re-create every enemy from its spawn point. Bosses only when `includeBoss` — never a defeated one. */
  public respawnEnemies(includeBoss: boolean): void {
    for (const spawn of this._spawns) {
      const s = spawn as any
      if (s.isBossSpawn && (!includeBoss || this.bossDefeated)) continue
      s.respawnEnemy?.()
    }
  }

  private _setRespawn(bonfire: Node): void {
    if (!bonfire) return
    this._restBonfire = bonfire
    const b = bonfire as any
    const point: Node = b.respawnPoint?.() ?? bonfire
    const p = point.worldPosition
    this._respawnPoint = [p[0], p[1] + 0.1, p[2]]
    this._respawnYaw = forwardYaw(point)
  }

  // =================================================================================================
  // The boss
  // =================================================================================================

  /** The boss spawn calls this every time it creates a boss, so the manager always holds the live one. */
  public registerBoss(boss: Node): void {
    this._boss = boss
    const b = boss as any
    this.bossName = b.displayName ?? boss.name
    this.bossHp = num(b.hp, 1)
    this.bossMaxHp = Math.max(1, num(b.maxHp, 1))
  }

  public startBossFight(gate: Node): void {
    if (this.bossActive || this.bossDefeated) return
    if (gate) this._fogGate = gate
    const boss = this._boss as any
    if (!boss || boss.isDead) return
    this.bossActive = true
    boss.awaken?.()
    this._music('Boss Music', true)
    this._music('Ambience', false)
  }

  public onBossDefeated(boss: Node): void {
    this.bossDefeated = true
    this.bossActive = false
    this._music('Boss Music', false)
    this._music('Ambience', true)
    ;(this._fogGate as any)?.dissolve?.()
    this.after(2.5, () => {
      this.showBanner('VICTORY ACHIEVED', 'gold')
      this.sfx('Victory')
    })
    for (const name of [this.bossRewardName, this.bossEpilogueName]) {
      const node = this.findNode(name) as any
      if (node?.reveal) node.reveal()
    }
  }

  /** The player died mid-fight: the boss goes back to sleep at full health and the fog lets you in again. */
  private _resetBossFight(): void {
    if (this.bossDefeated) return
    const wasActive = this.bossActive
    this.bossActive = false
    if (wasActive) {
      this._music('Boss Music', false)
      this._music('Ambience', true)
    }
    ;(this._fogGate as any)?.resetGate?.()
    this.respawnEnemies(true)
  }

  onUpdate(delta: number) {
    const boss = this._boss as any
    if (boss) {
      this.bossHp = Math.max(0, num(boss.hp, 0))
      this.bossMaxHp = Math.max(1, num(boss.maxHp, 1))
    }
    // Fallback: a player who reaches the arena without passing the fog (a physics push, an editor
    // teleport) still starts the fight rather than finding a boss asleep.
    const gate = this._fogGate as any
    const player = this._player as any
    if (!this.bossActive && !this.bossDefeated && gate?.isInsideArena && player && !player.isDead
      && gate.isInsideArena(this._player.worldPosition)) {
      this.startBossFight(this._fogGate)
    }
  }

  // =================================================================================================
  // Presentation helpers
  // =================================================================================================

  public showBanner(text: string, kind: string): void {
    const banner = this._banner as any
    if (banner?.showBanner) banner.showBanner(text, kind)
  }

  /** A short line under the HUD prompt: "Picked up Estus Shard", "Opens from the other side". */
  public notice(text: string): void {
    const hud = this._hud as any
    if (hud?.showNotice) hud.showNotice(text)
  }

  /** Show a readable message (title + body) until the player walks away or presses Interact again. */
  public showMessage(title: string, body: string, source: Node): void {
    const hud = this._hud as any
    if (hud?.showMessage) hud.showMessage(title, body, source)
  }

  /** Play the SoundNode of this name under the Sounds group. Silent when there is none. */
  public sfx(name: string): void {
    const node = this._soundNamed(name) as any
    if (node?.play) node.play()
  }

  /** Instantiate an effect template at a world point. Silent when the template does not exist. */
  public fx(template: string, at: ArrayLike<number>): Node {
    if (!template) return null
    return this.scene?.instantiate(template, { position: [at[0], at[1], at[2]] }) ?? null
  }

  /**
   * A hit drew blood: droplets fly off `target`, a pool lands under it and a spatter along the blow,
   * from `from` toward `target`. Called by SoulsEnemy.receiveHit and SoulsPlayer.receiveDamage when a hit
   * lands. `amount` (the damage dealt) sizes the splat.
   */
  public bleed(target: Node, from: Node, amount: number): void {
    if (!this.bloodEnabled || !target || !(amount > 0)) return
    const at = target.worldPosition
    const src = from?.worldPosition
    let dx = src ? at[0] - src[0] : 0
    let dz = src ? at[2] - src[2] : 1
    const len = Math.hypot(dx, dz)
    if (len < 1e-4) { dx = 0; dz = 1 } else { dx /= len; dz /= len }
    const t = target as any
    const height = num(t.bodyHeight, 1.8)
    const scale = clamp(amount / Math.max(1, this.bloodReferenceDamage), 0.6, 1.6)

    this.fx(this.bloodSprayTemplate, [at[0], at[1] + height * 0.6, at[2]])
    // Spawned a little above the ground: each decal finds the floor itself (SoulsBloodSplat).
    this._splat(this.bloodSplatTemplate, [at[0], at[1] + 0.5, at[2]], NaN, scale)
    this._splat(this.bloodDropsTemplate, [at[0] + dx * 0.9 * scale, at[1] + 0.5, at[2] + dz * 0.9 * scale],
                Math.atan2(dx, dz) * 180 / Math.PI, scale)
  }

  /** The blood decals currently on the ground, oldest first. */
  public get bloodDecals(): readonly Node[] { return this._bloodDecals }

  private _splat(template: string, at: number[], yaw: number, scale: number): void {
    if (!template) return
    const splat = this.scene?.instantiate(template, { position: at }) as any
    if (!splat) return
    splat.yaw = yaw
    splat.sizeScale = scale
    // Splats remove themselves when they fade out; forget those, then retire the oldest past the cap.
    this._bloodDecals = this._bloodDecals.filter(d => !!d.scene)
    this._bloodDecals.push(splat)
    while (this._bloodDecals.length > Math.max(0, this.maxBloodDecals)) {
      const old = this._bloodDecals.shift()
      try { old.remove() } catch { /* already gone */ }
    }
  }

  /** Shake the player's camera. 0.2 is a hit, 0.6 a boss slam. */
  public shake(amount: number): void {
    const rig = this._lockOnNode() as any
    if (rig?.shake) rig.shake(amount)
  }

  private _music(name: string, on: boolean): void {
    const node = this._soundNamed(name) as any
    if (!node) return
    if (on) node.play?.()
    else node.stop?.()
  }

  private _soundNamed(name: string): Node {
    if (!this._sounds) return null
    return this._sounds.getChildByName(name)[0] ?? null
  }

  private _lockOnNode(): any {
    if (!this._lockOn && this._player) {
      this._lockOn = this._player.children.find(c => c.nodeType === 'cameraRig') ?? null
    }
    return this._lockOn
  }

  private _checkInputMap(): void {
    const map: any = (Input as any).map
    const names = new Set<string>()
    for (const m of map?.maps ?? []) for (const a of m.actions ?? []) names.add(a.name)
    const missing = ['LightAttack', 'HeavyAttack', 'Roll', 'LockOn', 'UseItem', 'SwapWeapon', 'Interact']
      .filter(n => !names.has(n))
    if (missing.length) {
      Logger.warn('Hollow Keep: the input map has no ' + missing.join(', ') + ' action(s). Import the '
        + 'example again, or add them in the Input panel — see SOULS_DEMO.md "Controls".', 'Script')
    }
  }
}
