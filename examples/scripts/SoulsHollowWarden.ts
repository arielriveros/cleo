import { Node } from 'cleo'
import type { ClipName, TemplateName } from 'cleo'
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
  public displayName: string = 'Hollow Warden'
  public weaponTemplates: TemplateName[] = ['Halberd']
  public isBoss: boolean = true
  public flinchOnHit: boolean = false
  public maxHp: number = 2600
  public hp: number = 2600
  public defense: number = 0.2
  public maxPoise: number = 150
  public poise: number = 150
  public soulsReward: number = 6000
  public moveSpeed: number = 3
  public attackGapMin: number = 0.6
  public attackGapMax: number = 1.2
  public bodyRadius: number = 0.7
  public bodyHeight: number = 3.24
  public healthBarSeconds: number = 0
  public deathSeconds: number = 2.2
  public corpseSeconds: number = 20

  // ----- phase two -------------------------------------------------------------------------------
  /** Fraction of max HP at which the Warden turns. */
  public phase2At: number = 0.5
  public phase2SpeedMul: number = 1.15
  public phase2Seconds: number = 2
  public roarClip: ClipName = 'Souls_Roar'

  protected _onDamaged(dealt: number, poiseDamage: number, from: Node): void {
    super._onDamaged(dealt, poiseDamage, from)
    if (this.phase === 1 && this.hp <= this.maxHp * this.phase2At) this._startPhase2()
  }

  private _startPhase2(): void {
    this._stopAction()
    this.phase = 2
    this._speedMul = this.phase2SpeedMul
    this._phaseSeconds = this.phase2Seconds
    this._enter('phase')
    this._play(this.roarClip, 1)
    const gm = this._gm as any
    gm?.shake?.(0.6)
    playSound(this, 'Boss Roar')
    ;(this._aura as any)?.play?.()
  }
}
