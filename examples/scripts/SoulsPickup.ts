import { Node } from 'cleo'
import type { ClipName } from 'cleo'
import { playSound } from '@/Core/Scripts/SoulsAudio'

/**
 * Hollow Keep — an item lying in the world (the glowing corpse loot of the souls games). Attach to the
 * item's root; its children are the visuals (a mesh, a glow particle system, a light) and are hidden
 * once it is taken.
 *
 *   kind = 'souls'        adds `amount` souls
 *   kind = 'flaskShard'   +1 maximum Estus, and fills it
 *   kind = 'flaskCharge'  refills `amount` Estus, up to the maximum
 *
 * Pickups are one-shot for the whole session — resting does not bring them back. `hiddenUntilRevealed`
 * keeps one invisible and unreachable until something calls `reveal()` (the boss's reward does this).
 *
 * See SoulsBonfire for the interactable protocol.
 */
export default class SoulsPickupNode extends Node {
  public kind: string = 'souls'
  public amount: number = 200
  public itemName: string = 'Soul of a Lost Undead'
  public hiddenUntilRevealed: boolean = false
  public pickupClip: ClipName = 'Souls_Pickup'
  public taken: boolean = false

  private _gm: Node = null

  onStart() {
    this._gm = this.findNode('GameManager')
    if (this.hiddenUntilRevealed) this.visible = false
    else (this._gm as any)?.registerInteractable?.(this)
  }

  onDespawn() {
    ;(this._gm as any)?.unregisterInteractable?.(this)
  }

  public reveal(): void {
    if (this.taken) return
    this.visible = true
    ;(this._gm as any)?.registerInteractable?.(this)
  }

  public canInteract(player: Node): boolean { return !this.taken && this.visible }
  public promptText(player: Node): string { return 'Pick up ' + this.itemName }

  public interact(player: Node): void {
    if (this.taken) return
    const p = player as any
    const gm = this._gm as any
    this.taken = true
    p.playGesture?.(this.pickupClip, 0.8)
    if (this.kind === 'souls') p.addSouls?.(this.amount)
    // The flasks are the player's; it is asked to change them, never written to.
    else if (this.kind === 'flaskShard') p.addEstusFlask?.()
    else if (this.kind === 'flaskCharge') p.refillEstus?.(this.amount)
    gm?.notice?.('Picked up ' + this.itemName)
    playSound(this, 'Pickup')
    this.visible = false
    gm?.unregisterInteractable?.(this)
  }
}
