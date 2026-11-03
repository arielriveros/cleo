import { Input, Logger, ModelNode, Node, moveWorldDirection, setMoveWorld } from 'cleo'
import type { AnimationTriggerInfo, TemplateName, TriggerName } from 'cleo'
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
 *     │  ──running, stick reversed─▶ runTurn (plant, turn round, run back) ──▶ free
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
 * This script plays no clip and names no animator state: every one-shot — the roll, the running turn,
 * each weapon move, the drink, the reactions — is a TRIGGER fired here by name (the `*Trigger` fields, and
 * each move's `animTrigger`). In the shipped animator each enters a state of its **Actions** layer, a
 * full-body layer over the locomotion machine; the graph owns the clip, its speed and its blends, and
 * leaves the state on its own at the clip's end. The script owns the gameplay, and asks the animator how
 * long what a trigger plays lasts and whether it still plays (`triggerInfo`, `activeTrigger`).
 * The base machine needs `Died` and `Revive`. Attack timing comes from CLIP EVENTS named `hit`, `combo`
 * and `recover` (`drink` on the drink clip, `swap` on the sheathe); a clip without them falls back to the
 * move's `hitTime`/`comboTime`/`recoverTime`. Travel is driven from here: a state that extracts its root
 * travel (the roll, the Longsword's steps) hands it over through `consumeRootMotion`.
 */
export default class SoulsPlayerNode extends SoulsCharacterNode {
  public displayName: string = 'Player'
  public team: string = 'player'
  /** The weapons the player starts with, by template. F swaps between them. */
  public weaponTemplates: TemplateName[] = ['Longsword', 'Greatsword']

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
  /** Shown once on wading in: water slows you and stops rolls and sprints. */
  public waterNotice: string = "Can't roll or sprint in water"
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
  /**
   * Move by the roll's OWN travel (the Roll state extracts its clip's root travel) instead of the
   * rollSpeed curve above: the body covers exactly the ground the dive does, through its own collision,
   * for as long as the state lasts. The roll always faces the way it goes -- there is only a forward roll.
   */
  public rollRootMotion: boolean = true
  // ----- running turn (see _startRunTurn) --------------------------------------------------------
  /** Reversing at a run plays a planted 180° turn instead of spinning on the spot. Off: the plain turn. */
  public runTurnEnabled: boolean = true
  /** Degrees between where the player is running and where the stick now points that count as reversing. */
  public runTurnAngle: number = 130
  /** Running at least this fast (m/s); a walker just turns. */
  public runTurnMinSpeed: number = 3
  /** Share of the turn spent braking to a stop before pushing off the other way. */
  public runTurnPlant: number = 0.45
  /**
   * The animator parameters the turn holds on a straight-ahead run underneath its clip (see _pinRunPose):
   * the character's measured speed and direction, which would otherwise drop to Idle at the plant.
   */
  public runTurnSpeedParam: string = 'Speed'
  public runTurnDirectionParam: string = 'Direction'
  /** After the turn, the longest the speed parameter keeps following the body while the measured speed catches up. */
  public runTurnReleaseSeconds: number = 0.3
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
  /** Real seconds of hit-stop when a hit lands on the player (the GameManager's), light and heavy. */
  public hurtHitStop: number = 0.08
  public heavyHurtHitStop: number = 0.14
  public hitLightSeconds: number = 0.45
  /** A swing that meets a wall (a `blocksSwings` body) before any enemy bounces off it for this long. */
  public recoilSeconds: number = 0.45
  public hitHeavySeconds: number = 0.9
  public knockbackSpeed: number = 4
  public knockbackSeconds: number = 0.15
  /** Falling below this height is death. */
  public killY: number = -15

  // ----- animator triggers: each enters a state of the Actions layer (the clips are the graph's) ------
  public rollTrigger: TriggerName = 'Roll'
  public backstepTrigger: TriggerName = 'Backstep'
  /** The running 180° turn, turning right and turning left (Left falls back to Right when it is missing). */
  public runTurnRightTrigger: TriggerName = 'RunTurnRight'
  public runTurnLeftTrigger: TriggerName = 'RunTurnLeft'
  public drinkTrigger: TriggerName = 'Drink'
  /** Fallback seconds into the drink clip at which the heal starts when it has no `drink` event. */
  public drinkTime: number = 0.85
  public hitLightTrigger: TriggerName = 'HitLight'
  public hitHeavyTrigger: TriggerName = 'HitHeavy'
  /** Played when a swing bounces off a wall. */
  public recoilTrigger: TriggerName = 'Recoil'
  /**
   * A weapon swap: the layer sheathes the one in hand, then draws the next. The weapon changes on the
   * sheathe clip's `swap` event (or as the draw begins, when the clip has none).
   */
  public swapTrigger: TriggerName = 'Swap'
  /** Sitting at a bonfire: a looping state, left on SoulsCharacter's `stopTrigger`. */
  public restTrigger: TriggerName = 'Rest'
  public fogWalkTrigger: TriggerName = 'FogWalk'

  // ----- the fight -----------------------------------------------------------------------------------
  /**
   * Seconds the combat stance holds after the last blow given or taken (once no enemy is engaged and
   * nothing is locked). While `inCombat`, the animator's `InCombat` swaps the idle for the Longsword's
   * guard and keeps both hands on the hilt while moving.
   */
  public combatLinger: number = 5
  /** How often the engaged enemies are looked for, seconds. */
  public combatScanInterval: number = 0.25

  // ----- derived, read by the HUD and other scripts ------------------------------------------------
  public level: number = 1
  /** I-frames (roll, backstep, fog, rest, death): `hurtboxActive` is its inverse. */
  public invulnerable: boolean = false
  public actionState: string = 'free'
  public isSprinting: boolean = false
  public attackRatingNow: number = 0
  /** Locked on, an enemy engaged with us, or a blow given or taken within `combatLinger` seconds. */
  public inCombat: boolean = false
  /** What pressing Interact would do right now, or '' — the HUD prompt. */
  public interactPrompt: string = ''
  /** The last souls gain and how long ago, for the HUD popup. */
  public lastSoulsGain: number = 0
  public soulsGainAge: number = 99
  /** Where the bloodstain goes if the player falls off the world. */
  public lastSafePosition: number[] = null

  private _rig: Node = null
  private _offEvents: (() => void) | null = null

  private _stateTime: number = 0
  private _bufferAction: string = ''
  private _bufferAge: number = 99
  private _rollHeld: number = -1
  /** Seconds the current root-motion roll lasts (0: the timed roll). */
  private _rollLength: number = 0
  /** The running turn under way: its length, the speed it came in at, the way out, and the yaw it ends facing. */
  private _runTurnLength: number = 0
  private _runTurnSpeed: number = 0
  private _runTurnOut: number[] = [0, 0, 1]
  private _runTurnYaw: number = 0
  private _runTurnDone: boolean = true
  /** Seconds since a finished turn handed the speed parameter back to the body (see _settleRunPin); -1: not. */
  private _runPinSettle: number = -1
  private _frameDelta: number = 1 / 60
  private _sprintedThisHold: boolean = false
  private _sinceSpend: number = 99
  private _sprintLocked: boolean = false
  private _safeTimer: number = 0
  private _sinceBlow: number = 99
  private _combatScan: number = 0
  private _enemyEngaged: boolean = false

  // the current action
  private _move: any = null
  /** What the playing move's trigger plays (Animator.triggerInfo), or null. */
  private _moveInfo: AnimationTriggerInfo | null = null
  /** The clip of the one-shot playing, so only its own events count. */
  private _clip: string = ''
  private _playSpeed: number = 1
  /** The active window has opened this attack (the swing has started connecting). */
  private _windowOpened: boolean = false
  private _swing: Swing = newSwing()
  private _comboOpen: boolean = false
  private _recovered: boolean = false
  private _usesEvents: boolean = false
  /** A combo move queued to continue the playing clip when the current segment ends ('' none). */
  private _chainQueued: string = ''
  private _motionDir: number[] = [0, 0, 1]
  private _actionSeconds: number = 0
  private _healLeft: number = 0
  private _healRate: number = 0
  private _drank: boolean = false
  private _swapped: boolean = false
  /** The swap's clip carries the `swap` event the weapon changes on. */
  private _swapEvent: boolean = false
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
    else if (animator && !this._hasAction(this.rollTrigger))
      Logger.warn('Hollow Keep: "' + this.name + '"\'s animator plays nothing on "' + this.rollTrigger + '", so it will roll, swing '
        + 'and drink without animating. Assign "Souls Character" in the model\'s Animation section.', 'Script')
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
    ;(this._gm as any)?.hitStop?.(heavy ? this.heavyHurtHitStop : this.hurtHitStop)
    this._sinceBlow = 0
    this._motionDir = from ? this._dirFrom(from.worldPosition) : this._forward(-1)
    this._enter('hit')
    this._actionSeconds = heavy ? this.hitHeavySeconds : this.hitLightSeconds
    // From any state: the reaction cuts whatever was playing (and a queued combo swing with it).
    this._oneShot(heavy ? this.hitHeavyTrigger : this.hitLightTrigger)
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
    const wasDead = this.isDead
    this._stopActions()
    this.isDead = false
    this.restoreAll()
    this.setPosition([at[0], at[1], at[2]])
    this.setRotation([0, yaw, 0])
    this.velocity = [0, 0, 0]
    this.lastSafePosition = [at[0], at[1], at[2]]
    this._bufferAction = ''
    this._enter('free')
    const animator = this._animator
    animator?.resetTrigger?.('Died')
    // Only the dead revive: raised on a living player (the pause menu's respawn), Revive would wait for the
    // next death and stand the body straight back up.
    if (wasDead) animator?.setTrigger?.('Revive')
    else animator?.resetTrigger?.('Revive')
    const rig = this._rig as any
    rig?.setOrbit?.(yaw, 12)
    rig?.snapToTarget?.()
  }

  /** Called by a bonfire: sit down. The manager opens the menu; `standUp` ends it. */
  public sitAtBonfire(): void {
    this._enter('rest')
    this._oneShot(this.restTrigger)
  }

  public standUp(): void {
    if (this.actionState !== 'rest') return
    this._stopActions()
    this._enter('free')
  }

  /**
   * Called by the fog gate: stand at `start` facing `yaw`, then walk `distance` metres over `seconds`
   * with i-frames. The gate turns its own collider off for the duration.
   */
  public walkThroughFog(start: ArrayLike<number>, yaw: number, distance: number, seconds: number): void {
    this.setPosition([start[0], start[1], start[2]])
    this.setRotation([0, yaw, 0])
    this._motionDir = [Math.sin(yaw * Math.PI / 180), 0, Math.cos(yaw * Math.PI / 180)]
    this._fogSpeed = distance / Math.max(0.1, seconds)
    this._enter('fog')
    this._actionSeconds = seconds
    this._oneShot(this.fogWalkTrigger)
  }

  /**
   * A short locked gesture (picking something up, pulling a lever): `gesture` is the animator trigger of
   * its Actions state ('Pickup', 'Interact'); empty only holds still. `seconds` is how long control is held.
   */
  public playGesture(gesture: TriggerName, seconds: number): void {
    if (this.isDead) return
    this._enter('gesture')
    this._actionSeconds = seconds
    if (gesture) this._oneShot(gesture)
    else this._stopActions()
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
    try {
      this._frame(intent, delta)
    } finally {
      this.applyWater(intent)
      this.limitClimb(intent)
    }
  }

  private _frame(intent: any, delta: number): void {
    this._stateTime += delta
    this._frameDelta = delta
    this._bufferAge += delta
    this._sinceSpend += delta
    this.soulsGainAge += delta
    this._settleRunPin(delta)
    this._trackAction(delta)

    if (this.isDead) { this._setCombat(false); this._holdStill(intent); return }

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
      case 'runTurn': this._runTurn(intent); break
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
    // The hurtbox trigger follows on the same frame: a roll's i-frames are the frames it is switched off.
    this._syncHurtbox()
    this._tickStamina(delta)
    this._tickCombat(delta)
  }

  /** Whether we are in a fight: what the animator's `InCombat` (the guard stance) follows. */
  private _tickCombat(delta: number): void {
    this._sinceBlow += delta
    this._combatScan -= delta
    if (this._combatScan <= 0) {
      this._combatScan = this.combatScanInterval
      const gm = this._gm as any
      const enemies: any[] = gm?.liveEnemies ? gm.liveEnemies() : []
      this._enemyEngaged = enemies.some(e => !!e?.engagedWith?.(this))
    }
    const resting = this.actionState === 'rest' || this.actionState === 'fog'
    this._setCombat(!resting && (!!this.lockTarget || this._enemyEngaged || this._sinceBlow < this.combatLinger))
  }

  private _setCombat(on: boolean): void {
    if (on === this.inCombat) return
    this.inCombat = on
    ;(this._model?.animator as any)?.setBool?.('InCombat', on)
  }

  // ----- states ----------------------------------------------------------------------------------

  private _free(intent: any, delta: number): void {
    const target = this.lockTarget
    const moving = Math.hypot(intent.move[0], intent.move[1]) > 0.15

    // Sprint: Roll HELD past the threshold while moving, with stamina to burn.
    // Not while wading: water slows you and will not let you sprint or roll (see onEnterWater).
    const holdSprint = this._rollHeld >= this.sprintHoldSeconds && moving && !this.inWater
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

    // Reversing at a run: a planted turn rather than a spin on the spot. Not locked on and strafing, where
    // pulling the stick back is a backpedal.
    if (moving && !(target && !this.isSprinting) && this._wantsRunTurn(intent)) {
      this._startRunTurn(intent)
      return
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

    if (this._moveInfo?.extractsRootMotion) {
      // The clip's own steps (its state extracts the root travel): its hips travel this frame, along the facing.
      const d = this._animator?.consumeRootMotion?.()
      const fwd = this._forward(1)
      const along = d ? d[0] * fwd[0] + d[2] * fwd[2] : 0
      this._driveMotion(intent, along >= 0 ? fwd : this._forward(-1), this._frameDelta > 1e-5 ? Math.abs(along) / this._frameDelta : 0)
    } else {
      // Lunge: forward drive for a window of the clip.
      const lungeStart = num(move?.lungeStart, 0)
      const lunging = t >= lungeStart && t < lungeStart + num(move?.lungeSeconds, 0) * this._playSpeed
      this._driveMotion(intent, this._forward(1), lunging ? num(move?.lungeSpeed, 0) : 0)
    }

    // Chain: inside the combo window, a buffered attack goes to the next move. Its trigger is fired now, and
    // the animator decides when it starts: at once, or -- when that move is the next segment of this same
    // clip -- as the clip reaches it, the animation playing straight on.
    const buffered = this._bufferAge <= this.inputBufferSeconds ? this._bufferAction : ''
    if (!this._chainQueued && this._comboOpen && this._windowOpened && (buffered === 'light' || buffered === 'heavy')) {
      const next = buffered === 'light' ? (move?.next || '') : ''
      const nextMove = next ? (this.currentWeapon() as any)?.findMove?.(next) : null
      const nextInfo = nextMove ? this._triggerInfo(this._moveTrigger(nextMove)) : null
      // A move entered only from certain states (a segment that follows this one) waits for its cue.
      if (nextInfo && !nextInfo.fromAnywhere) {
        this._consumeBuffer()
        // The trigger waits raised for the segment's end, so the stamina for it is checked here, at the press.
        if (this.stamina > 0) {
          this._chainQueued = next
          this._raise(this._moveTrigger(nextMove))
        }
      } else {
        this._startAttack(buffered, next)
        return
      }
    }
    // After recovery, a roll or a drink cancels the tail (and a combo swing queued for its end).
    if (this._recovered && (buffered === 'roll' || buffered === 'item')) {
      this._chainQueued = ''
      this._lowerRaised()
      this._enter('free')
      return
    }
    if (this._stateTime >= this._actionSeconds) {
      const queued = this._chainQueued
      this._chainQueued = ''
      // The segment's end: the animator hands over to the queued segment on this same frame.
      if (queued && this._startAttack('light', queued, true)) return
      // Otherwise its exit transition blends out of it (at a segment's end, or as the clip ends).
      this._enter('free')
    }
  }

  /** The animator trigger that plays `move` (SoulsMove.animTrigger; its node name when that is empty). */
  private _moveTrigger(move: any): TriggerName {
    return (move?.animTrigger || move?.name || '') as TriggerName
  }

  private _roll(intent: any): void {
    const t = this._stateTime
    if (this._rollLength > 0) {
      // The animation's own travel this frame, along the roll direction.
      const d = this._animator?.consumeRootMotion?.()
      const dist = d ? Math.hypot(d[0], d[2]) : 0
      this._driveMotion(intent, this._motionDir, this._frameDelta > 1e-5 ? dist / this._frameDelta : 0)
      if (t >= this._rollLength) this._enter('free')
      return
    }
    const speed = t < this.rollFastSeconds ? this.rollSpeed : (t < this.rollSeconds * 0.85 ? this.rollSlowSpeed : 0)
    this._driveMotion(intent, this._motionDir, speed)
    if (t >= this.rollSeconds) this._enter('free')
  }

  /** Running fast enough, on the ground, with the stick pointed back the way the player came. */
  private _wantsRunTurn(intent: any): boolean {
    if (!this.runTurnEnabled || this.inWater || !this.isGrounded) return false
    const v = this.velocity
    const speed = Math.hypot(v[0], v[2])
    if (speed < this.runTurnMinSpeed) return false
    const dir = moveWorldDirection([0, 0, 0] as any, intent)
    const len = Math.hypot(dir[0], dir[2])
    if (len < 0.2) return false
    const cos = (v[0] * dir[0] + v[2] * dir[2]) / (speed * len)
    if (cos > Math.cos(this.runTurnAngle * Math.PI / 180)) return false
    return this._hasAction(this.runTurnRightTrigger)
  }

  /**
   * A running 180° turn: the body brakes along the way it was running, plants, and pushes off the way the
   * stick points, while the Actions layer's turn state turns the character round. The clip turns the MESH
   * (its hips) and the node keeps its yaw throughout; the state leaves at its clip's end with no blend, and
   * on that same frame the node snaps round to face the new way, so the run that follows takes over from a
   * pose that already faces that way.
   */
  private _startRunTurn(intent: any): void {
    const v = this.velocity
    const speed = Math.hypot(v[0], v[2])
    const dir = moveWorldDirection([0, 0, 0] as any, intent)
    const len = Math.hypot(dir[0], dir[2]) || 1
    this._motionDir = [v[0] / speed, 0, v[2] / speed]
    this._runTurnOut = [dir[0] / len, 0, dir[2] / len]
    this._runTurnSpeed = speed
    // Turn toward the side the stick went. Yaw is atan2(x, z), so turning right lowers it: the way out is to the
    // right when this cross product is negative. Straight back turns right.
    const cross = this._motionDir[2] * this._runTurnOut[0] - this._motionDir[0] * this._runTurnOut[2]
    const right = cross <= 0
    // The turn toward that side; with no left turn in the graph, the right one (a half turn either way).
    const trigger = right || !this._hasAction(this.runTurnLeftTrigger) ? this.runTurnRightTrigger : this.runTurnLeftTrigger
    // The clip turns the body a half turn whatever the stick's exact angle: end facing exactly round from where
    // the run was going, and let the run's own facing turn the last few degrees toward the stick.
    const f = this.worldForward
    this._runTurnYaw = Math.atan2(f[0], f[2]) * 180 / Math.PI + (right ? -180 : 180)
    this.facingMode = 'none'
    this._enter('runTurn')
    this._runTurnDone = false
    // Under the clip the base machine keeps running on the measured speed, which falls to 0 at the plant:
    // held on a run instead, so the pose the turn cuts to is already one (see _pinRunPose).
    this._runPinSettle = -1
    this._pinRunPose(speed)
    const info = this._oneShot(trigger)
    this._runTurnLength = info && info.seconds > 0 ? info.seconds : 0.5
  }

  private _runTurn(intent: any): void {
    const t = this._stateTime, length = this._runTurnLength
    const plant = Math.min(0.9, Math.max(0.1, this.runTurnPlant)) * length
    // The speed the turn leaves at, up to which it pushes off the other way.
    const out = this.isSprinting ? this.sprintSpeed : this.jogSpeed
    if (t < plant) {
      this._driveMotion(intent, this._motionDir, this._runTurnSpeed * (1 - t / plant))
      this._pinRunPose(this._runTurnSpeed)
    } else {
      this._driveMotion(intent, this._runTurnOut, out * Math.min(1, (t - plant) / Math.max(1e-3, length - plant)))
      this._pinRunPose(out)
    }
    if (this._runTurnEnded(t >= length)) { this._finishRunTurn(true); this._enter('free') }
  }

  /**
   * Whether the turn is over. While the animator plays it, that is the frame its clip reaches the end: the
   * state leaves on the animator's next pass -- later this same frame, after this script -- cutting to the
   * run, so turning the node now lands on exactly that frame. The timer only answers when it never played.
   */
  private _runTurnEnded(timedOut: boolean): boolean {
    if (!this._actEntered) return timedOut
    if (!this._isPlaying(this._actTrigger)) return true
    return this._turnClipEnded()
  }

  /** The playing turn's clip has reached its last frame. */
  private _turnClipEnded(): boolean {
    const length = this._actInfo?.clipLength ?? 0
    return length > 0 && this._actTime() >= length - 1e-4
  }

  /**
   * End the turn: face the new way if the turn got far enough to show it. Called off past halfway (a roll, a
   * hit), the turn is cut at once as well: whatever follows must not blend from a pose drawn a half turn round.
   */
  private _finishRunTurn(turned: boolean): void {
    if (this._runTurnDone) return
    this._runTurnDone = true
    if (turned) {
      this.setRotation([0, this._runTurnYaw, 0])
      if (this._actEntered && this._isPlaying(this._actTrigger) && !this._turnClipEnded()) this._stopActions(true)
      // The run pose stays held while the measured speed catches up with the body's (see _settleRunPin).
      this._runPinSettle = 0
      this._settleRunPin(0)
    } else this._pinRunPose(null)
  }

  /**
   * Hold the animator's speed parameter at `speed` and its direction straight ahead, or hand both back to
   * what they are linked to (the character's measured motion) with null. Layers share the parameter table,
   * so the upper-body and guard layers follow too.
   */
  private _pinRunPose(speed: number | null): void {
    const animator = this._model?.animator as any
    if (!animator?.setParamOverride) return
    animator.setParamOverride(this.runTurnSpeedParam, speed)
    animator.setParamOverride(this.runTurnDirectionParam, speed === null ? null : 0)
  }

  /**
   * After a turn: the measured speed is smoothed, so it trails the body's for a moment and would read as a
   * slower stride. The speed parameter follows the body's own speed until the measured one is within
   * 0.2 m/s of it, or `runTurnReleaseSeconds` have passed, then both parameters are released.
   */
  private _settleRunPin(delta: number): void {
    if (this._runPinSettle < 0) return
    this._runPinSettle += delta
    const v = this.velocity
    const actual = Math.hypot(v[0], v[2])
    if (this._runPinSettle >= this.runTurnReleaseSeconds || Math.abs(this.planarSpeed - actual) <= 0.2) {
      this._runPinSettle = -1
      this._pinRunPose(null)
    } else this._pinRunPose(actual)
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
    // The weapon changes on the sheathe's `swap` event (_onAnimEvent); a clip without one, halfway through
    // (where a sheathe hands over to the draw).
    if (!this._swapped && !this._swapEvent && this._stateTime >= this._actionSeconds * 0.5) this._swapWeapon()
    if (this._stateTime >= this._actionSeconds) {
      this._swapWeapon()
      this._enter('free')
    }
  }

  /** Hold the next weapon (once per swap). */
  private _swapWeapon(): void {
    if (this._swapped) return
    this._swapped = true
    this.equipWeapon((this._weaponIndex + 1) % Math.max(1, this._weapons.length))
    this.recomputeStats()
  }

  private _hit(intent: any): void {
    this._driveMotion(intent, this._motionDir, this._stateTime < this.knockbackSeconds ? this.knockbackSpeed : 0)
    if (this._stateTime >= this._actionSeconds) this._enter('free')
  }

  // ----- entering actions ------------------------------------------------------------------------

  /**
   * Start an attack. `kind` light/heavy; `named` is the next combo move, or null for the chain's start.
   * `continuing`: the move is the next segment of the clip already playing -- its trigger was fired at the
   * press, and the animator hands over to it as the segment ends -- so nothing is fired again. False when no
   * attack could start (no stamina, no weapon).
   */
  private _startAttack(kind: string, named: string, continuing: boolean = false): boolean {
    // A continuing segment's stamina was checked at the press (the trigger was already raised).
    if (this.stamina <= 0 && !continuing) return false
    const weapon = this.currentWeapon() as any
    if (!weapon) return false
    const name = named || (kind === 'heavy' ? weapon.heavyMove : weapon.lightMove)
    const move = weapon.findMove?.(name) ?? weapon.findMove?.(weapon.lightMove)
    if (!move) return false
    this._consumeBuffer()
    this._chainQueued = ''
    this._spend(num(move.staminaCost, 20) * num(weapon.staminaMul, 1))

    this._move = move
    this._sinceBlow = 0
    this._windowOpened = false
    closeSwing(this._swing)
    this._comboOpen = false
    this._recovered = false
    this._enter('attack')
    const trigger = this._moveTrigger(move)
    let info: AnimationTriggerInfo | null
    if (continuing) {
      // Its trigger was fired at the press; the animator hands over to it later this frame, and
      // _trackAction confirms it.
      info = this._triggerInfo(trigger)
      this._actTrigger = trigger
      this._actInfo = info
      this._actEntered = false
      this._clip = info?.clip ?? ''
    } else {
      // Whatever travel collected before this swing is not this swing's.
      this._animator?.consumeRootMotion()
      info = this._oneShot(trigger)
    }
    this._moveInfo = info
    this._playSpeed = info?.speed ?? 1
    this._usesEvents = !!info && this._clipHasEvent(info.clip, 'hit')
    this._actionSeconds = info && info.seconds > 0 ? info.seconds : (num(move.recoverTime, 0.7) + 0.4) / this._playSpeed
    playSound(this, kind === 'heavy' ? 'Swing Heavy' : 'Swing')
    return true
  }

  private _startRoll(intent: any): void {
    if (this.stamina <= 0) return
    if (this.inWater) { this._consumeBuffer(); return }
    this._consumeBuffer()
    const dir = moveWorldDirection([0, 0, 0] as any, intent)
    const len = Math.hypot(dir[0], dir[2])
    if (len < 0.2) {
      // No stick: a backstep, facing kept.
      this._spend(this.backstepCost)
      this._motionDir = this._forward(-1)
      this._enter('backstep')
      this._oneShot(this.backstepTrigger)
    } else {
      this._spend(this.rollCost)
      this._motionDir = [dir[0] / len, 0, dir[2] / len]
      // There is only a FORWARD roll, so the body turns to the roll's direction for its length -- even
      // locked on and rolling backwards, toward the camera -- and lock-on turns it back to the target
      // afterwards. 'none' from this very frame: the locked strafe's 'aim' facing set earlier in it would
      // otherwise start pulling the body back toward the enemy before the roll's first step.
      this.facingMode = 'none'
      this.setRotation([0, Math.atan2(dir[0], dir[2]) * 180 / Math.PI, 0])
      this._enter('roll')
      this._rollLength = 0
      const info = this._oneShot(this.rollTrigger)
      if (this.rollRootMotion && info?.extractsRootMotion) {
        // The state extracts the dive's travel for _roll to move the body by, for as long as it lasts.
        this._animator?.consumeRootMotion()   // drop anything left from before
        this._rollLength = info.seconds > 0 ? info.seconds : this.rollSeconds
      }
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
    const info = this._oneShot(this.drinkTrigger)
    this._usesEvents = !!info && this._clipHasEvent(info.clip, 'drink')
    this._actionSeconds = info && info.seconds > 0 ? info.seconds : 1.4
  }

  private _startSwap(): void {
    this._consumeBuffer()
    if (this._weapons.length < 2) return
    this._swapped = false
    this._enter('swap')
    // The sheathe and the draw it goes on into: `seconds` covers both.
    const info = this._oneShot(this.swapTrigger)
    this._swapEvent = !!info && this._clipHasEvent(info.clip, 'swap')
    this._actionSeconds = info && info.seconds > 0 ? info.seconds : 0.4
  }

  /** Fire a one-shot (see SoulsCharacter._playTrigger) and remember its clip: only its own events count. */
  private _oneShot(trigger: TriggerName): AnimationTriggerInfo | null {
    const info = this._playTrigger(trigger)
    this._clip = info?.clip ?? ''
    return info
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
    this._enter('dead')
    // The base falls on Died, and the Actions layer leaves whatever it plays on the same trigger.
    this._lowerRaised()
    this._actTrigger = ''
    this._actInfo = null
    this._animator?.setTrigger('Died')
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
    } else if (this.actionState === 'swap' && name === 'swap') {
      this._swapWeapon()
    }
  }

  /**
   * The `hit` event: the blade's hitbox switches on, live until `hitEnd`. Only a weapon in this character's
   * own hand arms (see wieldedBy): one riding someone else's socket hits nothing.
   */
  private _openWindow(): void {
    this._windowOpened = true
    const weapon = this.currentWeapon()
    openSwing(this._swing, wieldedBy(weapon, this) ? weapon : null, 'enemy')
  }

  /**
   * One frame of the active window: damage the hurtboxes the hitbox entered, and bounce off a wall it
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
    this._motionDir = this._forward(-1)
    this._enter('recoil')
    this._actionSeconds = this.recoilSeconds
    this._oneShot(this.recoilTrigger)
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
      if (!this._sprintedThisHold && !this.inWater) this._buffer('roll')
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
    super.onTriggerEnter(other)   // water zones (SoulsCharacter)
    if (other && (other as any).interact && !this._nearby.includes(other)) this._nearby.push(other)
    ;(this._gm as any)?.onPlayerEnteredZone?.(other)
  }

  onTriggerExit(other: Node) {
    super.onTriggerExit(other)
    this._nearby = this._nearby.filter(n => n !== other)
    ;(this._gm as any)?.onPlayerLeftZone?.(other)
  }

  /** Wading: no rolling and no sprinting in water — say so once, on the way in. */
  protected onEnterWater(): void {
    if (this._bufferAction === 'roll') this._bufferAction = ''
    this.isSprinting = false
    ;(this._gm as any)?.notice?.(this.waterNotice)
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
    // Leaving a running turn early (a hit, a roll): past halfway the body is drawn facing the new way already.
    if (this.actionState === 'runTurn' && state !== 'runTurn') this._finishRunTurn(this._stateTime >= this._runTurnLength / 2)
    if (state !== 'attack') closeSwing(this._swing)
    this.actionState = state
    this._stateTime = 0
    if (state === 'free') {
      this._move = null
      this._moveInfo = null
      this._clip = ''
    }
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
