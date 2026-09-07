import { ControllerNode, Node } from 'cleo'

/**
 * Night Shift — the zombie's driver. Attach to the `Brain` child of the Zombie template, on a Controller
 * node with Source: AI.
 *
 * This exists for one reason: **the engine has no faction system.** `ControllerNode.perceive` offers
 * every other Character in the scene as a perception candidate, and the built-in `autoAcquire` takes the
 * nearest NOTICED one. Zombies are Characters, so with auto-acquire left on, zombies target each other
 * and the horde mills around itself while the player walks past untouched.
 *
 * So the template sets `autoAcquire = false` and acquisition happens here instead, filtered to nodes
 * carrying an `isPlayer` variable (set by `NightShiftPlayer.onStart`). Matching on a variable rather than
 * on the node's name means renaming the Playable cannot silently blind every zombie.
 *
 * ## Why `onThink`
 *
 * It runs LAST in the control pass, after possession, the aim basis and this frame's perception are all
 * resolved, and before any node's `onUpdate` reads the result. Writing the blackboard anywhere else
 * would act on the previous frame's senses.
 *
 * ## Why a target is kept after it goes out of sight
 *
 * `investigate` walks to where the target was last seen, and it can only do that while the blackboard
 * still names it. Dropping the target the moment line of sight breaks is what makes an agent forget you
 * the instant you round a corner — the memory span exists precisely to stop that. So a held target is
 * kept until perception has genuinely forgotten it.
 *
 * The engine's own `_acquire` uses `Perception.remembers` for that test, but `ControllerNode._perception`
 * is private and `sightingOf` is not re-exposed on the controller. `sightings` is, and it carries
 * `timeSinceSeen`, so the same question is answered here directly.
 */
export default class NightShiftZombieBrainNode extends ControllerNode {
  /** Node variable that marks something worth hunting. */
  public targetMarker: string = 'isPlayer'

  onThink(delta: number) {
    const key = this.targetKey
    const held = this.getBlackboard(key)
    const heldId = typeof held === 'string' && held ? held : null

    const self = this.possessed ? this.possessed.worldPosition : this.worldPosition
    let bestId: string = null
    let bestDistance: number = Infinity
    let heldRemembered: boolean = false

    for (const sighting of this.sightings) {
      const candidate = this.scene?.getNodeById(sighting.id)
      if (!candidate || !candidate.getVariable(this.targetMarker)) continue

      // `timeSinceSeen` is 0 while visible and Infinity if never seen, so this covers both.
      if (sighting.id === heldId && sighting.timeSinceSeen <= this.perception.memorySpan) {
        heldRemembered = true
      }

      if (!sighting.noticed) continue
      const p = candidate.worldPosition
      const distance = Math.hypot(p[0] - self[0], p[1] - self[1], p[2] - self[2])
      if (distance < bestDistance) {
        bestDistance = distance
        bestId = sighting.id
      }
    }

    if (bestId) { this.setBlackboard(key, bestId); return }
    // Nothing in sight. Hold the last target until its memory lapses, then genuinely forget it.
    if (heldId && !heldRemembered) this.setBlackboard(key, undefined)
  }
}
