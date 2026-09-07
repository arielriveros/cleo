import { Game, Logger, Node, UIButtonNode, UIRootNode, UITextNode } from 'cleo'

/**
 * Night Shift — the end-of-level panel. Attach to the `EndScreen` node, a screen-space UI Root authored
 * with `visible: false`.
 *
 * Expected children:
 *
 *   Backdrop     uiPanel    stretched, interactive so it eats clicks meant for the world
 *     Card       uiStack    column, centred
 *       Title    uiText
 *       Items    uiText
 *       Score    uiText
 *       Buttons  uiStack    row
 *         Exit     uiButton
 *         Continue uiButton
 *
 * ## Why it is its own root and not a child of the HUD
 *
 * Setting `visible` walks the whole subtree and writes every descendant, so revealing a panel nested
 * inside the HUD would also force every HUD widget visible — including any you had deliberately hidden.
 * Keeping the two roots as siblings sidesteps that entirely.
 *
 * And `visible` is the right tool here rather than `despawn()`: the layout solve skips unspawned
 * children, but the DOM layer renders from the child list with no spawned filter, so a despawned inner
 * panel stays on screen frozen at its last solved rect.
 *
 * ## Buttons still work while the game is paused
 *
 * `Game.pause()` freezes every `onUpdate`, but not the UI layout pass, and clicks arrive through the DOM
 * rather than the node loop. So the panel lays out and responds with the game stopped behind it.
 */
export default class NightShiftEndScreenNode extends UIRootNode {
  public wonTitle: string = 'Dawn Breaks'
  public lostTitle: string = 'Game Over'
  public continueLabel: string = 'Continue'
  public retryLabel: string = 'Retry'
  public exitLabel: string = 'Exit'
  /** Scene the Exit button loads. There is no engine quit API; a menu is just another scene. */
  public menuScene: string = 'Main Menu'

  private _won: boolean = false

  onStart() {
    this.visible = false

    // `onPress` takes no arguments, and assigning it as an own property shadows the prototype method —
    // which is exactly how a script would have overridden it anyway.
    const exit = this._find('Exit') as UIButtonNode
    if (exit) {
      exit.label = this.exitLabel
      exit.onPress = () => this._exit()
    }
    const next = this._find('Continue') as UIButtonNode
    if (next) next.onPress = () => this._continue()
  }

  /** Called by the director. `won` picks the wording and which verb the second button gets. */
  public showResult(won: boolean, found: number, total: number, score: number, level: number): void {
    this._won = won

    this._text('Title', won ? this.wonTitle : this.lostTitle)
    this._text('Items', 'Items   ' + found + ' / ' + total)
    this._text('Score', 'Score   ' + score.toLocaleString())

    const next = this._find('Continue') as UIButtonNode
    if (next) next.label = won ? this.continueLabel : this.retryLabel

    // Reveal LAST, so nothing is drawn for a frame with the previous level's numbers in it.
    this.visible = true
  }

  private _continue(): void {
    // Won: the director already banked level+1, so re-loading this scene starts the next one. Lost: the
    // same load is a retry, because the level number was left alone.
    Game.resume()
    this._load(Game.sceneName)
  }

  private _exit(): void {
    Game.resume()
    this._load(this.menuScene)
  }

  private _load(scene: string): void {
    try { Game.loadScene(scene) }
    catch (e) { Logger.warn('Night Shift: could not load "' + scene + '": ' + e, 'Script') }
  }

  private _text(name: string, value: string): void {
    const node = this._find(name) as UITextNode
    if (node) node.text = value
  }

  private _find(name: string): Node {
    const walk = (node: Node): Node => {
      for (const child of node.children) {
        if (child.name === name) return child
        const found = walk(child)
        if (found) return found
      }
      return null
    }
    return walk(this)
  }
}
