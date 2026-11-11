import { Node } from 'cleo'

/**
 * Valley — a fire-and-forget effect: the pond's splashes. Attach to the root of an effect template. On
 * start it plays every Particle System below it, and removes the whole effect `lifetime` seconds later.
 *
 * The pond's Water Volume spawns these by template name (its Splash Template and Wade Splash Template).
 */
export default class ValleyFxNode extends Node {
  /** Seconds before the effect removes itself: at least as long as its longest particle lives. */
  public lifetime: number = 1.2

  private _age: number = 0

  onStart() {
    this._age = 0
    const walk = (node: Node) => {
      for (const child of node.children) {
        // play(), not restart(): a fresh instance is already playing if its system plays on start.
        if (child.nodeType === 'particleSystem') (child as any).play?.()
        walk(child)
      }
    }
    walk(this)
  }

  onUpdate(delta: number) {
    this._age += delta
    if (this._age >= this.lifetime) this.remove()
  }
}
