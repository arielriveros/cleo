import { Logger, Node } from 'cleo'
import type { TemplateName } from 'cleo'
import { attribute, eventDispatch } from 'cleo/decorators'

/** What one shot was, as the gun tells it (`weapon:Shot`). */
export interface SandboxShot {
    gun: Node
    /** What it hit, or null: nothing within `range`. */
    hit: { point: number[], node: Node | null } | null
    /** The kick a pull of the trigger gives (camera pitch up and yaw, degrees, and the weapon's); null for a shot fired directly. */
    recoil: { pitch: number, yaw: number, kick: number } | null
}

/**
 * A Sandbox gun: hitscan shots by raycast, pushing what they hit. Attach to a weapon's holder (the `Pistol Grip` and
 * `Rifle Grip` nodes on the Mannequin's hand), whose child `Muzzle` is the end of its bore. The character holding it
 * (SandboxPlayer) calls {@link pull} every frame with the trigger and where the crosshair looks; the gun decides
 * when a shot goes, and returns the recoil for the holder to apply.
 *
 * A SHOT is two raycasts. The first goes from the camera through the crosshair (the middle of the screen), up to
 * `range`: what the player aims at. The second goes from the muzzle to that point: what the bullet meets on its way
 * there (a corner the camera sees past, but the gun does not). The bullet stops at whichever comes first. Neither
 * meets the shooter's own body, the trigger zones or the layers named in `passThroughLayers` (the stairs' ramps:
 * there to be walked on, not seen).
 *
 * A HIT on a dynamic body pushes it: an `impulse` along the shot, at the point it hit (so a crate hit high tips, a
 * ball spins), no more than `maxPushSpeed` of speed at once. Every hit leaves sparks and dust (`impactTemplate`) and a hole (`holeTemplate`), the hole moving with
 * what it is on; the shot draws a tracer (`tracerTemplate`) and a muzzle flash (`flashTemplate`). A template the scene
 * does not have is skipped, with a warning once.
 *
 * SPREAD is a cone round the crosshair: tight aimed (`aimSpread`), wider from the hip (`hipSpread`), wider moving
 * (`moveSpread` at a run), and wider still the longer it fires (`bloomPerShot`, up to `bloomMax`, settling at
 * `bloomRecovery` degrees a second). The holder reads {@link spread} for its crosshair.
 *
 * EVERY SHOT is told as the event `weapon:Shot` (a {@link SandboxShot}), dispatched at the gun: it bubbles up to the
 * character holding it, whose `@eventListener('weapon:Shot')` applies the recoil, and then reaches anything listening
 * with `@onEvent('weapon:Shot')` anywhere (a hit marker, a sound, a score).
 */
export default class SandboxGunNode extends Node {
    /** Holding the trigger keeps firing (a rifle); a pistol fires once per pull. */
    @attribute('Firing')
    public auto: boolean = false

    @attribute('Firing', { min: 30, max: 1500, step: 10 })
    public roundsPerMinute: number = 420

    /** How far a shot reaches, m. */
    @attribute('Firing', { min: 5, max: 1000, step: 5 })
    public range: number = 200

    /**
     * The push a hit gives a dynamic body, newton-seconds: far more than a real bullet's (a rifle's carries about 4), so
     * a shot crate shoves. No body is sped up by more than `maxPushSpeed` by one hit, so a ball is not shot away.
     */
    @attribute('Firing', { min: 0, max: 500, step: 0.5 })
    public impulse: number = 14

    @attribute('Firing', { min: 0, max: 50, step: 0.25 })
    public maxPushSpeed: number = 2.5

    /** Spread, degrees from the crosshair at most: aimed, from the hip, and the extra at a run. */
    @attribute('Spread', { min: 0, max: 20, step: 0.05 })
    public aimSpread: number = 0.3

    @attribute('Spread', { min: 0, max: 20, step: 0.05 })
    public hipSpread: number = 2.2

    @attribute('Spread', { min: 0, max: 20, step: 0.05 })
    public moveSpread: number = 2.5

