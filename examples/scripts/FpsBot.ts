import { Logger, ModelNode, Node, setMoveWorld } from 'cleo'
import type { Animator } from 'cleo'
import FpsCombatantNode from './FpsCombatant'
import { angleDiff, clamp, combatantOf, distance3, findByVariable, findDescendant, hostile, manager, planarDistance, playCue, yawTo } from './FpsShared'

/** The death clips, in the order the animator's `Die0..Die5` triggers play them. */
const DEATHS = ['DeathFromTheFront', 'DeathFromFrontHeadshot', 'DeathFromTheBack', 'DeathFromBackHeadshot', 'DeathFromRight', 'DeathCrouchingHeadshotFront']

type BotState = 'patrol' | 'search' | 'engage' | 'cover' | 'retreat' | 'dead'

/**
 * FPS example — a computer fighter. The enemy template's root script (the Character node): it senses,
 * decides and shoots, and the AI controller under it (Brain, source AI) only walks where it is told.
 *
 * ## What it does
 *
 *   patrol    wanders between spots near where it started, at a walk
 *   search    goes to where it last saw a target, or heard a shot, or was called to; looks round; gives up
 *   engage    a target in sight: holds a firing distance, strafes, crouches at range, shoots in bursts
 *   cover     hurt or under fire: runs to a spot the target cannot see (FpsGameManager.bestCover), crouches
 *             there and pops up to shoot
 *   retreat   badly hurt (below `retreatAt` of its health): runs for cover, calls its team for reinforcements,
 *             reloads and waits out of sight, then recovers a little and comes back
 *   dead      plays a random death clip (matched to where the shot came from), then goes ragdoll
 *
 * The Brain's behaviour graph only reads `navMode` (0 stand, 1 walk the nav mesh to `goalPoint`, 2 this script
 * moves the body) and does the pathing; everything else is here. Targets are the sightings the controller
 * reports, filtered on {@link hostile}: perception offers every character, and teams are this example's.
 *
 * Tunables are fields on the template, so a scene can make one bot lazier or deadlier by overriding them
 * on its instance.
 */
export default class FpsBotNode extends FpsCombatantNode {
  public displayName: string = 'Bot'
  /** 0..1: aim, reaction and how long it keeps its head up. */
  public skill: number = 0.55
  /** Sees this far, and across this cone (the full angle). */
  public sightRange: number = 55
  public sightAngle: number = 140
  /** Seconds between noticing a target and opening fire (the worse the skill, the longer). */
  public reactionSeconds: number = 0.45
  /** Walk and run speeds, metres a second. */
  public patrolSpeedScale: number = 0.42
  /** Below this share of health: seek cover. Below `retreatAt`: run for it and call for help. */
  public coverAt: number = 0.62
  public retreatAt: number = 0.3
  /** Health regained a second while out of combat. */
  public regenPerSecond: number = 3
  /** Probability of crouching while standing and shooting at long range. */
  public crouchChance: number = 0.45
  /** Seconds it waits behind cover before it looks. */
  public coverSeconds: number = 3.5
  /** Seconds the clip plays before the body goes ragdoll (0: the clip's length times `ragdollAt`). */
  public ragdollAt: number = 0.62
  public corpseSeconds: number = 8
  /** Damage multiplier for a bot's bullets against everyone. */
  public damageScale: number = 0.55
  /** Rounds a second as a share of the weapon's rate. */
  public fireRateScale: number = 0.7

  // ----- published for the Brain graph and the HUD -----------------------------------------------------
  public navMode: number = 0
  public state: BotState = 'patrol'
  public goalPoint: number[] = [0, 0, 0]
  /** Mirrors of the controller's blackboard, for the graph. */
  public hasThreat: boolean = false

  private _brain: any = null
  private _model: ModelNode | null = null
  private _animator: Animator | null = null
  private _weapons: Node[] = []
  private _muzzle: Node | null = null
  private _home: number[] = [0, 0, 0]

