import { Node, UIProgressBarNode, UIRootNode, UITextNode } from 'cleo'
import { WEAPONS, angleDiff, clamp, manager, yawTo } from '@/FPS/Scripts/FpsShared'

/**
 * FPS example — the player's HUD. Attach to the `HUD` node, a screen-space UI Root that is a CHILD of the
 * player (in the Player template): it reads its parent, so a second player would bring a second HUD.
 *
 * It finds its widgets by NAME once (missing ones are skipped, so restyle or rebuild it freely as long as
 * the names stay) and writes them every frame:
 *
 *   CrossTop/Bottom/Left/Right, CrossDot   the crosshair; the arms open with the weapon's spread
 *   HitMarker, HitMarkerKill               a hit; red on a kill; the head shot's is larger
 *   Health, HealthText                     hp
 *   Ammo, Reserve, WeaponName, Reloading   the weapon in hand
 *   Score, Timer, Feed, Mode               the match (from the Game Manager, when the scene has one)
 *   Message, SubMessage                    centre text: "YOU DIED", the respawn count, the winner
 *   HitFront/Back/Left/Right, Vignette     where damage came from, and the red edge at low health
 */
export default class FpsHudNode extends UIRootNode {
  /** Pixels of crosshair gap per degree of spread, at the hip field of view. */
  public pixelsPerDegree: number = 11
  public crosshairGap: number = 5
  public crosshairLength: number = 9
  public hitMarkerSeconds: number = 0.22
  public indicatorSeconds: number = 1.4
  /** Hide the crosshair while aimed (the sights are the aim). */
  public hideCrosshairAimed: boolean = true

  private _player: any = null
  private _w: Record<string, any> = {}
  private _gap: number = -1

  onStart() {
    for (let n: Node | null = this.parent; n; n = n.parent) if ((n as any).getVariable?.('fpsCombatant') || (n as any).team) { this._player = n; break }
    for (const name of ['CrossTop', 'CrossBottom', 'CrossLeft', 'CrossRight', 'CrossDot', 'HitMarker', 'HitMarkerKill',
      'Health', 'HealthText', 'Ammo', 'Reserve', 'WeaponName', 'Reloading', 'Score', 'Timer', 'Feed', 'Mode',
      'Message', 'SubMessage', 'HitFront', 'HitBack', 'HitLeft', 'HitRight', 'Vignette', 'Crosshair', 'Ammunition'])
      this._w[name] = this._find(name)
    this._show('HitMarker', false)
    this._show('HitMarkerKill', false)
  }