    /** Bloom: each shot widens the spread by this, up to `bloomMax`, settling at `bloomRecovery` degrees a second. */
    @attribute('Spread', { min: 0, max: 10, step: 0.05 })
    public bloomPerShot: number = 0.5

    @attribute('Spread', { min: 0, max: 20, step: 0.1 })
    public bloomMax: number = 2.5

    @attribute('Spread', { min: 0, max: 50, step: 0.5 })
    public bloomRecovery: number = 8

    /** The camera's kick per shot, degrees: up, and up to this either way. */
    @attribute('Recoil', { min: 0, max: 20, step: 0.05 })
    public recoilPitch: number = 1.6

    @attribute('Recoil', { min: 0, max: 10, step: 0.05 })
    public recoilYaw: number = 0.4

    /** The weapon's own kick in the hands per shot, degrees up (the aim settles it back). */
    @attribute('Recoil', { min: 0, max: 30, step: 0.5 })
    public kick: number = 6

    /** Collision layers a shot passes through, by name, comma separated. */
    @attribute('Hits')
    public passThroughLayers: string = 'Stair Ramp'

    /**
     * A pull that comes while the gun cannot fire yet (still coming up from the hip, or between two shots) fires as soon
     * as it can, if that is within this many seconds.
     */
    @attribute('Firing', { min: 0, max: 1, step: 0.05 })
    public pullBuffer: number = 0.35

    /** Bullet holes this gun keeps; the oldest goes when there are more. */
    @attribute('Hits', { min: 0, max: 500, step: 1 })
    public maxHoles: number = 60

    @attribute('Effects')
    public flashTemplate: TemplateName = 'Muzzle Flash' as TemplateName

    @attribute('Effects')
    public impactTemplate: TemplateName = 'Bullet Impact' as TemplateName

    @attribute('Effects')
    public holeTemplate: TemplateName = 'Bullet Hole' as TemplateName

    @attribute('Effects')
    public tracerTemplate: TemplateName = 'Tracer' as TemplateName

    /** Shots fired, ever, and what the last one hit (null: nothing within `range`). */
    public shots: number = 0
    public lastHit: { point: number[], node: Node | null } | null = null

    /** Seconds to the next shot the rate allows (below 0: the shot is late by that much, and the next comes as early). */
    private _cooldown: number = 0
    private _held: boolean = false
    /** Seconds a pull that could not fire yet still waits to. */
    private _queued: number = 0
    private _bloom: number = 0
    private _mask: number | null = null
    private _holes: Node[] = []
    private _missing: Set<string> = new Set()

    onUpdate(delta: number) {
        this._cooldown -= delta
        this._queued = Math.max(0, this._queued - delta)
        this._bloom = Math.max(0, this._bloom - this.bloomRecovery * delta)
    }

    /** The spread now, degrees: `aim` 0 from the hip to 1 aimed, `moving` 0 standing to 1 at a run. */
    public spread(aim: number, moving: number): number {
        const base = this.hipSpread + (this.aimSpread - this.hipSpread) * Math.max(0, Math.min(1, aim))
        return base + this.moveSpread * Math.max(0, Math.min(1, moving)) + this._bloom
    }

    /**
     * The trigger, every frame: `held` whether it is pulled, `ready` whether the weapon is up to fire, `eye` and
     * `look` the camera's position and the way the crosshair looks (unit), `aim` and `moving` as for {@link spread},
     * `shooter` the body the shots never meet. Fires when the trigger asks and the gun is ready; returns the recoil
     * of the shot (camera pitch up and yaw, degrees, and the weapon's kick), or null when it did not fire.
     */
    public pull(held: boolean, ready: boolean, eye: ArrayLike<number>, look: ArrayLike<number>, aim: number, moving: number, shooter: unknown)
        : { pitch: number, yaw: number, kick: number } | null {
        // A pull (the trigger going down) waits `pullBuffer` for the gun to be able to fire; an automatic fires while held.
        if (held && !this._held) this._queued = this.pullBuffer
        this._held = held
        const wants = this.auto ? held : this._queued > 0
        if (!wants || !ready) { this._cooldown = Math.max(0, this._cooldown); return null }
        if (this._cooldown > 0) return null
        // The rate kept on average, whatever the frame rate: a shot late by part of a frame brings the next one forward.
        const interval = 60 / Math.max(1, this.roundsPerMinute)
        this._cooldown = Math.max(this._cooldown, -interval) + interval
        this._queued = 0
        const recoil = { pitch: this.recoilPitch, yaw: (Math.random() * 2 - 1) * this.recoilYaw, kick: this.kick }
        this.fire(eye, look, this.spread(aim, moving), shooter, recoil)
        this._bloom = Math.min(this.bloomMax, this._bloom + this.bloomPerShot)
        return recoil
    }

