import { Node } from 'cleo'

/**
 * Hollow Keep — a bonfire. Attach to the bonfire's root node.
 *
 *   Bonfire           this script
 *   ├── Model         the coiled sword and ash — swap freely
 *   ├── Fire          particle system, playing only while lit
 *   ├── Fire Light    point light, on only while lit
 *   └── RespawnPoint  empty node: where (and facing where) the player respawns
 *
 * `Fire` may instead be a whole fire carrying the Valley's Fire Light script (ValleyFireLight.ts), with its
 * flames, embers and light under it: then it is lit and put out through its `lit`, and `Fire Light` is optional.
 *
 * ## The interactable protocol
 *
 * Every interactable in Hollow Keep — this, pickups, bloodstains, messages, the lever, the door and the
 * fog gate — carries a TRIGGER volume (its interaction zone, authored on the node like a collider) and
 * implements the same three members. Walking into the zone makes it a candidate (the player's
 * onTriggerEnter); walking out removes it. Of the candidates whose `canInteract` passes, the player
 * prompts for the nearest and calls `interact` on Interact. No distance is measured in script:
 *
 *   canInteract(player): boolean    whether to offer it at all right now
 *   promptText(player): string      what the HUD prompt says
 *   interact(player): void          do it
 *
 * First use lights it (BONFIRE LIT, and it becomes the respawn point). After that, Interact rests:
 * heal, refill flasks, respawn enemies, open the level-up menu.
 */
export default class SoulsBonfireNode extends Node {
  public startLit: boolean = false
  public lightIntensity: number = 900
  public isBonfire: boolean = true
  public lit: boolean = false

  private _gm: Node = null
  private _fire: Node = null
  private _light: Node = null

  onStart() {
    this._gm = this.findNode('GameManager')
    this._fire = this.getChildByName('Fire')[0] ?? null
    this._light = this.getChildByName('Fire Light')[0] ?? null
    this.lit = this.startLit
    this._applyLit()
    ;(this._gm as any)?.registerInteractable?.(this)
  }

  onDespawn() {
    ;(this._gm as any)?.unregisterInteractable?.(this)
  }

  public canInteract(player: Node): boolean {
    return !(player as any)?.isDead
  }

  public promptText(player: Node): string {
    return this.lit ? 'Rest at bonfire' : 'Light bonfire'
  }

  public interact(player: Node): void {
    const p = player as any
    const gm = this._gm as any
    if (!this.lit) {
      this.lit = true
      this._applyLit()
      p.playGesture?.('Souls_Interact', 1)
      gm?.lightBonfire?.(this)
      return
    }
    p.sitAtBonfire?.()
    gm?.rest?.(this)
  }

  /** Where the player stands up after a death. */
  public respawnPoint(): Node {
    return this.getChildByName('RespawnPoint')[0] ?? this
  }

  private _applyLit(): void {
    const fire = this._fire as any
    if (fire && 'lit' in fire) fire.lit = this.lit
    else if (fire) { if (this.lit) fire.play?.(); else fire.stop?.(true) }
    const light = (this._light as any)?.light
    if (light) light.intensity = this.lit ? this.lightIntensity : 0
  }
}
