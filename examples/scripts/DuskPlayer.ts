import { AnimatedSpriteNode, CharacterBody2DNode, Game, Input, Node } from 'cleo'

/**
 * Duskwell -- the player: the warrior of the Medieval Warrior pack. Attach to the `Player` Character Body 2D;
 * its children are `Sprite` (the animation set, whose state machine plays idle / run / jump / fall on its
 * own) and `Sword` (the Area 2D the attack frames switch on).
 *
 * The body moves itself (its platformer controller reads Move / Jump / Dash). This adds what makes it a
 * fighter: a three-hit combo on Attack -- press again during a swing, or just after it, for the next --, health, a hurt
 * knock-back with a moment of invulnerability, death, and a respawn at the last checkpoint. Pickups call
 * `collect(kind)`; checkpoints call `setRespawn(x, y)`.
 *
 * Anything that hurts on touch has an Area 2D that sees the player's layer, under a node with a
 * `contactDamage` field (a bat's `Bite`). Falling below `killY` costs the whole health.
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
  /** Below this the player has fallen out of the world (the map's bottom edge is y = 0). */
  public killY: number = -4
  /** Seconds the death plays before the respawn. */
  public deathSeconds: number = 1.8

  private _sprite: AnimatedSpriteNode = null
  private _runSpeed: number = 8
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

  onStart() {
    this._sprite = this.getChildByName('Sprite')[0] as AnimatedSpriteNode
    this._runSpeed = this.settings.runSpeed
    this._respawn = [this.position[0], this.position[1]]
    this.health = this.maxHealth
  }

  /** The one-line message the HUD shows (a pickup, a checkpoint), and how long ago it came. */
  public get notice(): string { return this._noticeAge < 3 ? this._notice : '' }
  public get isDead(): boolean { return this._dead }

  public say(text: string) { this._notice = text; this._noticeAge = 0 }

  onUpdate(delta: number) {
    this._noticeAge += delta
    if (this._dead) {
      this._deathLeft -= delta
      if (this._deathLeft <= 0) this.respawn()
      return
    }
    this._invulnLeft = Math.max(0, this._invulnLeft - delta)
    if (this._hurtLeft > 0) {
      this._hurtLeft -= delta
      if (this._hurtLeft <= 0) this.playerInput = true
    }
    if (this._sprite) this._sprite.opacity = this._invulnLeft > 0 && Math.floor(this._invulnLeft * 16) % 2 === 0 ? 0.35 : 1

    if (this._graceLeft > 0) {
      this._graceLeft -= delta
      if (this._graceLeft <= 0) this._combo = 0
    }
    if (Input.started(this.attackAction) && this._hurtLeft <= 0) this._attack()
    this.settings.runSpeed = this._swinging && this.isGrounded ? this.attackRunSpeed : this._runSpeed

    // Whatever hurts on touch, while it still touches (a hit does nothing while invulnerable).
    for (const n of this._touching) {
      const owner = (n.parent as any) ?? null
      const damage = (owner?.contactDamage ?? (n as any).contactDamage ?? 0) as number
      if (damage > 0 && !owner?.isDead) this.takeHit(damage, n)
    }
    if (this.position[1] < this.killY) this.takeHit(this.maxHealth, null)
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
    if (this.health <= 0) { this._die(); return }
    this._invulnLeft = this.invulnerableSeconds
    this._hurtLeft = this.hurtSeconds
    this.playerInput = false
    this.move(0)
    const away = from ? Math.sign(this.worldPosition[0] - from.worldPosition[0]) || -this.facing : -this.facing
    this.controlState.vx = away * this.knockback
    this.controlState.vy = this.knockup
    this._sprite?.play('hurt', true)
  }

  private _die() {
    this._dead = true
    this._deathLeft = this.deathSeconds
    this.playerInput = false
    this.move(0)
    this._sprite?.play('death', true)
  }

  /** Back at the last checkpoint, whole. */
  public respawn() {
    this._dead = false
    this.health = this.maxHealth
    this._invulnLeft = this.invulnerableSeconds
    this.playerInput = true
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
    if (kind === 'dash') { this.abilities.dash = true; this.say('Dash: Shift or L'); return }
    if (kind === 'doubleJump') { this.abilities.doubleJump = true; this.say('Double jump: jump again in the air'); return }
    if (kind === 'wallJump') { this.abilities.wallJump = true; this.say('Wall jump: hold toward a wall, then jump'); return }
  }
}
