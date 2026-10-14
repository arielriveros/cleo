import { Node, UIProgressBarNode, UIRootNode, UITextNode } from 'cleo'

/**
 * Hollow Keep — the PLAYER's HUD. Attach to the `HUD` node, a screen-space UI Root that is a CHILD of
 * the player (in the Player template): the HUD belongs to the character it shows, and reads that
 * character — its parent — not some node found by name. A second player would bring its own HUD.
 *
 * One script for the whole HUD. It finds its widgets by NAME once (missing ones are skipped, so you can
 * restyle or rebuild the HUD freely as long as the names stay) and writes them every frame from its
 * owner's public fields:
 *
 *   Health, HealthLag        uiProgressBar   HP, and the yellow "damage taken" bar that drains behind it
 *   Stamina                  uiProgressBar
 *   Estus                    uiText          flask count
 *   Weapon                   uiText          weapon in hand
 *   Souls, SoulsGain         uiText          souls held, and the +N popup
 *   Prompt / PromptText      uiPanel/uiText  "E  Rest at bonfire" — hidden when there is nothing to do
 *   Notice                   uiText          one-line messages ("Picked up ..."), fading
 *   Message / MessageTitle / MessageBody     the readable-message panel
 *
 * The boss bar is not here: it belongs to the boss (SoulsBossBar, inside the Hollow Warden template).
 *
 * Bars grow with their maximum (`pxPerHp`, `pxPerStamina`), so levelling Vigor visibly lengthens the bar.
 */
export default class SoulsHudNode extends UIRootNode {
  public pxPerHp: number = 0.75
  public pxPerStamina: number = 2.4
  public minBarWidth: number = 160
  public maxBarWidth: number = 900
  public noticeSeconds: number = 2.6
  /** Key shown in front of the interaction prompt. */
  public interactKey: string = 'E'

  private _player: Node = null
  private _w: any = {}
  private _barLeft: number = 48
  private _noticeAge: number = 99
  private _message: Node = null
  private _messageAge: number = 0

  onStart() {
    // The owner: the nearest ancestor that is a fighter (the Player the HUD is a child of).
    for (let n = this.parent; n; n = n.parent) if ((n as any).team) { this._player = n; break }
    for (const name of ['Health', 'HealthLag', 'HealthBack', 'Stamina', 'StaminaBack', 'Estus', 'Weapon', 'Souls',
      'SoulsGain', 'Prompt', 'PromptText', 'Notice', 'Message', 'MessageTitle', 'MessageBody']) {
      this._w[name] = this._find(name)
    }
    const health = this._w.Health as any
    if (health) this._barLeft = health.offsetMin[0]
    this._show('Message', false)
    this._show('Prompt', false)
    this._text('Notice', '')
    this._text('SoulsGain', '')
  }

  onUpdate(delta: number) {
    const p = this._player as any
    this._noticeAge += delta
    this._messageAge += delta

    if (p) {
      this._bar('Health', p.hp, p.maxHp)
      this._bar('HealthLag', p.hp, p.maxHp)
      this._width(['Health', 'HealthLag', 'HealthBack'], p.maxHp * this.pxPerHp)
      this._bar('Stamina', p.stamina, p.maxStamina)
      this._width(['Stamina', 'StaminaBack'], p.maxStamina * this.pxPerStamina)
      this._text('Estus', 'Estus Flask  ' + (p.estus ?? 0) + ' / ' + (p.estusMax ?? 0))
      this._text('Weapon', p.weaponName ?? '')
      this._text('Souls', String(Math.round(p.souls ?? 0)))
      this._text('SoulsGain', p.soulsGainAge < 2 && p.lastSoulsGain > 0 ? '+' + p.lastSoulsGain : '')

      const prompt = p.interactPrompt ?? ''
      this._show('Prompt', !!prompt && !this._message)
      if (prompt) this._text('PromptText', this.interactKey + '   ' + prompt)
    }

    if (this._noticeAge > this.noticeSeconds) this._text('Notice', '')

    // A message closes when the player walks out of its source's zone (closeMessageFrom), or dies.
    if (this._message && p?.isDead) this._closeMessage()
  }

  /** The character this HUD shows. */
  public get owner(): Node { return this._player }

  public showNotice(text: string): void {
    this._text('Notice', text)
    this._noticeAge = 0
  }

  /** Show a message; showing the SAME source again closes it (Interact toggles). */
  /** The player left `source`'s trigger zone: close its message if it is the one showing. */
  public closeMessageFrom(source: Node): void {
    if (this._message && this._message === source) this._closeMessage()
  }

  public showMessage(title: string, body: string, source: Node): void {
    if (this._message && this._message === source && this._messageAge > 0.15) { this._closeMessage(); return }
    this._message = source
    this._messageAge = 0
    this._text('MessageTitle', title)
    this._text('MessageBody', body)
    this._show('Message', true)
  }

  private _closeMessage(): void {
    this._message = null
    this._show('Message', false)
  }

  private _bar(name: string, value: number, max: number): void {
    const bar = this._w[name] as UIProgressBarNode
    if (!bar) return
    if (bar.max !== max) bar.max = Math.max(1, max)
    bar.value = Math.max(0, value)
  }

  private _width(names: string[], px: number): void {
    const width = Math.max(this.minBarWidth, Math.min(this.maxBarWidth, px))
    for (const name of names) {
      const node = this._w[name] as any
      if (!node) continue
      const right = node.offsetMin[0] + width
      if (Math.abs(node.offsetMax[0] - right) > 0.5) node.offsetMax = [right, node.offsetMax[1]]
    }
  }

  private _text(name: string, value: string): void {
    const node = this._w[name] as UITextNode
    if (node && node.text !== value) node.text = value
  }

  private _show(name: string, on: boolean): void {
    const node = this._w[name] as any
    if (node && node.visible !== on) node.visible = on
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
