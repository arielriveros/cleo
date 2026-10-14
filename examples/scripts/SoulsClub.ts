import SoulsWeaponNode from './SoulsWeapon'

/**
 * Hollow Keep — the Hollows' club. A crude strength weapon; the Hollow's damage comes from its own
 * attacks (SoulsEnemyAttack), so here the club is mostly its hitbox and its look.
 */
export default class SoulsClubNode extends SoulsWeaponNode {
  public displayName: string = 'Club'
  public baseDamage: number = 85
  public strScaling: number = 0.7
  public strRequirement: number = 10
  public poiseDamage: number = 20
  public bladeStart: number[] = [0, 0.05, 0]
  public bladeEnd: number[] = [0, 0.72, 0]
  public bladeRadius: number = 0.13
}
