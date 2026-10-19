import { CameraRigNode, Input, Node } from 'cleo'
import { angleDiff, planarDistance, yawTo } from '@/Core/Scripts/SoulsMath'
import { playSound } from '@/Core/Scripts/SoulsAudio'

/**
 * Hollow Keep — the third-person camera with target lock. Attach to the Player's `camera rig`, a Camera
 * Rig node that sits BEFORE the Player Controller among the Player's children.
 *
 * Free: an ordinary orbit camera the controller steers with Look.
 *
 * Locked: the rig switches to `aimMode = 'lookAt'` on the target's `LockPoint`, so the camera holds the
 * enemy in frame by itself. The controller keeps writing the rig's yaw into the intent as the aim, which
 * is what makes the player STRAFE around the target — SoulsPlayer sets `facingMode = 'aim'` while locked.
 *
 *   LockOn                   toggle. With nothing to lock, it re-centres the camera behind the player.
 *   SwitchTargetLeft/Right   cycle (keys); a hard flick of the right stick or the mouse does the same
 *
 * Candidates are the manager's live enemies within `lockRange` and in line of sight, ranked by angle off
 * the camera's forward and then by distance (rankLockTargets, below). The lock breaks past
 * `breakRange`, after `losBreakSeconds` behind a wall, or when the target dies — in which case another
 * enemy within `retargetRange` is picked up, as the games do.
 *
 * The reticle is a world-space UI Root named `LockReticle`, a child of the player beside this rig. Its
 * `uiTargetId` is kept pointed at the
 * target's lock point.
 */
export default class SoulsLockOnNode extends CameraRigNode {
  public lockRange: number = 20
  public breakRange: number = 26
  /** Seconds the target may stay hidden behind geometry before the lock lets go. */
  public losBreakSeconds: number = 1.5
  /** Seconds between two target switches, so one flick switches once. */
  public switchCooldown: number = 0.35
  /** Right-stick deflection (scaled ×4 in the map) that counts as a flick. */
  public stickFlick: number = 2.6
  /**
   * Mouse speed, in pixels per SECOND, that counts as a flick. A per-frame pixel threshold made switching
   * targets harder the higher the frame rate, since the same flick is spread over more frames.
   */
  public mouseFlickPerSecond: number = 2700
  /** Pitch limits while locked (positive looks down). Keeps a tall boss from flipping the camera. */
  public lockedPitchMin: number = -25
  public lockedPitchMax: number = 35
  public reticleName: string = 'LockReticle'
  /** When the target dies, the lock jumps to another enemy only if one is this close. */
  public retargetRange: number = 10

  /** The locked enemy (a SoulsEnemy root), or null. SoulsPlayer reads this. */
  public lockTarget: Node = null

  private _gm: Node = null
  private _player: Node = null
  private _reticle: Node = null
  private _hiddenFor: number = 0
  private _switchWait: number = 0
  private _freePitchMin: number = -80
  private _freePitchMax: number = 80

  onStart() {
    this._gm = this.findNode('GameManager')
    this._player = this.parent
    // The reticle is the player's (a sibling of this rig, inside the Player template).
    this._reticle = this._player?.getChildByName(this.reticleName)[0] ?? null
    this._freePitchMin = this.pitchMin
    this._freePitchMax = this.pitchMax
    this.aimMode = 'orbit'
    this._showReticle(null)
    // Start behind the player, whichever way the level placed them: the orbit's yaw is a world angle
    // and does not follow the player's own rotation.
    if (this._player) {
      const f = this._player.worldForward
      this.yaw = Math.atan2(f[0], f[2]) * 180 / Math.PI
    }
  }

  onUpdate(delta: number) {
    this._switchWait = Math.max(0, this._switchWait - delta)
    const player = this._player as any
    if (player?.isDead) { if (this.lockTarget) this.unlock(); return }

    if (Input.started('LockOn')) {
      if (this.lockTarget) this.unlock()
      else if (!this._lockBest()) this._recenter()
    }
    if (!this.lockTarget) return

    // Lost?
    const target = this.lockTarget as any
    if (!target || target.isDead || target.spawned === false || !this.scene?.getNodeById(this.lockTarget.id)) {
      this.onTargetDied(this.lockTarget)
      return
    }
    const me = this._player.worldPosition
    const at = this.lockTarget.worldPosition
    if (Math.hypot(at[0] - me[0], at[2] - me[2]) > this.breakRange) { this.unlock(); return }
    this._hiddenFor = this._hasLineOfSight(this.lockTarget) ? 0 : this._hiddenFor + delta
    if (this._hiddenFor > this.losBreakSeconds) { this.unlock(); return }

    // Switching.
    let dir = 0
    if (Input.started('SwitchTargetLeft')) dir = 1
    if (Input.started('SwitchTargetRight')) dir = -1
    if (!dir && this._switchWait <= 0) {
      const look = Input.vector('Look')
      const device = Input.device('Look')
      // A stick is a deflection; a mouse delta is distance this frame, so it is turned into a speed.
      const amount = device === 'gamepadAxis' ? Math.abs(look[0]) : Math.abs(look[0]) / Math.max(delta, 1e-3)
      const flick = device === 'gamepadAxis' ? this.stickFlick : this.mouseFlickPerSecond
      // Look X is positive to the RIGHT; right means a clockwise (negative) yaw step.
      if (amount >= flick) dir = look[0] > 0 ? -1 : 1
    }
    if (dir) this._switch(dir)
  }

