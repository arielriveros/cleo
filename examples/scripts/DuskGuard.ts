import { AnimatedSpriteNode, CharacterBody2DNode, ControllerNode, Node } from 'cleo'

/**
 * Duskwell -- a Ruin Guard: the knight of the Pixel Platformer set, gone dark. Attach to a walking
 * Character Body 2D whose children are `Sprite` (the knight's clips, its state machine playing idle / run /
 * jump / fall / land from the body), `Blade` (an Area 2D the attack frames switch on) and, last, its `Guard
 * Brain` AI Controller.
 *
 * The brain decides what the guard does (the Guard Brain asset): walk its route, chase the player it sees
 * across the 2D navigation -- jumping between platforms where the path says --, attack when close and
 * level, search where it lost the player, walk home. This script does what a goal cannot: the swing, the
 * hurt and the death, and it publishes the facts the brain reads, as fields: `attackReady`, `isAttacking`,
 * `isHurt`, `isDead`, `targetDead`, `distanceFromHome`.
 *
 * The player's script reads `contactDamage` from the Blade's owner, so the Blade hurts the player while
 * the swing has it switched on.
 */
export default class DuskGuard extends CharacterBody2DNode {
  public maxHealth: number = 3
  public health: number = 3
  public contactDamage: number = 1
  /** Seconds between swings. */
  public attackCooldown: number = 1.1
  /** A sword hit's push away, and up. */
  public knockback: number = 7
  public knockup: number = 4
  /** Seconds a hit staggers it. */
  public hurtSeconds: number = 0.35
  /** Diamonds it drops. */
  public reward: number = 2

  private _sprite: AnimatedSpriteNode = null
  private _brain: ControllerNode = null
  private _player: Node = null
  private _home: [number, number] = [0, 0]
  private _attacking: boolean = false
  private _attackLeft: number = 0
  private _cooldownLeft: number = 0
  private _hurtLeft: number = 0
  private _dead: boolean = false
  private _deadLeft: number = 0

  onStart() {
    this._sprite = this.getChildByName('Sprite')[0] as AnimatedSpriteNode
    this._brain = this.children.find(c => c instanceof ControllerNode) as ControllerNode ?? null
    this._player = this.findNode('Player') ?? null
    this._home = [this.position[0], this.position[1]]
    // Where Return walks back to: the brain's goal point, read when a state targets 'point'.
    if (this._brain) this._brain.goalPoint = [this._home[0], this._home[1], 0]
    this.health = this.maxHealth
  }

  public get attackReady(): boolean { return !this._attacking && this._cooldownLeft <= 0 && this.isGrounded && !this._dead }
  public get isAttacking(): boolean { return this._attacking }
  public get isHurt(): boolean { return this._hurtLeft > 0 }
  public get isDead(): boolean { return this._dead }
  public get targetDead(): boolean { return (this._player as any)?.isDead === true }
  public get distanceFromHome(): number {
    return Math.hypot(this.position[0] - this._home[0], this.position[1] - this._home[1])
  }

  onUpdate(delta: number) {
    this._cooldownLeft = Math.max(0, this._cooldownLeft - delta)
    this._hurtLeft = Math.max(0, this._hurtLeft - delta)
    if (this._sprite) this._sprite.opacity = this._hurtLeft > 0 && Math.floor(this._hurtLeft * 20) % 2 === 0 ? 0.4 : 1
    if (this._dead) {
      this._deadLeft -= delta
      if (this._deadLeft <= 0) this.remove()
      return
    }
    if (this._attacking) {
      this._attackLeft -= delta
      if (this._attackLeft <= 0) this._attacking = false
    }
    // The brain's Attack state is the cue; the swing is ours.
    if (this._brain?.behaviorState === 'Attack' && this.attackReady) this._swing()
  }

  private _swing() {
    const p = this._player
    if (p) this.facing = p.worldPosition[0] - this.worldPosition[0]
    this._attacking = true
    this._attackLeft = 0.75
    this._cooldownLeft = this.attackCooldown
    this._sprite?.play('attack', true)
  }

  onAnimationFinished(clip: string) {
    if (clip === 'attack') {
      this._attacking = false
      this._sprite?.resumeMachine()
    }
  }

  /** A hurt or dead guard's motion is its own: the knock-back's arc, slowed along the ground. */
  onMove2D(dt: number): boolean {
    if (this._hurtLeft <= 0 && !this._dead) return false
    if (this.isGrounded) {
      const v = this.velocity2D
      const step = this.deceleration * dt
      v[0] = v[0] > 0 ? Math.max(0, v[0] - step) : Math.min(0, v[0] + step)
    }
    return true
  }

  onTriggerEnter(other: Node) {
    if (other.name === 'Sword' && !this._dead) this.takeHit(1, other)
  }

  public takeHit(damage: number, from: Node | null) {
    if (this._dead) return
    this.health -= damage
    const away = from ? Math.sign(this.worldPosition[0] - from.worldPosition[0]) || 1 : 1
    this.velocity2D[0] = away * this.knockback
    this.velocity2D[1] = this.knockup
    this._attacking = false
    this._hurtLeft = this.hurtSeconds
    const cam = this.findNode('Camera') as any
    cam?.shake?.(0.12, 0.15)
    if (this.health > 0) return
    this._dead = true
    this._deadLeft = 1.6
    this._sprite?.play('dead', true)
    const blade = this.getChildByName('Blade')[0] as any
    if (blade) blade.enabled = false
    ;(this._player as any)?.collect?.('diamond', this.reward)
  }
}
