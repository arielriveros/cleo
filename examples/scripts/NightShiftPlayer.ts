import { CharacterNode, Logger, Node } from 'cleo'

/**
 * Night Shift — the playable. Attach to the `Playable` root, which must be a Character node.
 *
 * Movement is not here and must not be: locomotion lives in `CharacterNode` itself and writes the body's
 * velocity every frame, so a second writer produces a character that stutters. This script owns the
 * things locomotion has no opinion about — health, powerups, and dying.
 *
 * See `ThirdPersonPlayable.ts` and `examples/scripts/README.md` for the body setup this depends on
 * (capsule collider, friction 0, linearConstraints [1,1,1]).
 *
 * ## The `isPlayer` marker
 *
 * The engine has no faction system: the perception pass offers every other Character as a candidate, so
 * a zombie's brain would happily target another zombie. `NightShiftZombieBrain` filters on this node
 * variable, which is set here rather than authored so it can never be lost in a scene edit. It is a
 * VARIABLE and not a field on purpose — `getVariable` works across nodes without a cast.
 */
export default class NightShiftPlayerNode extends CharacterNode {
  public maxHealth: number = 100
  public health: number = 100
  /** True while an Invincibility powerup is running. The zombie's damage check reads it. */
  public invincible: boolean = false
  /** Multiplier applied to walk and run speed while a Speed powerup is running. */
  public speedMultiplier: number = 1.7
  /** Seconds a Speed powerup lasts. */
  public speedSeconds: number = 8
  /** Seconds an Invincibility powerup lasts. */
  public invincibleSeconds: number = 6
  /** How long the AoE pip stays lit after a blast, purely so the HUD has something to show. */
  public aoeFlashSeconds: number = 1.5

  /** Seconds left on each powerup. The HUD reads these to fill its pips. */
  public speedLeft: number = 0
  public invincibleLeft: number = 0
  public aoeLeft: number = 0

  private _baseWalk: number = 0
  private _baseRun: number = 0
  private _dead: boolean = false
  private _director: Node = null

  onStart() {
    this.setVariable('isPlayer', true, 'boolean', 'public')
    this._baseWalk = this.walkSpeed
    this._baseRun = this.runSpeed
    this._director = this.findNode('GameManager')
    this.health = this.maxHealth
  }

  onUpdate(delta: number, time: number) {
    if (this.speedLeft > 0) {
      this.speedLeft -= delta
      if (this.speedLeft <= 0) this._endSpeed()
    }
    if (this.invincibleLeft > 0) {
      this.invincibleLeft -= delta
      if (this.invincibleLeft <= 0) {
        this.invincibleLeft = 0
        this.invincible = false
      }
    }
    if (this.aoeLeft > 0) this.aoeLeft = Math.max(0, this.aoeLeft - delta)
  }

  /** Called by the zombie. Returns true if the hit landed, so the caller can play a reaction. */
  public damage(amount: number): boolean {
    if (this._dead || this.invincible || amount <= 0) return false

    this.health = Math.max(0, this.health - amount)
    if (this.health > 0) return true

    this._dead = true
    const director = this._director as any
    if (director && director.endLevel) director.endLevel(false)
    else Logger.warn('Night Shift: player died with no GameManager to tell.', 'Script')
    return true
  }

  /** Speed and Invincibility both re-arm rather than stack, which is what a player expects. */
  public grantSpeed(): void {
    if (this.speedLeft <= 0) {
      this._baseWalk = this.walkSpeed
      this._baseRun = this.runSpeed
      this.walkSpeed = this._baseWalk * this.speedMultiplier
      this.runSpeed = this._baseRun * this.speedMultiplier
    }
    this.speedLeft = this.speedSeconds
  }

  public grantInvincibility(): void {
    this.invincible = true
    this.invincibleLeft = this.invincibleSeconds
  }

  /** Lights the AoE pip. The blast itself is the powerup's job — it owns the radius. */
  public flashAoe(): void {
    this.aoeLeft = this.aoeFlashSeconds
  }

  /**
   * Restore the authored speeds rather than dividing back out: repeated pickups would otherwise drift
   * the base upward through floating-point error, and a pickup taken while one is already running would
   * compound the multiplier.
   */
  private _endSpeed(): void {
    this.speedLeft = 0
    this.walkSpeed = this._baseWalk
    this.runSpeed = this._baseRun
  }
}
