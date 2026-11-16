import { AnimatedSpriteNode, Logger, Node, SaveGame, TriggerNode, save, child } from 'cleo'

/**
 * Duskwell -- a checkpoint: a lamp the player lights by walking past it. Attach to an Area 2D that sees the
 * player's layer; its `Lamp` child is the sprite, dim until lit. Lighting it heals the player and makes it
 * where the player comes back after a death.
 *
 * Every lamp the player reaches saves the game to the `auto` slot (SaveGame): the diamonds and moves the
 * player carries, the lamps lit, the pickups taken. The title screen's Continue loads it.
 */
export default class DuskCheckpoint extends TriggerNode {
  public litTint: number[] = [1, 1, 1]
  public unlitTint: number[] = [0.35, 0.35, 0.45]
  public healTo: number = 99

  /** Whether the lamp is lit: a loaded game keeps it lit. */

  @save
  private _lit: boolean = false
  @child('Lamp')
  private _lamp: AnimatedSpriteNode = null

  onStart() {
    // A lamp lit before a save comes back lit (the field is @save).
    if (this._lamp) this._lamp.tint = (this._lit ? this.litTint : this.unlitTint) as [number, number, number]
  }

  onTriggerEnter(other: Node) {
    const p = other as any
    if (typeof p.setRespawn !== 'function') return
    const here = this.worldPosition
    p.setRespawn(here[0], here[1] - this.size[1] / 2 + 0.01)
    p.heal?.(this.healTo)
    if (!this._lit) {
      this._lit = true
      if (this._lamp) this._lamp.tint = this.litTint as [number, number, number]
      p.say?.('Checkpoint')
    }
    this._save()
  }

  /** The checkpoint save. Only where the game can save (it cannot in a test with no store, say). */
  private _save() {
    if (!SaveGame.available) return
    SaveGame.save('auto', { label: this.name })
      .catch(e => Logger.warn(`The checkpoint could not save: ${e?.message ?? e}`, 'Script'))
  }
}
