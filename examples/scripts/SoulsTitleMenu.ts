import { Game, Input, Logger, Node, SaveGame, UIButtonNode, UIRootNode, attribute } from 'cleo'

/**
 * Hollow Keep — the title menu: Continue from the last bonfire, or start a new game. Attach to the `TitleMenu`
 * node, a screen-space UI Root authored hidden, a child of the Player like the other menus.
 *
 *   Backdrop
 *     Card
 *       Title       "HOLLOW KEEP"                              uiText
 *       Continue    load the game saved at the last bonfire     uiButton
 *       New Game    start again from the beginning               uiButton
 *       Hint        the controls line                            uiText
 *
 * It shows only when there is a bonfire save to go back to and this session did not begin from one: a first
 * game starts at once, and so does a game the menu already let through (the `started` global, which every
 * save carries). While it shows, the game is paused. Navigate up/down picks, Submit confirms; the mouse can
 * click either button.
 *
 * Like the pause menu it listens in a LATE UPDATE, which runs while the game is paused.
 */
export default class SoulsTitleMenuNode extends UIRootNode {
  /** The slot Continue loads: the one the bonfires save to (GameManager.saveSlot). */
  @attribute
  public slot: string = 'auto'
  @attribute
  public isOpen: boolean = false

  private _buttons: UIButtonNode[] = []
  private _selected: number = 0
  private _navLast: number = 0
  private _stopListening: (() => void) | null = null

  async onStart() {
    this.visible = false
    this.isOpen = false
    const resume = this._find('Continue') as UIButtonNode
    const fresh = this._find('New Game') as UIButtonNode
    this._buttons = [resume, fresh].filter(b => !!b)
    if (resume) resume.onPress = () => this._continue()
    if (fresh) fresh.onPress = () => this._newGame()
    this._stopListening = this.scene?.addLateUpdate(() => this._listen()) ?? null

    // Loaded (Continue, Load last rest, the editor's Play from save), already let through, or nowhere to save.
    if (!SaveGame.available || SaveGame.loadedFrom || SaveGame.has('started')) return
    let saved = false
    try { saved = await SaveGame.exists(this.slot) } catch { saved = false }
    if (!saved) { SaveGame.set('started', true); return }
    this.open()
  }

  onDespawn() {
    this._stopListening?.()
    this._stopListening = null
    if (this.isOpen) this.close()
  }

  public open(): void {
    this.isOpen = true
    this.visible = true
    this._selected = 0
    this._refresh()
    Game.pause()
    Input.disableMap('Gameplay')
    Input.releaseMouse()
  }

  public close(): void {
    if (!this.isOpen) return
    this.isOpen = false
    this.visible = false
    Game.resume()
    Input.enableMap('Gameplay')
  }

  private _listen(): void {
    if (!this.isOpen) return
    const nav = Input.vector('Navigate')
    const dy = Math.abs(nav[1]) > 0.5 ? Math.sign(nav[1]) : 0
    // Navigate Y is positive UP; the buttons run top to bottom. One step per press.
    if (dy && dy !== this._navLast && this._buttons.length) {
      this._selected = (this._selected - dy + this._buttons.length) % this._buttons.length
      this._refresh()
    }
    this._navLast = dy
    if (Input.started('Submit')) this._buttons[this._selected]?.onPress()
  }

  /** The selected button lit, the other dim. */
  private _refresh(): void {
    this._buttons.forEach((b, i) => {
      b.tint = i === this._selected ? [0.32, 0.26, 0.16, 1] : [0.18, 0.15, 0.12, 1]
    })
  }

  private _continue(): void {
    this.close()
    SaveGame.load(this.slot, { loadingScreen: { title: 'Hollow Keep' } })
      .catch(e => Logger.warn(`Hollow Keep: Continue could not load the save: ${e?.message ?? e}`, 'Script'))
  }

  private _newGame(): void {
    // The bonfire save stays in its slot until the next bonfire saves over it.
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
