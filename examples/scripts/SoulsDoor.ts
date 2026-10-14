import { Node } from 'cleo'
import { playSound } from './SoulsAudio'

/**
 * Hollow Keep — a door or portcullis that slides open. Attach to a node with a STATIC box body at the
 * scene root (or under an untransformed group); its visual is the node's own model or a child.
 *
 * Opened by a lever (`openDoor()`). From the locked side it is an interactable that only says why it
 * will not open — the souls convention that tells the player a shortcut exists. "Locked side" is the
 * side the node's local +Z points AWAY from when `lockedFromFront` is false, and toward when true.
 *
 * The slide moves the whole node, body included, so nothing else needs to know the door moved.
 */
export default class SoulsDoorNode extends Node {
  /** Offset from the closed position when fully open, in world metres. */
  public openOffset: [number, number, number] = [0, 4.2, 0]
  public openSeconds: number = 1.6
  public isOpen: boolean = false
  public lockedText: string = 'Opens from the other side'
  public lockedFromFront: boolean = false

  private _gm: Node = null
  private _closed: number[] = [0, 0, 0]
  private _t: number = 0
  private _opening: boolean = false

  onStart() {
    this._gm = this.findNode('GameManager')
    const p = this.position
    this._closed = [p[0], p[1], p[2]]
    if (this.isOpen) this._apply(1)
    ;(this._gm as any)?.registerInteractable?.(this)
  }

  onDespawn() {
    ;(this._gm as any)?.unregisterInteractable?.(this)
  }

  public canInteract(player: Node): boolean {
    if (this.isOpen || this._opening || !player) return false
    const p = player.worldPosition
    const me = this.worldPosition
    const f = this.worldForward
    const front = (p[0] - me[0]) * f[0] + (p[2] - me[2]) * f[2] > 0
    return front === this.lockedFromFront
  }

  public promptText(player: Node): string { return 'Examine' }

  public interact(player: Node): void {
    ;(this._gm as any)?.notice?.(this.lockedText)
  }

  public openDoor(): void {
    if (this.isOpen || this._opening) return
    this._opening = true
    this._t = 0
    playSound(this, 'Door')
  }

  onUpdate(delta: number) {
    if (!this._opening) return
    this._t = Math.min(1, this._t + delta / Math.max(0.01, this.openSeconds))
    this._apply(this._t * this._t * (3 - 2 * this._t))
    if (this._t >= 1) {
      this._opening = false
      this.isOpen = true
      ;(this._gm as any)?.notice?.('A shortcut has opened')
    }
  }

  private _apply(k: number): void {
    this.setPosition([
      this._closed[0] + this.openOffset[0] * k,
      this._closed[1] + this.openOffset[1] * k,
      this._closed[2] + this.openOffset[2] * k,
    ])
  }
}