  private _target: any = null
  private _seenAt: number = -999
  private _noticedAt: number = -999
  private _lastKnown: number[] | null = null
  private _sees: boolean = false
  private _alert: number[] | null = null
  private _alertUntil: number = 0

  private _stateTime: number = 0
  private _wait: number = 0
  private _burst: number = 0
  private _nextShot: number = 0
  private _strafe: number = 1
  private _strafeUntil: number = 0
  private _crouching: boolean = false
  private _crouchUntil: number = 0
  private _reloading: number = 0
  private _coverPoint: number[] | null = null
  private _inCover: boolean = false
  private _calledAt: number = -999
  private _hurtAt: number = -999
  private _patrolWait: number = 0
  private _losTimer: number = 0
  private _pathTimer: number = 0
  private _sinceCombat: number = 99
  private _ammoClip: number = 0

  // =================================================================================================
  // Lifecycle
  // =================================================================================================

  onStart() {
    super.onStart()
    this.setVariable('isBot', true, 'boolean', 'public')
    this.facingMode = 'aim'
    this.acceleration = 14
    this._home = Array.from(this.worldPosition as ArrayLike<number>)
    this._model = this._findModel()
    this._animator = this._model?.animator ?? null
    this._brain = this._findBrain()
    if (this._brain) {
      this._brain.autoAcquire = false
      this._brain.perception = { ...this._brain.perception, range: this.sightRange, fieldOfView: this.sightAngle, memorySpan: 8, reactionTime: 0.2 }
    }
    this._equip()
    this.state = 'patrol'
    this._pickPatrol()
    // Skill reads as a spread of the bot's own reaction time, so a scene's bots are not clones.
    this.reactionSeconds *= 1.35 - this.skill * 0.7
  }

  onDespawn() {
    super.onDespawn()
  }

  private _findModel(): ModelNode | null {
    let found: ModelNode | null = null
    const visit = (n: Node) => {
      for (const c of n.children) {
        if (!found && c instanceof ModelNode && (c as any).animator) { found = c; return }
        if (!found) visit(c)
      }
    }
    visit(this)
    return found
  }

  private _findBrain(): any {
    for (const c of this.children) if ((c as any).nodeType === 'controller') return c
    return null
  }

  /** Show the weapon named by `weapon`, hide the others; the muzzle is the shown one's `Muzzle`. */
  private _equip(): void {
    const group = this.getChildByName('Weapons')[0]
    this._weapons = group ? findByVariable(group, 'fpsWeapon') : []
    this._muzzle = null
    for (const w of this._weapons) {
      const on = w.getVariable('fpsWeapon') === this.weapon
      w.visible = on
      if (on) this._muzzle = findDescendant(w, 'Muzzle')
    }
  }

  protected muzzleWorld(origin: number[]): number[] {
    const m = this._muzzle as any
    if (m?.worldPosition) { const p = m.worldPosition; return [p[0], p[1], p[2]] }
    return origin
  }

  // =================================================================================================
  // The frame
  // =================================================================================================

  onUpdate(delta: number) {
    this._time += delta
    this._stateTime += delta
    if (this.isDead) { this._deadFrame(); return }
    const gm = manager()
    const intent = this.drive()
    intent.sprint = false
    if (gm?.matchOver) { this._stand(intent); return }

    this._perceive(delta)
    this._think(delta)
    this._act(intent, delta)
    // The controller's pathing has written this frame's move; the speed it walks at is this script's call.
    if (this.navMode === 1) { intent.speedScale = this._speedScale; intent.sprint = this._sprint }

    if (this._sinceCombat > 6 && this.hp < this.maxHp) this.hp = Math.min(this.maxHp, this.hp + this.regenPerSecond * delta)
    this._animator?.setBool('Crouch', this.isCrouching)
  }

