import { AnimatedSpriteNode, CharacterBody2DNode, Game, Input, Node } from 'cleo'

/**
 * Duskwell -- the player: the warrior of the Medieval Warrior pack. Attach to the `Player` Character Body 2D;
 * its children are `Sprite` (the animation set, whose state machine plays idle / run / jump / fall on its
 * own), `Sword` (the Area 2D the attack frames switch on) and, last, the `Player Controller` that reads Move
 * and Jump into the body's intent -- so the engine runs and jumps it, as a 3D Character's controller does.
 *
 * Everything that makes it THIS game's warrior is here, the way the 3D examples add a roll or a sprint over
 * the engine's walking:
 *   * the moves a metroidvania hands out -- a double jump, a dash, a wall slide and wall jump -- each off
 *     until its pickup (`hasDoubleJump`, `hasDash`, `hasWallJump`), and a jump cut (let go early for a hop).
 *     They run in `onMove2D`, every physics substep, so a dash covers the same distance at any frame rate.
 *   * a three-hit combo on Attack -- press again during a swing, or just after it, for the next.
 *   * health, a hurt knock-back with a moment of invulnerability, death, and a respawn at the last lamp.
 * Pickups call `collect(kind)`; checkpoints call `setRespawn(x, y)`.
 *
 * Anything that hurts on touch has an Area 2D that sees the player's layer, under a node with a
 * `contactDamage` field (a bat's `Bite`, a guard's `Blade`). Falling below `killY` costs the whole health.
 */
export default class DuskPlayer extends CharacterBody2DNode {
  public maxHealth: number = 5
  public health: number = 5
  public diamonds: number = 0
  /** Seconds of invulnerability after a hit, the sprite flickering. */
  public invulnerableSeconds: number = 1.1
  /** Seconds the controls are taken away by a hit. */
  public hurtSeconds: number = 0.3
  /** The knock-back of a hit: away, and up. */
  public knockback: number = 9
  public knockup: number = 7
  /** Running speed while a swing is on: a swing commits. */
  public attackRunSpeed: number = 1.5
  /** Seconds after a swing ends in which a press still chains the next one. */
  public comboWindow: number = 0.35
  public attackAction: string = 'Attack'
  public jumpAction: string = 'Jump'
  public dashAction: string = 'Dash'
  /** Below this the player has fallen out of the world (the map's bottom edge is y = 0). */
  public killY: number = -4
  /** Seconds the death plays before the respawn. */
  public deathSeconds: number = 1.8

  // --- the moves, found over the game ------------------------------------------------------------------
  public hasDoubleJump: boolean = false
  public hasDash: boolean = false
  public hasWallJump: boolean = false
  /** Jumps in the air before landing again, with the double jump, and their height as a share of a jump's. */
  public airJumps: number = 1
  public airJumpHeight: number = 0.85
  /** Letting go of jump while still rising keeps this share of the speed: a tap is a hop. */
  public jumpCut: number = 0.45
  /** The dash: speed, seconds, seconds before the next, and dashes in the air before landing. */
  public dashSpeed: number = 22
  public dashTime: number = 0.2
  public dashCooldown: number = 0.35
  public airDashes: number = 1
  /** The fastest slide down a wall pressed into; a wall jump's push away and up; seconds the push holds. */
  public wallSlideSpeed: number = 3
  public wallJumpX: number = 9
  public wallJumpY: number = 12
  public wallJumpLock: number = 0.16

  private _sprite: AnimatedSpriteNode = null
  private _baseWalk: number = 8
  private _baseMaxFall: number = 24
  /** The swing of the combo on now or last (1..3), 0 when the combo is over. */
  private _combo: number = 0
  private _swinging: boolean = false
  private _queued: boolean = false
  private _graceLeft: number = 0
  private _hurtLeft: number = 0
  private _invulnLeft: number = 0
  private _dead: boolean = false
  private _deathLeft: number = 0
  private _respawn: [number, number] = [0, 0]
  private _touching: Node[] = []
  private _notice: string = ''
  private _noticeAge: number = 99
  // The moves' memory, kept per substep in onMove2D.
  private _jumpHeld: boolean = false
  private _dashPress: number = 0
  private _airJumpsLeft: number = 0
  private _airDashesLeft: number = 0
  private _dashLeft: number = 0
  private _dashDir: number = 1
  private _dashCooldownLeft: number = 0
  private _wallLockLeft: number = 0
  private _wallLockDir: number = 0
  private _rising: boolean = false
  private _engineJumpSeen: boolean = false
  private _wallSliding: boolean = false

  onStart() {
    this._sprite = this.getChildByName('Sprite')[0] as AnimatedSpriteNode
    this._baseWalk = this.walkSpeed
    this._baseMaxFall = this.maxFallSpeed
    this._respawn = [this.position[0], this.position[1]]
    this.health = this.maxHealth
  }

  /** The one-line message the HUD shows (a pickup, a checkpoint), and how long ago it came. */
  public get notice(): string { return this._noticeAge < 3 ? this._notice : '' }
  public get isDead(): boolean { return this._dead }
  public get isDashing(): boolean { return this._dashLeft > 0 }
  public get isWallSliding(): boolean { return this._wallSliding }

