import { Game, Input, Logger, Node, SaveGame, UIButtonNode, UIRootNode } from 'cleo'
import type { ActionName } from 'cleo'
import { attribute } from 'cleo/decorators'

/**
 * Duskwell -- the title screen. Attach to the `Title` screen-space UI Root, authored hidden:
 *
 *   Backdrop
 *     Card
 *       Heading     "Duskwell"                              uiText
 *       Continue    loads the last checkpoint's save        uiButton
 *       New Game    starts again from the beginning         uiButton
 *       Hint        the keys                                uiText
 *
 * It shows only when there is a save to go back to and this session did not come from one: a first game
 * goes straight in, and so does one the title already let through (the `started` global, kept in every
 * save). While it shows the game is paused. Jump picks Continue and Dash picks New Game, or click.
 *
 * It listens in a LATE UPDATE, which runs every frame paused or not: no node's onUpdate runs while paused.
 */
export default class DuskTitle extends UIRootNode {
  /** The slot Continue loads: the one the checkpoints save to. */
  @attribute
  public slot: string = 'auto'
  @attribute
  public continueAction: ActionName = 'Jump'
  @attribute
  public newGameAction: ActionName = 'Dash'
  @attribute
  public isOpen: boolean = false

  private _stopListening: (() => void) | null = null

  async onStart() {
    this.visible = false
    this.isOpen = false
    const resume = this._find('Continue') as UIButtonNode
    if (resume) resume.onPress = () => this._continue()
    const fresh = this._find('New Game') as UIButtonNode
    if (fresh) fresh.onPress = () => this._newGame()
    this._stopListening = this.scene?.addLateUpdate(() => this._listen()) ?? null

    // Loaded (Continue, or the editor's Play from save), already past this screen, or nowhere to save to.
    if (!SaveGame.available || SaveGame.loadedFrom || SaveGame.has('started')) return
    let saved = false
    try { saved = await SaveGame.exists(this.slot) } catch { saved = false }
    if (!saved) { SaveGame.set('started', true); return }
    this.open()
  }

  onDespawn() {
    this._stopListening?.()
    this._stopListening = null
  }

  public open(): void {
    this.isOpen = true
    this.visible = true
    Game.pause()
    Input.releaseMouse()
  }

  public close(): void {
    if (!this.isOpen) return
    this.isOpen = false
    this.visible = false
    Game.resume()
  }

  private _listen(): void {
    if (!this.isOpen) return
    if (Input.started(this.continueAction)) this._continue()
    else if (Input.started(this.newGameAction)) this._newGame()
  }

  private _continue(): void {
    this.close()
    SaveGame.load(this.slot, { loadingScreen: { title: 'Duskwell' } })
      .catch(e => Logger.warn(`Continue: ${e?.message ?? e}`, 'Script'))
  }

  private _newGame(): void {
    // The lamps, pickups and moves of the last game stay in its save (slot `auto`) until a lamp saves over it.
    SaveGame.newGame()
    SaveGame.set('started', true)
    this.close()
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
