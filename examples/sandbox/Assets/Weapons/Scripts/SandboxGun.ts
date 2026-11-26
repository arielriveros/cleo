import { Logger, MathUtils, Node } from 'cleo'
import type { LayerName, TemplateName, TriggerName } from 'cleo'
import { attribute, eventDispatch } from 'cleo/decorators'

/** What one shot was, as the gun tells it (`weapon:Shot`). */
export interface SandboxShot {
    gun: Node
    /** What the first pellet hit (the only one, but for a shotgun), or null: nothing within `range`. */
    hit: { point: number[], node: Node | null } | null
    /** Every pellet's hit (a shotgun fires `pellets` of them); null where a pellet hit nothing. */
    hits: ({ point: number[], node: Node | null } | null)[]
    /** The kick a pull of the trigger gives (camera pitch up and yaw, degrees, the weapon's own, the camera's shake); null for a shot fired directly. */
    recoil: { pitch: number, yaw: number, kick: number, shake: number } | null
}

/** Where a shot is seen from: the third person's weapon in the hands, or the first person's viewmodel. */
export interface SandboxShotView {
    /** Fired in first person: the camera's ray alone, and no flash or sound of the gun's own (the viewmodel's clip has them). */
    firstPerson: boolean
    /** Where the tracer starts in first person: the viewmodel's muzzle where it is drawn. */
    muzzle?: ArrayLike<number> | null
}

/**
 * A Sandbox gun: the weapon in the hands, in either view. Attach to a weapon's holder (the `Pistol Grip`, `Rifle Grip`
 * and `Shotgun Grip` nodes on the Mannequin's hand), whose child `Muzzle` is the end of its bore. Its numbers are the
 * weapon's (Firing Line's pistol, AK-47 and SAPS-12), set on each holder in the Player template. The character
 * holding it (SandboxPlayer) calls {@link pull} every frame with the trigger and where the crosshair looks; the gun
 * decides when a shot goes, spends a round from its magazine, and returns the recoil for the holder to apply. It
 * keeps its own magazine and reserve (`ammo`, `reserve`), so a weapon put away and taken out again is as it was left;
 * {@link reload} fills the magazine from the reserve. Out of the reserve, it is dry until the scene starts again.
 *
 * A SHOT is a raycast per pellet (a pistol and a rifle fire one; the shotgun `pellets`), each its own way inside the
 * spread's cone. In third person a pellet is two raycasts: from the camera through the crosshair, up to `range`
 * (what the player aims at), then from the muzzle to that point (what the bullet meets on its way: a corner the
 * camera sees past but the gun does not). In first person the camera's alone, as Firing Line fires. Neither meets the
 * shooter's own body, the trigger zones or the layers named in `passThroughLayers` (the stairs' ramps: there to be
 * walked on, not seen).
 *
 * A HIT on a dynamic body pushes it: the shot's `impulse` (shared by its pellets) along the shot at the point it hit
 * (so a crate hit high tips, a ball spins), no more than `maxPushSpeed` of speed at once. Every hit leaves sparks and
 * dust (`impactTemplate`) and a hole (`holeTemplate`), the hole moving with what it is on; the shot draws a tracer
 * (`tracerTemplate`). In third person the gun flashes at its muzzle (`flashTemplate`) and plays its shot (`shotSound`,
 * a cue in the character's `Sounds` group); in first person the viewmodel's fire clip does both. A template the scene
 * does not have is skipped, with a warning once.
 *
 * SPREAD is Firing Line's: a cone round the crosshair, from `hipSpread` to `aimSpread` as the weapon aims, half again
 * moving (2.2 times at a sprint), less crouched, much more in the air, and wider the longer it fires (bloom, up to 1.6
 * times the hip spread, settling at 5 degrees a second). The holder reads {@link spread} for its crosshair.
 *
 * EVERY SHOT is told as the event `weapon:Shot` (a {@link SandboxShot}), dispatched at the gun: it bubbles up to the
 * character holding it, whose `@eventListener('weapon:Shot')` applies the recoil, and then reaches anything listening
 * with `@onEvent('weapon:Shot')` anywhere (a hit marker, a sound, a score).
 */
export default class SandboxGunNode extends Node {
    /** The weapon's name, on the HUD. */
    @attribute('Weapon')
    public displayName: string = 'Pistol'

    /** Holding the trigger keeps firing (a rifle); a pistol or the shotgun fires once per pull. */
    @attribute('Firing')
    public auto: boolean = false

    @attribute('Firing', { min: 30, max: 1500, step: 1 })
    public roundsPerMinute: number = 380