  public say(text: string) { this._notice = text; this._noticeAge = 0 }

  /**
   * Once a frame, after the Player Controller wrote this frame's intent and before the 2D physics moves the
   * body: read this game's own buttons, and take the controls away while hurt or dead.
   */
  onUpdate(delta: number) {
    this._noticeAge += delta
    this._jumpHeld = Input.pressed(this.jumpAction)
    if (Input.started(this.dashAction)) this._dashPress = 0.12
    if (this._dead) {
      this._deathLeft -= delta
      this._lockControls()
      if (this._deathLeft <= 0) this.respawn()
      return
    }
    this._invulnLeft = Math.max(0, this._invulnLeft - delta)
    if (this._hurtLeft > 0) {
      this._hurtLeft -= delta
      this._lockControls()
    }
    if (this._sprite) this._sprite.opacity = this._invulnLeft > 0 && Math.floor(this._invulnLeft * 16) % 2 === 0 ? 0.35 : 1

    if (this._graceLeft > 0) {
      this._graceLeft -= delta
      if (this._graceLeft <= 0) this._combo = 0
    }
    if (Input.started(this.attackAction) && this._hurtLeft <= 0) this._attack()
    this.walkSpeed = this._swinging && this.isGrounded ? this.attackRunSpeed : this._baseWalk

    // Whatever hurts on touch, while it still touches (a hit does nothing while invulnerable).
    for (const n of this._touching) {
      const owner = (n.parent as any) ?? null
      const damage = (owner?.contactDamage ?? (n as any).contactDamage ?? 0) as number
      if (damage > 0 && !owner?.isDead) this.takeHit(damage, n)
    }
    if (this.position[1] < this.killY) this.takeHit(this.maxHealth, null)
  }

  /** No steering and no jumps: the knock-back or the fall plays out. */
  private _lockControls() {
    const intent = this.drive()
    intent.move[0] = 0
    intent.move[1] = 0
    intent.requests.jump = 0
    this._dashPress = 0
  }

  /**
   * Every physics substep, before the engine steers: this game's moves. Returning true owns the substep --
   * the engine's running and jumping skip it -- which is what a dash, a knock-back and a death do.
   */
  onMove2D(dt: number, _substep: number): boolean {
    const v = this.velocity2D
    const grounded = this.isGrounded
    // Landing refills what the air spends.
    if (grounded) {
      this._airJumpsLeft = this.hasDoubleJump ? Math.max(0, Math.floor(this.airJumps)) : 0
      this._airDashesLeft = Math.max(0, Math.floor(this.airDashes))
      this._rising = false
    }
    this._dashCooldownLeft = Math.max(0, this._dashCooldownLeft - dt)
    this._wallLockLeft = Math.max(0, this._wallLockLeft - dt)
    this._dashPress = Math.max(0, this._dashPress - dt)

    // Hurt or dead: the knock-back's arc, slowed along the ground.
    if (this._dead || this._hurtLeft > 0) {
      if (grounded) v[0] = this._toward(v[0], 0, this.deceleration * dt)
      return true
    }

    const steer = this.intent.move[0]
    // --- the dash: a straight burst that holds its height and ends early on a wall ------------------------
    if (this._dashPress > 0 && this.hasDash && this._dashLeft <= 0 && this._dashCooldownLeft <= 0
        && (grounded || this._airDashesLeft > 0)) {
      if (!grounded) this._airDashesLeft--
      this._dashPress = 0
      this._dashLeft = this.dashTime
      this._dashDir = steer > 0.2 ? 1 : steer < -0.2 ? -1 : this.facing
      this.facing = this._dashDir
      this._dashCooldownLeft = this.dashCooldown
      this._rising = false
      this.gravityScale = 0
      this._sprite?.fireTrigger('dashed')
    }
    if (this._dashLeft > 0) {
      this._dashLeft = Math.max(0, this._dashLeft - dt)
      if (this._dashDir > 0 ? this.contacts.wallRight : this.contacts.wallLeft) this._dashLeft = 0
      v[0] = this._dashLeft > 0 ? this._dashDir * this.dashSpeed : this._dashDir * this._baseWalk
      v[1] = 0
      if (this._dashLeft <= 0) this.gravityScale = 1
      this._sprite?.setParam('dashing', this._dashLeft > 0)
      return true
    }

    // Just after a wall jump, steering back into that wall is ignored: the push away has to land first.
    if (this._wallLockLeft > 0 && Math.sign(steer) === this._wallLockDir) this.drive().move[0] = 0

    // --- the wall slide: pressing into a wall while falling ------------------------------------------
    const pressing = (steer > 0.2 && this.contacts.wallRight) || (steer < -0.2 && this.contacts.wallLeft)
    this._wallSliding = this.hasWallJump && !grounded && pressing && v[1] <= 0
    this.maxFallSpeed = this._wallSliding ? this.wallSlideSpeed : this._baseMaxFall
    this._sprite?.setParam('wallSliding', this._wallSliding)

    // --- the jumps the engine does not make: off a wall, and in the air --------------------------------
    if (this.jumpRequested && !this.canJump) {
      const wall = this.onWall
      if (this.hasWallJump && wall !== 0) {
        this.consumeJump()
        const away = -wall
        v[0] = away * this.wallJumpX
        v[1] = this.wallJumpY
        this.facing = away
        this._wallLockLeft = this.wallJumpLock
        this._wallLockDir = -away
        this._rising = true
        this._wallSliding = false
        this.drive().move[0] = 0
        this._sprite?.fireTrigger('jumped')
      } else if (this._airJumpsLeft > 0) {
        this.consumeJump()
        this._airJumpsLeft--
        v[1] = this.jumpSpeed * Math.sqrt(Math.max(0, this.airJumpHeight))
        this._rising = true
        this._sprite?.fireTrigger('jumped')
      }
    }
    // The engine's own jump, from the ground, is a rise too (seen once: the flag holds for the frame).
    if (this.justJumped) {
      if (!this._engineJumpSeen && v[1] > 0) this._rising = true
      this._engineJumpSeen = true
    } else this._engineJumpSeen = false

    // Letting go while rising cuts the jump: the height follows how long it is held.
    if (this._rising && !this._jumpHeld && v[1] > 0) {
      v[1] *= this.jumpCut
      this._rising = false
    }
    if (v[1] <= 0) this._rising = false
    return false
  }

