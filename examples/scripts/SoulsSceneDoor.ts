import { Game, Logger, Node } from 'cleo'

/**
 * A way into another scene: the skull cave's mouth, the dungeon's way back out. Attach to a node with a
 * TRIGGER volume where the player stands to use it. Standing there offers `prompt`; Interact asks
 * `question` in the player's ConfirmDialog, and yes loads `targetScene` behind a loading screen.
 *
 * Only offered from in FRONT of the node (its local +Z side) when `frontOnly` is set, so a door in a
 * wall is not usable from inside the wall.
 */
export default class SoulsSceneDoorNode extends Node {
  /** The scene to load, by name or id. */
  public targetScene: string = 'Dungeon'
  public prompt: string = 'Enter'
  public question: string = 'Enter?'
  public detail: string = ''
  /** Heading on the loading screen. */
  public loadingTitle: string = ''
  public frontOnly: boolean = false

  private _busy: boolean = false

  public canInteract(player: Node): boolean {
    if (this._busy || !player) return false
    if (!this.frontOnly) return true
    const me = this.worldPosition, p = player.worldPosition, f = this.worldForward
    return (p[0] - me[0]) * f[0] + (p[2] - me[2]) * f[2] > 0
  }

  public promptText(_player: Node): string { return this.prompt }

  public interact(player: Node): void {
    const dialog = this._dialogOf(player) as any
    if (!dialog?.ask) { this.go(); return }
    dialog.ask(this.question, this.detail, () => this.go())
  }

  /** Load the target scene now. */
  public go(): void {
    if (this._busy) return
    this._busy = true
    try {
      Game.loadScene(this.targetScene, { loadingScreen: { title: this.loadingTitle || this.targetScene } })
        .catch(e => { this._busy = false; Logger.error(`Could not load "${this.targetScene}": ${e}`, 'Script') })
    } catch (e) {
      // Outside play (no game host): nothing to switch to.
      this._busy = false
      Logger.warn(`Scene doors only work while the game is running: ${e}`, 'Script')
    }
  }

  private _dialogOf(player: Node): Node {
    const walk = (n: Node): Node => {
      for (const c of n.children) {
        if (c.name === 'ConfirmDialog') return c
        const found = walk(c)
        if (found) return found
      }
      return null
    }
    return player ? walk(player) : null
  }
}
