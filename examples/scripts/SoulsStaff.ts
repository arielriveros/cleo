import { attribute } from 'cleo'
import SoulsWeaponNode from '@/Weapons/Base Weapon/Scripts/SoulsWeapon'

/**
 * Hollow Keep — the Hollow Sorcerer's staff. Held upright; its orb is where the sorcerer's bolts are cast
 * from (the left-hand socket on the wielder), and the shaft is a weak melee hitbox for the Shove.
 */
export default class SoulsStaffNode extends SoulsWeaponNode {
  @attribute
  public displayName: string = 'Sorcerer Staff'
  @attribute
  public baseDamage: number = 40
  @attribute
  public dexScaling: number = 0.3
  @attribute
  public poiseDamage: number = 10
  @attribute
  public bladeStart: number[] = [0, 0.05, 0]
  @attribute
  public bladeEnd: number[] = [0, 1.12, 0]
  @attribute
  public bladeRadius: number = 0.11
}
