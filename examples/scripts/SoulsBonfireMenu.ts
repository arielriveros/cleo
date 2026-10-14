import { Input, Node, UIButtonNode, UIRootNode, UITextNode } from 'cleo'
import { playSound } from './SoulsAudio'

/**
 * Hollow Keep — the level-up menu shown while resting at a bonfire. Attach to the `BonfireMenu` node, a
 * screen-space UI Root authored hidden.
 *
 *   Card
 *     Title, LevelText, SoulsText, CostText, Derived, Help       uiText
 *     Row_Vigor / Row_Endurance / Row_Strength / Row_Dexterity     uiStack rows, each with
 *        Label (uiText)  Minus (uiButton)  Value (uiText)  Plus (uiButton)
 *     Confirm, Leave                                                uiButton
 *
 * Points are allocated as PENDING and cost nothing until Confirm, so the player can try a build and back
 * out. Each point costs the souls for one more level, priced by the player's own `levelCost`, so the total
 * of several points is the sum of consecutive levels. Every number shown comes from its owner: HP and
 * stamina from the player's curves, attack rating from each weapon.
 *
 * Keyboard/gamepad (the UI map): Navigate up/down picks a stat, left/right removes/adds a point, Submit
 * confirms, Cancel leaves. The mouse can click every button. The Gameplay map is disabled while open, so
 * the same keys do not also move the character.
 */
const STATS = ['vigor', 'endurance', 'strength', 'dexterity']

export default class SoulsBonfireMenuNode extends UIRootNode {
  public repeatDelay: number = 0.35
  public repeatRate: number = 0.09
  public selectedTint: [number, number, number, number] = [0.85, 0.65, 0.3, 0.35]
  public rowTint: [number, number, number, number] = [1, 1, 1, 0.04]
  public isOpen: boolean = false

  private _gm: Node = null
  private _player: Node = null
  private _pending: number[] = [10, 10, 10, 10]
  private _selected: number = 0
  private _navHeld: number = 0
  private _navRepeat: number = 0
  private _navLast: number[] = [0, 0]
  private _openedAt: number = 0
  private _clock: number = 0

  onStart() {
    this.visible = false
    this.isOpen = false
    const rows = ['Row_Vigor', 'Row_Endurance', 'Row_Strength', 'Row_Dexterity']
    rows.forEach((name, i) => {
      const row = this._find(name)
      if (!row) return
      const minus = this._find('Minus', row) as UIButtonNode
      const plus = this._find('Plus', row) as UIButtonNode
      if (minus) minus.onPress = () => { this._selected = i; this._adjust(-1) }
      if (plus) plus.onPress = () => { this._selected = i; this._adjust(1) }
    })
    const confirm = this._find('Confirm') as UIButtonNode
    if (confirm) confirm.onPress = () => this._confirm()
    const leave = this._find('Leave') as UIButtonNode
    if (leave) leave.onPress = () => this.close()
  }

  /** Called by the manager when the player rests. */
  public open(gm: Node, player: Node, bonfire: Node): void {
    this._gm = gm
    this._player = player
    this._resetPending()
    this._selected = 0
    this.isOpen = true
    this._openedAt = this._clock
    this.visible = true
    Input.disableMap('Gameplay')
    Input.releaseMouse()
    this._refresh()
  }

  public close(): void {
    if (!this.isOpen) return
    this.isOpen = false
    this.visible = false
    Input.enableMap('Gameplay')
    ;(this._gm as any)?.leaveBonfire?.()
  }

