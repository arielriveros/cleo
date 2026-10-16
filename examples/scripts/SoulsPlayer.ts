import { Input, Logger, ModelNode, Node, moveWorldDirection, setMoveWorld } from 'cleo'
import type { ClipName, TemplateName } from 'cleo'
import { clamp, num } from '@/Core/Scripts/SoulsMath'
import { Swing, bladeCapsule, closeSwing, newSwing, openSwing, stepSwing, wieldedBy } from '@/Core/Scripts/SoulsHitbox'
import SoulsCharacterNode from '@/Core/Scripts/SoulsCharacter'
import { playSound } from '@/Core/Scripts/SoulsAudio'

/**
 * Hollow Keep — the player. Attach to the `Player` root, which must be a Character node. Extends
 * SoulsCharacter, so its health, defence, hit handling and weapons work exactly as an enemy's do.
 *
 * Expected hierarchy (names matter where marked *):
 *
 *   Player                   Character (this script) — capsule body, friction 0
 *   ├── camera rig           CameraRigNode + SoulsLockOn — must come BEFORE the controller
 *   │   └── camera
 *   ├── <model>              the skinned model; found automatically (first Model child with an animator)
 *   ├── Weapons *            empty group; the weapons in `weaponTemplates` are spawned into it on start
 *   └── Player Controller    ControllerNode, source Player, LAST child; Jump and Sprint actions blank
 *
 * ## What the controller does, and what this does
 *
 * The controller turns Move and Look into a camera-relative intent every frame. This script runs after it
 * (a character's `onUpdate` precedes its locomotion) and PATCHES that intent: it decides the speed, the
 * facing mode and — during a roll, a lunge or a stagger — replaces the movement outright. Locomotion then
 * turns the result into velocity. Nothing here ever writes `velocity`, except the one-off zero on respawn.
 *
 * ## The action state machine
 *
 *   free ──LightAttack/HeavyAttack──▶ attack ──combo window + buffered press──▶ attack (next move)
 *     │  ──Roll (tap)──────────────▶ roll / backstep (no stick)
 *     │  ──UseItem─────────────────▶ drink
 *     │  ──SwapWeapon──────────────▶ swap
 *     │  ──Interact────────────────▶ (whatever the interactable asks for: rest, fog, gesture)
 *   any ──hit outside i-frames─────▶ hit ──▶ free
 *   any ──HP 0─────────────────────▶ dead ──respawn──▶ free
 *
 * ## Stats belong to the player
 *
 * The four attributes, and the curves that turn them into HP, stamina and a level (`hpForVigor`,
 * `staminaForEndurance`, `levelFor`, `levelCost`), are this script's own. The weapon in hand turns
 * STR/DEX into damage (SoulsWeapon.attackRating). Nothing about the player lives on the manager.
 *
 * Presses are BUFFERED for `inputBufferSeconds`, so mashing during an attack queues the next one instead
 * of being lost — the single most important thing for the controls to feel right.
 *
 * ## Animation contract
 *
 * One-shots (attacks, roll, drink...) play through `animator.playAction`, as full-body actions over the
 * locomotion machine. The machine itself needs only `Died` and `Revive` triggers. Attack timing comes
 * from CLIP EVENTS named `hit`, `combo` and `recover` (and `drink` on the drink clip); a clip without them
 * falls back to the move's `hitTime`/`comboTime`/`recoverTime`, so a freshly imported clip still works
 * before anyone has authored its markers. Action slots ignore root motion — clips must be IN PLACE; the
 * travel of a roll or a lunge is driven from here.
 */
export default class SoulsPlayerNode extends SoulsCharacterNode {
  public displayName: string = 'Player'
  public team: string = 'player'
  /** The weapons the player starts with, by template. F swaps between them. */
  public weaponTemplates: TemplateName[] = ['Straight Sword', 'Greatsword']

  // ----- stats (level-up spends souls on these four) ---------------------------------------------
  public vigor: number = 10
  public endurance: number = 10
  public strength: number = 10
  public dexterity: number = 10
  public souls: number = 0

  // ----- resources (runtime; the HUD reads them) --------------------------------------------------
  public hp: number = 400
  public maxHp: number = 400
  public bodyRadius: number = 0.3
  public stamina: number = 90
  public maxStamina: number = 90
  public estus: number = 3
  public estusMax: number = 3
  /** HP restored per flask, spread over `estusHealSeconds`. */
  public estusHeal: number = 250
  public estusHealSeconds: number = 0.4