    /** Pellets a shot fires, each its own way inside the spread: 1, but for a shotgun. */
    @attribute('Firing', { min: 1, max: 24, step: 1 })
    public pellets: number = 1

    /** How far a shot reaches, m. */
    @attribute('Firing', { min: 5, max: 1000, step: 5 })
    public range: number = 140

    /**
     * The push a shot gives a dynamic body, newton-seconds (shared by its pellets): far more than a real bullet's (a
     * rifle's carries about 4), so a shot crate shoves. No body is sped up by more than `maxPushSpeed` by one hit, so a
     * ball is not shot away.
     */
    @attribute('Firing', { min: 0, max: 500, step: 0.5 })
    public impulse: number = 14

    @attribute('Firing', { min: 0, max: 50, step: 0.25 })
    public maxPushSpeed: number = 2.5

    /** Damage a pellet deals at close range (nothing in the Sandbox takes it yet: kept for game modes). */
    @attribute('Firing', { min: 0, max: 500, step: 1 })
    public damage: number = 26

    /**
     * A pull that comes while the gun cannot fire yet (still coming up from the hip, or between two shots) fires as soon
     * as it can, if that is within this many seconds.
     */
    @attribute('Firing', { min: 0, max: 1, step: 0.05 })
    public pullBuffer: number = 0.35

    /** Rounds a magazine holds, and the rounds carried besides it. */
    @attribute('Ammunition', { min: 1, max: 200, step: 1 })
    public magazine: number = 12

    @attribute('Ammunition', { min: 0, max: 2000, step: 1 })
    public reserveRounds: number = 84

    /** Spread, degrees from the crosshair at most: from the hip, and aimed. */
    @attribute('Spread', { min: 0, max: 20, step: 0.05 })
    public hipSpread: number = 1.6

    @attribute('Spread', { min: 0, max: 20, step: 0.05 })
    public aimSpread: number = 0.25

    /** The camera's kick per shot, degrees: up, and up to this either way; and how hard the camera shakes (0..1). */
    @attribute('Recoil', { min: 0, max: 20, step: 0.05 })
    public recoilPitch: number = 1.5

    @attribute('Recoil', { min: 0, max: 10, step: 0.05 })
    public recoilYaw: number = 0.45

    @attribute('Recoil', { min: 0, max: 1, step: 0.01 })
    public shake: number = 0.04

    /** The weapon's own kick per shot, degrees up, carried on `weapon:Shot` for listeners (the Sandbox's body takes `fireTrigger`'s clip instead). */
    @attribute('Recoil', { min: 0, max: 30, step: 0.5 })
    public kick: number = 7

    /** Seconds a reload and the weapon coming into the hands take where no clip says (third person). */
    @attribute('Timing', { min: 0.1, max: 10, step: 0.05 })
    public reloadSeconds: number = 2.2

    @attribute('Timing', { min: 0.1, max: 5, step: 0.05 })
    public equipSeconds: number = 1.2

    /** First person, aimed: the field of view (degrees), the share of the walk it moves at, and whether its viewmodel has aim clips. */
    @attribute('First Person', { min: 10, max: 120, step: 1 })
    public aimFov: number = 62

    @attribute('First Person', { min: 0.1, max: 1, step: 0.05 })
    public aimMove: number = 0.7

    @attribute('First Person')
    public aimClips: boolean = true

    /** First person, aimed without aim clips: how far the viewmodel comes in to the sights (m: left, up, forward). */
    @attribute('First Person')
    public aimOffset: number[] = [0, 0.012, 0]

    /** Collision layers a shot passes through, by name. */
    @attribute('Hits')
    public passThroughLayers: LayerName[] = ['Stair Ramp']

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

    /** The shot's cue in the holder's `Sounds` group (third person; in first person the fire clip plays it). */
    @attribute('Effects')
    public shotSound: string = 'ShotPistol'

    /** The holder's body recoil, an animator trigger (the Recoil layer's kick of this weapon), raised on every shot. */
    @attribute('Effects')
    public fireTrigger: TriggerName = '' as TriggerName

    /** Rounds in the magazine, and in the reserve. */
    public ammo: number = 12
    public reserve: number = 84
    /** Shots fired, ever, and what the last one hit (null: nothing within `range`). */
    public shots: number = 0
    public lastHit: { point: number[], node: Node | null } | null = null
    /** The last pull found the magazine empty. */
    public dry: boolean = false

