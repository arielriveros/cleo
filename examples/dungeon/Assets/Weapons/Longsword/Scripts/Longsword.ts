import { attribute } from 'cleo/decorators'
import type { Vec3 } from 'cleo'
import SoulsWeaponNode from '@/Weapons/Base Weapon/Scripts/SoulsWeapon'

/**
 * Hollow Keep — the Longsword: a two-handed blade, quick for its reach. The "Longsword" template (a variant
 * of "Weapon") carries this script, its mesh and its Light1-3 / Heavy moves, whose clips were made in the
 * Motion Creator. Only the numbers differ from the base weapon, so this class
 * is nothing but defaults.
 */
export default class SoulsLongswordNode extends SoulsWeaponNode {
  @attribute
  public displayName: string = 'Longsword'
  @attribute
  public baseDamage: number = 112
  @attribute
  public strScaling: number = 0.5
  @attribute
  public dexScaling: number = 0.5
  @attribute
  public strRequirement: number = 10
  @attribute
  public dexRequirement: number = 10
  @attribute
  public poiseDamage: number = 20
  // From just above the guard to the point (the blade runs 0.075 m to 1.03 m up the grip's axis).
  @attribute
  public bladeStart: Vec3 = [0, 0.12, 0]
  @attribute
  public bladeEnd: Vec3 = [0, 1.02, 0]
  @attribute
  public bladeRadius: number = 0.11
}
