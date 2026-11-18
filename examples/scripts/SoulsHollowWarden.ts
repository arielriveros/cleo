import { Node } from 'cleo'
import { attribute } from 'cleo/decorators'
import type { TemplateName, TriggerName } from 'cleo'
import SoulsEnemyNode from '@/Characters/Enemies/Base Enemy/Scripts/SoulsEnemy'
import { playSound } from '@/Core/Scripts/SoulsAudio'

/**
 * Hollow Keep — the Hollow Warden, the boss. A giant with a halberd; dormant until the fog gate wakes it,
 * never flinches, and at `phase2At` of its health it turns:
 *
 *   it ROARS (invulnerable for `phase2Seconds`), starts its `PhaseAura`, speeds up by `phase2SpeedMul`
 *   and unlocks every attack whose `phase` is 2 (the Leap and the Bolt Fan).
 *
 * The phase two lives here and nowhere else: a different boss writes its own `_onDamaged`.
 */
export default class SoulsHollowWardenNode extends SoulsEnemyNode {
  @attribute
  public displayName: string = 'Hollow Warden'
  @attribute
  public weaponTemplates: TemplateName[] = ['Halberd']
  @attribute
  public isBoss: boolean = true
  @attribute
  public flinchOnHit: boolean = false
  @attribute
  public maxHp: number = 2600
  @attribute
  public hp: number = 2600
  @attribute
  public defense: number = 0.2
  @attribute
  public maxPoise: number = 150
  @attribute
  public poise: number = 150
  @attribute
  public soulsReward: number = 6000
  @attribute
  public moveSpeed: number = 3
  @attribute
  public attackGapMin: number = 0.6
  @attribute
  public attackGapMax: number = 1.2
  @attribute
  public bodyRadius: number = 0.7
  @attribute
  public bodyHeight: number = 3.24
  @attribute
  public healthBarSeconds: number = 0
  @attribute
  public deathSeconds: number = 2.2
  @attribute
  public corpseSeconds: number = 20

  // ----- phase two -------------------------------------------------------------------------------
  /** Fraction of max HP at which the Warden turns. */
  @attribute('Phase two')
  public phase2At: number = 0.5
  @attribute('Phase two')
  public phase2SpeedMul: number = 1.15
  @attribute('Phase two')
  public phase2Seconds: number = 2
  /** The animator trigger of the roar's Actions state. */
  @attribute('Phase two')
  public roarTrigger: TriggerName = 'Roar'

  protected _onDamaged(dealt: number, poiseDamage: number, from: Node): void {
    super._onDamaged(dealt, poiseDamage, from)
    if (this.phase === 1 && this.hp <= this.maxHp * this.phase2At) this._startPhase2()
  }

  private _startPhase2(): void {
    this.phase = 2
    this._setSpeedMul(this.phase2SpeedMul)
    this._phaseSeconds = this.phase2Seconds
    this._enter('phase')
    this._oneShot(this.roarTrigger)
    const gm = this._gm as any
    gm?.shake?.(0.6)
    playSound(this, 'Boss Roar')
    ;(this._aura as any)?.play?.()
  }
}
