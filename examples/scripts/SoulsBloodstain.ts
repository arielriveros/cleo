import { Node } from 'cleo'

/**
 * Hollow Keep — the bloodstain left where the player died, holding every soul they carried. Attach to
 * the root of the `Bloodstain` template; the GameManager instantiates it on death and sets `souls`.
 *
 * Touch it to get the souls back. Die again before you do and the manager replaces it with a new one —
 * the old souls are gone for good. See SoulsBonfire for the interactable protocol.
 */
export default class SoulsBloodstainNode extends Node {
  public souls: number = 0

  private _gm: Node = null
  private _taken: boolean = false

  onStart() {
    this._gm = this.findNode('GameManager')
    ;(this._gm as any)?.registerInteractable?.(this)
  }

  onDespawn() {
    ;(this._gm as any)?.unregisterInteractable?.(this)
  }

  public canInteract(player: Node): boolean { return !this._taken && !(player as any)?.isDead }
  public promptText(player: Node): string { return 'Retrieve souls' }

  public interact(player: Node): void {
    if (this._taken) return
    this._taken = true
    const p = player as any
    p.playGesture?.('Souls_Pickup', 0.8)
    p.addSouls?.(this.souls)
    const gm = this._gm as any
    gm?.onBloodstainRecovered?.(this)
    gm?.notice?.('Souls retrieved')
    this.remove()
  }
}
