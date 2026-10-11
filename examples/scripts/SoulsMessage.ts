import { Node } from 'cleo'

/**
 * Hollow Keep — a readable message on the ground: tutorial hints and lore. Attach to the message's root
 * (a glowing glyph mesh and a few motes). Interact shows `title` and `text` in the HUD's message panel,
 * which closes when the player presses Interact again or walks away.
 *
 * `\n` in `text` is a line break. See SoulsBonfire for the interactable protocol.
 */
export default class SoulsMessageNode extends Node {
  public title: string = 'A message'
  public text: string = 'Try rolling.'
  public interactRadius: number = 1.6
  public hiddenUntilRevealed: boolean = false

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
    this.visible = true
    ;(this._gm as any)?.registerInteractable?.(this)
  }

  public canInteract(player: Node): boolean { return this.visible }
  public promptText(player: Node): string { return 'Read message' }

  public interact(player: Node): void {
    const gm = this._gm as any
    gm?.showMessage?.(this.title, this.text.split('\\n').join('\n'), this)
  }
}
