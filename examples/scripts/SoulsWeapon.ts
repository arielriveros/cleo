import { Node } from 'cleo'
import type { NodeName, SoundName, TemplateName } from 'cleo'
import { num, statBonus } from '@/Core/Scripts/SoulsMath'
import { playSound } from '@/Core/Scripts/SoulsAudio'

/**
 * Hollow Keep — the base WEAPON. Every weapon is its own template, made from the base "Weapon" template
 * as a VARIANT, with its own script extending this one:
 *
 *   Weapon (template)            this script; Socket: RightHand (attach to socket, target parent)
 *   └── Mesh                     the visible weapon — its local transform IS the grip
 *
 *   Straight Sword (variant)     SoulsStraightSword extends SoulsWeapon — its stats are that class's defaults
 *   ├── Mesh                     inherited, given the sword's parts and grip
 *   ├── Light1 Light2 Light3     SoulsMove data nodes, added by the variant — the moveset and its clips
 *   └── Heavy
 *
 * A character does not carry its weapons in its template. It names them (`weaponTemplates` on
 * SoulsCharacter) and spawns them on start, into the hand. So the same "Greatsword" template is the
 * player's second weapon and the Elite Knight's only one, and a change to it reaches both.
 *
 * The weapon owns everything about itself: its numbers, its hitbox, its moves (with the clips the wielder
 * plays), and the maths that turns a swing into damage (`attackRating`, `hitFor`, `strike`). The wielder
 * only decides WHEN to swing and WHAT the blade reached.
 *
 * The weapon node itself is driven by the socket every frame, so never offset IT to fix a grip: rotate
 * and move the `Mesh` child instead (see SOULS_DEMO.md, "Swapping a weapon").
 *
 * ## Hitbox
 *
 * `bladeStart`/`bladeEnd`/`bladeRadius` is a capsule along the blade, in the `Mesh` child's space. During
 * an attack's active window it is swept every frame against hurtboxes (SoulsHitbox).
 *
 * ## Attack rating
 *
 *   AR = baseDamage × (1 + strScaling·bonus(STR) + dexScaling·bonus(DEX)),  × unmetRequirementPenalty
 *        when a requirement is unmet
 */
export default class SoulsWeaponNode extends Node {
  public displayName: string = 'Weapon'
  public baseDamage: number = 100
  /** How fully the weapon scales with each stat: 1.0 is an "A", 0.2 an "E". */
  public strScaling: number = 0
  public dexScaling: number = 0
  public strRequirement: number = 0
  public dexRequirement: number = 0
  /** Attack-rating multiplier when the wielder misses a STR or DEX requirement. */
  public unmetRequirementPenalty: number = 0.6
  /** Poise damage per hit, before the move's own multiplier. */
  public poiseDamage: number = 15
  /** Multiplies every move's stamina cost. */
  public staminaMul: number = 1
  /** First move of the light chain, and the heavy attack. Names of child SoulsMove nodes. */
  public lightMove: NodeName = 'Light1'
  public heavyMove: NodeName = 'Heavy'
  /** The blade hitbox, in the Mesh child's space. See "Hitbox" above. */
  public bladeStart: number[] = [0, 0.12, 0]
  public bladeEnd: number[] = [0, 1, 0]
  public bladeRadius: number = 0.12
  /** Effect spawned where the blade meets a body, and the sound of the hit. */
  public hitSparkTemplate: TemplateName = 'Hit Spark'
  public hitSound: SoundName = 'Hit'
  /** Marker characters look for among the nodes they spawn (a script class is never `instanceof`). */
  public isWeapon: boolean = true

  protected _gm: Node = null

  onStart() {
    this._gm = this.findNode('GameManager')
  }

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

  /** This weapon's attack rating in the hands of someone with these stats. See "Attack rating". */
  public attackRating(strength: number, dexterity: number): number {
    let ar = this.baseDamage * (1 + this.strScaling * statBonus(strength) + this.dexScaling * statBonus(dexterity))
    if (strength < this.strRequirement || dexterity < this.dexRequirement) ar *= this.unmetRequirementPenalty
    return Math.round(ar)
  }

  /**
   * What one hit of `move` deals when `wielder` swings this: attack rating (from the wielder's own
   * STR/DEX, 10 when it has none) × the move's damage multiplier, and poise × the move's poise multiplier.
   */
  public hitFor(wielder: Node, move: any): { damage: number; poise: number } {
    const w = wielder as any
    const ar = this.attackRating(num(w?.strength, 10), num(w?.dexterity, 10))
    return {
      damage: Math.round(ar * num(move?.damageMul, 1)),
      poise: this.poiseDamage * num(move?.poiseMul, 1),
    }
  }

  /**
   * The blade reached `target`'s hurtbox at `point` during `move`. The target takes the hit through its
   * own `receiveHit` (its defence, its poise, its reaction are its business). Returns true if it landed.
   */
  public strike(wielder: Node, move: any, target: Node, point: ArrayLike<number>): boolean {
    const t = target as any
    if (!wielder || typeof t?.receiveHit !== 'function') return false
    const { damage, poise } = this.hitFor(wielder, move)
    if (!t.receiveHit(damage, poise, wielder)) return false
    const gm = (this._gm ?? this.findNode?.('GameManager')) as any
    if (point) gm?.fx?.(this.hitSparkTemplate, point)
    playSound(this, this.hitSound)
    return true
  }
}