  // ----- stat curves (see hpForVigor and friends) -------------------------------------------------
  /** HP at Vigor 10. Each point to 30 adds `hpPerVigor`, then the curve flattens. */
  public baseHp: number = 400
  public hpPerVigor: number = 30
  /** Stamina at Endurance 10, plus `staminaPerEndurance` per point to 40. */
  public baseStamina: number = 90
  public staminaPerEndurance: number = 3

  // ----- movement -------------------------------------------------------------------------------
  public jogSpeed: number = 3.8
  public sprintSpeed: number = 5.8
  /** Throttle while locked on: strafing is slower than running. */
  public lockedSpeedScale: number = 0.8
  /** Ramp while freely moving. Actions snap (0) so a roll starts at full speed. */
  public freeAcceleration: number = 24
  /** Degrees per second the body turns toward a locked target while standing. */
  public lockTurnSpeed: number = 540

  // ----- stamina --------------------------------------------------------------------------------
  public staminaRegen: number = 45
  public staminaRegenDelay: number = 0.6
  public sprintCostPerSecond: number = 14
  /** After sprinting to empty, sprint stays locked until stamina recovers to this. */
  public exhaustThreshold: number = 15

  // ----- roll / backstep --------------------------------------------------------------------------
  public rollCost: number = 20
  public rollSeconds: number = 0.7
  public rollInvulnStart: number = 0.06
  public rollInvulnEnd: number = 0.42
  public rollSpeed: number = 6.5
  public rollFastSeconds: number = 0.45
  public rollSlowSpeed: number = 2
  public backstepCost: number = 12
  public backstepSeconds: number = 0.45
  public backstepInvulnEnd: number = 0.22
  public backstepSpeed: number = 4
  public backstepMoveSeconds: number = 0.25
  /** Hold Roll longer than this while moving and it becomes a sprint instead of a roll. */
  public sprintHoldSeconds: number = 0.25

  // ----- input / reactions ------------------------------------------------------------------------
  public inputBufferSeconds: number = 0.3
  /** A hit at or above this much damage is a heavy stagger with knockback; below, a flinch. */
  public heavyHitThreshold: number = 150
  public hitLightSeconds: number = 0.45
  /** A swing that meets a wall (a `blocksSwings` body) before any enemy bounces off it for this long. */
  public recoilSeconds: number = 0.45
  public hitHeavySeconds: number = 0.9
  public knockbackSpeed: number = 4
  public knockbackSeconds: number = 0.15
  /** Falling below this height is death. */
  public killY: number = -15

  // ----- clip names (swap these when the final animations arrive) ---------------------------------
  public rollClip: ClipName = 'Souls_Roll'
  public backstepClip: ClipName = 'Souls_Backstep'
  public drinkClip: ClipName = 'Souls_Drink'
  /** Fallback seconds into the drink clip at which the heal starts when it has no `drink` event. */
  public drinkTime: number = 0.85
  public hitLightClip: ClipName = 'Souls_HitLight'
  public hitHeavyClip: ClipName = 'Souls_HitHeavy'
  /** Played when a swing bounces off a wall. */
  public recoilClip: ClipName = 'Souls_HitLight'
  public swapClip: ClipName = 'Souls_Swap'
  public restClip: ClipName = 'Souls_Rest'
  public fogWalkClip: ClipName = 'Souls_FogWalk'

  // ----- derived, read by the HUD and other scripts ------------------------------------------------
  public level: number = 1
  /** I-frames (roll, backstep, fog, rest, death): `hurtboxActive` is its inverse. */
  public invulnerable: boolean = false
  public actionState: string = 'free'
  public isSprinting: boolean = false
  public attackRatingNow: number = 0
  /** What pressing Interact would do right now, or '' — the HUD prompt. */
  public interactPrompt: string = ''
  /** The last souls gain and how long ago, for the HUD popup. */
  public lastSoulsGain: number = 0
  public soulsGainAge: number = 99
  /** Where the bloodstain goes if the player falls off the world. */
  public lastSafePosition: number[] = null

  private _model: ModelNode = null
  private _rig: Node = null
  private _offEvents: (() => void) | null = null

  private _stateTime: number = 0
  private _bufferAction: string = ''
  private _bufferAge: number = 99
  private _rollHeld: number = -1
  private _sprintedThisHold: boolean = false
  private _sinceSpend: number = 99
  private _sprintLocked: boolean = false
  private _safeTimer: number = 0

