import { Node } from 'cleo'

/**
 * Hollow Keep — the fog wall in front of the boss. Attach to a node at the arena's mouth that carries a
 * STATIC box body (the blocker), with its local +Z pointing INTO the arena.
 *
 *   Fog Gate          this script + box body
 *   ├── FogWall       the translucent sheet — any mesh
 *   └── Fog           particle system, the drifting fog
 *
 *   closed    blocks both ways. From OUTSIDE, Interact: "Traverse the white fog". The player is lined
 *             up, walks through over `walkSeconds` with i-frames while the body is a ghost, and the
 *             fight starts on the far side.
 *   fight     blocks both ways, no prompt — there is no leaving.
 *   gone      the boss is dead: the fog dissolves for good.
 *
 * A death mid-fight resets it to `closed` (the manager calls `resetGate`).
 *
 * The arena is a circle (`arenaCenter`, `arenaRadius`); the manager uses `isInsideArena` to start the
 * fight anyway if the player ever ends up inside without walking through.
 */
export default class SoulsFogGateNode extends Node {
  public interactRadius: number = 2.2
  /** Metres in front of the gate (outside) the player is lined up at before walking. */
  public entryDistance: number = 1.1
  public walkDistance: number = 2.8
  public walkSeconds: number = 1.5
  public arenaCenter: [number, number, number] = [0, 0, 0]
  public arenaRadius: number = 15
  public isFogGate: boolean = true
  /** 'closed' | 'fight' | 'gone' */
  public gateState: string = 'closed'

  private _gm: Node = null
  private _fog: Node = null
  private _wall: Node = null
  private _fade: number = -1

  onStart() {
    this._gm = this.findNode('GameManager')
    this._fog = this.getChildByName('Fog')[0] ?? null
    this._wall = this.getChildByName('FogWall')[0] ?? null
    this._solid(true)
    ;(this._gm as any)?.registerInteractable?.(this)
  }

  onDespawn() {
    ;(this._gm as any)?.unregisterInteractable?.(this)
  }

  public canInteract(player: Node): boolean {
    if (this.gateState !== 'closed' || !player) return false
    return this._side(player.worldPosition) < 0
  }

  public promptText(player: Node): string { return 'Traverse the white fog' }

  public interact(player: Node): void {
    const p = player as any
    if (!p.walkThroughFog) return
    const me = this.worldPosition
    const f = this._forward()
    const start = [me[0] - f[0] * this.entryDistance, player.worldPosition[1], me[2] - f[2] * this.entryDistance]
    const yaw = Math.atan2(f[0], f[2]) * 180 / Math.PI
    this._solid(false)
    p.walkThroughFog(start, yaw, this.walkDistance, this.walkSeconds)
    ;(this._gm as any)?.sfx?.('Fog')
    this.after(this.walkSeconds + 0.05, () => {
      this._solid(true)
      this.gateState = 'fight'
      ;(this._gm as any)?.startBossFight?.(this)
    })
  }

  /** The boss died: fade the fog out and leave the way open. */
  public dissolve(): void {
    this.gateState = 'gone'
    this._solid(false)
    ;(this._fog as any)?.stop?.()
    this._fade = 0
  }

  /** The player died mid-fight. */
  public resetGate(): void {
    if (this.gateState === 'gone') return
    this.gateState = 'closed'
    this._solid(true)
  }

  public isInsideArena(point: ArrayLike<number>): boolean {
    const c = this.arenaCenter
    return Math.hypot(point[0] - c[0], point[2] - c[2]) < this.arenaRadius && this._side(point) > 1
  }

  onUpdate(delta: number) {
    if (this._fade < 0) return
    this._fade += delta
    const wall = this._wall as any
    if (wall && this._fade > 1.2 && wall.visible) wall.visible = false
    if (this._fade > 1.2) this._fade = -1
  }

  /** Signed distance of a point along the gate's forward: negative outside, positive inside. */
  private _side(point: ArrayLike<number>): number {
    const me = this.worldPosition
    const f = this._forward()
    return (point[0] - me[0]) * f[0] + (point[2] - me[2]) * f[2]
  }

  private _forward(): number[] {
    const f = this.worldForward
    const len = Math.hypot(f[0], f[2]) || 1
    return [f[0] / len, 0, f[2] / len]
  }

  private _solid(on: boolean): void {
    const body = this.body as any
    if (body) body.simulatePhysics = on
  }
}
