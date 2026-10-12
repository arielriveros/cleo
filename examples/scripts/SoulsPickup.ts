import { Node } from 'cleo'

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
  public pickupClip: string = 'Souls_Pickup'
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
    else if (this.kind === 'flaskShard') { p.estusMax = (p.estusMax ?? 3) + 1; p.estus = p.estusMax }
    else if (this.kind === 'flaskCharge') p.estus = Math.min(p.estusMax ?? 3, (p.estus ?? 0) + Math.max(1, this.amount))
    gm?.notice?.('Picked up ' + this.itemName)
    gm?.sfx?.('Pickup')
    this.visible = false
    gm?.unregisterInteractable?.(this)
  }
}
