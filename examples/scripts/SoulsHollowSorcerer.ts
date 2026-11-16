import { attribute } from 'cleo'
import type { TemplateName } from 'cleo'
import SoulsEnemyNode from '@/Characters/Enemies/Base Enemy/Scripts/SoulsEnemy'

/**
 * Hollow Keep — the Hollow Sorcerer: keeps its distance and casts bolts from its staff, shoving anyone
 * who gets too close. Fragile; kill it first.
 */
export default class SoulsHollowSorcererNode extends SoulsEnemyNode {
  @attribute
  public displayName: string = 'Hollow Sorcerer'
  @attribute
  public weaponTemplates: TemplateName[] = ['Sorcerer Staff']
  @attribute
  public maxHp: number = 110
  @attribute
  public hp: number = 110
  @attribute
  public defense: number = 0
  @attribute
  public maxPoise: number = 15
  @attribute
  public poise: number = 15
  @attribute
  public soulsReward: number = 160
  @attribute
  public moveSpeed: number = 2.2
  @attribute
  public strafeSpeedScale: number = 0.5
  @attribute
  public attackGapMin: number = 1
  @attribute
  public attackGapMax: number = 2
}
