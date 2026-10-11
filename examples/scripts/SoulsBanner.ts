import { Node, UIRootNode, UITextNode } from 'cleo'

/**
 * Hollow Keep — the big centre-screen banners: YOU DIED, BONFIRE LIT, VICTORY ACHIEVED. Attach to the
 * `Banner` node, a screen-space UI Root authored hidden, with a `Band` panel and a `BannerText` text.
 *
 * Its own root rather than part of the HUD, because setting `visible` on a node writes every descendant —
 * revealing a panel nested in the HUD would force every HUD widget visible with it.
 *
 * `showBanner(text, kind)` fades in, holds, and fades out. `kind` picks the colour: `red` (death — held
 * until `hideBanner`, which the respawn calls) or `gold`.
 */
export default class SoulsBannerNode extends UIRootNode {
  public fadeIn: number = 0.6
  public hold: number = 2.2
  public fadeOut: number = 1
  public redColor: [number, number, number] = [0.72, 0.08, 0.06]
  public goldColor: [number, number, number] = [0.96, 0.82, 0.46]

  private _text: UITextNode = null
  private _age: number = -1
  private _sticky: boolean = false

  onStart() {
    this._text = this._find('BannerText') as UITextNode
    this.visible = false
  }

  public showBanner(text: string, kind: string): void {
    const c = kind === 'red' ? this.redColor : this.goldColor
    if (this._text) {
      this._text.text = text
      this._text.tint = [c[0], c[1], c[2], 1]
    }
    this._sticky = kind === 'red'
    this._age = 0
    this.opacity = 0
    this.visible = true
  }

  public hideBanner(): void {
    if (this._age < 0) return
    this._sticky = false
    this._age = Math.max(this._age, this.fadeIn + this.hold)
  }

  onUpdate(delta: number) {
    if (this._age < 0) return
    this._age += delta
    const t = this._age
    let a = 1
    if (t < this.fadeIn) a = t / this.fadeIn
    else if (this._sticky) a = 1
    else if (t > this.fadeIn + this.hold) a = 1 - (t - this.fadeIn - this.hold) / this.fadeOut
    a = Math.max(0, Math.min(1, a))
    if (Math.abs(this.opacity - a) > 0.004) this.opacity = a
    if (!this._sticky && t > this.fadeIn + this.hold + this.fadeOut) {
      this._age = -1
      this.visible = false
    }
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
