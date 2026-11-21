import { Node, UIProgressBarNode, UIRootNode, UITextNode } from 'cleo'

/**
 * Hollow Keep — a boss's health bar. Attach to a screen-space UI Root that is a CHILD of the boss (in the
 * Hollow Warden template): the bar belongs to the boss it shows and reads that boss — its owner — every
 * frame. It shows while the boss is awake and alive, so it comes up when the fight starts and goes when
 * the boss falls. A second boss template brings its own bar; nothing in the scene has to change.
 *
 *   BossName                 uiText          the owner's `displayName`
 *   BossHealth, BossLag      uiProgressBar   HP, and the yellow bar that drains behind it
 */
export default class SoulsBossBarNode extends UIRootNode {
  private _owner: Node = null
  private _w: any = {}

  onStart() {
    for (let n = this.parent; n; n = n.parent) if ((n as any).team) { this._owner = n; break }
    for (const name of ['Bar', 'BossName', 'BossHealth', 'BossLag']) this._w[name] = this._find(name)
    this._show(false)
  }

  onUpdate(delta: number) {
    const boss = this._owner as any
    const on = !!boss && boss.isAwake && !boss.isDead && boss.fightState !== 'dormant'
    this._show(on)
    if (!on) return
    const hp = Math.max(0, boss.hp ?? 0), max = Math.max(1, boss.maxHp ?? 1)
    const name = this._w.BossName as UITextNode
    const label = boss.displayName ?? boss.name ?? ''
    if (name && name.text !== label) name.text = label
    for (const key of ['BossHealth', 'BossLag']) {
      const bar = this._w[key] as UIProgressBarNode
      if (!bar) continue
      if (bar.max !== max) bar.max = max
      bar.value = hp
    }
  }

  /** The boss this bar shows. */
  public get owner(): Node { return this._owner }

  private _show(on: boolean): void {
    const bar = this._w.Bar as any
    if (bar && bar.visible !== on) bar.visible = on
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
