import { Logger, ModelNode, Node, setMoveWorld } from 'cleo'
import type { ClipName, SocketName } from 'cleo'
import { clamp, num, planarDistance } from '@/Core/Scripts/SoulsMath'
import { Swing, bladeCapsule, closeSwing, newSwing, openSwing, stepSwing, wieldedBy } from '@/Core/Scripts/SoulsHitbox'
import SoulsCharacterNode from '@/Core/Scripts/SoulsCharacter'
import { playSound } from '@/Core/Scripts/SoulsAudio'

/**
 * Hollow Keep — the base ENEMY. Never attached as-is: each enemy type has its own script extending this
 * one (SoulsHollow, SoulsHollowSorcerer, SoulsEliteKnight, SoulsHollowWarden), whose defaults are that
 * type's stats, and its own template, a variant of the base "Enemy" template. This class is everything
 * the types share: how an enemy fights, spaces, reacts and dies.
 *
 *   Hollow                Character (SoulsHollow) — capsule body, friction 0
 *   ├── <model>           skinned model with a state machine that has `Died` and `Revive` triggers
 *   ├── LockPoint *       empty node at chest height: where the lock-on camera and reticle aim
 *   ├── Weapons           empty group; `weaponTemplates` (e.g. "Club") is spawned into it on start, into
 *   │                     the RightHand socket. The weapon's blade is the melee HITBOX (see SoulsHitbox)
 *   ├── Attacks *         group of SoulsEnemyAttack data nodes — the moveset
 *   ├── HealthBar         world-space UI Root with a `Fill` progress bar (optional; not on the boss)
 *   ├── PhaseAura         particle system started when the boss turns (optional)
 *   └── Brain             ControllerNode, source AI, SoulsEnemyBrain — LAST child
 *
 * ## Who drives
 *
 * The Brain's behaviour machine handles everything that is navigation: Idle at home, Chase along the
 * navmesh, Return home when leashed. Once it reaches its `Engage` state it hands the body over (goal
 * `script`) and THIS script fights: spacing, strafing, choosing attacks, reacting to hits. Attacks,
 * flinches and death override movement in any brain state.
 *
 * ## Poise
 *
 * Each hit subtracts its poise damage. At zero the enemy STAGGERS — the attack it was in is cancelled —
 * and poise refills. It also refills after `poiseRegenDelay` seconds without being hit. Regular enemies
 * additionally FLINCH on every hit unless the attack they are in has `hyperArmor`; a boss never flinches,
 * only staggers.
 *
 * ## Bosses
 *
 * `isBoss` enemies start DORMANT and stand still until the fog gate calls `awaken()`, never flinch, and
 * have no floating health bar (the HUD reads the boss itself). What a boss does at low health is its own
 * script's business — see SoulsHollowWarden, which overrides `_onDamaged` for its phase two.
 */
export default class SoulsEnemyNode extends SoulsCharacterNode {
  public displayName: string = 'Enemy'
  public team: string = 'enemy'
  public maxPoise: number = 25
  public poiseRegenDelay: number = 3
  public soulsReward: number = 120
  public isBoss: boolean = false
  /** A dead enemy lets its weapon fall (a physics body); it lies there until the corpse goes. */
  public dropWeaponOnDeath: boolean = true

  // ----- movement --------------------------------------------------------------------------------
  // WHEN to chase, close in, strafe, back off or give up is the type's AI graph (its `.brain`, linked on
  // the Brain controller): the engage distance, the spacing band and the leash are numbers in ITS
  // transitions. This script only carries out the state the graph is in — see `_ai`.
  /** Chase / approach speed. Patrol and return run slower through the brain's speed scales. */
  public moveSpeed: number = 3
  /** Degrees per second the body turns toward the player while engaged. */
  public engageTurnRate: number = 300
  public strafeSpeedScale: number = 0.35
  public retreatSpeedScale: number = 0.7

