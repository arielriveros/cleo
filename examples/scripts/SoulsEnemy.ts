import { CharacterNode, Logger, ModelNode, Node, setMoveWorld } from 'cleo'
import { num, planarDistance } from './SoulsMath'

/**
 * Hollow Keep — every enemy: the Hollow, the Caster, the Elite Knight and the boss. Attach to the
 * enemy template's root, a Character node. The archetypes differ only in tuning and in their attack
 * children, so there is one script and four templates.
 *
 *   Hollow                Character (this script) — capsule body, friction 0
 *   ├── <model>           skinned model with a state machine that has `Died` and `Revive` triggers
 *   ├── LockPoint *       empty node at chest height: where the lock-on camera and reticle aim
 *   ├── Weapon            any held prop, attached to the RightHand socket (optional, visual only)
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
 * ## The boss
 *
 * `isBoss` enemies start DORMANT and stand still until the fog gate calls `awaken()`. At `phase2At` of
 * their health they roar (invulnerable for `phase2Seconds`), start `PhaseAura`, speed up by
 * `phase2SpeedMul`, and unlock every attack whose `phase` is 2.
 */
export default class SoulsEnemyNode extends CharacterNode {
  public displayName: string = 'Hollow'
  public maxHp: number = 160
  public hp: number = 160
  /** Fraction of incoming damage ignored, 0..0.9. */
  public defense: number = 0
  public maxPoise: number = 25
  public poiseRegenDelay: number = 3
  public soulsReward: number = 120
  public isBoss: boolean = false
  /** Collision-ish size, used by hit checks and lock-on height. */
  public bodyRadius: number = 0.4
  public bodyHeight: number = 1.8

  // ----- movement --------------------------------------------------------------------------------
  /** Chase / approach speed. Patrol and return run slower through the brain's speed scales. */
  public moveSpeed: number = 3
  /** Degrees per second the body turns toward the player while engaged. */
  public engageTurnRate: number = 300
  /** Distance at which the brain hands control to this script. */
  public engageRange: number = 4.5
  /** Metres from home past which the enemy gives up and walks back. */
  public leashRange: number = 25
  /** Preferred distance band while engaged: approach above max, back off below min, strafe between. */
  public preferredMin: number = 0
  public preferredMax: number = 1.8
  public strafeSpeedScale: number = 0.35
  public retreatSpeedScale: number = 0.7

  // ----- fighting --------------------------------------------------------------------------------
  /** Seconds of breathing room between attacks (a random value in this range). */
  public attackGapMin: number = 0.6
  public attackGapMax: number = 1.2
  public flinchOnHit: boolean = true
  public flinchClip: string = 'Souls_HitLight'
  public flinchSeconds: number = 0.4
  public staggerClip: string = 'Souls_HitHeavy'
  public staggerSeconds: number = 1.2
  /** Seconds the death clip plays before the ragdoll takes over (0 = no ragdoll). */
  public deathSeconds: number = 1.6
  public useRagdoll: boolean = true
  /** Seconds the body lies there before it is removed. */
  public corpseSeconds: number = 6
  /** Socket projectiles leave from. */
  public castSocket: string = 'LeftHand'
  /** Seconds the health bar stays up after the last hit. */
  public healthBarSeconds: number = 4

  // ----- boss ------------------------------------------------------------------------------------
  public phase2At: number = 0.5
  public phase2SpeedMul: number = 1.15
  public phase2Seconds: number = 2
  public roarClip: string = 'Souls_Roar'

  // ----- runtime, read by others -------------------------------------------------------------------
  public isDead: boolean = false
  public isAwake: boolean = true
  public phase: number = 1
  public poise: number = 25
  public fightState: string = 'ai'
  /** Where the enemy was spawned; the brain walks back here. */
  public home: number[] = [0, 0, 0]