  // the current action
  private _move: any = null
  private _clip: string = ''
  private _clipLength: number = 0
  private _playSpeed: number = 1
  /** The active window has opened this attack (the swing has started connecting). */
  private _windowOpened: boolean = false
  private _swing: Swing = newSwing()
  private _comboOpen: boolean = false
  private _recovered: boolean = false
  private _usesEvents: boolean = false
  private _motionDir: number[] = [0, 0, 1]
  private _actionSeconds: number = 0
  private _healLeft: number = 0
  private _healRate: number = 0
  private _drank: boolean = false
  private _swapped: boolean = false
  private _gestureSeconds: number = 0
  private _fogSpeed: number = 0
  private _interactTarget: Node = null
  /** Interactables whose trigger zone the player is standing in. See onTriggerEnter. */
  private _nearby: Node[] = []

  onStart() {
    this.setVariable('isPlayer', true, 'boolean', 'public')
    this._gm = this.findNode('GameManager')
    this._model = this._findModel()
    this._rig = this.children.find(c => c.nodeType === 'cameraRig') ?? null
    this._spawnWeapons()

    this.recomputeStats()
    this.hp = this.maxHp
    this.stamina = this.maxStamina
    this.estus = this.estusMax
    const p = this.worldPosition
    this.lastSafePosition = [p[0], p[1], p[2]]

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
  }

  onDespawn() {
    this._offEvents?.()
    this._offEvents = null
  }

  // =================================================================================================
  // Public API (called by the manager, enemies, interactables and the menu)
  // =================================================================================================

  // ----- stat curves: pure functions of their arguments and the tuning fields above ------------------

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

  /** Souls needed to go from `level` to `level + 1`. */
  public levelCost(level: number): number {
    const l = Math.max(1, level) - 1
    return Math.round(400 + 120 * l + 4 * l * l)
  }

  /** Character level from the four stats: 1 + every point spent above 10. */
  public levelFor(vigor: number, endurance: number, strength: number, dexterity: number): number {
    return 1 + (vigor - 10) + (endurance - 10) + (strength - 10) + (dexterity - 10)
  }

  /** Max HP / stamina / level from the four stats, and the held weapon's attack rating. */
  public recomputeStats(): void {
    this.maxHp = this.hpForVigor(this.vigor)
    this.maxStamina = this.staminaForEndurance(this.endurance)
    this.level = this.levelFor(this.vigor, this.endurance, this.strength, this.dexterity)
    const weapon = this.currentWeapon() as any
    this.attackRatingNow = weapon?.attackRating ? weapon.attackRating(this.strength, this.dexterity) : 0
    this.hp = Math.min(this.hp, this.maxHp)
    this.stamina = Math.min(this.stamina, this.maxStamina)
  }

  // ----- taking hits (SoulsCharacter.receiveHit calls these) -----------------------------------------

  /** I-frames make a hit pass straight through, so a bolt keeps flying past a rolling player. */
  protected _canBeHit(damage: number): boolean {
    return !this.isDead && !this.invulnerable && damage > 0
  }

  protected _onHurt(dealt: number, from: Node): void {
    playSound(this, 'Player Hurt')
  }

  /** Interrupt whatever was happening — a drink included, which is the souls tax on greedy healing. */
  protected _onDamaged(dealt: number, poiseDamage: number, from: Node): void {
    const heavy = dealt >= this.heavyHitThreshold
    this._stopAction()
    this._motionDir = from ? this._dirFrom(from.worldPosition) : this._forward(-1)
    this._enter('hit')
    this._actionSeconds = heavy ? this.hitHeavySeconds : this.hitLightSeconds
    this._play(heavy ? this.hitHeavyClip : this.hitLightClip, 1)
    ;(this._gm as any)?.shake?.(heavy ? 0.35 : 0.15)
  }

  /** A flask shard: one more flask, and every flask refilled. */
  public addEstusFlask(): void {
    this.estusMax += 1
    this.estus = this.estusMax
  }

  /** Refill up to `count` flasks, never past the maximum. */
  public refillEstus(count: number): void {
    this.estus = Math.min(this.estusMax, this.estus + Math.max(1, Math.round(count)))
  }

  public addSouls(amount: number): void {
    if (amount <= 0) return
    this.souls += Math.round(amount)
    this.lastSoulsGain = Math.round(amount)
    this.soulsGainAge = 0
    playSound(this, 'Souls')
  }

  /** Full heal, full stamina, full flasks. Resting and respawning both do this. */
  public restoreAll(): void {
    this.recomputeStats()
    this.hp = this.maxHp
    this.stamina = this.maxStamina
    this.estus = this.estusMax
    this._healLeft = 0
  }