    /** Seconds to the next shot the rate allows (below 0: the shot is late by that much, and the next comes as early). */
    private _cooldown: number = 0
    private _held: boolean = false
    /** Seconds a pull that could not fire yet still waits to. */
    private _queued: number = 0
    private _bloom: number = 0
    private _mask: number | null = null
    private _holes: Node[] = []
    private _missing: Set<string> = new Set()
    private readonly _dir: number[] = [0, 0, 0]

    onStart() {
        this.ammo = this.magazine
        this.reserve = this.reserveRounds
    }

    onUpdate(delta: number) {
        this._cooldown -= delta
        this._queued = Math.max(0, this._queued - delta)
        this._bloom = Math.max(0, this._bloom - 5 * delta)
    }

    /**
     * The spread now, degrees: `aim` 0 from the hip to 1 aimed, and whether the holder is moving, sprinting,
     * crouching and on the ground.
     */
    public spread(aim: number, moving: boolean, sprinting = false, crouched = false, grounded = true): number {
        const a = Math.max(0, Math.min(1, aim))
        const base = this.hipSpread + (this.aimSpread - this.hipSpread) * a
        return base * (moving ? (sprinting ? 2.2 : 1.5) : 1) * (crouched ? 0.7 : 1) * (grounded ? 1 : 2.5) + this._bloom * (1 - a * 0.6)
    }

    /** Whether a reload would put anything in the magazine. */
    public get canReload(): boolean {
        return this.ammo < this.magazine && this.reserve > 0
    }

    /** Fill the magazine from the reserve; returns the rounds moved. */
    public reload(): number {
        const take = Math.min(this.magazine - this.ammo, this.reserve)
        this.ammo += take
        this.reserve -= take
        return take
    }

    /**
     * The trigger, every frame: `held` whether it is pulled, `ready` whether the weapon is up to fire, `eye` and
     * `look` the camera's position and the way the crosshair looks (unit), `spread` the cone (degrees), `shooter` the
     * body the shots never meet, `view` where it is seen from. Fires when the trigger asks, the gun is ready and the
     * magazine holds a round; returns the recoil of the shot, or null when it did not fire (`dry` says whether that
     * was an empty magazine).
     */
    public pull(held: boolean, ready: boolean, eye: ArrayLike<number>, look: ArrayLike<number>, spread: number, shooter: unknown, view: SandboxShotView)
        : SandboxShot['recoil'] {
        // A pull (the trigger going down) waits `pullBuffer` for the gun to be able to fire; an automatic fires while held.
        const pulled = held && !this._held
        if (pulled) this._queued = this.pullBuffer
        this._held = held
        this.dry = false
        const wants = this.auto ? held : this._queued > 0
        if (!wants || !ready) { this._cooldown = Math.max(0, this._cooldown); return null }
        if (this._cooldown > 0) return null
        if (this.ammo <= 0) { this.dry = pulled || this.auto; this._queued = 0; return null }
        // The rate kept on average, whatever the frame rate: a shot late by part of a frame brings the next one forward.
        const interval = 60 / Math.max(1, this.roundsPerMinute)
        this._cooldown = Math.max(this._cooldown, -interval) + interval
        this._queued = 0
        this.ammo--
        const recoil = { pitch: this.recoilPitch, yaw: (Math.random() * 2 - 1) * this.recoilYaw, kick: this.kick, shake: this.shake }
        this.fire(eye, look, spread, shooter, recoil, view)
        this._bloom = Math.min(this.hipSpread * 1.6, this._bloom + this.hipSpread * 0.12)
        return recoil
    }

    /**
     * One shot from the camera at `eye` along `look`, `spread` degrees round it at most, passing `shooter`'s body:
     * a raycast (or two) per pellet, the push, the effects, and the `weapon:Shot` event (with `recoil`, when a pull
     * fired it). Spends no round. Returns what the first pellet hit, or null.
     */
    public fire(eye: ArrayLike<number>, look: ArrayLike<number>, spread: number, shooter?: unknown,
        recoil: SandboxShot['recoil'] = null, view: SandboxShotView = { firstPerson: false }): { point: number[], node: Node | null } | null {
        const hits = this._shoot(eye, look, spread, shooter, view)
        this._told({ gun: this, hit: hits[0] ?? null, hits, recoil })
        return hits[0] ?? null
    }

    /** Tell the shot: what this returns is the `weapon:Shot` event, dispatched here and bubbling to the holder. */
    @eventDispatch('weapon:Shot')
    private _told(shot: SandboxShot): SandboxShot {
        return shot
    }

