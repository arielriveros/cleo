import { Node } from 'cleo'
import { clamp } from '@/FPS/Scripts/FpsShared'

/**
 * FPS example — a bullet hole. Attach to the root of a template whose children are Decal nodes; the shooter
 * (FpsCombatant) instantiates one at the hit, turned so its decals project straight into the surface. On
 * start each decal takes a random spin about its own axis and a random size; after `lifetime` they fade over
 * `fadeSeconds` and the template removes itself. The Game Manager also removes the oldest past its limit.
 */
export default class FpsDecalNode extends Node {
  public lifetime: number = 45
  public fadeSeconds: number = 6
  public minSize: number = 0.8
  public maxSize: number = 1.2

  private _age: number = 0
  private _decals: any[] = []

  onStart() {
    this._decals = this.children.filter(c => c.nodeType === 'decal')
    const scale = this.minSize + Math.random() * Math.max(0, this.maxSize - this.minSize)
    for (const d of this._decals) {
      d.setRotation([0, Math.random() * 360, 0])
      const s = d.size
      d.size = [s[0] * scale, s[1], s[2] * scale]
    }
  }

  onUpdate(delta: number) {
    this._age += delta
    const k = clamp((this.lifetime - this._age) / Math.max(0.01, this.fadeSeconds), 0, 1)
    for (const d of this._decals) if (Math.abs(d.opacity - k) > 0.01) d.opacity = k
    if (this._age >= this.lifetime) this.remove({ immediate: true })
  }
}
