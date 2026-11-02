import { Game, Input, Node, UIButtonNode, UIRootNode } from 'cleo'

/**
 * Hollow Keep — the pause menu. Attach to the `PauseMenu` node, a screen-space UI Root authored hidden,
 * a child of the Player like the HUD and the bonfire menu.
 *
 *   Card
 *     Title                "PAUSED"                                 uiText
 *     Resume               back to the game                          uiButton
 *     Bonfire              return to the last bonfire rested at      uiButton
 *     Hint                 the controls line                         uiText
 *
 * Pause (P, Escape, or Start on a pad — the UI map) opens it: the game is paused with `Game.pause()`, so
 * physics, scripts, timers and animation all stop where they are. Pause or Cancel closes it; the mouse
 * can click either button.
 *
 * It listens in a LATE UPDATE (`scene.addLateUpdate`), not in onUpdate: while the game is paused no node's
 * onUpdate runs, so a menu that polled there could open but never close. Late updates run every frame,
 * paused or not, and input is read every frame too.
 *
 * It never opens over another menu (resting at a bonfire, a yes/no dialog) or while the player is dying,
 * nor in the moment just after one closes: Escape is also the bonfire menu's Cancel, and the press that
 * closes that menu must not open this one.
 */
export default class SoulsPauseMenuNode extends UIRootNode {
  /** Real seconds after another menu closes during which Pause is ignored (see above). */
  public reopenGuard: number = 0.25
  public isOpen: boolean = false

  private _gm: Node = null
  private _player: Node = null
  private _menus: Node[] = []
  private _stopListening: (() => void) | null = null
  /** Real time (seconds), counted in the late update, and when another menu was last seen open. */
  private _clock: number = 0
  private _otherMenuAt: number = -1

  onStart() {
    this.visible = false
    this.isOpen = false
    this._gm = this.findNode('GameManager')
    this._player = this.findNode('Player')
    // The other menus this must not open over: the bonfire menu and the yes/no dialog.
    this._menus = [
      this._player?.getChildByName('BonfireMenu')[0],
      this._player?.getChildByName('ConfirmDialog')[0],
      this.findNode('ConfirmDialog'),
    ].filter(n => !!n && n !== this)
    const resume = this._find('Resume') as UIButtonNode
    if (resume) resume.onPress = () => this.close()
    const bonfire = this._find('Bonfire') as UIButtonNode
    if (bonfire) bonfire.onPress = () => this._toBonfire()
    this._stopListening = this.scene?.addLateUpdate((_delta, unscaled) => this._listen(unscaled)) ?? null
  }

  onDespawn() {
    this._stopListening?.()
    this._stopListening = null
    if (this.isOpen) this.close()
  }

  /** Pause the game and show the menu. */
  public open(): void {
    if (this.isOpen) return
    this.isOpen = true
    this.visible = true
    Game.clearSlowMotion()
    Game.pause()
    Input.disableMap('Gameplay')
    Input.releaseMouse()
  }

  /** Hide the menu and carry on. */
  public close(): void {
    if (!this.isOpen) return
    this.isOpen = false
    this.visible = false
    Game.resume()
    // Another menu may have been opened underneath by a script; it keeps the Gameplay map off.
    if (!this._otherMenuOpen()) Input.enableMap('Gameplay')
    this._otherMenuAt = this._clock
  }

  private _listen(unscaled: number): void {
    this._clock += unscaled
    if (this._otherMenuOpen()) this._otherMenuAt = this._clock
    if (this.isOpen) {
      if (Input.started('Pause') || Input.started('Cancel')) this.close()
      else if (Input.started('Submit')) this.close()
      return
    }
    if (!Input.started('Pause') || !this._canPause()) return
    this.open()
  }

  private _canPause(): boolean {
    if (Game.isPaused) return false                        // paused by someone else (the editor)
    if (this._otherMenuOpen()) return false
    if (this._clock - this._otherMenuAt < this.reopenGuard) return false
    const p = this._player as any
    if (p?.isDead) return false
    return true
  }

  private _otherMenuOpen(): boolean {
    return this._menus.some(m => (m as any).isOpen)
  }

  private _toBonfire(): void {
    this.close()
    ;(this._gm as any)?.respawnAtBonfire?.()
  }

  private _find(name: string, under: Node = this): Node {
    for (const child of under.children) {
      if (child.name === name) return child
      const deeper = this._find(name, child)
      if (deeper) return deeper
    }
    return null
  }
}
