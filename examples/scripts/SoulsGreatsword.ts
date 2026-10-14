import SoulsWeaponNode from './SoulsWeapon'

/**
 * Hollow Keep — the Greatsword: slow, heavy, strength-hungry, and it breaks poise. The player's second
 * weapon and the Elite Knight's only one: both spawn the same "Greatsword" template.
 */
export default class SoulsGreatswordNode extends SoulsWeaponNode {
  public displayName: string = 'Greatsword'
  public baseDamage: number = 165
  public strScaling: number = 1
  public dexScaling: number = 0.15
  public strRequirement: number = 16
  public dexRequirement: number = 0
  public poiseDamage: number = 32
  public bladeStart: number[] = [0, 0.17, 0]
  public bladeEnd: number[] = [0, 1.52, 0]
  public bladeRadius: number = 0.15
}
