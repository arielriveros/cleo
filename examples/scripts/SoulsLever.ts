import { Node, save, find, child, attribute } from 'cleo'
import { playSound } from '@/Core/Scripts/SoulsAudio'

/**
 * Hollow Keep — a lever that opens a door elsewhere (the shortcut back to the bonfire). Attach to the
 * lever's root; a child named `Handle` is swung through `swingDegrees` about X when pulled.
 *
 * One use. `doorName` names a node carrying SoulsDoor. See SoulsBonfire for the interactable protocol.
 * A save keeps `pulled` (the door keeps its own `isOpen`), so a loaded game finds the lever down.
 */
export default class SoulsLeverNode extends Node {
  @attribute
  public doorName: string = 'Shortcut Gate'
  @attribute
  public swingDegrees: number = 70
  @attribute
  public swingSeconds: number = 0.6
  @save
  @attribute
  public pulled: boolean = false

  @find('GameManager')
  private _gm: Node = null
  @child('Handle')
  private _handle?: Node
  private _t: number = -1
  private _rest: number[] = [0, 0, 0]

  onStart() {
    if (this._handle) { const r = this._handle.rotation; this._rest = [r[0], r[1], r[2]] }
    // Pulled before a save that was loaded: the handle down, and nothing left to offer.
    if (this.pulled) {
      this._handle?.setRotation([this._rest[0] + this.swingDegrees, this._rest[1], this._rest[2]])
      return
    }
    ;(this._gm as any)?.registerInteractable?.(this)
  }

  onDespawn() {
    ;(this._gm as any)?.unregisterInteractable?.(this)
  }

  public canInteract(player: Node): boolean { return !this.pulled }
  public promptText(player: Node): string { return 'Pull lever' }

  public interact(player: Node): void {
    if (this.pulled) return
    this.pulled = true
    this._t = 0
    ;(player as any).playGesture?.('Interact', 0.9)
    const gm = this._gm as any
    playSound(this, 'Lever')
    const door = this.findNode(this.doorName) as any
    if (door?.openDoor) this.after(this.swingSeconds, () => door.openDoor())
    gm?.unregisterInteractable?.(this)
  }

  onUpdate(delta: number) {
    if (this._t < 0 || !this._handle) return
    this._t = Math.min(1, this._t + delta / Math.max(0.01, this.swingSeconds))
    const k = this._t * this._t * (3 - 2 * this._t)
    this._handle.setRotation([this._rest[0] + this.swingDegrees * k, this._rest[1], this._rest[2]])
    if (this._t >= 1) this._t = -1
  }
}