    /**
     * One shot from the camera at `eye` along `look`, `spread` degrees round it at most, passing `shooter`'s body:
     * the two raycasts, the push, the effects, and the `weapon:Shot` event (with `recoil`, when a pull fired it).
     * Returns what it hit, or null.
     */
    public fire(eye: ArrayLike<number>, look: ArrayLike<number>, spread: number, shooter?: unknown,
        recoil: SandboxShot['recoil'] = null): { point: number[], node: Node | null } | null {
        const hit = this._shoot(eye, look, spread, shooter)
        this._told({ gun: this, hit, recoil })
        return hit
    }

    /** Tell the shot: what this returns is the `weapon:Shot` event, dispatched here and bubbling to the holder. */
    @eventDispatch('weapon:Shot')
    private _told(shot: SandboxShot): SandboxShot {
        return shot
    }

    /** The shot itself: the raycasts, the push and the effects. */
    private _shoot(eye: ArrayLike<number>, look: ArrayLike<number>, spread: number, shooter?: unknown): { point: number[], node: Node | null } | null {
        const physics = this.scene?.physics as any
        this.shots++
        const muzzleNode = this.getChildByName('Muzzle')[0] ?? this
        muzzleNode.updateTransforms(muzzleNode.parent ? muzzleNode.parent.worldTransform : null)
        const m = muzzleNode.worldPosition
        const muzzle = [m[0], m[1], m[2]]
        const f = muzzleNode.worldForward
        this._spawn(this.flashTemplate, muzzle, eulerAlong([f[0], f[1], f[2]]))
        this.lastHit = null
        if (!physics) return null
        const dir = cone(look, spread)
        const options = { ignore: shooter ?? null, layerMask: this._layerMask(physics) }
        // What the crosshair looks at...
        const far = [eye[0] + dir[0] * this.range, eye[1] + dir[1] * this.range, eye[2] + dir[2] * this.range]
        const seen = physics.raycast([eye[0], eye[1], eye[2]], far, options)
        const target = seen ? seen.point : far
        // ...and what the bullet meets on its way there from the muzzle (a little past it, so it meets the surface).
        const toTarget = [target[0] - muzzle[0], target[1] - muzzle[1], target[2] - muzzle[2]]
        const length = Math.hypot(toTarget[0], toTarget[1], toTarget[2])
        if (length < 1e-3) return null
        const way = [toTarget[0] / length, toTarget[1] / length, toTarget[2] / length]
        const end = [muzzle[0] + way[0] * (length + 0.05), muzzle[1] + way[1] * (length + 0.05), muzzle[2] + way[2] * (length + 0.05)]
        const hit = physics.raycast(muzzle, end, options)
        this._tracer(muzzle, hit ? hit.point : target)
        this.lastHit = hit ? { point: [hit.point[0], hit.point[1], hit.point[2]], node: hit.node ?? null } : null
        if (!hit) return null
        this._push(hit, way)
        this._impact(hit)
        return this.lastHit
    }

    /** Every layer but `passThroughLayers`, looked up by name once. */
    private _layerMask(physics: any): number {
        if (this._mask === null) {
            let mask = -1
            for (const name of this.passThroughLayers.split(',').map(s => s.trim()).filter(Boolean)) mask &= ~(physics.layer?.(name) ?? 0)
            this._mask = mask
        }
        return this._mask
    }