  // ----- fighting --------------------------------------------------------------------------------
  /** Seconds of breathing room between attacks (a random value in this range). */
  public attackGapMin: number = 0.6
  public attackGapMax: number = 1.2
  public flinchOnHit: boolean = true
  public flinchClip: ClipName = 'Souls_HitLight'
  public flinchSeconds: number = 0.4
  public staggerClip: ClipName = 'Souls_HitHeavy'
  public staggerSeconds: number = 1.2
  /** Seconds the death clip plays before the ragdoll takes over (0 = no ragdoll). */
  public deathSeconds: number = 1.6
  public useRagdoll: boolean = true
  /** Seconds the body lies there before it is removed. */
  public corpseSeconds: number = 6
  /** Socket projectiles leave from. */
  public castSocket: SocketName = 'LeftHand'
  /** Seconds the health bar stays up after the last hit. */
  public healthBarSeconds: number = 4

  // ----- runtime, read by others -------------------------------------------------------------------
  public isAwake: boolean = true
  /** Which attacks are unlocked: an attack's `phase` is the phase it needs (see pickAttack). */
  public phase: number = 1
  public poise: number = 25
  public fightState: string = 'ai'
  /** Where the enemy was spawned; the brain walks back here. */
  public home: number[] = [0, 0, 0]
  /**
   * Published for the AI graph's Attack Ready: the breathing gap since the last attack has passed AND the
   * moveset has something for the current distance. The graph decides to attack; this script picks which.
   */
  public attackReady: boolean = false

  // ----- what the AI graph reads (builtin parameters) -----------------------------------------------
  /** The brain's current target has died — the graph walks home. */
  public get targetDead(): boolean {
    const id = (this._brain as any)?.getBlackboard?.('target')
    const target: any = typeof id === 'string' && id ? this.scene?.getNodeById(id) : null
    return !!target?.isDead
  }
  /** Planar metres from where the enemy spawned — the graph's leash and "home again" tests. */
  public get distanceFromHome(): number {
    const p = this.worldPosition
    return Math.hypot(p[0] - this.home[0], p[2] - this.home[2])
  }
  public get isAttacking(): boolean { return this.fightState === 'attack' }
  /** A flinch or a stagger is playing out. */
  public get isReacting(): boolean { return this.fightState === 'flinch' || this.fightState === 'stagger' }
  /** A boss's invulnerable phase transition is playing out. */
  public get isPhaseShifting(): boolean { return this.fightState === 'phase' }

  protected _player: Node = null
  protected _model: ModelNode = null
  protected _brain: Node = null
  protected _lockPoint: Node = null
  protected _healthBar: Node = null
  protected _healthFill: Node = null
  protected _aura: Node = null
  private _attacks: Node[] = []
  private _offEvents: (() => void) | null = null

  private _stateTime: number = 0
  private _sinceHit: number = 99
  private _gap: number = 1
  private _cooldowns: any = {}
  private _lastAttack: string = ''
  private _attack: any = null
  private _clip: string = ''
  private _clipLength: number = 0
  private _playSpeed: number = 1
  private _usesEvents: boolean = false
  /** The attack's active window has opened (its `hit` event, or the fallback `hitTime`). */
  private _windowOpened: boolean = false
  private _swing: Swing = newSwing()
  private _actionSeconds: number = 0
  private _lungeSpeedNow: number = 0
  private _strafeDir: number = 1
  private _strafeTimer: number = 0
  /** Multiplies movement and attack speed (a boss's later phase raises it). */
  protected _speedMul: number = 1
  private _reactSeconds: number = 0
  /** How long the current `phase` state (an invulnerable transition) lasts. */
  protected _phaseSeconds: number = 0