  /** Spend souls on a set of stats. The menu validates first; this re-validates. */
  public applyLevelUp(vigor: number, endurance: number, strength: number, dexterity: number, cost: number): boolean {
    if (cost > this.souls) return false
    if (vigor < this.vigor || endurance < this.endurance || strength < this.strength || dexterity < this.dexterity) return false
    this.souls -= cost
    this.vigor = vigor
    this.endurance = endurance
    this.strength = strength
    this.dexterity = dexterity
    this.restoreAll()
    return true
  }

  /** Back to life at a point. Called by the manager after YOU DIED. */
  public respawnAt(at: ArrayLike<number>, yaw: number): void {
    this._stopAction()
    this.isDead = false
    this.restoreAll()
    this.setPosition([at[0], at[1], at[2]])
    this.setRotation([0, yaw, 0])
    this.velocity = [0, 0, 0]
    this.lastSafePosition = [at[0], at[1], at[2]]
    this._bufferAction = ''
    this._enter('free')
    const animator = this._model?.animator as any
    animator?.resetTrigger?.('Died')
    animator?.setTrigger?.('Revive')
    const rig = this._rig as any
    rig?.setOrbit?.(yaw, 12)
    rig?.snapToTarget?.()
  }

  /** Called by a bonfire: sit down. The manager opens the menu; `standUp` ends it. */
  public sitAtBonfire(): void {
    this._stopAction()
    this._enter('rest')
    this._play(this.restClip, 1, true)
  }

  public standUp(): void {
    if (this.actionState !== 'rest') return
    this._stopAction()
    this._enter('free')
  }

  /**
   * Called by the fog gate: stand at `start` facing `yaw`, then walk `distance` metres over `seconds`
   * with i-frames. The gate turns its own collider off for the duration.
   */
  public walkThroughFog(start: ArrayLike<number>, yaw: number, distance: number, seconds: number): void {
    this._stopAction()
    this.setPosition([start[0], start[1], start[2]])
    this.setRotation([0, yaw, 0])
    this._motionDir = [Math.sin(yaw * Math.PI / 180), 0, Math.cos(yaw * Math.PI / 180)]
    this._fogSpeed = distance / Math.max(0.1, seconds)
    this._enter('fog')
    this._actionSeconds = seconds
    this._play(this.fogWalkClip, 1)
  }

  /** A short locked gesture (picking something up, pulling a lever). */
  public playGesture(clip: string, seconds: number): void {
    if (this.isDead) return
    this._stopAction()
    this._enter('gesture')
    this._actionSeconds = seconds
    if (clip) this._play(clip, 1)
  }

  /** The lock-on target's node, or null. Read off the camera rig's SoulsLockOn. */
  public get lockTarget(): Node {
    return (this._rig as any)?.lockTarget ?? null
  }

  // =================================================================================================
  // The frame
  // =================================================================================================

  onUpdate(delta: number) {
    const intent = this.drive()
    this._stateTime += delta
    this._bufferAge += delta
    this._sinceSpend += delta
    this.soulsGainAge += delta

    if (this.isDead) { this._holdStill(intent); return }

    if (this.worldPosition[1] < this.killY) {
      this.hp = 0
      this._die()
      this._holdStill(intent)
      return
    }

    this._trackSafeGround(delta)
    this._tickHeal(delta)
    this._readInput()
    this._findInteractable()

    switch (this.actionState) {
      case 'free': this._free(intent, delta); break
      case 'attack': this._attack(intent, delta); break
      case 'roll': this._roll(intent); break
      case 'backstep': this._backstep(intent); break
      case 'drink': this._drink(intent); break
      case 'swap': this._swap(intent); break
      case 'hit': this._hit(intent); break
      case 'recoil': this._hit(intent); break
      case 'rest': this._holdStill(intent); break
      case 'gesture':
        this._holdStill(intent)
        if (this._stateTime >= this._actionSeconds) this._enter('free')
        break
      case 'fog':
        this._driveMotion(intent, this._motionDir, this._fogSpeed)
        if (this._stateTime >= this._actionSeconds) this._enter('free')
        break
      default: this._enter('free')
    }

    this.invulnerable = this._computeInvulnerable()
    this.hurtboxActive = !this.invulnerable
    this._tickStamina(delta)
  }

  // ----- states ----------------------------------------------------------------------------------

