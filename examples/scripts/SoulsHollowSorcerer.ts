import SoulsEnemyNode from './SoulsEnemy'

/**
 * Hollow Keep — the Hollow Sorcerer: keeps its distance and casts bolts from its staff, shoving anyone
 * who gets too close. Fragile; kill it first.
 */
export default class SoulsHollowSorcererNode extends SoulsEnemyNode {
  public displayName: string = 'Hollow Sorcerer'
  public weaponTemplates: string = 'Sorcerer Staff'
  public maxHp: number = 110
  public hp: number = 110
  public defense: number = 0
  public maxPoise: number = 15
  public poise: number = 15
  public soulsReward: number = 160
  public moveSpeed: number = 2.2
  public strafeSpeedScale: number = 0.5
  public attackGapMin: number = 1
  public attackGapMax: number = 2
}