  onStart() {
    this.setVariable('isEnemy', true, 'boolean', 'public')
    this._gm = this.findNode('GameManager')
    this._player = this.findNode('Player')
    this._model = this._findModel()
    this._brain = this.children.find(c => c.nodeType === 'controller') ?? null
    this._lockPoint = this.getChildByName('LockPoint')[0] ?? null
    this._healthBar = this.getChildByName('HealthBar')[0] ?? null
    this._healthFill = this._healthBar ? this._find(this._healthBar, 'Fill') : null
    this._aura = this.getChildByName('PhaseAura')[0] ?? null
    this._spawnWeapons()
    const group = this.getChildByName('Attacks')[0]
    this._attacks = group ? group.children.filter(c => (c as any).isEnemyAttack) : []
    if (!this._attacks.length) Logger.warn('Hollow Keep: enemy "' + this.name + '" has no Attacks.', 'Script')

    const p = this.worldPosition
    this.home = [p[0], p[1], p[2]]
    this.hp = this.maxHp
    this.poise = this.maxPoise
    this.isDead = false
    this.phase = 1
    this._speedMul = 1
    this.isAwake = !this.isBoss
    this.fightState = this.isBoss ? 'dormant' : 'ai'
    this._gap = this._rand(this.attackGapMin, this.attackGapMax)
    this._setBar(false)
    ;(this._aura as any)?.stop?.(true)

    const animator = this._model?.animator as any
    // The character's idle/locomotion/death machine is embedded in its model node. A model swapped by
    // deleting the node and dropping a new one in has none, and would walk around in its bind pose with
    // nothing to say why. Linking the mannequin rig gives it the "Souls Character" controller.
    const machine = animator?.getStateMachine?.()
    if (animator && !machine?.states?.length)
      Logger.warn('Hollow Keep: "' + this.name + '" has no animation controller on its model, so it will hold its bind pose. '
        + 'Select the model node and assign "Souls Character" in its Animation section (or link the mannequin rig).', 'Script')
    if (animator?.onAnimationEvent) {
      this._offEvents = animator.onAnimationEvent((name: string, clip: string) => this._onAnimEvent(name, clip))
    }
    ;(this._gm as any)?.registerEnemy?.(this)
  }

  onDespawn() {
    this._offEvents?.()
    this._offEvents = null
    ;(this._gm as any)?.unregisterEnemy?.(this)
    // The weapon it dropped went to the world root, so it does not go with the corpse on its own.
    this._clearDroppedWeapons()
  }

  // =================================================================================================
  // Public API
  // =================================================================================================

  /** The node the lock-on camera aims at. */
  public lockPoint(): Node { return this._lockPoint ?? this }

  /** Wake a dormant boss: it starts hunting the player straight away. */
  public awaken(): void {
    if (this.isDead) return
    this.isAwake = true
    if (this.fightState === 'dormant') this._enter('ai')
    ;(this._brain as any)?.setBlackboard?.('target', this._player?.id)
  }

  // ----- taking hits (SoulsCharacter.receiveHit calls these) -----------------------------------------

  /** Nothing lands on the dead, or during an invulnerable phase transition. */
  protected _canBeHit(damage: number): boolean {
    return super._canBeHit(damage) && this.fightState !== 'phase'
  }

  /** Anything that hurts us is now our target, even from behind. */
  protected _onHurt(dealt: number, from: Node): void {
    this._sinceHit = 0
    if (!this.isBoss) this._setBar(true)
    if (!this.isBoss || this.isAwake) {
      this.isAwake = true
      if (this.fightState === 'dormant') this._enter('ai')
      if (from) (this._brain as any)?.setBlackboard?.('target', from.id)
    }
  }

  /** Poise: at zero, a stagger; otherwise a flinch, unless armoured. */
  protected _onDamaged(dealt: number, poiseDamage: number, from: Node): void {
    this.poise -= poiseDamage
    if (this.poise <= 0) {
      this.poise = this.maxPoise
      this._react('stagger', this.staggerClip, this.staggerSeconds)
      playSound(this, 'Stagger')
    } else if (this.flinchOnHit && !this.isBoss && !(this.fightState === 'attack' && this._attack?.hyperArmor)) {
      this._react('flinch', this.flinchClip, this.flinchSeconds)
    }
  }