    /** The shot itself: its pellets' raycasts, the pushes and the effects. */
    private _shoot(eye: ArrayLike<number>, look: ArrayLike<number>, spread: number, shooter: unknown, view: SandboxShotView) {
        const physics = this.scene?.physics as any
        this.shots++
        const muzzleNode = this.getChildByName('Muzzle')[0] ?? this
        muzzleNode.updateTransforms(muzzleNode.parent ? muzzleNode.parent.worldTransform : null)
        const m = view.firstPerson && view.muzzle ? view.muzzle : muzzleNode.worldPosition
        const muzzle = [m[0], m[1], m[2]]
        if (!view.firstPerson) {
            const f = muzzleNode.worldForward
            this._spawn(this.flashTemplate, muzzle, eulerAlong([f[0], f[1], f[2]]))
            this._playSound()
        }
        this.lastHit = null
        const hits: ({ point: number[], node: Node | null } | null)[] = []
        if (!physics) return hits
        const options = { ignore: shooter ?? null, layerMask: this._layerMask(physics) }
        const pellets = Math.max(1, Math.round(this.pellets))
        const push = this.impulse / pellets
        for (let k = 0; k < pellets; k++) {
            const dir = MathUtils.randomInCone(this._dir, look, spread) as number[]
            // What the crosshair looks at...
            const far = [eye[0] + dir[0] * this.range, eye[1] + dir[1] * this.range, eye[2] + dir[2] * this.range]
            const seen = physics.raycast([eye[0], eye[1], eye[2]], far, options)
            let hit = seen, way = [dir[0], dir[1], dir[2]]
            if (!view.firstPerson) {
                // ...and, in third person, what the bullet meets on its way there from the muzzle (a little past it,
                // so it meets the surface).
                const target = seen ? seen.point : far
                const toTarget = [target[0] - muzzle[0], target[1] - muzzle[1], target[2] - muzzle[2]]
                const length = Math.hypot(toTarget[0], toTarget[1], toTarget[2])
                if (length < 1e-3) { hits.push(null); continue }
                way = [toTarget[0] / length, toTarget[1] / length, toTarget[2] / length]
                const end = [muzzle[0] + way[0] * (length + 0.05), muzzle[1] + way[1] * (length + 0.05), muzzle[2] + way[2] * (length + 0.05)]
                hit = physics.raycast(muzzle, end, options)
                // One tracer a shot: the first pellet's.
                if (k === 0) this._tracer(muzzle, hit ? hit.point : target)
            } else if (k === 0) this._tracer(muzzle, seen ? seen.point : far)
            const record = hit ? { point: [hit.point[0], hit.point[1], hit.point[2]], node: hit.node ?? null } : null
            hits.push(record)
            if (k === 0) this.lastHit = record
            if (!hit) continue
            this._push(hit, way, push)
            this._impact(hit)
        }
        return hits
    }

    /** Every layer but `passThroughLayers`, looked up by name once. */
    private _layerMask(physics: any): number {
        if (this._mask === null) {
            let mask = -1
            for (const name of this.passThroughLayers ?? []) if (name) mask &= ~(physics.layer?.(name) ?? 0)
            this._mask = mask
        }
        return this._mask
    }

    /** A dynamic body hit is pushed along the shot, at the point hit (measured from its centre). */
    private _push(hit: any, way: number[], impulse: number): void {
        const body = hit.body
        if (!body || !body.isDynamic || impulse <= 0) return
        const origin = body.owner?.worldPosition ?? hit.point
        const push = Math.min(impulse, this.maxPushSpeed * Math.max(0, body.mass ?? 0))
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

    /** The shot's cue, from the nearest `Sounds` group above the gun (the character's). */
    private _playSound(): void {
        if (!this.shotSound) return
        for (let n: Node | null = this.parent; n; n = n.parent) {
            const group = n.getChildByName('Sounds')[0]
            if (!group) continue
            const cue = group.getChildByName(this.shotSound)[0] as any
            cue?.play?.()
            return
        }
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
    const aim = MathUtils.aimFromDirection([d[0], d[1], d[2]] as any)
    return [aim.pitch, aim.yaw, 0]
}

/** Euler degrees [pitch, yaw, 0] that turn a node's +Y onto `normal` (a decal projects down its -Y). */
function eulerOntoNormal(normal: ArrayLike<number>): number[] {
    const ny = Math.max(-1, Math.min(1, normal[1]))
    return [Math.acos(ny) * 180 / Math.PI, Math.atan2(normal[0], normal[2]) * 180 / Math.PI, 0]
}