    /** A dynamic body hit is pushed along the shot, at the point hit (measured from its centre). */
    private _push(hit: any, way: number[]): void {
        const body = hit.body
        if (!body || !body.isDynamic || this.impulse <= 0) return
        const origin = body.owner?.worldPosition ?? hit.point
        const push = Math.min(this.impulse, this.maxPushSpeed * Math.max(0, body.mass ?? 0))
        if (push <= 0) return
        body.wakeUp?.()
        body.impulse([way[0] * push, way[1] * push, way[2] * push],
            [hit.point[0] - origin[0], hit.point[1] - origin[1], hit.point[2] - origin[2]])
    }

    /** Sparks and dust off the surface, and a hole in it: one that moves with what it is on. */
    private _impact(hit: any): void {
        const n = hit.normal
        const at = [hit.point[0] + n[0] * 0.01, hit.point[1] + n[1] * 0.01, hit.point[2] + n[2] * 0.01]
        const rotation = eulerOntoNormal(n)
        this._spawn(this.impactTemplate, at, rotation)
        const hole = this._spawn(this.holeTemplate, at, [rotation[0], rotation[1], Math.random() * 360])
        if (!hole) return
        // On a body that moves, the hole goes with it.
        if (hit.node && hit.body?.isDynamic) hole.reparent(hit.node)
        this._holes.push(hole)
        while (this._holes.length > this.maxHoles) {
            const old = this._holes.shift()!
            if (old.scene) old.remove({ immediate: true })
        }
    }

    /** A streak from the muzzle to where the shot ended (none for a shot too short to see one). */
    private _tracer(from: number[], to: number[]): void {
        const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]]
        const length = Math.hypot(d[0], d[1], d[2])
        if (length < 2) return
        const node: any = this._spawn(this.tracerTemplate, from, eulerAlong(d))
        if (node) node.tracerLength = length
    }

    /** Spawn an effect template, or nothing (and a warning, once) when the scene has none of that name. */
    private _spawn(template: string, position: number[], rotation: number[]): Node | null {
        if (!template || this._missing.has(template)) return null
        const node = (this.scene as any)?.instantiate(template, { position, rotation }) ?? null
        if (!node) {
            this._missing.add(template)
            Logger.warn(`SandboxGun: no "${template}" template, so that effect is skipped`, 'Script')
        }
        return node
    }
}

/** Euler degrees [pitch, yaw, 0] that turn a node's +Z along `d`. */
function eulerAlong(d: ArrayLike<number>): number[] {
    return [Math.atan2(-d[1], Math.hypot(d[0], d[2])) * 180 / Math.PI, Math.atan2(d[0], d[2]) * 180 / Math.PI, 0]
}

/** Euler degrees [pitch, yaw, 0] that turn a node's +Y onto `normal` (a decal projects down its -Y). */
function eulerOntoNormal(normal: ArrayLike<number>): number[] {
    const ny = Math.max(-1, Math.min(1, normal[1]))
    return [Math.acos(ny) * 180 / Math.PI, Math.atan2(normal[0], normal[2]) * 180 / Math.PI, 0]
}

/** A direction at most `degrees` off `dir` (unit), spread evenly over the cone's disc. */
function cone(dir: ArrayLike<number>, degrees: number): number[] {
    const angle = Math.sqrt(Math.random()) * degrees * Math.PI / 180
    const roll = Math.random() * Math.PI * 2
    // Two directions square to `dir`.
    const up = Math.abs(dir[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0]
    let rx = dir[1] * up[2] - dir[2] * up[1], ry = dir[2] * up[0] - dir[0] * up[2], rz = dir[0] * up[1] - dir[1] * up[0]
    const rl = Math.hypot(rx, ry, rz) || 1
    rx /= rl; ry /= rl; rz /= rl
    const ux = ry * dir[2] - rz * dir[1], uy = rz * dir[0] - rx * dir[2], uz = rx * dir[1] - ry * dir[0]
    const s = Math.sin(angle), c = Math.cos(angle), a = Math.cos(roll) * s, b = Math.sin(roll) * s
    const out = [dir[0] * c + rx * a + ux * b, dir[1] * c + ry * a + uy * b, dir[2] * c + rz * a + uz * b]
    const l = Math.hypot(out[0], out[1], out[2]) || 1
    return [out[0] / l, out[1] / l, out[2] / l]
}
