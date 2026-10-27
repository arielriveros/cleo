import { Game, Logger, Node } from 'cleo'

/**
 * A way into another scene: the skull cave's mouth, the dungeon's way back out. Attach to a node with a
 * TRIGGER volume where the player stands to use it. Standing there offers `prompt`; Interact asks
 * `question` in the player's ConfirmDialog, and yes loads `targetScene` behind a loading screen.
 *
 * Only offered from in FRONT of the node (its local +Z side) when `frontOnly` is set, so a door in a
 * wall is not usable from inside the wall.
 *
 * `exitTo` names the door in the target scene the player comes out of: that door puts the player
 * `arrivalDistance` in front of itself, facing out, instead of at the scene's start. The skull cave and the
 * dungeon's way out name each other, so a trip down and back up ends where it began.
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
  /** The door (by node name) in the target scene to come out of; empty = the scene's own start. */
  public exitTo: string = ''
  /** How far in front of this door an arriving player stands. */
  public arrivalDistance: number = 2

  private _busy: boolean = false

  onStart() {
    const g = globalThis as any
    if (!this.name || g.__soulsArrival !== this.name) return
    // A frame later: the player has run its own start (and placed its body) by then. The arrival is
    // cleared then too, so anything else starting in this scene can tell it was arrived at through a door.
    this.after(0, () => {
      g.__soulsArrival = undefined
      const player = this.findNode('Player') as any
      if (!player) return
      const me = this.worldPosition, f = this.worldForward
      player.setPosition?.([me[0] + f[0] * this.arrivalDistance, me[1] + 0.05, me[2] + f[2] * this.arrivalDistance])
      player.setRotation?.([0, Math.atan2(f[0], f[2]) * 180 / Math.PI, 0])
    })
  }

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
    ;(globalThis as any).__soulsArrival = this.exitTo || undefined
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