  onUpdate(delta: number) {
    const p = this._player
    if (!p) return
    const gm = manager()
    const t = p._time ?? 0

    // ----- crosshair
    const aimed = this.hideCrosshairAimed && p.ads > 0.6
    this._show('Crosshair', !p.isDead && !aimed && !p.sprinting)
    const gap = Math.round(this.crosshairGap + p.spreadNow * this.pixelsPerDegree)
    if (gap !== this._gap) {
      this._gap = gap
      const len = this.crosshairLength
      this._setRect('CrossTop', [-1, -(gap + len)], [1, -gap])
      this._setRect('CrossBottom', [-1, gap], [1, gap + len])
      this._setRect('CrossLeft', [-(gap + len), -1], [-gap, 1])
      this._setRect('CrossRight', [gap, -1], [gap + len, 1])
    }
    const hm = t - p.hitMarkerAt
    const hit = hm >= 0 && hm < this.hitMarkerSeconds
    this._show('HitMarker', hit && !p.hitMarkerKill)
    this._show('HitMarkerKill', hit && p.hitMarkerKill)
    if (hit) this._setOpacity(p.hitMarkerKill ? 'HitMarkerKill' : 'HitMarker', 1 - hm / this.hitMarkerSeconds)

    // ----- health and the weapon
    this._bar('Health', p.hp, p.maxHp)
    this._text('HealthText', String(Math.ceil(p.hp)))
    const spec = WEAPONS[p.weapon]
    this._show('Ammunition', !p.isDead)
    this._text('Ammo', String(p.ammo))
    this._text('Reserve', '/ ' + p.reserve)
    this._text('WeaponName', spec ? spec.name.toUpperCase() : '')
    this._text('Reloading', p.reloading ? 'RELOADING' : p.ammo <= 0 && !p.isDead ? 'EMPTY' : p.ammo <= Math.ceil((spec?.mag ?? 30) * 0.25) && !p.isDead ? 'LOW AMMO' : '')

    // ----- damage direction, and the edge of the screen at low health
    const since = p._time - p.lastHitAt
    if (since < this.indicatorSeconds && p.lastHitFrom) {
      const rig = p._rig
      const yaw = rig ? rig.yaw : 0
      const rel = angleDiff(yawTo(p.worldPosition, p.lastHitFrom), yaw)
      const k = 1 - since / this.indicatorSeconds
      // Front is 0; the screen's right is a NEGATIVE turn.
      const front = Math.cos(rel * Math.PI / 180), side = Math.sin(rel * Math.PI / 180)
      this._setOpacity('HitFront', Math.max(0, front) * k)
      this._setOpacity('HitBack', Math.max(0, -front) * k)
      this._setOpacity('HitLeft', Math.max(0, side) * k)
      this._setOpacity('HitRight', Math.max(0, -side) * k)
    } else for (const n of ['HitFront', 'HitBack', 'HitLeft', 'HitRight']) this._setOpacity(n, 0)
    const low = clamp(1 - p.hp / (p.maxHp * 0.5), 0, 1)
    this._setOpacity('Vignette', p.isDead ? 0.7 : low * 0.75)

    // ----- the match
    if (gm) {
      const standings = gm.standings()
      const mine = standings.find((s: any) => s.team === p.team)
      const best = standings.find((s: any) => s.team !== p.team)
      this._text('Score', gm.gameType === 'ffa'
        ? `${mine?.score ?? 0}`  + (best ? `   best ${best.score}` : '')
        : `${gm.teamName(p.team)} ${mine?.score ?? 0}   -   ${best ? gm.teamName(best.team) : ''} ${best?.score ?? 0}`)
      this._text('Timer', gm.timeLimit > 0 ? this._clock(gm.timeLeft) : '')
      this._text('Feed', gm.feed.join('\n'))
      this._text('Mode', gm.scoreLimit > 0 ? `first to ${gm.scoreLimit}` : '')
    }
    let message = '', sub = ''
    if (gm?.matchOver) { message = gm.message; sub = 'next match shortly' }
    else if (p.isDead) { message = 'YOU DIED'; sub = p.respawnIn > 0.05 ? `respawn in ${Math.ceil(p.respawnIn)}` : '' }
    this._text('Message', message)
    this._text('SubMessage', sub)
  }

  private _clock(seconds: number): string {
    const s = Math.max(0, Math.ceil(seconds))
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }

  private _bar(name: string, value: number, max: number): void {
    const bar = this._w[name] as UIProgressBarNode
    if (!bar) return
    if (bar.max !== max) bar.max = Math.max(1, max)
    bar.value = Math.max(0, value)
  }

  private _text(name: string, value: string): void {
    const node = this._w[name] as UITextNode
    if (node && node.text !== value) node.text = value
  }

  private _show(name: string, on: boolean): void {
    const node = this._w[name]
    if (node && node.visible !== on) node.visible = on
  }

  private _setOpacity(name: string, value: number): void {
    const node = this._w[name]
    if (node && Math.abs(node.opacity - value) > 0.01) node.opacity = value
  }

  private _setRect(name: string, min: number[], max: number[]): void {
    const node = this._w[name]
    if (!node) return
    node.offsetMin = min
    node.offsetMax = max
  }

  private _find(name: string): Node | null {
    const walk = (node: Node): Node | null => {
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
