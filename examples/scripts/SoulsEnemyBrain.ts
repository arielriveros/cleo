import { ControllerNode, Node } from 'cleo'

/**
 * Hollow Keep — an enemy's brain. Attach to the `Brain` child (the LAST child) of every enemy template,
 * a Controller node with Source: AI and Brain: Behaviour machine.
 *
 * Two jobs, both done in `onThink` — the last step of the control pass, so this frame's perception is
 * already in and the behaviour machine reads what is written here on the next frame:
 *
 * 1. **Targeting.** The engine has no factions: perception offers every other Character, and auto-acquire
 *    would have enemies chase each other. So `autoAcquire` is off and the target is the nearest NOTICED
 *    character carrying `targetMarker` (the player sets `isPlayer`). A held target is kept until
 *    perception forgets it. `SoulsEnemy.receiveHit` also writes the attacker in directly, so an enemy hit
 *    from behind turns round.
 *
 * 2. **Blackboard for the machine.** Booleans the behaviour machine switches on:
 *
 *      engage   the target is within the enemy's `engageRange`       -> Engage (the enemy script fights)
 *      leash    too far from home, or the player died                -> Return (path back to `goalPoint`)
 *      atHome   back within `homeRadius` of where it spawned         -> Idle
 *      awake    false only for a dormant boss                        -> stays Idle
 *      dead     set by the enemy on death                            -> Dead
 *
 * Leashing LATCHES: once an enemy turns for home it ignores the player until it gets there, which is
 * what stops it dithering at the edge of its range.
 */
export default class SoulsEnemyBrainNode extends ControllerNode {
  public targetMarker: string = 'isPlayer'
  /** Hysteresis on `engage`, so the hand-over does not flicker at the boundary. */
  public engageBand: number = 0.75
  public homeRadius: number = 1.2

  private _returning: boolean = false
  private _engaged: boolean = false

  onThink(delta: number) {
    const pawn = this.possessed as any
    if (!pawn) return
    const key = this.targetKey

    if (pawn.isDead) { this.setBlackboard('dead', true); return }
    this.setBlackboard('dead', false)
    this.setBlackboard('awake', pawn.isAwake !== false)

    const home = pawn.home ?? [0, 0, 0]
    this.goalPoint = [home[0], home[1], home[2]]
    const self = this.possessed.worldPosition
    const fromHome = Math.hypot(self[0] - home[0], self[2] - home[2])
    const atHome = fromHome <= this.homeRadius
    this.setBlackboard('atHome', atHome)

    // ----- acquisition (the faction filter) -----
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
    let targetId: string = bestId ?? (heldValid ? heldId : null)
    const target: Node = targetId ? this.scene?.getNodeById(targetId) : null
    const targetDead = !!(target as any)?.isDead

    // ----- leash (latched) -----
    if (!pawn.isBoss && fromHome > (pawn.leashRange ?? 25)) this._returning = true
    if (targetDead) this._returning = true
    if (this._returning && atHome) this._returning = false
    if (this._returning) targetId = null
    this.setBlackboard('leash', this._returning)
    this.setBlackboard(key, targetId ?? undefined)

    // ----- engage band -----
    let engage = false
    if (targetId && target && pawn.isAwake !== false) {
      const p = target.worldPosition
      const d = Math.hypot(p[0] - self[0], p[2] - self[2])
      const range = pawn.engageRange ?? 4
      engage = this._engaged ? d <= range + this.engageBand : d <= range
    }
    this._engaged = engage
    this.setBlackboard('engage', engage)
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