  private _free(intent: any, delta: number): void {
    const target = this.lockTarget
    const moving = Math.hypot(intent.move[0], intent.move[1]) > 0.15

    // Sprint: Roll HELD past the threshold while moving, with stamina to burn.
    const holdSprint = this._rollHeld >= this.sprintHoldSeconds && moving
    if (this.stamina <= 0) this._sprintLocked = true
    if (this._sprintLocked && this.stamina >= this.exhaustThreshold) this._sprintLocked = false
    this.isSprinting = holdSprint && !this._sprintLocked

    this.acceleration = this.freeAcceleration
    this.walkSpeed = this.jogSpeed
    this.runSpeed = this.sprintSpeed
    intent.sprint = this.isSprinting
    if (this.isSprinting) {
      this.stamina = Math.max(0, this.stamina - this.sprintCostPerSecond * delta)
      this._sinceSpend = 0
    }

    if (target && !this.isSprinting) {
      // Strafe: face the target, move relative to the camera (which is aimed at it).
      this.facingMode = 'aim'
      intent.speedScale = this.lockedSpeedScale
      if (!moving) this._turnToward(target.worldPosition, this.lockTurnSpeed * delta)
    } else {
      this.facingMode = 'velocity'
      intent.speedScale = 1
    }

    // Buffered actions, most recent first.
    if (this._bufferAge > this.inputBufferSeconds) this._bufferAction = ''
    const action = this._bufferAction
    if (!action) return
    if (action === 'light' || action === 'heavy') this._startAttack(action === 'light' ? 'light' : 'heavy', null)
    else if (action === 'roll') this._startRoll(intent)
    else if (action === 'item') this._startDrink()
    else if (action === 'swap') this._startSwap()
    else if (action === 'interact') this._interact()
  }

  private _attack(intent: any, delta: number): void {
    const move = this._move
    const t = this._stateTime * this._playSpeed   // clip seconds

    // Fallback timing for clips that carry no events.
    if (!this._usesEvents && move) {
      const hitTime = num(move.hitTime, 0.4)
      if (!this._windowOpened && t >= hitTime) this._openWindow()
      if (this._swing.open && t >= hitTime + num(move.activeSeconds, 0.15)) closeSwing(this._swing)
      if (!this._comboOpen && t >= num(move.comboTime, 0.5)) this._comboOpen = true
      if (!this._recovered && t >= num(move.recoverTime, 0.7)) this._recovered = true
    }
    if (this._swing.open && this._stepSwing()) return

    // Track toward the target (or the stick) only during the wind-up.
    if (this._stateTime < num(move?.trackSeconds, 0.2)) {
      const target = this.lockTarget
      if (target) this._turnToward(target.worldPosition, 720 * delta)
      else {
        const stick = moveWorldDirection([0, 0, 0] as any, intent)
        if (Math.hypot(stick[0], stick[2]) > 0.2) this._turnToward(
          [this.worldPosition[0] + stick[0], 0, this.worldPosition[2] + stick[2]], 720 * delta)
      }
    }

    // Lunge: forward drive for a window of the clip.
    const lungeStart = num(move?.lungeStart, 0)
    const lunging = t >= lungeStart && t < lungeStart + num(move?.lungeSeconds, 0) * this._playSpeed
    this._driveMotion(intent, this._forward(1), lunging ? num(move?.lungeSpeed, 0) : 0)

    // Chain: inside the combo window, a buffered attack goes straight to the next move.
    const buffered = this._bufferAge <= this.inputBufferSeconds ? this._bufferAction : ''
    if (this._comboOpen && this._windowOpened && (buffered === 'light' || buffered === 'heavy')) {
      const next = buffered === 'light' ? (move?.next || '') : ''
      this._startAttack(buffered, next)
      return
    }
    // After recovery, a roll or a drink cancels the tail.
    if (this._recovered && (buffered === 'roll' || buffered === 'item')) {
      this._enter('free')
      return
    }
    if (this._stateTime >= this._actionSeconds) this._enter('free')
  }

  private _roll(intent: any): void {
    const t = this._stateTime
    const speed = t < this.rollFastSeconds ? this.rollSpeed : (t < this.rollSeconds * 0.85 ? this.rollSlowSpeed : 0)
    this._driveMotion(intent, this._motionDir, speed)
    if (t >= this.rollSeconds) this._enter('free')
  }

  private _backstep(intent: any): void {
    const t = this._stateTime
    this._driveMotion(intent, this._motionDir, t < this.backstepMoveSeconds ? this.backstepSpeed : 0)
    if (t >= this.backstepSeconds) this._enter('free')
  }

  private _drink(intent: any): void {
    this._holdStill(intent)
    const t = this._stateTime
    if (!this._drank && !this._usesEvents && t >= this.drinkTime) this._doDrink()
    if (t >= this._actionSeconds) this._enter('free')
  }

