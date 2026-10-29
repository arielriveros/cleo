import { ControllerNode, Node } from 'cleo'

/**
 * Hollow Keep — an enemy's brain script. Attach to the `Brain` child (the LAST child) of every enemy
 * template: a Controller node with Source: AI, Brain: Behaviour machine, linked to the type's AI graph
 * (`<Type> Brain.brain` under /AI).
 *
 * The GRAPH makes every decision — chase, close in, strafe, back off, attack, flinch, give up and walk
 * home — reading perception senses and the enemy's own fields. This script does the two things a graph
 * cannot express, in `onThink` (the last step of the control pass, so this frame's perception is in):
 *
 * 1. **Targeting.** The engine has no factions: perception offers every other Character, and auto-acquire
 *    would have enemies chase each other. So `autoAcquire` is off and the target is the nearest NOTICED
 *    character carrying `targetMarker` (the player sets `isPlayer`). A held target is kept until
 *    perception forgets it. `SoulsEnemy.receiveHit` also writes the attacker in directly, so an enemy hit
 *    from behind turns round.
 *
 * 2. **Home.** `goalPoint` is where the enemy spawned, which the graph's Return state paths back to.
 */
export default class SoulsEnemyBrainNode extends ControllerNode {
  public targetMarker: string = 'isPlayer'

  onThink(delta: number) {
    const pawn = this.possessed as any
    if (!pawn || pawn.isDead) return
    const key = this.targetKey

    const self = this.possessed.worldPosition
    // On patrol, "home" walks with the enemy: the leash is measured from where it LEFT its route, and
    // giving up a chase returns it there. Left at the spawn, a patrol that saw the player 25 m down the
    // road was already past its leash, so it gave up the chase the moment it began and never attacked.
    if (this.behaviorState === 'Patrol' && pawn.home) pawn.home = [self[0], self[1], self[2]]
    const home = pawn.home ?? [0, 0, 0]
    this.goalPoint = [home[0], home[1], home[2]]

    const held = this.getBlackboard(key)
    const heldId = typeof held === 'string' && held ? held : null
    let bestId: string = null
    let bestDistance = Infinity
    let heldRemembered = false
    for (const sighting of this.sightings) {
      const candidate = this.scene?.getNodeById(sighting.id)
      if (!candidate || !candidate.getVariable(this.targetMarker)) continue
      if (sighting.id === heldId && sighting.timeSinceSeen <= this.perception.memorySpan) heldRemembered = true
      if (!sighting.noticed) continue
      const p = candidate.worldPosition
      const d = Math.hypot(p[0] - self[0], p[1] - self[1], p[2] - self[2])
      if (d < bestDistance) { bestDistance = d; bestId = sighting.id }
    }
    // A held target written by `receiveHit` or `awaken` survives even unseen for the memory span; a boss
    // never forgets the player inside its arena.
    const heldValid = !!heldId && (heldRemembered || pawn.isBoss || this._heldFresh(heldId))
    this.setBlackboard(key, bestId ?? (heldValid ? heldId : undefined))
  }

  /**
   * A target written in from outside perception (a hit from behind) has no sighting yet. Keep it while
   * it is within perception range, so the enemy turns and closes in rather than shrugging it off.
   */
  private _heldFresh(id: string): boolean {
    const node = this.scene?.getNodeById(id)
    if (!node || !this.possessed) return false
    const a = node.worldPosition
    const b = this.possessed.worldPosition
    return Math.hypot(a[0] - b[0], a[2] - b[2]) <= this.perception.range
  }
}
