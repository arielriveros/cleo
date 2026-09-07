import { Logger, Node } from 'cleo'

/**
 * Night Shift — the pickup spawner. ONE node at the scene root, and the only thing that places loot.
 *
 * Pickups used to be authored into the scene by hand, which meant the level had the same twelve items in
 * the same twelve places every night, and each of them had to be positioned above the terrain by eye.
 * They are scattered at runtime instead: a random point on the director's disc, dropped onto the ground
 * by a raycast, and rejected unless it landed on walkable terrain — so nothing spawns on the roof of the
 * house, where it could be seen but never collected.
 *
 * It runs once, shortly after the level starts, and then does nothing for the rest of it.
 *
 * NOT in `onStart`, and that is the whole reason `placeDelay` exists. The landscape's heightfield is
 * registered with the physics world inside `physics.update()`, which first runs AFTER `scene.start()`
 * has called every `onStart`. A ray fired down at that point passes through a world with no terrain in
 * it yet, every placement is rejected as "not ground", and the level comes up with no loot at all.
 *
 * `scoreCount` is published to the director as `itemsTotal` so the HUD's "found / total" counts what was
 * actually placed rather than what was hoped for. If the ground is too broken to fit them all, the total
 * says so instead of leaving a level that cannot be completed.
 */
export default class NightShiftPickupSpawnerNode extends Node {
  /** Template placed `scoreCount` times. */
  public scoreTemplate: string = 'Score Pickup'
  public scoreCount: number = 12
  /**
   * One of each powerup, by template name. Blank skips it — a level can leave out the instakill without
   * anything else changing.
   */
  public speedTemplate: string = 'Speed Powerup'
  public invincibilityTemplate: string = 'Invincibility Powerup'
  public firePowerupTemplate: string = 'Fire Powerup'
  /** Metres. Keeps loot from landing on top of the player's own spawn. */
  public minPlayerDistance: number = 8
  /** Metres. Stops two pickups landing in the same bush. */
  public minSpacing: number = 6
  /** Seconds to wait for the physics world to have the terrain in it. See the note above. */
  public placeDelay: number = 0.3
  /** How many times to wait again if the ground still is not there. */
  public groundRetries: number = 10

  private _placed: number[][] = []

  onStart() {
    this.after(this.placeDelay, () => this._scatter(this.groundRetries))
  }

  private _scatter(retriesLeft: number): void {
    const director = this.findNode('GameManager') as any
    if (!director || !director.findGroundSpot) {
      Logger.warn('Night Shift: the pickup spawner found no GameManager, so nothing was placed.', 'Script')
      return
    }

    // Probe once before committing. A miss here means the terrain is still not in the physics world, so
    // wait rather than scattering the whole level's loot into a void and reporting a total of zero.
    if (!director.groundAt(director.spawnCenter[0], director.spawnCenter[2]) && retriesLeft > 0) {
      this.after(this.placeDelay, () => this._scatter(retriesLeft - 1))
      return
    }

    let scored = 0
    for (let i = 0; i < this.scoreCount; i++) if (this._place(director, this.scoreTemplate)) scored++

    for (const template of [this.speedTemplate, this.invincibilityTemplate, this.firePowerupTemplate])
      if (template) this._place(director, template)

    // The HUD counts against this, so it has to be what was really placed.
    director.itemsTotal = scored
    if (scored < this.scoreCount) {
      Logger.warn('Night Shift: only ' + scored + ' of ' + this.scoreCount
        + ' pickups found walkable ground. Widen the director\'s spawnRadius, or raise maxSlope.', 'Script')
    }
  }

  private _place(director: any, template: string): boolean {
    // Several attempts per pickup: `findGroundSpot` rejects for slope and for the player, and this adds
    // spacing on top, so a single try would thin the field out on a broken map.
    for (let attempt = 0; attempt < 8; attempt++) {
      const at = director.findGroundSpot(this.minPlayerDistance)
      if (!at) continue
      if (this._crowded(at)) continue

      const node = this.scene?.instantiate(template, { position: at })
      if (!node) {
        Logger.warn('Night Shift: no "' + template + '" template to place.', 'Script')
        return false
      }
      this._placed.push(at)
      return true
    }
    return false
  }

  private _crowded(at: number[]): boolean {
    for (const other of this._placed)
      if (Math.hypot(at[0] - other[0], at[2] - other[2]) < this.minSpacing) return true
    return false
  }
}
