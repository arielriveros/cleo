import SoulsWeaponNode from './SoulsWeapon'

/**
 * Hollow Keep — the Straight Sword: quick, cheap, dexterity-leaning. The "Straight Sword" template (a
 * variant of "Weapon") carries this script, its mesh and its Light1-3 / Heavy moves. Only the numbers
 * differ from the base weapon, so this class is nothing but defaults.
 */
export default class SoulsStraightSwordNode extends SoulsWeaponNode {
  public displayName: string = 'Straight Sword'
  public baseDamage: number = 100
  public strScaling: number = 0.2
  public dexScaling: number = 0.8
  public strRequirement: number = 8
  public dexRequirement: number = 10
  public poiseDamage: number = 15
  public bladeStart: number[] = [0, 0.12, 0]
  public bladeEnd: number[] = [0, 0.98, 0]
  public bladeRadius: number = 0.12
}