  /** Stand still, facing as before. */
  private _stand(intent: any): void {
    intent.move[0] = 0
    intent.move[1] = 0
    this.navMode = 0
  }

  // ----- sense -------------------------------------------------------------------------------------

  private _perceive(delta: number): void {
    this._losTimer -= delta
    const self = this.worldPosition
    let best: any = null
    let bestD = Infinity
    let visible = false
    const brain = this._brain
    if (brain) {
      for (const s of brain.sightings ?? []) {
        const other: any = this.scene?.getNodeById(s.id)
        if (!other || !other.getVariable?.('fpsCombatant') || other.isDead || !hostile(this, other)) continue
        const keep = other === this._target && s.timeSinceSeen <= brain.perception.memorySpan
        if (!s.noticed && !keep) continue
        const d = distance3(self, other.worldPosition)
        if (s.visible && s.noticed) {
          if (d < bestD) { best = other; bestD = d; visible = true }
        } else if (keep && !best) { best = other; bestD = d }
      }
    }
    const hadTarget = !!this._target
    if (best) {
      this._target = best
      if (visible) {
        if (!this._sees) this._noticedAt = this._time
        this._seenAt = this._time
        const p = best.worldPosition
        this._lastKnown = [p[0], p[1], p[2]]
      }
    } else if (this._target && (this._target.isDead || this._time - this._seenAt > 8)) {
      this._target = null
    }
    this._sees = visible
    if (visible) this._sinceCombat = 0
    else this._sinceCombat += delta
    if (hadTarget && !this._target && this._lastKnown) { this._alert = this._lastKnown; this._alertUntil = this._time + 12 }
    this.hasThreat = !!this._target
  }

  /** A shot was heard at `at`: look there unless already in a fight. */
  public hear(at: ArrayLike<number>, source: any): void {
    if (this.isDead || this._sees || this.state === 'engage' || this.state === 'cover' || this.state === 'retreat') return
    this._alert = [at[0], at[1], at[2]]
    this._alertUntil = this._time + 10
    if (this.state === 'patrol') this._enter('search')
  }

  /** A teammate called for help: come to `at` unless busy. Returns whether it is coming. */
  public respondTo(at: ArrayLike<number>, caller: any): boolean {
    if (this.isDead || this._sees || this.state === 'retreat') return false
    this._alert = [at[0], at[1], at[2]]
    this._alertUntil = this._time + 14
    this._enter('search')
    return true
  }

  // ----- think -------------------------------------------------------------------------------------

  private _enter(state: BotState): void {
    if (this.state === state) return
    this.state = state
    this._stateTime = 0
    this._inCover = false
    this._burst = 0
    if (state !== 'cover' && state !== 'retreat') this._coverPoint = null
    if (state === 'patrol') this._pickPatrol()
    if (state === 'engage') this._strafeUntil = 0
  }

  private _think(delta: number): void {
    const frac = this.hp / this.maxHp
    const recentlyHurt = this._time - this._hurtAt < 1.6
    const threat = this._target && (this._sees || this._time - this._seenAt < 3)
    if (this.state === 'retreat') {
      // Hold out of sight; recover, then come back. Cornered (the enemy close and shooting) it fights.
      if (!threat && this._stateTime > 6 && frac > this.retreatAt + 0.18) this._enter(frac < this.coverAt ? 'cover' : 'patrol')
      else if (threat && this._sees && distance3(this.worldPosition, this._target.worldPosition) < 7 && this._inCover) this._enter('engage')
      return
    }
    if (threat) {
      if (frac < this.retreatAt) { this._beginRetreat(); return }
      if ((frac < this.coverAt || (recentlyHurt && this.skill > 0.35)) && this.state !== 'cover') {
        if (this._time - this._calledAt > 18 && frac < this.coverAt) this._callForHelp()
        if (this._findCover()) { this._enter('cover'); return }
      }
      if (this.state === 'cover') {
        if (this._stateTime > this.coverSeconds * 2.5 && frac >= this.coverAt) this._enter('engage')
        return
      }
      this._enter('engage')
      return
    }
    // No threat.
    if (this.state === 'engage' || this.state === 'cover') {
      this._alert = this._lastKnown
      this._alertUntil = this._time + 12
      this._enter(this._alert ? 'search' : 'patrol')
    } else if (this.state === 'search' && this._time > this._alertUntil) this._enter('patrol')
  }

