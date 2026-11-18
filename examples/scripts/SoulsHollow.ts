import { attribute } from 'cleo/decorators'
import type { TemplateName } from 'cleo'
import SoulsEnemyNode from '@/Characters/Enemies/Base Enemy/Scripts/SoulsEnemy'

/**
 * Hollow Keep — the Hollow: the shambling rank and file. Slow, fragile, swings a club. Everything that
 * makes it a Hollow is here; how it fights is SoulsEnemy's.
 */
export default class SoulsHollowNode extends SoulsEnemyNode {
  @attribute
  public displayName: string = 'Hollow'
  @attribute
  public weaponTemplates: TemplateName[] = ['Club']
  @attribute
  public maxHp: number = 160
  @attribute
  public hp: number = 160
  @attribute
  public defense: number = 0
  @attribute
  public maxPoise: number = 25
  @attribute
  public poise: number = 25
  @attribute
  public soulsReward: number = 120
  @attribute
  public moveSpeed: number = 2.6
}