  private _gm: Node = null
  private _player: Node = null
  private _model: ModelNode = null
  private _brain: Node = null
  private _lockPoint: Node = null
  private _healthBar: Node = null
  private _healthFill: Node = null
  private _aura: Node = null
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
  private _hitDone: boolean = false
  private _actionSeconds: number = 0
  private _lungeSpeedNow: number = 0
  private _strafeDir: number = 1
  private _strafeTimer: number = 0
  private _speedMul: number = 1
  private _reactSeconds: number = 0

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
    if (animator?.onAnimationEvent) {
      this._offEvents = animator.onAnimationEvent((name: string, clip: string) => this._onAnimEvent(name, clip))
    }
    ;(this._gm as any)?.registerEnemy?.(this)
  }

  onDespawn() {
    this._offEvents?.()
    this._offEvents = null
    ;(this._gm as any)?.unregisterEnemy?.(this)
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

  /**
   * Take a hit from the player. Returns true when it landed (false while dead or invulnerable).
   */
  public receiveHit(damage: number, poiseDamage: number, from: Node): boolean {
    if (this.isDead || this.fightState === 'phase') return false
    const gm = this._gm as any
    const dealt = gm?.applyDefense ? gm.applyDefense(damage, this.defense) : damage
    this.hp = Math.max(0, this.hp - dealt)
    this._sinceHit = 0
    gm?.bleed?.(this, from, dealt)
    if (!this.isBoss) this._setBar(true)

    // Anything that hurts us is now our target, even from behind.
    if (!this.isBoss || this.isAwake) {
      this.isAwake = true
      if (this.fightState === 'dormant') this._enter('ai')
      if (from) (this._brain as any)?.setBlackboard?.('target', from.id)
    }

    if (this.hp <= 0) { this._die(); return true }

    this.poise -= poiseDamage
    if (this.poise <= 0) {
      this.poise = this.maxPoise
      this._react('stagger', this.staggerClip, this.staggerSeconds)
      gm?.sfx?.('Stagger')
    } else if (this.flinchOnHit && !this.isBoss && !(this.fightState === 'attack' && this._attack?.hyperArmor)) {
      this._react('flinch', this.flinchClip, this.flinchSeconds)
    }

    if (this.isBoss && this.phase === 1 && this.hp <= this.maxHp * this.phase2At) this._startPhase2()
    return true
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
    this.walkSpeed = this.moveSpeed * this._speedMul
    this.runSpeed = this.walkSpeed
    intent.sprint = false

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
        if (this._stateTime >= this.phase2Seconds) this._enter('ai')
        return
      default: this._ai(intent, delta)
    }
  }

  /** Brain-driven, unless the brain has reached Engage — then we fight. */
  private _ai(intent: any, delta: number): void {
    const brain = this._brain as any
    const engaged = brain?.behaviorState === 'Engage'
    this.acceleration = 12
    this.turnSpeed = this.engageTurnRate
    if (!engaged || !this._player) {
      this.facingMode = 'velocity'
      return
    }
    const player = this._player as any
    if (player.isDead) { this._still(intent); return }

    const me = this.worldPosition
    const at = this._player.worldPosition
    const dx = at[0] - me[0]
    const dz = at[2] - me[2]
    const dist = Math.hypot(dx, dz)
    const toward = dist > 1e-4 ? [dx / dist, dz / dist] : [0, 1]

    // Attack when the gap has passed and something fits the distance.
    this._gap -= delta
    if (this._gap <= 0) {
      const gm = this._gm as any
      const attack = gm?.pickEnemyAttack?.(this._attacks, dist, this.phase, this._lastAttack, this._cooldowns, Math.random())
      if (attack) { this._startAttack(attack); this._still(intent); return }
    }

    // Spacing.
    this._strafeTimer -= delta
    if (this._strafeTimer <= 0) { this._strafeTimer = this._rand(1.5, 3.5); this._strafeDir = Math.random() < 0.5 ? -1 : 1 }
    let mx = 0, mz = 0, scale = 0
    if (dist > this.preferredMax) { mx = toward[0]; mz = toward[1]; scale = 1 }
    else if (dist < this.preferredMin) { mx = -toward[0]; mz = -toward[1]; scale = this.retreatSpeedScale }
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
    this._hitDone = false
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
    ;(this._gm as any)?.sfx?.(attack.sound || 'Enemy Swing')
  }

  private _attacking(intent: any, delta: number): void {
    const attack = this._attack
    const t = this._stateTime * this._playSpeed
    if (!this._usesEvents && !this._hitDone && t >= num(attack?.hitTime, 0.6)) this._land()

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
    if (name === 'hit' || name === 'cast') this._land()
  }

  /** The contact frame: a melee check, or the projectile(s) leaving the hand. */
  private _land(): void {
    this._hitDone = true
    const attack = this._attack
    if (!attack) return
    const gm = this._gm as any
    if (attack.projectileTemplate) { this._fire(attack); return }
    if (num(attack.aoeRadius, 0) > 0) {
      gm?.shake?.(0.5)
      gm?.fx?.(attack.impactTemplate || '', this.worldPosition)
    }
    if (gm?.resolveEnemyHit?.(this, attack)) gm?.sfx?.('Player Hit')
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
    ;(this._gm as any)?.sfx?.('Cast')
  }

  private _castOrigin(): number[] {
    const m = (this._model as any)?.getSocketWorldMatrix?.(this.castSocket)
    if (m) return [m[12], m[13], m[14]]
    const lp = this.lockPoint().worldPosition
    const f = this.worldForward
    return [lp[0] + f[0] * 0.6, lp[1], lp[2] + f[2] * 0.6]
  }

  // ----- reactions -------------------------------------------------------------------------------

  private _react(state: string, clip: string, seconds: number): void {
    this._stopAction()
    this._enter(state)
    this._reactSeconds = seconds
    this._play(clip, 1)
    this._gap = Math.max(this._gap, 0.4)
  }

  private _startPhase2(): void {
    this._stopAction()
    this.phase = 2
    this._speedMul = this.phase2SpeedMul
    this._enter('phase')
    this._play(this.roarClip, 1)
    const gm = this._gm as any
    gm?.shake?.(0.6)
    gm?.sfx?.('Boss Roar')
    ;(this._aura as any)?.play?.()
  }

  private _die(): void {
    if (this.isDead) return
    this.isDead = true
    this._stopAction()
    this._enter('dead')
    this._setBar(false)
    const brain = this._brain as any
    brain?.setBlackboard?.('dead', true)
    ;(this._aura as any)?.stop?.()
    ;(this._model?.animator as any)?.setTrigger?.('Died')
    const gm = this._gm as any
    gm?.sfx?.('Enemy Death')
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

  private _enter(state: string): void {
    this.fightState = state
    this._stateTime = 0
    if (state !== 'attack') this._attack = null
  }

  private _still(intent: any): void {
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

  private _play(clip: string, speed: number): void {
    this._clip = clip
    this._clipLength = this._clipDuration(clip)
    const animator = this._model?.animator as any
    if (animator?.playAction && clip) animator.playAction(clip, { speed, blendIn: 0.1, blendOut: 0.2 })
  }

  private _stopAction(): void {
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

  private _findModel(): ModelNode {
    for (const child of this.children)
      if (child.nodeType === 'model' && (child as any).animator) return child as ModelNode
    return null
  }

  private _rand(lo: number, hi: number): number {
    return lo + Math.random() * Math.max(0, hi - lo)
  }
}