  /** Drop the lock and hand the camera back to the player. */
  public unlock(): void {
    this.lockTarget = null
    this.aimMode = 'orbit'
    this.lookAtId = null
    this.pitchMin = this._freePitchMin
    this.pitchMax = this._freePitchMax
    this._hiddenFor = 0
    this._showReticle(null)
  }

  /** The manager calls this when any enemy dies; only our target matters. */
  public onTargetDied(enemy: Node): void {
    if (!this.lockTarget || enemy !== this.lockTarget) return
    this.unlock()
    const near = this._candidates().find(c => {
      const me = this._player.worldPosition
      return Math.hypot(c.position[0] - me[0], c.position[2] - me[2]) <= this.retargetRange
    })
    if (near) this.lockOnto(near.node)
  }

  /** Lock onto a specific enemy (e.g. the boss when its fight starts). */
  public lockOnto(enemy: Node): void {
    if (!enemy) return
    const point = this._lockPoint(enemy)
    this.lockTarget = enemy
    this.aimMode = 'lookAt'
    this.lookAtId = point.id
    this.lookAtOffset = [0, 0, 0]
    this.pitchMin = this.lockedPitchMin
    this.pitchMax = this.lockedPitchMax
    this._hiddenFor = 0
    this._showReticle(point)
  }

  private _lockBest(): boolean {
    const best = this._candidates()[0]
    if (!best) return false
    this.lockOnto(best.node)
    playSound(this, 'Lock On')
    return true
  }

  /** Step to the next candidate clockwise (dir -1) or counter-clockwise (dir +1) of the current one. */
  private _switch(dir: number): void {
    this._switchWait = this.switchCooldown
    const current = this.lockTarget
    const me = this._player.worldPosition
    const base = yawTo(me, current.worldPosition)
    let best: Node = null
    let bestStep = Infinity
    for (const c of this._candidates()) {
      if (c.node === current) continue
      // How far round in the requested direction this candidate is, 0..360.
      let step = (yawTo(me, c.position) - base) * dir
      step = ((step % 360) + 360) % 360
      if (step > 0 && step < bestStep) { bestStep = step; best = c.node }
    }
    if (best) this.lockOnto(best)
  }

  private _candidates(): { node: Node, position: ArrayLike<number> }[] {
    const gm = this._gm as any
    if (!gm?.liveEnemies || !this._player) return []
    const list = gm.liveEnemies()
      .filter((e: Node) => this._hasLineOfSight(e))
      .map((e: Node) => ({ node: e, position: e.worldPosition }))
    return this.rankLockTargets(this._player.worldPosition, this.yaw, list, this.lockRange)
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

  /** Line of sight from the camera pivot to the enemy's lock point, ignoring characters. */
  private _hasLineOfSight(enemy: Node): boolean {
    const physics = this.scene?.physics as any
    if (!physics?.raycast) return true
    const from = this.worldPosition
    const to = this._lockPoint(enemy).worldPosition
    const hit = physics.raycast([from[0], from[1], from[2]], [to[0], to[1], to[2]], {
      reject: (owner: Node) => !!owner && (owner.nodeType === 'character'
        || !!owner.getVariable?.('isEnemy') || !!owner.getVariable?.('isPlayer')),
    })
    return !hit
  }

  private _lockPoint(enemy: Node): Node {
    const e = enemy as any
    return (e.lockPoint ? e.lockPoint() : null) ?? enemy.getChildByName('LockPoint')[0] ?? enemy
  }

  /** Swing the camera behind the player — what pressing lock with nothing in range does. */
  private _recenter(): void {
    if (!this._player) return
    const f = this._player.worldForward
    this.setOrbit(Math.atan2(f[0], f[2]) * 180 / Math.PI, 12)
  }

  private _showReticle(point: Node): void {
    const reticle = this._reticle as any
    if (!reticle) return
    reticle.uiTargetId = point ? point.id : null
    if (reticle.visible !== !!point) reticle.visible = !!point
  }
}
