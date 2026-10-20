import { Input, Node, UIButtonNode, UIRootNode, UITextNode } from 'cleo'
import { playSound } from '@/Core/Scripts/SoulsAudio'

/**
 * A yes/no question over the game: "Enter the skull cave?". Attach to the `ConfirmDialog` node, a
 * screen-space UI Root authored hidden, on the player beside the bonfire menu:
 *
 *   ConfirmDialog
 *     Card
 *       Title, Body      uiText
 *       Yes, No          uiButton
 *
 * `ask(title, body, onYes)` opens it. Submit or Yes answers yes, Cancel or No answers no; the mouse can
 * click either. Gameplay input is off while it is open, and back on before `onYes` runs -- a scene
 * switch keeps the input maps as they are, so a dialog that loaded a scene while still holding Gameplay
 * off would leave the next scene unable to move.
 */
export default class SoulsConfirmDialogNode extends UIRootNode {
  public isOpen: boolean = false

  private _onYes: () => void = null
  private _openedAt: number = 0
  private _clock: number = 0

  onStart() {
    this.visible = false
    this.isOpen = false
    const yes = this._find('Yes') as UIButtonNode
    if (yes) yes.onPress = () => this._answer(true)
    const no = this._find('No') as UIButtonNode
    if (no) no.onPress = () => this._answer(false)
  }

  public ask(title: string, body: string, onYes: () => void): void {
    this._set('Title', title)
    this._set('Body', body)
    this._onYes = onYes
    this.isOpen = true
    this._openedAt = this._clock
    this.visible = true
    Input.disableMap('Gameplay')
    Input.releaseMouse()
    playSound(this, 'Menu Tick')
  }

  onUpdate(delta: number) {
    this._clock += delta
    if (!this.isOpen) return
    // Swallow the press that opened us (Interact may share a key with Submit).
    if (this._clock - this._openedAt < 0.2) return
    if (Input.started('Submit')) this._answer(true)
    else if (Input.started('Cancel')) this._answer(false)
  }

  private _answer(yes: boolean): void {
    if (!this.isOpen) return
    this.isOpen = false
    this.visible = false
    Input.enableMap('Gameplay')
    const then = this._onYes
    this._onYes = null
    if (yes) then?.()
  }

  private _set(name: string, text: string): void {
    const node = this._find(name) as UITextNode
    if (node) node.text = text
  }

  private _find(name: string, root: Node = this): Node {
    for (const child of root.children) {
      if (child.name === name) return child
      const found = this._find(name, child)
      if (found) return found
    }
    return null
  }
}
