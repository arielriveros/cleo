import { Node } from 'cleo'

/**
 * Hollow Keep — the bloodstain left where the player died, holding every soul they carried. Attach to
 * the root of the `Bloodstain` template; the GameManager instantiates it on every death and sets `souls`.
 *
 * Touch it to get the souls back. Die again before you do and the manager replaces it with a new one —
 * the old souls are gone for good. See SoulsBonfire for the interactable protocol.
 *
 * It is also the pool of blood where the player last died: its decal children play their flipbook (a pool
 * spreading) when it appears. With no souls in it, it is only that: its `Glow` hides and there is nothing
 * to retrieve.
 */
export default class SoulsBloodstainNode extends Node {
  public souls: number = 0

  private _gm: Node = null
  private _taken: boolean = false
  private _shown: boolean = false

  onStart() {
    this._gm = this.findNode('GameManager')
    ;(this._gm as any)?.registerInteractable?.(this)
  }

  onUpdate() {
    // On the first frame, once the manager has set `souls` (it does so right after instantiating).
    if (this._shown) return
    this._shown = true
    for (const c of this.children) {
      if (c.nodeType === 'decal') (c as any).playFlipbook?.()
      else if (c.name === 'Glow' && !(this.souls > 0)) c.visible = false
    }
  }

  onDespawn() {
    ;(this._gm as any)?.unregisterInteractable?.(this)
  }

  public canInteract(player: Node): boolean { return !this._taken && this.souls > 0 && !(player as any)?.isDead }
  public promptText(player: Node): string { return 'Retrieve souls' }

  public interact(player: Node): void {
    if (this._taken) return
    this._taken = true
    const p = player as any
    p.playGesture?.('Pickup', 0.8)
    p.addSouls?.(this.souls)
    const gm = this._gm as any
    gm?.onBloodstainRecovered?.(this)
    gm?.notice?.('Souls retrieved')
    this.remove()
  }
}
