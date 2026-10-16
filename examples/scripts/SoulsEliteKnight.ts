import type { TemplateName } from 'cleo'
import SoulsEnemyNode from '@/Characters/Enemies/Base Enemy/Scripts/SoulsEnemy'

/**
 * Hollow Keep — the Elite Knight: armoured (15% of every hit turned aside), heavy poise, and a greatsword
 * — the very template the player can wield.
 */
export default class SoulsEliteKnightNode extends SoulsEnemyNode {
  public displayName: string = 'Elite Knight'
  public weaponTemplates: TemplateName[] = ['Greatsword']
  public maxHp: number = 650
  public hp: number = 650
  public defense: number = 0.15
  public maxPoise: number = 70
  public poise: number = 70
  public soulsReward: number = 900
  public moveSpeed: number = 2.8
  public attackGapMin: number = 0.8
  public attackGapMax: number = 1.4
  public bodyRadius: number = 0.45
  public bodyHeight: number = 2.16
}