  private _toward(current: number, target: number, step: number): number {
    return current < target ? Math.min(target, current + step) : Math.max(target, current - step)
  }

  private _attack() {
    if (!this._sprite) return
    // A press during a swing chains the next one when this one ends.
    if (this._swinging) {
      if (this._combo < 3) this._queued = true
      return
    }
    // Just after one, it chains at once; otherwise the combo starts over.
    this._swing(this._graceLeft > 0 && this._combo < 3 ? this._combo + 1 : 1)
  }

  private _swing(n: number) {
    this._combo = n
    this._swinging = true
    this._queued = false
    this._graceLeft = 0
    this._sprite?.play('attack' + n, true)
  }

  private _endCombo() {
    this._combo = 0
    this._swinging = false
    this._queued = false
    this._graceLeft = 0
  }

  onAnimationFinished(clip: string) {
    if (clip === 'hurt' && !this._dead) this._sprite?.resumeMachine()
    if (!clip.startsWith('attack') || !this._swinging) return
    this._swinging = false
    if (this._queued && this._combo < 3) this._swing(this._combo + 1)
    else if (this._combo < 3) this._graceLeft = this.comboWindow
    else this._endCombo()
  }

  onTriggerEnter(other: Node) {
    if (!this._touching.includes(other)) this._touching.push(other)
  }

  onTriggerExit(other: Node) {
    const i = this._touching.indexOf(other)
    if (i >= 0) this._touching.splice(i, 1)
  }

  /** A hit for `damage` from `from` (or the world): knock-back, invulnerability, or death. */
  public takeHit(damage: number, from: Node | null) {
    if (this._dead || this._invulnLeft > 0) return
    this.health = Math.max(0, this.health - damage)
    const cam = this.findNode('Camera') as any
    cam?.shake?.(0.25, 0.25)
    Game.hitStop(0.06)
    this._endCombo()
    this._dashLeft = 0
    this.gravityScale = 1
    if (this.health <= 0) { this._die(); return }
    this._invulnLeft = this.invulnerableSeconds
    this._hurtLeft = this.hurtSeconds
    const away = from ? Math.sign(this.worldPosition[0] - from.worldPosition[0]) || -this.facing : -this.facing
    this.velocity2D[0] = away * this.knockback
    this.velocity2D[1] = this.knockup
    this._sprite?.play('hurt', true)
  }

  private _die() {
    this._dead = true
    this._deathLeft = this.deathSeconds
    this._sprite?.play('death', true)
  }

  /** Back at the last checkpoint, whole. */
  public respawn() {
    this._dead = false
    this._hurtLeft = 0
    this.health = this.maxHealth
    this._invulnLeft = this.invulnerableSeconds
    this.teleport(this._respawn[0], this._respawn[1])
    this._sprite?.resumeMachine()
    const cam = this.findNode('Camera') as any
    cam?.snapToTarget?.()
  }

  public setRespawn(x: number, y: number) {
    this._respawn = [x, y]
  }

  public heal(amount: number) {
    this.health = Math.min(this.maxHealth, this.health + amount)
  }

  /** A pickup: a diamond, a heart, or one of the movement abilities. */
  public collect(kind: string, amount: number = 1) {
    if (kind === 'diamond') { this.diamonds += amount; return }
    if (kind === 'heart') { this.heal(amount); this.say('Health restored'); return }
    if (kind === 'dash') { this.hasDash = true; this.say('Dash: Shift or L'); return }
    if (kind === 'doubleJump') { this.hasDoubleJump = true; this.say('Double jump: jump again in the air'); return }
    if (kind === 'wallJump') { this.hasWallJump = true; this.say('Wall jump: hold toward a wall, then jump'); return }
  }
}
