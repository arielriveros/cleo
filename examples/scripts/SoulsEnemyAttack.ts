import { Node } from 'cleo'

/**
 * Hollow Keep — one attack of an enemy's moveset. Attach to a plain child of the enemy's `Attacks`
 * group; the node's NAME identifies it (for `comboNext` and for the no-repeat rule).
 *
 * ## Choosing
 *
 * When its attack gap runs out, an engaged enemy picks among the attacks that are off `cooldown`, whose
 * `minRange`..`maxRange` contains the distance to the player, and whose `phase` it has reached (0/1:
 * always; 2: boss phase two only). It avoids repeating the last one when anything else fits, then rolls
 * weighted by `weight`. See SoulsGameManager.pickEnemyAttack.
 *
 * ## Timing
 *
 * The contact frame is a `hit` event on the clip (`cast` for a projectile attack). Without one, `hitTime`
 * (clip seconds) is used. At that moment a melee attack re-checks `hitRange` and `arcDeg` against where
 * the player is NOW, so rolling or stepping away during the wind-up works. With `aoeRadius > 0` it is a
 * slam that hits everything inside the radius regardless of facing. With a `projectileTemplate`, it
 * fires `projectileCount` projectiles fanned over `spreadDeg` instead.
 *
 * ## Movement
 *
 * The enemy turns toward the player for `trackSeconds`, then commits. It lunges forward from
 * `lungeStart` (clip seconds) for `lungeSeconds` at `lungeSpeed`; `lungeToTarget` instead covers the
 * distance to the player (capped at `lungeSpeed`) — the boss's leap. Clips must be in place.
 */
export default class SoulsEnemyAttackNode extends Node {
  public clip: string = 'Souls_Enemy_Swing'
  public playSpeed: number = 1
  public damage: number = 70
  public poiseDamage: number = 20
  public minRange: number = 0
  public maxRange: number = 2.2
  /** Reach checked at the contact frame, and the FULL width of the swing. */
  public hitRange: number = 2.2
  public arcDeg: number = 100
  public weight: number = 1
  public cooldown: number = 0
  public phase: number = 0
  public trackSeconds: number = 0.45
  public lungeStart: number = 0
  public lungeSeconds: number = 0
  public lungeSpeed: number = 0
  public lungeToTarget: boolean = false
  /** No flinch while this attack plays (poise breaks still stagger). */
  public hyperArmor: boolean = false
  /** Attack that follows immediately, without a gap, when the player is still in its range. */
  public comboNext: string = ''
  /** Fallback contact time (clip seconds) for a clip without a `hit`/`cast` event. */
  public hitTime: number = 0.6
  /** Ground-slam radius. 0 is an ordinary swing. */
  public aoeRadius: number = 0
  /** Effect template spawned at the enemy's feet on a slam. */
  public impactTemplate: string = ''
  /** Projectile template; non-empty makes this a ranged attack. */
  public projectileTemplate: string = ''
  public projectileSpeed: number = 12
  public projectileCount: number = 1
  public spreadDeg: number = 0
  /** Sound cue played when the attack starts (a SoundNode name under Sounds). */
  public sound: string = 'Enemy Swing'
  public isEnemyAttack: boolean = true
}
