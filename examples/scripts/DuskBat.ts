import { AnimatedSpriteNode, Area2DNode, CharacterBody2DNode, Node } from 'cleo'

/**
 * Duskwell -- a bat. Attach to a flying Character Body 2D (no gravity) that passes through one-way
 * platforms. Its children are `Sprite` (the bat's clips: sleep, wakeup, fly, attack, hurt,
 * die) and `Bite` (an Area 2D that sees the player's layer: the player's script asks this node's
 * `contactDamage`).
 *
 * It hangs asleep until the player comes within `wakeDistance`, wakes, then flies at the player, swooping
 * in when close. The player's sword (an Area 2D named `Sword`) hurts it: knocked back, and dead after
 * `health` hits, falling out of the air.
 */
export default class DuskBat extends CharacterBody2DNode {
  public health: number = 3
  public contactDamage: number = 1
  public flySpeed: number = 3.2
  public swoopSpeed: number = 7.5
  public wakeDistance: number = 10
  public swoopDistance: number = 3
  public knockback: number = 8
  /** The bat's art faces left: its sprite is mirrored to face right. */
  public artFacesLeft: boolean = false

  private _sprite: AnimatedSpriteNode = null
  private _bite: Area2DNode = null
  private _player: Node = null
  private _mode: string = 'sleep'
  private _modeTime: number = 0
  private _bob: number = 0
  private _deadLeft: number = 0

  onStart() {
    this._sprite = this.getChildByName('Sprite')[0] as AnimatedSpriteNode
    this._bite = this.getChildByName('Bite')[0] as Area2DNode
    this._player = this.findNode('Player') ?? null
    this.movement = 'fly'
    this.flipSprites = false
    this.oneWayPlatforms = false
    this._bob = Math.random() * 6.28
    this._sprite?.play('sleep', true)
  }

  public get isDead(): boolean { return this._mode === 'die' }

  private _set(mode: string, clip: string) {
    this._mode = mode
    this._modeTime = 0
    this._sprite?.play(clip, true)
  }

  onUpdate(delta: number) {
    this._modeTime += delta
    this._bob += delta * 5
    const p = this._player
    const here = this.worldPosition
    const dx = p ? p.worldPosition[0] - here[0] : 0
    const dy = p ? p.worldPosition[1] + 1.2 - here[1] : 0
    const d = Math.hypot(dx, dy)
    const v = this.velocity2D
    const dead = (p as any)?.isDead === true

    if (this._mode === 'die') {
      v[0] *= 0.95
      v[1] = Math.max(-14, v[1] - 30 * delta)
      this._deadLeft -= delta
      if (this._deadLeft <= 0) this.remove()
      return
    }
    if (this._mode === 'sleep') {
      v[0] = 0; v[1] = 0
      if (p && d < this.wakeDistance && !dead) this._set('wake', 'wakeup')
    } else if (this._mode === 'wake') {
      v[0] = 0; v[1] = 0.4
      if (this._sprite?.isFinished) this._set('fly', 'fly')
    } else if (this._mode === 'fly') {
      const k = d > 0.01 ? this.flySpeed / d : 0
      v[0] = dead ? 0 : dx * k
      v[1] = dead ? Math.sin(this._bob) * 0.6 : dy * k + Math.sin(this._bob) * 1.2
      if (!dead && d < this.swoopDistance && this._modeTime > 0.6) this._set('swoop', 'attack')
    } else if (this._mode === 'swoop') {
      const k = d > 0.01 ? this.swoopSpeed / d : 0
      if (this._modeTime < 0.15) { v[0] = -dx * 0.5; v[1] = -dy * 0.5 }
      else if (this._modeTime < 0.55) { v[0] = dx * k; v[1] = dy * k }
      else this._set('fly', 'fly')
    } else if (this._mode === 'hurt') {
      v[0] *= 0.9; v[1] *= 0.9
      if (this._modeTime > 0.35) this._set('fly', 'fly')
    }

    // Face the player (or the way it flies).
    const facingLeft = (Math.abs(v[0]) > 0.1 ? v[0] : dx) < 0
    if (this._sprite) this._sprite.flipX = this.artFacesLeft ? !facingLeft : facingLeft
  }

  onTriggerEnter(other: Node) {
    if (other.name !== 'Sword' || this._mode === 'die') return
    this.takeHit(1, other)
  }

  public takeHit(damage: number, from: Node | null) {
    if (this._mode === 'die') return
    this.health -= damage
    const away = from ? Math.sign(this.worldPosition[0] - from.worldPosition[0]) || 1 : 1
    this.velocity2D[0] = away * this.knockback
    this.velocity2D[1] = 3
    const cam = this.findNode('Camera') as any
    cam?.shake?.(0.12, 0.15)
    if (this.health <= 0) {
      if (this._bite) this._bite.enabled = false
      this._deadLeft = 1.4
      this._set('die', 'die')
      const player = this._player as any
      player?.collect?.('diamond', 1)
      return
    }
    this._set('hurt', 'hurt')
  }
}
