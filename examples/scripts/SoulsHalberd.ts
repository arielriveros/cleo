import { attribute } from 'cleo'
import SoulsWeaponNode from '@/Weapons/Base Weapon/Scripts/SoulsWeapon'

/**
 * Hollow Keep — the Hollow Warden's halberd. Long reach, a wide head: the hitbox runs from mid-shaft to
 * past the blade, and the Warden's size (the socket's scale) makes it bigger still.
 */
export default class SoulsHalberdNode extends SoulsWeaponNode {
  @attribute
  public displayName: string = 'Halberd'
  @attribute
  public baseDamage: number = 150
  @attribute
  public strScaling: number = 0.6
  @attribute
  public dexScaling: number = 0.4
  @attribute
  public strRequirement: number = 14
  @attribute
  public dexRequirement: number = 12
  @attribute
  public poiseDamage: number = 40
  @attribute
  public bladeStart: number[] = [0, 0.4, 0]
  @attribute
  public bladeEnd: number[] = [0.06, 1.9, 0]
  @attribute
  public bladeRadius: number = 0.2
}
