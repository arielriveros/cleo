import { Node } from 'cleo'

/**
 * Hollow Keep — a weapon. Attach to each weapon node under the Player's `Weapons` group.
 *
 *   Weapons
 *   └── Weapon_StraightSword     this script; Socket: RightHand (Attach to socket, target parent)
 *       ├── Mesh                 the visible weapon — swap the model here; its local transform IS the grip
 *       ├── Light1 Light2 Light3 SoulsMove data nodes — one per attack in the moveset
 *       └── Heavy
 *
 * The weapon node itself is driven by the socket every frame, so never offset IT to fix a grip: rotate
 * and move the `Mesh` child instead (see SOULS_DEMO.md, "Swapping a weapon").
 *
 * Every attack is a child node rather than a list field, because script fields are numbers, strings,
 * booleans and vectors only. Selecting a move in the hierarchy shows its inspector; duplicating one adds
 * an attack. The chain is `lightMove` → each move's `next` → ... and `heavyMove` on its own.
 *
 * Attack rating (see SoulsGameManager.attackRating):
 *
 *   AR = baseDamage × (1 + strScaling·bonus(STR) + dexScaling·bonus(DEX)),  ×0.6 if a requirement is unmet
 */
export default class SoulsWeaponNode extends Node {
  public displayName: string = 'Straight Sword'
  public baseDamage: number = 100
  /** How fully the weapon scales with each stat: 1.0 is an "A", 0.2 an "E". */
  public strScaling: number = 0.2
  public dexScaling: number = 0.8
  public strRequirement: number = 8
  public dexRequirement: number = 10
  /** Poise damage per hit, before the move's own multiplier. */
  public poiseDamage: number = 15
  /** Multiplies every move's stamina cost. */
  public staminaMul: number = 1
  /** First move of the light chain, and the heavy attack. Names of child SoulsMove nodes. */
  public lightMove: string = 'Light1'
  public heavyMove: string = 'Heavy'
  /** Marker the player looks for among its Weapons group. */
  public isWeapon: boolean = true

  /** The child SoulsMove named `name`, or null. */
  public findMove(name: string): Node {
    if (!name) return null
    const found = this.getChildByName(name)[0]
    return found && (found as any).isMove ? found : null
  }

  /** Every move, in hierarchy order. */
  public moves(): Node[] {
    return this.children.filter(c => (c as any).isMove)
  }
}
