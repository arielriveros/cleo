import { Node } from 'cleo'

/**
 * Hollow Keep — one attack of a weapon's moveset. Attach to a plain child node of a SoulsWeapon; the
 * node's NAME is what the weapon's `lightMove`/`heavyMove` and other moves' `next` refer to.
 *
 * ## Timing
 *
 * Three moments drive an attack, and they come from EVENT MARKERS on the clip when it has them:
 *
   *   hit       the blade becomes ACTIVE: from here until `hitEnd` it is swept every frame and damages
 *             each enemy hurtbox it touches, once per swing (SoulsHitbox)
 *   hitEnd    the blade stops being active
 *   combo     from here a buffered attack chains into `next`
 *   recover   from here a buffered roll or drink may cancel the rest of the swing
 *
 * Author them on the clip's timeline in the Animation editor. A clip with no `hit` event uses the
 * `hitTime`/`comboTime`/`recoverTime` fields below instead (CLIP seconds, i.e. before `playSpeed`), so a
 * freshly imported animation is playable straight away and only gets better once marked up.
 *
 * The clip must be IN PLACE: one-shot actions ignore root motion. Forward travel is `lunge*` below.
 */
export default class SoulsMoveNode extends Node {
  /** Animation clip played for this attack (a clip on the player's rig). */
  public clip: string = 'Souls_Sword_L1'
  public playSpeed: number = 1
  /** Multipliers on the weapon's attack rating and poise damage. */
  public damageMul: number = 1
  public poiseMul: number = 1
  public staminaCost: number = 16
  /**
   * The swing bounces off walls (`blocksSwings` bodies) it reaches before any enemy: sparks, a recoil, no
   * damage. Heavy slams turn it off and plough through.
   */
  public bounceOff: boolean = true
  /** Forward drive: from `lungeStart` (clip seconds) for `lungeSeconds`, at `lungeSpeed` m/s. */
  public lungeStart: number = 0.1
  public lungeSeconds: number = 0.15
  public lungeSpeed: number = 2.5
  /** Seconds after the swing starts during which the player can still turn toward the target. */
  public trackSeconds: number = 0.2
  /** Fallback timings, used only when the clip carries no `hit` event. Clip seconds. */
  public hitTime: number = 0.38
  public activeSeconds: number = 0.15
  public comboTime: number = 0.45
  public recoverTime: number = 0.62
  /** Name of the move a buffered light attack chains into. Empty restarts the chain. */
  public next: string = 'Light2'
  public isMove: boolean = true
}
