import { attribute } from 'cleo/decorators'
import type { Vec3 } from 'cleo'
import SoulsWeaponNode from '@/Weapons/Base Weapon/Scripts/SoulsWeapon'

/**
 * Hollow Keep — the Greatsword: slow, heavy, strength-hungry, and it breaks poise. The player's second
 * weapon and the Elite Knight's only one: both spawn the same "Greatsword" template.
 */
export default class SoulsGreatswordNode extends SoulsWeaponNode {
  @attribute
  public displayName: string = 'Greatsword'
  @attribute
  public baseDamage: number = 165
  @attribute
  public strScaling: number = 1
  @attribute
  public dexScaling: number = 0.15
  @attribute
  public strRequirement: number = 16
  @attribute
  public dexRequirement: number = 0
  @attribute
  public poiseDamage: number = 32
  @attribute
  public bladeStart: Vec3 = [0, 0.17, 0]
  @attribute
  public bladeEnd: Vec3 = [0, 1.52, 0]
  @attribute
  public bladeRadius: number = 0.15
}
