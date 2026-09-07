import { Node, UIProgressBarNode, UIRootNode, UITextNode } from 'cleo'

/**
 * Night Shift — the HUD. Attach to the `HUD` node, which must be a screen-space UI Root.
 *
 * One script for the whole HUD rather than one per element. It finds its widgets by name once in
 * `onStart` and writes them every frame; four `findNode` calls a frame from four separate scripts would
 * be four whole-scene searches for values one node already has.
 *
 * Expected children (missing ones are simply skipped, so you can build the HUD up a piece at a time):
 *
 *   Clock        uiText          the level clock, 22:00 -> 06:00
 *   Score        uiText          items found / total
 *   Health       uiProgressBar   the player's health
 *   Pips         uiStack (row)
 *     Speed      uiProgressBar   seconds left, drains
 *     Invincible uiProgressBar
 *     Aoe        uiProgressBar
 *
 * Writing these every frame is free: assigning an unchanged string to `text` or an unchanged number to
 * `value` early-returns. And because the UI layout pass runs AFTER every `onUpdate`, a value written
 * here is on screen the same frame rather than one behind.
 */
export default class NightShiftHudNode extends UIRootNode {
  private _director: Node = null
  private _player: Node = null
  private _clock: UITextNode = null
  private _score: UITextNode = null
  private _health: UIProgressBarNode = null
  private _speed: UIProgressBarNode = null
  private _invincible: UIProgressBarNode = null
  private _aoe: UIProgressBarNode = null

  onStart() {
    this._director = this.findNode('GameManager')
    this._player = this.findNode('Playable')

    this._clock = this._find('Clock') as UITextNode
    this._score = this._find('Score') as UITextNode
    this._health = this._find('Health') as UIProgressBarNode
    this._speed = this._find('Speed') as UIProgressBarNode
    this._invincible = this._find('Invincible') as UIProgressBarNode
    this._aoe = this._find('Aoe') as UIProgressBarNode

    const player = this._player as any
    if (this._health && player) {
      this._health.min = 0
      this._health.max = player.maxHealth ?? 100
    }
  }

  onUpdate(delta: number, time: number) {
    const director = this._director as any
    const player = this._player as any

    if (this._clock && director) this._clock.text = director.clockText
    if (this._score && director) this._score.text = director.itemsFound + ' / ' + director.itemsTotal
    if (this._health && player) this._health.value = player.health

    if (!player) return
    this._pip(this._speed, player.speedLeft, player.speedSeconds)
    this._pip(this._invincible, player.invincibleLeft, player.invincibleSeconds)
    this._pip(this._aoe, player.aoeLeft, player.aoeFlashSeconds)
  }

  /** A pip is hidden while its powerup is not running, and drains to empty while it is. */
  private _pip(bar: UIProgressBarNode, left: number, duration: number): void {
    if (!bar) return
    const running = left > 0
    if (bar.visible !== running) bar.visible = running
    if (running) bar.value = left / Math.max(0.001, duration)
  }

  /** Depth-first search of this root's own subtree — `getChildByName` is direct children only. */
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
