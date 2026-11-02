import SoulsWeaponNode from '@/Weapons/Base Weapon/Scripts/SoulsWeapon'

/**
 * Hollow Keep — the Longsword: a two-handed blade, quick for its reach. The "Longsword" template (a variant
 * of "Weapon") carries this script, its mesh and its Light1-3 / Heavy moves, whose clips were made in the
 * Motion Creator (tools/soulsDemo/longsword/). Only the numbers differ from the base weapon, so this class
 * is nothing but defaults.
 */
export default class SoulsLongswordNode extends SoulsWeaponNode {
  public displayName: string = 'Longsword'
  public baseDamage: number = 112
  public strScaling: number = 0.5
  public dexScaling: number = 0.5
  public strRequirement: number = 10
  public dexRequirement: number = 10
  public poiseDamage: number = 20
  // From just above the guard to the point (the blade runs 0.075 m to 1.03 m up the grip's axis).
  public bladeStart: number[] = [0, 0.12, 0]
  public bladeEnd: number[] = [0, 1.02, 0]
  public bladeRadius: number = 0.11
}