  private _beginRetreat(): void {
    if (this._time - this._calledAt > 18) this._callForHelp()
    this._enter('retreat')
    this._findCover(true)
  }

  private _callForHelp(): void {
    this._calledAt = this._time
    const at = this.worldPosition
    manager()?.callReinforcements?.(this.team, [at[0], at[1], at[2]], this)
  }

  private _findCover(far: boolean = false): boolean {
    const gm = manager()
    const from = this.worldPosition
    const threatAt = this._lastKnown ?? (this._target?.worldPosition as number[] | undefined)
    if (!gm || !threatAt) return false
    const cover = gm.bestCover([from[0], from[1], from[2]], threatAt, far ? 40 : 24)
    if (!cover) return false
    this._coverPoint = cover
    this._inCover = false
    return true
  }

  // ----- act ---------------------------------------------------------------------------------------

  private _act(intent: any, delta: number): void {
    switch (this.state) {
      case 'patrol': this._patrol(intent, delta); break
      case 'search': this._search(intent, delta); break
      case 'engage': this._engage(intent, delta); break
      case 'cover': this._cover(intent, delta, false); break
      case 'retreat': this._cover(intent, delta, true); break
    }
    // A reload takes the bot's hands and, in the open, ducks it.
    if (this._reloading > 0) {
      this._reloading -= delta
      if (this._reloading <= 0) {
        const spec = this.spec
        const take = Math.min(spec.mag - this.ammo, this.reserve)
        this.ammo += take
        this.reserve = Math.max(spec.mag, this.reserve - take)
      }
    }
    this.isCrouching = this._crouching || this._reloading > 0 && this.state !== 'engage'
  }

  private _go(point: number[], speed: number, sprint: boolean = false): void {
    this.goalPoint = point
    this.navMode = 1
    this._speedScale = speed
    this._sprint = sprint
    if (this._brain) this._brain.goalPoint = [point[0], point[1], point[2]]
  }

  private _speedScale: number = 1
  private _sprint: boolean = false

  private _patrol(intent: any, delta: number): void {
    this.facingMode = 'velocity'
    this._crouching = false
    const p = this.worldPosition
    if (this._patrolWait > 0) {
      this._patrolWait -= delta
      this._stand(intent)
      return
    }
    if (planarDistance(p, this.goalPoint) < 1.6 || this._stateTime > 25) {
      this._patrolWait = 1 + Math.random() * 3
      this._pickPatrol()
      this._stand(intent)
      return
    }
    this._go(this.goalPoint, this.patrolSpeedScale)
  }

