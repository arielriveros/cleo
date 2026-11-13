import { AnimatedSpriteNode, Area2DNode, CharacterBody2DNode, ControllerNode, Node } from 'cleo'

/**
 * Duskwell -- a bat. Attach to a flying Character Body 2D (no gravity, through one-way platforms) whose
 * children are `Sprite` (the bat's clips: sleep, wakeup, fly, attack, hurt, die), `Bite` (an Area 2D that
 * sees the player's layer: the player's script asks this node's `contactDamage`) and, last, its `Bat Brain`
 * AI Controller.
 *
 * The brain decides (the Bat Brain asset): asleep until it sees the player, it wakes, flies at the player
 * on the air grid -- round the pillar, not through it --, swoops when close, and flies home to roost when
 * it forgets the player. This script does what a goal cannot: waking, the swoop (a dash it owns in
 * onMove2D), the hurt and the death, and it publishes what the brain reads: `isAwake`, `swoopReady`,
 * `isSwooping`, `isHurt`, `isDead`, `distanceFromHome`.
 */
export default class DuskBat extends CharacterBody2DNode {
  public health: number = 3
  public contactDamage: number = 1
  public swoopSpeed: number = 7.5
  /** Seconds between swoops. */
  public swoopCooldown: number = 1.2
  public knockback: number = 8
  /** The bat's art faces left: its sprite is mirrored to face right. */
  public artFacesLeft: boolean = false

  private _sprite: AnimatedSpriteNode = null
  private _bite: Area2DNode = null
  private _brain: ControllerNode = null
  private _player: Node = null
  private _home: [number, number] = [0, 0]
  private _awake: boolean = false
  private _waking: boolean = false
  private _swoopLeft: number = 0
  private _swoopDir: [number, number] = [1, 0]
  private _cooldownLeft: number = 0
  private _hurtLeft: number = 0
  private _dead: boolean = false
  private _deadLeft: number = 0
  private _bob: number = 0

  onStart() {
    this._sprite = this.getChildByName('Sprite')[0] as AnimatedSpriteNode
    this._bite = this.getChildByName('Bite')[0] as Area2DNode
    this._brain = this.children.find(c => c instanceof ControllerNode) as ControllerNode ?? null
    this._player = this.findNode('Player') ?? null
    this.movement = 'fly'
    this.oneWayPlatforms = false
    this.flipSprites = false
    const p = this.position
    // A flier steers by the middle of its box: home, for Roost's 'point', is there too.
    this._home = [p[0], p[1] + this.size[1] * 0.5]
    if (this._brain) this._brain.goalPoint = [this._home[0], this._home[1], 0]
    this._bob = Math.random() * 6.28
    this._sprite?.play('sleep', true)
  }

  public get isDead(): boolean { return this._dead }
  public get isHurt(): boolean { return this._hurtLeft > 0 }
  public get isAwake(): boolean { return this._awake }
  public get isSwooping(): boolean { return this._swoopLeft > 0 }
  public get swoopReady(): boolean { return this._awake && this._swoopLeft <= 0 && this._cooldownLeft <= 0 && !this._dead }
  public get distanceFromHome(): number {
    return Math.hypot(this.position[0] - this._home[0], this.position[1] + this.size[1] * 0.5 - this._home[1])
  }

  onUpdate(delta: number) {
    this._cooldownLeft = Math.max(0, this._cooldownLeft - delta)
    this._hurtLeft = Math.max(0, this._hurtLeft - delta)
    this._bob += delta * 5
    if (this._dead) {
      this._deadLeft -= delta
      if (this._deadLeft <= 0) this.remove()
      return
    }
    const state = this._brain?.behaviorState ?? ''
    const s = this._sprite
    if (state === 'Sleep') {
      this._awake = false
      this._waking = false
      if (s && s.clip !== 'sleep') s.play('sleep', true)
    } else if (state === 'Wake') {
      if (!this._waking) { this._waking = true; s?.play('wakeup', true) }
      if (s && s.clip === 'wakeup' && s.isFinished) { this._awake = true; s.play('fly', true) }
    } else if (state === 'Swoop') {
      if (this.swoopReady) this._startSwoop()
    } else if ((state === 'Chase' || state === 'Roost') && s && s.clip !== 'fly' && this._swoopLeft <= 0 && this._hurtLeft <= 0) {
      s.play('fly', true)
    }
    // A gentle bob, on the sprite alone so the body's path stays true.
    if (s) s.setPosition([0, this._awake ? Math.sin(this._bob) * 0.12 : 0, 0])
    // Face the way it flies, or the player.
    const vx = this.velocity2D[0]
    const p = this._player
    const facingLeft = (Math.abs(vx) > 0.1 ? vx : p ? p.worldPosition[0] - this.worldPosition[0] : 1) < 0
    if (s) s.flipX = this.artFacesLeft ? !facingLeft : facingLeft
  }

  private _startSwoop() {
    const p = this._player
    if (!p) return
    const dx = p.worldPosition[0] - this.worldPosition[0]
    const dy = p.worldPosition[1] + 1.2 - (this.worldPosition[1] + this.size[1] * 0.5)
    const d = Math.hypot(dx, dy) || 1
    this._swoopDir = [dx / d, dy / d]
    this._swoopLeft = 0.55
    this._cooldownLeft = this.swoopCooldown
    this._sprite?.play('attack', true)
  }

  /**
   * The swoop, the hurt and the death are the bat's own motion, every physics substep: a wind-up back, a
   * lunge at the player; a knock-back easing off; a fall out of the air.
   */
  onMove2D(dt: number): boolean {
    const v = this.velocity2D
    if (this._dead) {
      v[0] *= Math.pow(0.4, dt)
      v[1] = Math.max(-14, v[1] - 30 * dt)
      return true
    }
    if (this._hurtLeft > 0) {
      const k = Math.pow(0.02, dt)
      v[0] *= k; v[1] *= k
      return true
    }
    if (this._swoopLeft > 0) {
      const t = 0.55 - this._swoopLeft
      this._swoopLeft = Math.max(0, this._swoopLeft - dt)
      const speed = t < 0.15 ? -2 : this.swoopSpeed
      v[0] = this._swoopDir[0] * speed
      v[1] = this._swoopDir[1] * speed
      return true
    }
    return false
  }

  onTriggerEnter(other: Node) {
    if (other.name !== 'Sword' || this._dead) return
    this.takeHit(1, other)
  }

  public takeHit(damage: number, from: Node | null) {
    if (this._dead) return
    this.health -= damage
    const away = from ? Math.sign(this.worldPosition[0] - from.worldPosition[0]) || 1 : 1
    this.velocity2D[0] = away * this.knockback
    this.velocity2D[1] = 3
    this._swoopLeft = 0
    this._awake = true
    const cam = this.findNode('Camera') as any
    cam?.shake?.(0.12, 0.15)
    if (this.health <= 0) {
      this._dead = true
      if (this._bite) this._bite.enabled = false
      this._deadLeft = 1.4
      this._sprite?.play('die', true)
      ;(this._player as any)?.collect?.('diamond', 1)
      return
    }
    this._hurtLeft = 0.35
    this._sprite?.play('hurt', true)
  }
}
