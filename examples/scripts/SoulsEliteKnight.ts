import { attribute } from 'cleo'
import type { TemplateName } from 'cleo'
import SoulsEnemyNode from '@/Characters/Enemies/Base Enemy/Scripts/SoulsEnemy'

/**
 * Hollow Keep — the Elite Knight: armoured (15% of every hit turned aside), heavy poise, and a two-handed
 * maul (the Valley's knight carries its own).
 */
export default class SoulsEliteKnightNode extends SoulsEnemyNode {
  @attribute
  public displayName: string = 'Elite Knight'
  @attribute
  public weaponTemplates: TemplateName[] = ['Maul']
  @attribute
  public maxHp: number = 650
  @attribute
  public hp: number = 650
  @attribute
  public defense: number = 0.15
  @attribute
  public maxPoise: number = 70
  @attribute
  public poise: number = 70
  @attribute
  public soulsReward: number = 900
  @attribute
  public moveSpeed: number = 2.8
  @attribute
  public attackGapMin: number = 0.8
  @attribute
  public attackGapMax: number = 1.4
  @attribute
  public bodyRadius: number = 0.45
  @attribute
  public bodyHeight: number = 2.16
}