  /**
   * Choose the next attack.
   *
   * Eligible: off cooldown, `minRange <= distance <= maxRange`, and allowed in this `phase` (an attack's
   * `phase` is the phase it UNLOCKS at — 0 and 1 mean always, 2 means only once a boss has turned).
   * The same attack twice in a row is avoided whenever anything else qualifies. Then weighted random.
   *
   * `attacks` are plain records (or SoulsEnemyAttack nodes) and `cooldowns` maps name -> seconds left,
   * so the choice is testable with no scene at all.
   */
  public pickAttack(attacks: any[], distance: number, phase: number, lastName: string,
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

  /** Called by the spawn point when re-creating; also usable to reset in place. */
  public resetForRespawn(): void {
    this.hp = this.maxHp
    this.poise = this.maxPoise
    this.isDead = false
    this.phase = 1
    this._speedMul = 1
    this.isAwake = !this.isBoss
    this._enter(this.isBoss ? 'dormant' : 'ai')
  }

  // =================================================================================================
  // The frame
  // =================================================================================================

  onUpdate(delta: number) {
    this._stateTime += delta
    this._sinceHit += delta
    for (const key of Object.keys(this._cooldowns)) this._cooldowns[key] = Math.max(0, this._cooldowns[key] - delta)
    if (this._sinceHit > this.poiseRegenDelay) this.poise = this.maxPoise
    if (this._healthBar && !this.isBoss && this._sinceHit > this.healthBarSeconds) this._setBar(false)
    if (this._healthFill) (this._healthFill as any).value = this.hp / Math.max(1, this.maxHp)

    const intent = this.drive()
    // Re-earned every frame by `_ai`; anything else (an attack, a stagger, death) is not ready.
    this.attackReady = false
    this.walkSpeed = this.moveSpeed * this._speedMul
    this.runSpeed = this.walkSpeed
    intent.sprint = false

    try {
      switch (this.fightState) {
        case 'dead':
        case 'dormant':
          this._still(intent)
          return
        case 'attack': this._attacking(intent, delta); return
        case 'flinch':
        case 'stagger':
          this._still(intent)
          if (this._stateTime >= this._reactSeconds) this._enter('ai')
          return
        case 'phase':
          this._still(intent)
          if (this._stateTime >= this._phaseSeconds) this._enter('ai')
          return
        default: this._ai(intent, delta)
      }
    } finally {
      this.applyWater(intent)
      this.limitClimb(intent)
    }
  }

  /**
   * Carry out the AI graph's current state. The graph has already decided; this is the doing:
   *
   *   Idle, Chase, Approach, Return   the brain steers (idle / path / seek); the body faces where it walks
   *   Attack                          pick WHICH attack (weighted, cooldowns, range) and start it
   *   Strafe                          circle the player, facing them
   *   Retreat                         back-pedal to the spacing band, facing them
   *   Stagger, Phase Shift, Dead      handled by `fightState` before this runs
   *
   * Every engaged frame it also publishes `attackReady`, which is how the graph knows it MAY attack.
   */
  private _ai(intent: any, delta: number): void {
    const state: string = (this._brain as any)?.behaviorState ?? 'Idle'
    this.acceleration = 12
    this.turnSpeed = this.engageTurnRate
    const engaged = state === 'Approach' || state === 'Strafe' || state === 'Retreat' || state === 'Attack'
    const player = this._player as any
    if (!engaged || !player || player.isDead) {
      this.facingMode = 'velocity'
      return
    }

    const me = this.worldPosition
    const at = this._player.worldPosition
    const dx = at[0] - me[0]
    const dz = at[2] - me[2]
    const dist = Math.hypot(dx, dz)
    const toward = dist > 1e-4 ? [dx / dist, dz / dist] : [0, 1]

    this._gap -= delta
    // `random = 0` makes this a pure "is anything eligible" test — the real draw happens on Attack.
    this.attackReady = this._gap <= 0
      && !!this.pickAttack(this._attacks, dist, this.phase, this._lastAttack, this._cooldowns, 0)

    if (state === 'Approach') { this.facingMode = 'velocity'; return }

    if (state === 'Attack') {
      const attack = this.pickAttack(this._attacks, dist, this.phase, this._lastAttack, this._cooldowns, Math.random())
      this._still(intent)
      if (attack) this._startAttack(attack)
      else this._turnToward(at, this.engageTurnRate * delta)
      return
    }

    // Strafe or Retreat: move relative to the player while facing them.
    this._strafeTimer -= delta
    if (this._strafeTimer <= 0) { this._strafeTimer = this._rand(1.5, 3.5); this._strafeDir = Math.random() < 0.5 ? -1 : 1 }
    let mx = 0, mz = 0, scale = 0
    if (state === 'Retreat') { mx = -toward[0]; mz = -toward[1]; scale = this.retreatSpeedScale }
    else if (this.strafeSpeedScale > 0) {
      // Perpendicular to the line to the player: right of it is (-z, x) rotated by the convention.
      mx = toward[1] * this._strafeDir; mz = -toward[0] * this._strafeDir; scale = this.strafeSpeedScale
    }

    this.facingMode = 'aim'
    if (scale > 0) {
      setMoveWorld(intent, mx, mz)
      intent.speedScale = scale
    } else {
      intent.move[0] = 0
      intent.move[1] = 0
      this._turnToward(at, this.engageTurnRate * delta)
    }
    intent.aimYaw = Math.atan2(dx, dz) * 180 / Math.PI
  }

  // ----- attacks ---------------------------------------------------------------------------------

  private _startAttack(attack: any): void {
    this._attack = attack
    this._lastAttack = attack.name
    this._cooldowns[attack.name] = num(attack.cooldown, 0)
    this._windowOpened = false
    closeSwing(this._swing)
    this._enter('attack')
    this._playSpeed = Math.max(0.05, num(attack.playSpeed, 1) * this._speedMul)
    this._play(attack.clip, this._playSpeed)
    this._usesEvents = this._clipHasEvent(attack.clip, 'hit') || this._clipHasEvent(attack.clip, 'cast')
    const length = this._clipLength > 0 ? this._clipLength : num(attack.hitTime, 0.6) + 0.6
    this._actionSeconds = length / this._playSpeed

    // A leap covers whatever distance there is, within reason.
    this._lungeSpeedNow = num(attack.lungeSpeed, 0)
    if (attack.lungeToTarget && this._player) {
      const d = planarDistance(this.worldPosition, this._player.worldPosition)
      this._lungeSpeedNow = Math.min(num(attack.lungeSpeed, 12), Math.max(0, d - 1) / Math.max(0.05, num(attack.lungeSeconds, 0.5)))
    }
    playSound(this, attack.sound || 'Enemy Swing')
  }

  private _attacking(intent: any, delta: number): void {
    const attack = this._attack
    const t = this._stateTime * this._playSpeed
    if (!this._usesEvents) {
      const hitTime = num(attack?.hitTime, 0.6)
      if (!this._windowOpened && t >= hitTime) this._land()
      if (this._swing.open && t >= hitTime + num(attack?.activeSeconds, 0.15)) closeSwing(this._swing)
    }
    if (this._swing.open) this._stepSwing()

    if (this._player && this._stateTime < num(attack?.trackSeconds, 0.4))
      this._turnToward(this._player.worldPosition, this.engageTurnRate * 1.5 * delta)

    const start = num(attack?.lungeStart, 0)
    const lunging = t >= start && t < start + num(attack?.lungeSeconds, 0) * this._playSpeed
    this.acceleration = 0
    this.facingMode = 'none'
    if (lunging && this._lungeSpeedNow > 0) {
      const f = this.worldForward
      setMoveWorld(intent, f[0], f[2])
      intent.sprint = true
      intent.speedScale = 1
      this.runSpeed = this._lungeSpeedNow
    } else {
      intent.move[0] = 0
      intent.move[1] = 0
    }

    if (this._stateTime >= this._actionSeconds) {
      const next = attack?.comboNext ? this._attacks.find(a => a.name === attack.comboNext) : null
      if (next && this._player && planarDistance(this.worldPosition, this._player.worldPosition) <= num((next as any).maxRange, 3) + 1) {
        this._startAttack(next)
        return
      }
      this._gap = this._rand(this.attackGapMin, this.attackGapMax) / this._speedMul
      this._enter('ai')
    }
  }

  private _onAnimEvent(name: string, clip: string): void {
    if (this.fightState !== 'attack' || (clip && clip !== this._clip)) return
    if ((name === 'hit' || name === 'cast') && !this._windowOpened) this._land()
    else if (name === 'hitEnd') closeSwing(this._swing)
  }

  /**
   * The contact frame. A projectile attack fires; a slam (`aoeRadius`) hits every player hurtbox inside
   * the radius at once; a melee attack opens its active window, and the weapon is swept every frame
   * until `hitEnd` (see _stepSwing).
   */
  private _land(): void {
    this._windowOpened = true
    const attack = this._attack
    if (!attack) return
    const gm = this._gm as any
    if (attack.projectileTemplate) { this._fire(attack); return }
    const aoe = num(attack.aoeRadius, 0)
    if (aoe > 0) {
      gm?.shake?.(0.5)
      gm?.fx?.(attack.impactTemplate || '', this.worldPosition)
      const p = this.worldPosition
      const hits = (this.scene?.physics as any)?.overlapSphere?.([p[0], p[1] + 0.5, p[2]], aoe, {
        ignore: this, filter: (node: Node) => !!node && node !== this && (node as any).team === 'player'
          && typeof (node as any).receiveHit === 'function' && (node as any).hurtboxActive !== false && !(node as any).isDead,
      }) ?? []
      for (const h of hits) this._hitPlayer(attack, h.node)
      return
    }
    openSwing(this._swing)
  }

  /** One frame of the active window: sweep the weapon's blade; the player is hit at most once. */
  private _stepSwing(): void {
    const weapon = this.currentWeapon() as any
    // Not in this enemy's own hand (no hand socket on its model): the blade is elsewhere, hit nothing.
    if (!wieldedBy(weapon, this)) return
    const blade = bladeCapsule(weapon)
    if (!blade) return
    const attack = this._attack as any
    const contact = stepSwing(this.scene?.physics, this._swing, blade, this, 'player', !!attack?.bounceOff)
    for (const t of contact.targets) this._hitPlayer(attack, t.node)
    if (contact.blockedAt) {
      closeSwing(this._swing)
      ;(this._gm as any)?.fx?.(weapon?.hitSparkTemplate || 'Hit Spark', contact.blockedAt)
    }
  }

  /**
   * An attack reached `target`. The damage is the ATTACK's — an enemy's moveset is tuned per move — and
   * the target takes it through its own receiveHit (where a rolling player's i-frames let it pass).
   */
  private _hitPlayer(attack: any, target: Node): boolean {
    const t = target as any
    if (!attack || typeof t?.receiveHit !== 'function') return false
    const landed = !!t.receiveHit(num(attack.damage, 50), num(attack.poiseDamage, 20), this)
    if (landed) playSound(this, 'Player Hit')
    return landed
  }

  private _fire(attack: any): void {
    if (!this._player) return
    const origin = this._castOrigin()
    const p = this._player.worldPosition
    const aim = [p[0] - origin[0], p[1] + 1.1 - origin[1], p[2] - origin[2]]
    const len = Math.hypot(aim[0], aim[1], aim[2]) || 1
    const count = Math.max(1, Math.round(num(attack.projectileCount, 1)))
    const spread = num(attack.spreadDeg, 0)
    for (let i = 0; i < count; i++) {
      const offset = count > 1 ? (i - (count - 1) / 2) * spread * Math.PI / 180 : 0
      const c = Math.cos(offset), s = Math.sin(offset)
      const dx = aim[0] / len, dz = aim[2] / len
      const dir = [dx * c + dz * s, aim[1] / len, -dx * s + dz * c]
      const bolt = this.scene?.instantiate(attack.projectileTemplate, { position: [origin[0], origin[1], origin[2]] }) as any
      if (bolt?.launch) bolt.launch(dir, num(attack.projectileSpeed, 12), num(attack.damage, 60), this.id)
    }
    playSound(this, 'Cast')
  }

  private _castOrigin(): number[] {
    const m = (this._model as any)?.getSocketWorldMatrix?.(this.castSocket)
    if (m) return [m[12], m[13], m[14]]
    const lp = this.lockPoint().worldPosition
    const f = this.worldForward
    return [lp[0] + f[0] * 0.6, lp[1], lp[2] + f[2] * 0.6]
  }

  // ----- reactions -------------------------------------------------------------------------------

  protected _react(state: string, clip: string, seconds: number): void {
    this._stopAction()
    this._enter(state)
    this._reactSeconds = seconds
    this._play(clip, 1)
    this._gap = Math.max(this._gap, 0.4)
  }

  protected _die(): void {
    if (this.isDead) return
    this.isDead = true
    this._stopAction()
    this._enter('dead')
    this._setBar(false)
    const brain = this._brain as any
    brain?.setBlackboard?.('dead', true)
    ;(this._aura as any)?.stop?.()
    if (this.dropWeaponOnDeath) this.dropWeapon()
    ;(this._model?.animator as any)?.setTrigger?.('Died')
    const gm = this._gm as any
    playSound(this, 'Enemy Death')
    gm?.onEnemyKilled?.(this)
    if (this.useRagdoll && this.deathSeconds > 0) this.after(this.deathSeconds, () => this._ragdoll())
    this.after(this.corpseSeconds, () => this.remove())
  }

  private _ragdoll(): void {
    const physics = this.scene?.physics as any
    if (!physics?.startRagdoll || !this._model) return
    try { physics.startRagdoll(this._model) }
    catch (e) { Logger.warn('Hollow Keep: ragdoll failed on ' + this.name + ': ' + e, 'Script') }
  }

  // ----- helpers ---------------------------------------------------------------------------------

  protected _enter(state: string): void {
    this.fightState = state
    this._stateTime = 0
    if (state !== 'attack') { this._attack = null; closeSwing(this._swing) }
    this.hurtboxActive = state !== 'dead' && state !== 'phase'
  }

  protected _still(intent: any): void {
    this.acceleration = 0
    this.facingMode = 'none'
    intent.move[0] = 0
    intent.move[1] = 0
  }

  private _turnToward(point: ArrayLike<number>, maxDegrees: number): void {
    const me = this.worldPosition
    const dx = point[0] - me[0]
    const dz = point[2] - me[2]
    if (Math.hypot(dx, dz) < 0.05) return
    const want = Math.atan2(dx, dz) * 180 / Math.PI
    const f = this.worldForward
    const have = Math.atan2(f[0], f[2]) * 180 / Math.PI
    let diff = (want - have) % 360
    if (diff > 180) diff -= 360
    else if (diff < -180) diff += 360
    this.setRotation([0, have + Math.max(-maxDegrees, Math.min(maxDegrees, diff)), 0])
  }

  protected _play(clip: string, speed: number): void {
    this._clip = clip
    this._clipLength = this._clipDuration(clip)
    const animator = this._model?.animator as any
    if (animator?.playAction && clip) animator.playAction(clip, { speed, blendIn: 0.1, blendOut: 0.2 })
  }

  protected _stopAction(): void {
    ;(this._model?.animator as any)?.stopAction?.(undefined, 0.12)
    this._clip = ''
  }

  private _clipDuration(name: string): number {
    const clip = this._findClip(name)
    if (!clip) return 0
    let end = 0
    for (const s of clip.samplers ?? []) if (s.input?.length) end = Math.max(end, s.input[s.input.length - 1])
    return end
  }

  private _clipHasEvent(name: string, event: string): boolean {
    return !!this._findClip(name)?.events?.some((e: any) => e.name === event)
  }

  private _findClip(name: string): any {
    const animations = (this._model?.model as any)?.animations
    return animations && name ? animations.find((a: any) => a.name === name) ?? null : null
  }

  private _setBar(show: boolean): void {
    const bar = this._healthBar as any
    if (bar && bar.visible !== show) bar.visible = show
  }

  private _find(root: Node, name: string): Node {
    for (const child of root.children) {
      if (child.name === name) return child
      const found = this._find(child, name)
      if (found) return found
    }
    return null
  }

  /** The animated model, however deep: a swapped-in model may sit under a holder node. */
  private _findModel(): ModelNode {
    const walk = (node: Node): ModelNode => {
      for (const child of node.children) {
        if (child.nodeType === 'model' && (child as any).animator) return child as ModelNode
        // Not into the weapons, the brain or the UI: none of them is this enemy's body.
        if (child.nodeType === 'controller' || child.name === 'Weapons' || child.nodeType === 'uiRoot') continue
        const found = walk(child)
        if (found) return found
      }
      return null
    }
    return walk(this)
  }

  private _rand(lo: number, hi: number): number {
    return lo + Math.random() * Math.max(0, hi - lo)
  }
}
