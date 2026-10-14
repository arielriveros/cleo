import SoulsEnemyNode from './SoulsEnemy'

/**
 * Hollow Keep — the Hollow: the shambling rank and file. Slow, fragile, swings a club. Everything that
 * makes it a Hollow is here; how it fights is SoulsEnemy's.
 */
export default class SoulsHollowNode extends SoulsEnemyNode {
  public displayName: string = 'Hollow'
  public weaponTemplates: string = 'Club'
  public maxHp: number = 160
  public hp: number = 160
  public defense: number = 0
  public maxPoise: number = 25
  public poise: number = 25
  public soulsReward: number = 120
  public moveSpeed: number = 2.6
}
