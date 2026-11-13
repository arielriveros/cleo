import { Node, UIRootNode, UITextNode } from 'cleo'

/**
 * Duskwell -- the HUD. Attach to the `HUD` screen-space UI Root; it reads the `Player` node every frame and
 * writes its widgets, found by name once:
 *
 *   Health     uiText   "HP 4 / 5"
 *   Diamonds   uiText   the diamonds carried
 *   Notice     uiText   the player's one-line message (a pickup, a checkpoint), empty otherwise
 */
export default class DuskHud extends UIRootNode {
  public playerName: string = 'Player'

  private _player: Node = null
  private _health: UITextNode = null
  private _diamonds: UITextNode = null
  private _notice: UITextNode = null

  onStart() {
    this._player = this.findNode(this.playerName) ?? null
    this._health = this._find('Health')
    this._diamonds = this._find('Diamonds')
    this._notice = this._find('Notice')
  }

  private _find(name: string): UITextNode {
    const queue: Node[] = [...this.children]
    while (queue.length) {
      const n = queue.shift()
      if (n.name === name && n instanceof UITextNode) return n
      queue.push(...n.children)
    }
    return null
  }

  onUpdate() {
    const p = this._player as any
    if (!p) return
    const health = `HP ${Math.max(0, Math.ceil(p.health ?? 0))} / ${p.maxHealth ?? 0}`
    if (this._health && this._health.text !== health) this._health.text = health
    const diamonds = `Diamonds ${p.diamonds ?? 0}`
    if (this._diamonds && this._diamonds.text !== diamonds) this._diamonds.text = diamonds
    const notice = p.notice ?? ''
    if (this._notice && this._notice.text !== notice) this._notice.text = notice
  }
}
