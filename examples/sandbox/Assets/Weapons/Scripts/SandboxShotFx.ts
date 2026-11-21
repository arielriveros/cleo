import { Node } from 'cleo'
import { attribute } from 'cleo/decorators'

/**
 * A Sandbox shot effect that plays once and goes: the muzzle flash, a bullet's impact. Attach to the root of the
 * effect's template; SandboxGun instantiates it. On start it plays every Particle System under it, fades every
 * light under it over `lifetime` (`lightFalloff` squares the fade, so a flash's light drops fast), and removes
 * itself when `lifetime` is up. The look is the template's particle systems and lights.
 */
export default class SandboxShotFxNode extends Node {
    @attribute({ min: 0.05, max: 10, step: 0.05 })
    public lifetime: number = 0.6

    @attribute({ min: 0.5, max: 8, step: 0.5 })
    public lightFalloff: number = 2

    private _age: number = 0
    private _lights: { light: any, intensity: number }[] = []

    onStart() {
        this._age = 0
        const walk = (node: Node) => {
            for (const child of node.children) {
                const c = child as any
                if (child.nodeType === 'particleSystem') c.play?.()
                if (child.nodeType === 'light' && c.light) this._lights.push({ light: c.light, intensity: c.light.intensity })
                walk(child)
            }
        }
        walk(this)
    }

    onUpdate(delta: number) {
        this._age += delta
        const k = Math.pow(Math.max(0, 1 - this._age / Math.max(0.01, this.lifetime)), this.lightFalloff)
        for (const l of this._lights) l.light.intensity = l.intensity * k
        if (this._age >= this.lifetime) this.remove({ immediate: true })
    }
}
