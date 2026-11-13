import { Area2DNode, Node } from 'cleo'

/**
 * Duskwell -- something lying in the world for the player to take. Attach to an Area 2D that sees the
 * player's layer; its children are the visuals (a sprite), which bob.
 *
 *   kind = 'diamond'     +`amount` diamonds
 *   kind = 'heart'       heals `amount`
 *   kind = 'dash' | 'doubleJump' | 'wallJump'   a movement ability, for good
 *
 * The player decides what a kind does (DuskPlayer.collect); this only hands it over and goes.
 */
export default class DuskPickup extends Area2DNode {
  public kind: string = 'diamond'
  public amount: number = 1
  public bobHeight: number = 0.12
  public bobSpeed: number = 3

  private _time: number = 0
  private _taken: boolean = false
  private _base: number[] = []

  onStart() {
    this._time = (this.worldPosition[0] * 0.37) % 6.28
    this._base = this.children.map(c => c.position[1])
  }

  onUpdate(delta: number) {
    this._time += delta * this.bobSpeed
    const y = Math.sin(this._time) * this.bobHeight
    this.children.forEach((c, i) => {
      if (this._base[i] === undefined) return
      const p = c.position
      c.setPosition([p[0], this._base[i] + y, p[2]])
    })
  }

  onTriggerEnter(other: Node) {
    if (this._taken || typeof (other as any).collect !== 'function') return
    this._taken = true
    ;(other as any).collect(this.kind, this.amount)
    this.enabled = false
    this.remove()
  }
}