  private _pickPatrol(): void {
    const ai = (this.scene as any)?.ai
    const mesh = ai?.navMeshFor?.(null)?.mesh
    const home = this._home
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2, r = 6 + Math.random() * 16
      let pt = [home[0] + Math.sin(a) * r, home[1], home[2] + Math.cos(a) * r]
      if (mesh?.randomPoint) {
        const out = [0, 0, 0]
        mesh.randomPoint(out)
        if (planarDistance(out, home) < 40) pt = [out[0], out[1], out[2]]
      }
      this.goalPoint = pt
      return
    }
  }

  private _search(intent: any, delta: number): void {
    this._crouching = false
    const target = this._alert
    if (!target) { this._enter('patrol'); return }
    const p = this.worldPosition
    if (planarDistance(p, target) > 2.2 && this._stateTime < 20) {
      this.facingMode = 'velocity'
      this._go(target, 0.9, planarDistance(p, target) > 18)
      return
    }
    // Arrived: look round, slowly, then give up.
    this.navMode = 0
    this.facingMode = 'aim'
    intent.move[0] = 0; intent.move[1] = 0
    this._turn(intent, this._baseYaw() + Math.sin(this._stateTime * 1.1) * 110, 180 * delta)
    if (this._stateTime > 5.5 && this._time > this._alertUntil - 8) this._enter('patrol')
  }

  private _baseYaw(): number {
    if (this._alert) return yawTo(this.worldPosition, this._alert)
    return this._yawNow()
  }

  private _yawNow(): number {
    const f = this.worldForward
    return Math.atan2(f[0], f[2]) * 180 / Math.PI
  }

  /** Turn toward `yaw` at most `maxStep` degrees this frame, through the intent. */
  private _turn(intent: any, yaw: number, maxStep: number): void {
    const have = this._yawNow()
    const diff = angleDiff(yaw, have)
    intent.aimYaw = have + clamp(diff, -maxStep, maxStep)
    this.facingMode = 'aim'
  }

  // ----- engage ------------------------------------------------------------------------------------

  private _engage(intent: any, delta: number): void {
    const target = this._target
    if (!target) return
    const me = this.worldPosition
    const at = this._sees ? target.worldPosition : (this._lastKnown ?? target.worldPosition)
    const dist = planarDistance(me, at)
    const spec = this.spec
    const yawToTarget = yawTo(me, at)
    const desired = clamp(spec.botRange * 0.45, 7, 22)

    // Out of sight but remembered: go and look rather than stand shooting at a wall.
    if (!this._sees && this._time - this._seenAt > 1.2) {
      this.facingMode = 'velocity'
      this._go([at[0], at[1], at[2]], 1, true)
      return
    }

    this._turn(intent, yawToTarget, 540 * delta * (0.5 + this.skill))
    if (dist > spec.botRange * 0.9) {
      // Too far to shoot: close the distance on the nav mesh at a run.
      this._crouching = false
      this._go([at[0], at[1], at[2]], 1)
      this.facingMode = 'velocity'
      return
    }

    // In range: hold a distance and strafe, standing or crouching; the controller does not move the body.
    this.navMode = 2
    this._strafeUntil -= delta
    if (this._strafeUntil <= 0) {
      this._strafeUntil = 1 + Math.random() * 2.2
      this._strafe = Math.random() < 0.5 ? -1 : 1
      // A crouch spell at long range makes a smaller target; at close range it keeps moving.
      this._crouching = dist > 13 && Math.random() < this.crouchChance
      if (this._crouching) this._strafeUntil += 1.2
    }
    const toward = [Math.sin(yawToTarget * Math.PI / 180), Math.cos(yawToTarget * Math.PI / 180)]
    let mx = 0, mz = 0, scale = 0
    if (!this._crouching) {
      if (dist < desired - 3) { mx = -toward[0]; mz = -toward[1]; scale = 0.7 }
      else if (dist > desired + 4) { mx = toward[0]; mz = toward[1]; scale = 0.8 }
      else { mx = toward[1] * this._strafe; mz = -toward[0] * this._strafe; scale = 0.75 }
    }
    if (scale > 0) { setMoveWorld(intent, mx, mz); intent.speedScale = scale } else { intent.move[0] = 0; intent.move[1] = 0 }

    this._shoot(intent, delta, target)
  }

  /** Fire when it faces the target, has seen it long enough and has rounds; reload when dry. */
  private _shoot(intent: any, delta: number, target: any): void {
    if (this._reloading > 0) return
    const spec = this.spec
    if (this.ammo <= 0) { this._startReload(); return }
    if (!this._sees || this._time - this._noticedAt < this.reactionSeconds) return
    const eye = this._eye()
    const aimAt = target.chest
    const dx = aimAt[0] - eye[0], dy = aimAt[1] - eye[1], dz = aimAt[2] - eye[2]
    const len = Math.hypot(dx, dy, dz) || 1
    if (Math.abs(angleDiff(Math.atan2(dx, dz) * 180 / Math.PI, this._yawNow())) > 9) return
    if (this._time < this._nextShot) return
    if (this._burst <= 0) {
      this._burst = Math.round(spec.botBurst[0] + Math.random() * (spec.botBurst[1] - spec.botBurst[0]))
    }
    this._fireOnce(eye, [dx / len, dy / len, dz / len], len)
    this._burst--
    const interval = 60 / (spec.rpm * this.fireRateScale)
    this._nextShot = this._time + interval + (this._burst <= 0 ? (0.5 + Math.random() * 1.2) * (1.4 - this.skill) : 0)
  }

  private _eye(): number[] {
    const p = this.worldPosition
    return [p[0], p[1] + this.eyeOffset, p[2]]
  }

  private _fireOnce(eye: number[], dir: number[], dist: number): void {
    const spec = this.spec
    this.ammo--
    // Worse aim at range and when moving; the skill narrows it. A degree and a half at 20 m at mid skill.
    const cone = (spec.hipSpread * 0.55 + dist * 0.045) * (1.7 - this.skill * 1.3) * (this._crouching ? 0.7 : 1)
    this.fireHitscan(eye, dir, cone, this.damageScale)
    this._muzzleFlash()
    this._animator?.setTrigger?.('Fire')
  }

  private _muzzleFlash(): void {
    const at = this.muzzleWorld(this._eye())
    this.spawnFx('FPS Muzzle Flash', at, [0, this._yawNow(), 0])
    playCue(this, 'Shot')
  }

  private _startReload(): void {
    if (this.reserve <= 0) { this.reserve = this.spec.reserve }
    this._reloading = this.spec.reloadSeconds * (1.2 - this.skill * 0.3)
    this._burst = 0
  }

  // ----- cover / retreat ---------------------------------------------------------------------------

  private _cover(intent: any, delta: number, retreat: boolean): void {
    const cover = this._coverPoint
    const me = this.worldPosition
    if (!cover) {
      // Nowhere to hide. A retreat with no cover runs away from the threat; a cover state just fights.
      if (retreat && this._lastKnown) {
        const away = yawTo(this._lastKnown, me)
        const goal = [me[0] + Math.sin(away * Math.PI / 180) * 18, me[1], me[2] + Math.cos(away * Math.PI / 180) * 18]
        this.facingMode = 'velocity'
        this._crouching = false
        this._go(goal, 1, true)
      } else if (!retreat) this._engage(intent, delta)
      if (this._stateTime > 1.5 && !this._findCover(retreat) && !retreat) this._enter('engage')
      return
    }
    if (!this._inCover) {
      this.facingMode = 'velocity'
      this._crouching = false
      this._go(cover, 1, true)
      if (planarDistance(me, cover) < 1.4) { this._inCover = true; this._stateTime = 0; this._wait = this.coverSeconds * (0.7 + Math.random() * 0.6) }
      else if (this._stateTime > 14) { this._coverPoint = null }
      return
    }
    // In cover: stay low and still, facing where the threat is; reload; look up and shoot in turn.
    this.navMode = 0
    intent.move[0] = 0; intent.move[1] = 0
    const look = this._lastKnown ? yawTo(me, this._lastKnown) : this._yawNow()
    this._turn(intent, look, 360 * delta)
    this._wait -= delta
    if (this.ammo < this.spec.mag * 0.5 && this._reloading <= 0 && this.ammo < this.spec.mag) this._startReload()
    const peek = !retreat && this._wait <= 0 && this._reloading <= 0
    this._crouching = !peek
    if (peek) {
      // Up from behind it: shoot while the threat is in sight, then back down.
      if (this._sees && this._target) this._shoot(intent, delta, this._target)
      if (this._stateTime > this.coverSeconds + 3 + this.skill * 3) { this._stateTime = 0; this._wait = this.coverSeconds * (0.8 + Math.random() * 0.8) }
    }
    if (retreat) this.hp = Math.min(this.maxHp, this.hp + this.regenPerSecond * 0.8 * delta)
  }

  // =================================================================================================
  // Hurt, dead
  // =================================================================================================

  protected onHurt(damage: number, from: Node | null, zone: string): void {
    this._hurtAt = this._time
    this._sinceCombat = 0
    const shooter: any = combatantOf(from)
    if (shooter && hostile(this, shooter)) {
      // Whoever shot it is now where it looks; with no target, it turns and goes to see.
      if (!this._target || !this._sees) {
        this._target = shooter
        this._noticedAt = this._time - this.reactionSeconds * 0.4
        const p = shooter.worldPosition
        this._lastKnown = [p[0], p[1], p[2]]
        this._seenAt = this._time
      }
    }
  }

  protected onDeath(killer: any, zone: string, dir?: ArrayLike<number>): void {
    this.state = 'dead'
    this.navMode = 0
    this.hasThreat = false
    this.facingMode = 'none'
    // Which clip: from where the bullet came, relative to the way the bot faces. Mostly the matching
    // one, sometimes any of them - a random death - and a crouching bot always falls its own way.
    const clip = this._pickDeath(killer, zone, dir)
    const index = DEATHS.indexOf(clip)
    this._animator?.setTrigger?.(`Die${index}`)
    const info = this._animator?.triggerInfo?.(`Die${index}`)
    const seconds = info?.seconds && info.seconds > 0 ? info.seconds : 3
    this.after(seconds * this.ragdollAt, () => this._ragdoll(dir))
    this.after(this.corpseSeconds, () => this.remove({ fade: 1.2 }))
    playCue(this, 'Death')
  }

  private _pickDeath(killer: any, zone: string, dir?: ArrayLike<number>): string {
    if (this.isCrouching) return Math.random() < 0.6 ? 'DeathCrouchingHeadshotFront' : DEATHS[Math.floor(Math.random() * 5)]
    const head = zone === 'head'
    const pool = ['DeathFromTheFront', 'DeathFromTheBack', 'DeathFromRight']
    if (head) pool.push('DeathFromFrontHeadshot', 'DeathFromBackHeadshot')
    let matched: string | null = null
    if (killer) {
      // The bearing of the shooter relative to where this bot faces: 0 ahead, +-180 behind.
      const rel = angleDiff(yawTo(this.worldPosition, killer.worldPosition), this._yawNow())
      if (Math.abs(rel) < 55) matched = head ? 'DeathFromFrontHeadshot' : 'DeathFromTheFront'
      else if (Math.abs(rel) > 125) matched = head ? 'DeathFromBackHeadshot' : 'DeathFromTheBack'
      else matched = 'DeathFromRight'
    }
    return matched && Math.random() < 0.55 ? matched : pool[Math.floor(Math.random() * pool.length)]
  }

  private _ragdoll(dir?: ArrayLike<number>): void {
    const physics = this.scene?.physics as any
    if (!physics?.startRagdoll || !this._model) return
    try {
      const push = dir ? [dir[0] * 2.2, 0.6, dir[2] * 2.2] : [0, 0, 0]
      physics.startRagdoll(this._model, { impulse: push })
    } catch (e) {
      Logger.warn('FPS: ragdoll failed on ' + this.name + ': ' + e, 'Script')
    }
  }

  private _deadFrame(): void {
    this.navMode = 0
    const intent = this.drive()
    intent.move[0] = 0
    intent.move[1] = 0
  }

  /** A fresh life (the manager moves the body): stand up, forget the fight. */
  public resetForRespawn(): void {
    super.resetForRespawn()
    this.state = 'patrol'
    this._target = null
    this._lastKnown = null
    this._alert = null
    this._enter('patrol')
  }
}