  private _swap(intent: any): void {
    this._holdStill(intent)
    if (!this._swapped && this._stateTime >= this._actionSeconds * 0.5) {
      this._swapped = true
      this.equipWeapon((this._weaponIndex + 1) % Math.max(1, this._weapons.length))
      this.recomputeStats()
    }
    if (this._stateTime >= this._actionSeconds) this._enter('free')
  }

  private _hit(intent: any): void {
    this._driveMotion(intent, this._motionDir, this._stateTime < this.knockbackSeconds ? this.knockbackSpeed : 0)
    if (this._stateTime >= this._actionSeconds) this._enter('free')
  }

  // ----- entering actions ------------------------------------------------------------------------

  /** Start an attack. `kind` light/heavy; `named` is the next combo move, or null for the chain's start. */
  private _startAttack(kind: string, named: string): void {
    if (this.stamina <= 0) return
    const weapon = this.currentWeapon() as any
    if (!weapon) return
    const name = named || (kind === 'heavy' ? weapon.heavyMove : weapon.lightMove)
    const move = weapon.findMove?.(name) ?? weapon.findMove?.(weapon.lightMove)
    if (!move) return
    this._consumeBuffer()
    this._spend(num(move.staminaCost, 20) * num(weapon.staminaMul, 1))

    this._move = move
    this._windowOpened = false
    closeSwing(this._swing)
    this._comboOpen = false
    this._recovered = false
    this._enter('attack')
    this._playSpeed = Math.max(0.05, num(move.playSpeed, 1))
    this._play(move.clip, this._playSpeed)
    this._usesEvents = this._clipHasEvent(move.clip, 'hit')
    const length = this._clipLength > 0 ? this._clipLength : num(move.recoverTime, 0.7) + 0.4
    this._actionSeconds = length / this._playSpeed
    playSound(this, kind === 'heavy' ? 'Swing Heavy' : 'Swing')
  }

  private _startRoll(intent: any): void {
    if (this.stamina <= 0) return
    this._consumeBuffer()
    const dir = moveWorldDirection([0, 0, 0] as any, intent)
    const len = Math.hypot(dir[0], dir[2])
    if (len < 0.2) {
      // No stick: a backstep, facing kept.
      this._spend(this.backstepCost)
      this._motionDir = this._forward(-1)
      this._enter('backstep')
      this._play(this.backstepClip, 1)
    } else {
      this._spend(this.rollCost)
      this._motionDir = [dir[0] / len, 0, dir[2] / len]
      this.setRotation([0, Math.atan2(dir[0], dir[2]) * 180 / Math.PI, 0])
      this._enter('roll')
      this._play(this.rollClip, 1)
    }
    playSound(this, 'Roll')
  }

  private _startDrink(): void {
    this._consumeBuffer()
    if (this.estus <= 0) {
      ;(this._gm as any)?.notice?.('No Estus left')
      return
    }
    this._drank = false
    this._enter('drink')
    this._play(this.drinkClip, 1)
    this._usesEvents = this._clipHasEvent(this.drinkClip, 'drink')
    this._actionSeconds = this._clipLength > 0 ? this._clipLength : 1.4
  }

  private _startSwap(): void {
    this._consumeBuffer()
    if (this._weapons.length < 2) return
    this._swapped = false
    this._enter('swap')
    this._play(this.swapClip, 1)
    this._actionSeconds = this._clipLength > 0 ? this._clipLength : 0.4
  }

  private _interact(): void {
    this._consumeBuffer()
    const target = this._interactTarget as any
    if (!target?.interact) return
    try { target.interact(this) }
    catch (e) { Logger.warn('Hollow Keep: interact failed on ' + (this._interactTarget?.name ?? '?') + ': ' + e, 'Script') }
  }

  protected _die(): void {
    if (this.isDead) return
    this.isDead = true
    this._stopAction()
    this._enter('dead')
    ;(this._model?.animator as any)?.setTrigger?.('Died')
    ;(this._gm as any)?.onPlayerDied?.(this)
  }

  // ----- events ----------------------------------------------------------------------------------

  private _onAnimEvent(name: string, clip: string): void {
    if (clip && this._clip && clip !== this._clip) return
    if (this.actionState === 'attack') {
      if (name === 'hit' && !this._windowOpened) this._openWindow()
      else if (name === 'hitEnd') closeSwing(this._swing)
      else if (name === 'combo') this._comboOpen = true
      else if (name === 'recover') this._recovered = true
    } else if (this.actionState === 'drink' && name === 'drink' && !this._drank) {
      this._doDrink()
    }
  }

  /** The `hit` event: the blade starts connecting. It stays live until `hitEnd`. */
  private _openWindow(): void {
    this._windowOpened = true
    openSwing(this._swing)
  }

