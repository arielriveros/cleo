import { AnimatedSpriteNode, Area2DNode, Node } from 'cleo'

/**
 * Duskwell -- a checkpoint: a lamp the player lights by walking past it. Attach to an Area 2D that sees the
 * player's layer; its `Lamp` child is the sprite, dim until lit. Lighting it heals the player and makes it
 * where the player comes back after a death.
 */
export default class DuskCheckpoint extends Area2DNode {
  public litTint: number[] = [1, 1, 1]
  public unlitTint: number[] = [0.35, 0.35, 0.45]
  public healTo: number = 99

  private _lit: boolean = false
  private _lamp: AnimatedSpriteNode = null

  onStart() {
    this._lamp = this.getChildByName('Lamp')[0] as AnimatedSpriteNode
    if (this._lamp) this._lamp.tint = this.unlitTint as [number, number, number]
  }

  onTriggerEnter(other: Node) {
    const p = other as any
    if (typeof p.setRespawn !== 'function') return
    const here = this.worldPosition
    p.setRespawn(here[0], here[1] - this.size[1] / 2 + 0.01)
    p.heal?.(this.healTo)
    if (this._lit) return
    this._lit = true
    if (this._lamp) this._lamp.tint = this.litTint as [number, number, number]
    p.say?.('Checkpoint')
  }
}
