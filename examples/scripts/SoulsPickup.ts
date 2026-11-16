import { Node, save, find } from 'cleo'
import type { TriggerName } from 'cleo'
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
 * Pickups are one-shot for the whole game — resting does not bring them back, and neither does loading a
 * save (`taken` is @save). `hiddenUntilRevealed` keeps one invisible and unreachable until something calls
 * `reveal()` (the boss's reward does this).
 *
 * See SoulsBonfire for the interactable protocol.
 */
export default class SoulsPickupNode extends Node {
  public kind: string = 'souls'
  public amount: number = 200
  public itemName: string = 'Soul of a Lost Undead'
  public hiddenUntilRevealed: boolean = false
  /** The trigger of the player animator's gesture state played on taking it. */
  public pickupGesture: TriggerName = 'Pickup'
  @save
  public taken: boolean = false

  @find('GameManager')
  private _gm: Node = null

  onStart() {
    // Taken before a save that was loaded: gone, and not offered again.
    if (this.taken) { this.visible = false; return }
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
    p.playGesture?.(this.pickupGesture, 0.8)
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
