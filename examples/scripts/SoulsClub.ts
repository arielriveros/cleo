import { attribute } from 'cleo/decorators'
import type { Vec3 } from 'cleo'
import SoulsWeaponNode from '@/Weapons/Base Weapon/Scripts/SoulsWeapon'

/**
 * Hollow Keep — the Hollows' club. A crude strength weapon; the Hollow's damage comes from its own
 * attacks (SoulsEnemyAttack), so here the club is mostly its hitbox and its look.
 */
export default class SoulsClubNode extends SoulsWeaponNode {
  @attribute
  public displayName: string = 'Club'
  @attribute
  public baseDamage: number = 85
  @attribute
  public strScaling: number = 0.7
  @attribute
  public strRequirement: number = 10
  @attribute
  public poiseDamage: number = 20
  @attribute
  public bladeStart: Vec3 = [0, 0.05, 0]
  @attribute
  public bladeEnd: Vec3 = [0, 0.72, 0]
  @attribute
  public bladeRadius: number = 0.13
}
