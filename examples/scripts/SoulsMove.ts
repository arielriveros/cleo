import { Node } from 'cleo'
import type { NodeName, TriggerName } from 'cleo'

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
 * `hitTime`/`comboTime`/`recoverTime` fields below instead (CLIP seconds from the move's start, i.e.
 * before its state's speed), so a freshly imported animation is playable straight away and only gets
 * better once marked up.
 *
 * ## Animation
 *
 * `animTrigger` names the animator trigger that plays the move: the player's animator has a state entered by
 * it, whose clip, speed, start in the clip and blends are the move's animation. A state that extracts its
 * root travel moves the body by the clip's own hips (an attack whose feet step goes exactly as far as they
 * do); otherwise the `lunge*` drive below does.
 *
 * ## One clip, several attacks
 *
 * A combo can be ONE continuous animation: each move's state plays a segment of it (its start time), and
 * hands over to the next move's state at the segment's end, on that move's trigger. A chained attack
 * restarts nothing -- the animation plays on into it. A segment that is not chained blends out.
 */
export default class SoulsMoveNode extends Node {
  /** The animator trigger that plays this move, e.g. "Longsword Light1". Empty: the node's name. */
  public animTrigger: TriggerName = ''
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
  public next: NodeName = 'Light2'
  public isMove: boolean = true
}