  /**
   * One frame of the active window: sweep the blade, damage what it reached, and bounce off a wall it
   * reached first. Returns true when the swing ended in a recoil (the state has changed).
   */
  private _stepSwing(): boolean {
    const weapon = this.currentWeapon() as any
    // Not in this character's own hand (no hand socket on its model): the blade is elsewhere, hit nothing.
    if (!wieldedBy(weapon, this)) return false
    const blade = bladeCapsule(weapon)
    if (!blade) return false
    const move = this._move as any
    const contact = stepSwing(this.scene?.physics, this._swing, blade, this, 'enemy', move?.bounceOff !== false)
    // The weapon turns the swing into damage; each target takes it through its own receiveHit.
    for (const t of contact.targets) weapon?.strike?.(this, move, t.node, t.point)
    if (contact.blockedAt && !contact.targets.length) {
      this._recoil(contact.blockedAt)
      return true
    }
    if (contact.blockedAt) closeSwing(this._swing)
    return false
  }

  /** The blade met a wall: sparks, a jolt, and a short stagger with the swing cancelled. */
  private _recoil(at: number[]): void {
    closeSwing(this._swing)
    const gm = this._gm as any
    gm?.fx?.((this.currentWeapon() as any)?.hitSparkTemplate || 'Hit Spark', at)
    playSound(this, 'Recoil')
    gm?.shake?.(0.2)
    this._stopAction()
    this._motionDir = this._forward(-1)
    this._enter('recoil')
    this._actionSeconds = this.recoilSeconds
    this._play(this.recoilClip, 1.4)
  }

  private _doDrink(): void {
    this._drank = true
    if (this.estus <= 0) return
    this.estus--
    this._healLeft = this.estusHeal
    this._healRate = this.estusHeal / Math.max(0.05, this.estusHealSeconds)
    playSound(this, 'Drink')
  }

  // ----- per-frame helpers -------------------------------------------------------------------------

  private _readInput(): void {
    if (Input.started('LightAttack')) this._buffer('light')
    if (Input.started('HeavyAttack')) this._buffer('heavy')
    if (Input.started('UseItem')) this._buffer('item')
    if (Input.started('SwapWeapon')) this._buffer('swap')
    if (Input.started('Interact') && this._interactTarget) this._buffer('interact')

    // Roll is a TAP; holding it is sprint. So the roll fires on RELEASE, and only if this press never
    // turned into a sprint. `heldSeconds` reads 0 on the release frame, hence the copy kept while held.
    if (Input.started('Roll')) { this._rollHeld = 0; this._sprintedThisHold = false }
    if (this._rollHeld >= 0 && Input.pressed('Roll')) this._rollHeld = Input.heldSeconds('Roll')
    if (this.isSprinting) this._sprintedThisHold = true
    if (Input.released('Roll') && this._rollHeld >= 0) {
      if (!this._sprintedThisHold) this._buffer('roll')
      this._rollHeld = -1
    }
  }

  private _buffer(action: string): void {
    this._bufferAction = action
    this._bufferAge = 0
  }

  private _consumeBuffer(): void {
    this._bufferAction = ''
    this._bufferAge = 99
  }

  private _tickStamina(delta: number): void {
    const resting = this.actionState === 'free' || this.actionState === 'rest' || this.actionState === 'gesture'
      || this.actionState === 'swap' || this.actionState === 'drink'
    if (resting && !this.isSprinting && this._sinceSpend >= this.staminaRegenDelay)
      this.stamina = Math.min(this.maxStamina, this.stamina + this.staminaRegen * delta)
  }

  private _tickHeal(delta: number): void {
    if (this._healLeft <= 0) return
    const step = Math.min(this._healLeft, this._healRate * delta)
    this._healLeft -= step
    this.hp = Math.min(this.maxHp, this.hp + step)
  }

  private _spend(amount: number): void {
    this.stamina = Math.max(0, this.stamina - amount)
    this._sinceSpend = 0
  }

  private _computeInvulnerable(): boolean {
    const t = this._stateTime
    switch (this.actionState) {
      case 'roll': return t >= this.rollInvulnStart && t <= this.rollInvulnEnd
      case 'backstep': return t <= this.backstepInvulnEnd
      case 'fog': case 'rest': case 'dead': return true
      default: return false
    }
  }

  /**
   * Entering an interactable's trigger zone makes it a candidate; leaving takes it off. The zones are
   * authored as each interactable's `trigger` volume — no distance is measured in script.
   */
  onTriggerEnter(other: Node) {
    if (other && (other as any).interact && !this._nearby.includes(other)) this._nearby.push(other)
    ;(this._gm as any)?.onPlayerEnteredZone?.(other)
  }

