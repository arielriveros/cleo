import { Node } from 'cleo'

/**
 * Night Shift — a score pickup. Attach to the pickup's root node.
 *
 * ## The trigger has to be on a child
 *
 * A node registers `node.body || node.trigger` with the physics world — one or the other, and the body
 * wins. So a pickup that carried both would silently never fire. The template puts the trigger on a
 * dedicated `Trigger` child of the visual, and `onTrigger` is declared here on the child's script.
 *
 * This same class is attached to BOTH the visual root (for the bob and spin) and its trigger child (for
 * the pickup itself). `_isTrigger` decides which half runs, so there is only one file and one set of
 * tunables to keep in sync.
 *
 * ## Once, not once per frame
 *
 * The underlying contact event is guarded on the previous frame's collision matrix, so overlap does not
 * re-fire while you stand in it. It CAN fire again if contact is momentarily lost and regained across an
 * edge or a substep gap, which is exactly what happens when you walk the rim of a trigger — hence the
 * `_taken` latch. There is no exit event to pair with it.
 */
export default class NightShiftPickupNode extends Node {
  /** Points awarded. */
  public points: number = 100
  /** Degrees per second the visual spins. */
  public spinSpeed: number = 70
  /** Metres the visual rises and falls. */
  public bobHeight: number = 0.18
  /** Bobs per second. */
  public bobSpeed: number = 1.1

  private _taken: boolean = false
  private _isTrigger: boolean = false
  private _baseY: number = 0
  private _phase: number = 0
  private _director: Node = null

  onStart() {
    this._isTrigger = this.trigger !== null
    this._director = this.findNode('GameManager')
    this._baseY = this.position[1]
    // Desynchronise the bob so a field of pickups does not pulse in unison.
    this._phase = Math.random() * Math.PI * 2
  }

  onUpdate(delta: number, time: number) {
    if (this._isTrigger || this._taken) return
    this.rotateY(this.spinSpeed * delta)
    this.setY(this._baseY + Math.sin(time * this.bobSpeed * Math.PI * 2 + this._phase) * this.bobHeight)
  }

  onTrigger(other: Node) {
    if (this._taken || !other || !other.getVariable('isPlayer')) return
    this._taken = true
    this.collect()
  }

  /** Split out so a test can drive it without standing up a physics world. */
  public collect(): void {
    const director = this._director as any
    if (director && director.addScore) director.addScore(this.points)
    // The whole pickup goes, not just the trigger: `remove()` on a child would leave the visual behind.
    const root = this._isTrigger && this.parent ? this.parent : this
    root.remove()
  }
}