  onUpdate(delta: number) {
    this._clock += delta
    if (!this.isOpen) return
    // Swallow the press that opened us (Interact may share a key with Submit).
    if (this._clock - this._openedAt < 0.2) return

    const nav = Input.vector('Navigate')
    const dy = Math.abs(nav[1]) > 0.5 ? Math.sign(nav[1]) : 0
    const dx = Math.abs(nav[0]) > 0.5 ? Math.sign(nav[0]) : 0
    const fresh = dy !== this._navLast[1] || dx !== this._navLast[0]
    this._navLast = [dx, dy]
    let step = false
    if (dx || dy) {
      if (fresh) { step = true; this._navHeld = 0; this._navRepeat = 0 }
      else {
        this._navHeld += delta
        if (this._navHeld > this.repeatDelay) {
          this._navRepeat += delta
          if (this._navRepeat >= this.repeatRate) { this._navRepeat = 0; step = true }
        }
      }
    }
    if (step) {
      // Navigate Y is positive UP; rows run top to bottom.
      if (dy) this._selected = (this._selected - dy + 4) % 4
      if (dx) this._adjust(dx)
      this._refresh()
    }

    if (Input.started('Submit')) this._confirm()
    if (Input.started('Cancel')) this.close()
  }

  // ----- the maths --------------------------------------------------------------------------------

  /** Souls to buy every pending point, from the player's CURRENT level. */
  public pendingCost(): number {
    const p = this._player as any
    if (!p?.levelFor) return 0
    const from = p.level
    const to = p.levelFor(this._pending[0], this._pending[1], this._pending[2], this._pending[3])
    let cost = 0
    for (let l = from; l < to; l++) cost += p.levelCost(l)
    return cost
  }

  private _adjust(delta: number): void {
    const p = this._player as any
    if (!p) return
    const key = STATS[this._selected]
    const floor = p[key]
    const next = this._pending[this._selected] + delta
    if (next < floor || next > 99) return
    const before = this._pending[this._selected]
    this._pending[this._selected] = next
    if (delta > 0 && this.pendingCost() > (p.souls ?? 0)) {
      this._pending[this._selected] = before
      playSound(this, 'Menu Deny')
      return
    }
    playSound(this, 'Menu Tick')
    this._refresh()
  }

  private _confirm(): void {
    const p = this._player as any
    if (!p) return
    const cost = this.pendingCost()
    if (cost <= 0) return
    if (p.applyLevelUp?.(this._pending[0], this._pending[1], this._pending[2], this._pending[3], cost)) {
      playSound(this, 'Level Up')
      ;(this._gm as any)?.notice?.('Level up!')
    }
    this._resetPending()
    this._refresh()
  }

  private _resetPending(): void {
    const p = this._player as any
    this._pending = STATS.map(k => (p ? p[k] : 10))
  }

  private _refresh(): void {
    const p = this._player as any
    if (!p?.levelFor) return
    const level = p.levelFor(this._pending[0], this._pending[1], this._pending[2], this._pending[3])
    const cost = this.pendingCost()
    this._set('LevelText', 'Level  ' + p.level + (level !== p.level ? '  ->  ' + level : ''))
    this._set('SoulsText', 'Souls  ' + p.souls + (cost ? '  ->  ' + (p.souls - cost) : ''))
    this._set('CostText', 'Next level  ' + p.levelCost(level) + ' souls')

    const labels = ['Vigor', 'Endurance', 'Strength', 'Dexterity']
    labels.forEach((label, i) => {
      const row = this._find('Row_' + label) as any
      if (!row) return
      const changed = this._pending[i] !== p[STATS[i]]
      const value = this._find('Value', row) as UITextNode
      if (value) value.text = String(this._pending[i]) + (changed ? ' *' : '')
      const tint = i === this._selected ? this.selectedTint : this.rowTint
      row.tint = [tint[0], tint[1], tint[2], tint[3]]
    })

    const weapons: Node[] = p.weapons?.() ?? []
    const ar = weapons.map(w => (w as any).displayName + ' ' + ((w as any).attackRating?.(this._pending[2], this._pending[3]) ?? 0))
    this._set('Derived', 'HP ' + p.hpForVigor(this._pending[0]) + '    Stamina ' + p.staminaForEndurance(this._pending[1])
      + '\nAttack  ' + ar.join('   '))
  }

  private _set(name: string, text: string): void {
    const node = this._find(name) as UITextNode
    if (node && node.text !== text) node.text = text
  }

  private _find(name: string, root: Node = this): Node {
    const walk = (node: Node): Node => {
      for (const child of node.children) {
        if (child.name === name) return child
        const found = walk(child)
        if (found) return found
      }
      return null
    }
    return walk(root)
  }
}
