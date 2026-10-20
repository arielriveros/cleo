import { Node, Shape } from 'cleo'

/**
 * The pieces of something that broke (see SoulsBreakable). Attach to the root of a template whose
 * children are the pieces, posed where they sat in the whole object:
 *
 *   Barrel Debris      this script
 *   ├── Stave 1        a model each, positioned in the intact shape
 *   ├── Lid Plank 2
 *   └── ...
 *
 * `burst(velocity)` gives every piece a dynamic box body fitted to its mesh -- moved to the scene root
 * first, since a body must not be parented -- an outward kick from the centre plus `velocity`, and a
 * spin. Each piece then lies for `lifeSeconds` (staggered a little) and dissolves away (Node.remove).
 * A copy placed by hand bursts on its own the frame after it starts.
 */
export default class SoulsDebrisNode extends Node {
  /** Seconds a piece lies there before it dissolves. */
  public lifeSeconds: number = 6
  /** Spread of that, so the pile does not vanish in one frame. */
  public lifeJitter: number = 1.5
  /** Metres per second each piece flies out from the centre, on top of the burst velocity. */
  public scatterSpeed: number = 2
  /** Radians per second of tumble, at most. */
  public spin: number = 8
  /** Kilograms per cubic metre of a piece's box: wood is around 600. */
  public density: number = 600

  private _burst: boolean = false
  private _pieces: Node[] = []

  onStart() {
    this.after(0, () => { if (!this._burst) this.burst([0, 0, 0]) })
  }

  public burst(velocity: ArrayLike<number>): void {
    if (this._burst) return
    this._burst = true
    const root = this.scene?.root
    if (!root) return
    this.updateTransforms?.()
    const centre = Array.from(this.worldPosition)
    let longest = 0
    for (const piece of [...this.children]) {
      const model = (piece as any).model
      if (!model?.geometry) continue
      const bb = model.geometry.boundingBox
      const s = piece.worldScale
      const size = [0, 1, 2].map(a => Math.max(0.02, (bb.max[a] - bb.min[a]) * Math.abs(s[a])))
      const offset = [0, 1, 2].map(a => (bb.min[a] + bb.max[a]) / 2 * s[a])

      const at = Array.from(piece.worldPosition), q = Array.from(piece.worldQuaternion)
      root.addChild(piece)
      piece.setPosition([at[0], at[1], at[2]])
      piece.setQuaternion(q as any)
      piece.updateTransforms?.()

      const mass = Math.max(0.2, size[0] * size[1] * size[2] * this.density)
      // The box takes the node's scale itself (Shape.Box scales by it), so it is given in local units.
      const body: any = piece.setBody(mass, 0.1, 0.3, undefined, undefined, 0.8, 0.05, true, false)
      body.attachShape(Shape.Box(size[0] / Math.abs(s[0] || 1), size[1] / Math.abs(s[1] || 1), size[2] / Math.abs(s[2] || 1), s as any),
        offset as any)
      body.recenterMass?.()

      // Out from the centre, up a little, plus the blow.
      const out = [at[0] - centre[0], 0, at[2] - centre[2]]
      const len = Math.hypot(out[0], out[2]) || 1
      const kick = this.scatterSpeed * (0.6 + Math.random() * 0.6)
      ;(piece as any).velocity = [
        velocity[0] + out[0] / len * kick,
        velocity[1] + 1 + Math.random() * 1.5,
        velocity[2] + out[2] / len * kick,
      ]
      body.angularVelocity?.set?.((Math.random() * 2 - 1) * this.spin, (Math.random() * 2 - 1) * this.spin, (Math.random() * 2 - 1) * this.spin)

      const life = this.lifeSeconds + Math.random() * this.lifeJitter
      longest = Math.max(longest, life)
      piece.after(life, () => piece.remove())
      this._pieces.push(piece)
    }
    // The empty root outlives the pieces' dissolve, then goes too.
    this.after(longest + (this.scene as any)?.despawnFadeSeconds + 0.5, () => this.remove({ immediate: true }))
  }
}
