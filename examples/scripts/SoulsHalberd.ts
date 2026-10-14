import SoulsWeaponNode from './SoulsWeapon'

/**
 * Hollow Keep — the Hollow Warden's halberd. Long reach, a wide head: the hitbox runs from mid-shaft to
 * past the blade, and the Warden's size (the socket's scale) makes it bigger still.
 */
export default class SoulsHalberdNode extends SoulsWeaponNode {
  public displayName: string = 'Halberd'
  public baseDamage: number = 150
  public strScaling: number = 0.6
  public dexScaling: number = 0.4
  public strRequirement: number = 14
  public dexRequirement: number = 12
  public poiseDamage: number = 40
  public bladeStart: number[] = [0, 0.4, 0]
  public bladeEnd: number[] = [0.06, 1.9, 0]
  public bladeRadius: number = 0.2
}