  onTriggerExit(other: Node) {
    this._nearby = this._nearby.filter(n => n !== other)
    ;(this._gm as any)?.onPlayerLeftZone?.(other)
  }

  /** The interactables in range right now, nearest first (for tests and the HUD). */
  public nearbyInteractables(): Node[] { return this._nearby.slice() }

  private _findInteractable(): void {
    this._interactTarget = null
    this.interactPrompt = ''
    if (this.actionState !== 'free' || !this._nearby.length) return
    const me = this.worldPosition
    let best: Node = null
    let bestDistance = Infinity
    for (const node of this._nearby) {
      const n = node as any
      if (!node || node.spawned === false || !n.interact) continue
      if (n.canInteract && !n.canInteract(this)) continue
      // Inside several zones at once (a lever beside a door): the nearest wins.
      const p = node.worldPosition
      const d = Math.hypot(p[0] - me[0], p[2] - me[2])
      if (d < bestDistance) { best = node; bestDistance = d }
    }
    if (!best) return
    this._interactTarget = best
    const b = best as any
    this.interactPrompt = (b.promptText ? b.promptText(this) : b.prompt) || 'Interact'
  }

  private _trackSafeGround(delta: number): void {
    this._safeTimer += delta
    if (this._safeTimer < 0.5) return
    this._safeTimer = 0
    if (this.isGrounded && this.actionState === 'free') {
      const p = this.worldPosition
      this.lastSafePosition = [p[0], p[1], p[2]]
    }
  }

  /** Replace the controller's move with a world direction at a fixed speed (0 stands still). */
  private _driveMotion(intent: any, dir: number[], speed: number): void {
    this.acceleration = 0
    this.facingMode = 'none'
    intent.speedScale = 1
    if (speed <= 0) {
      intent.move[0] = 0
      intent.move[1] = 0
      intent.sprint = false
      return
    }
    setMoveWorld(intent, dir[0], dir[2])
    intent.sprint = true
    this.runSpeed = speed
  }

  private _holdStill(intent: any): void {
    this._driveMotion(intent, this._motionDir, 0)
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
    const step = Math.max(-maxDegrees, Math.min(maxDegrees, diff))
    this.setRotation([0, have + step, 0])
  }

  private _forward(sign: number): number[] {
    const f = this.worldForward
    const len = Math.hypot(f[0], f[2]) || 1
    return [sign * f[0] / len, 0, sign * f[2] / len]
  }

  private _dirFrom(from: ArrayLike<number>): number[] {
    const me = this.worldPosition
    const dx = me[0] - from[0]
    const dz = me[2] - from[2]
    const len = Math.hypot(dx, dz)
    return len > 1e-4 ? [dx / len, 0, dz / len] : this._forward(-1)
  }

  private _enter(state: string): void {
    if (state !== 'attack') closeSwing(this._swing)
    this.actionState = state
    this._stateTime = 0
    if (state === 'free') {
      this._move = null
      this._clip = ''
    }
  }

  private _play(clip: string, speed: number, loop: boolean = false): void {
    this._clip = clip
    this._clipLength = this._clipDuration(clip)
    const animator = this._model?.animator as any
    if (!animator?.playAction || !clip) return
    animator.playAction(clip, { speed, loop, blendIn: 0.08, blendOut: 0.18 })
  }

  private _stopAction(): void {
    const animator = this._model?.animator as any
    animator?.stopAction?.(undefined, 0.12)
    this._clip = ''
  }

  private _clipDuration(name: string): number {
    const clip = this._findClip(name)
    if (!clip) return 0
    let end = 0
    for (const s of clip.samplers ?? []) {
      const input = s.input
      if (input && input.length) end = Math.max(end, input[input.length - 1])
    }
    return end
  }

  private _clipHasEvent(name: string, event: string): boolean {
    const clip = this._findClip(name)
    return !!clip?.events?.some((e: any) => e.name === event)
  }

  private _findClip(name: string): any {
    const animations = (this._model?.model as any)?.animations
    if (!animations || !name) return null
    return animations.find((a: any) => a.name === name) ?? null
  }

  private _findModel(): ModelNode {
    const walk = (node: Node): ModelNode => {
      for (const child of node.children) {
        if (child.nodeType === 'model' && (child as any).animator) return child as ModelNode
        if (child.nodeType === 'cameraRig' || child.nodeType === 'controller') continue
        const found = walk(child)
        if (found) return found
      }
      return null
    }
    return walk(this)
  }

}
