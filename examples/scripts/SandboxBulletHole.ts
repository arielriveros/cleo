import { Node } from 'cleo'
import { attribute } from 'cleo/decorators'

/**
 * A Sandbox bullet hole. Attach to the root of a template whose children are Decal nodes; SandboxGun instantiates it
 * at a hit, its +Y on the surface's normal (a decal projects down its -Y), and moves it under the body hit when that
 * body moves. On start each decal takes a random size between `minSize` and `maxSize`; after `lifetime` seconds they
 * fade out over `fadeSeconds` and the hole removes itself. The gun also removes its oldest past its own limit.
 */
export default class SandboxBulletHoleNode extends Node {
    @attribute({ min: 1, max: 600, step: 1 })
    public lifetime: number = 40

    @attribute({ min: 0, max: 60, step: 0.5 })
    public fadeSeconds: number = 5

    @attribute({ min: 0.1, max: 4, step: 0.05 })
    public minSize: number = 0.8

    @attribute({ min: 0.1, max: 4, step: 0.05 })
    public maxSize: number = 1.2

    private _age: number = 0
    private _decals: any[] = []

    onStart() {
        this._decals = this.children.filter(c => c.nodeType === 'decal')
        const scale = this.minSize + Math.random() * Math.max(0, this.maxSize - this.minSize)
        for (const d of this._decals) {
            const s = d.size
            d.size = [s[0] * scale, s[1], s[2] * scale]
        }
    }

    onUpdate(delta: number) {
        this._age += delta
        const k = Math.max(0, Math.min(1, (this.lifetime - this._age) / Math.max(0.01, this.fadeSeconds)))
        for (const d of this._decals) if (Math.abs(d.opacity - k) > 0.01) d.opacity = k
        if (this._age >= this.lifetime) this.remove({ immediate: true })
    }
}
