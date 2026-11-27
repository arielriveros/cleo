import { setMoveWorld } from 'cleo'
import type { ControllerNode, Node } from 'cleo'
import { attribute, eventListener, onEvent } from 'cleo/decorators'
import SandboxCharacterNode from '@/Characters/Mannequin/Scripts/SandboxCharacter'

/** What set an NPC off: a shot heard, one that nearly hit it, one that hit it, or a car. */
export type ThreatKind = 'shot' | 'nearMiss' | 'hit' | 'vehicle'

/** The pace an NPC goes at: standing, walking, jogging (the Character's walkSpeed) or sprinting (its runSpeed). */
export type Gait = 'stand' | 'walk' | 'jog' | 'sprint'

/**
 * A Sandbox NPC: a Sandbox Character (the player's body, model, rig and animations: SandboxCharacter) driven by a
 * brain instead of input. The base of the civilians (SandboxCivilian) and the enemies (SandboxEnemy). Attach to the
 * **Character** node of an NPC template (a variant of Sandbox Character), with an AI Controller under it:
 *
 *   Civilian / Enemy    capsule Collider
 *   └─ Character        THIS script's subclass
 *      ├─ Mannequin     the animated model (its own material: blue, red)
 *      ├─ Weapons, Sounds   (an enemy's)
 *      └─ AI Controller     possesses the Character, sees, walks the nav mesh, and thinks with its AI Brain
 *
 * THE BRAIN is the AI Controller's: an AI Brain asset (Characters/NPCs/AI: Civilian Brain, Enemy Brain), a behaviour
 * machine. Its states set the controller's goal (stand, walk the nav mesh to a point, keep away from the player...),
 * and its transitions decide when to change, on the controller's senses (the player in sight, how far, how long since
 * it was seen: the blackboard's `target` is the player, on foot) and on what this script measures (the getters under
 * "What the brain reads": knocked down, there yet, stuck, the state's time up, how long since a shot, a danger...).
 * Edit it in its AI Brain tab.
 *
 * THIS SCRIPT does what a graph cannot: on entering a state (`enterState`), choose where to go and how long to stay;
 * in it, every frame (`inState`), how fast, crouched or not, where to look, what its hands do. And the senses a
 * machine has no word for:
 *
 *   - shots heard (`weapon:Shot` from anyone else's gun within `hearing`), shots that nearly hit it (within
 *     `nearMiss` of their line), hits (`reaction:Hit`), and a car bearing down on it (SandboxCar's `dodgeVehicle`,
 *     answered at once with a sideways sprint) or hitting it: every one comes to `threaten(kind, at, source)`;
 *   - KNOCK-DOWNS: hits add up (`shock`, fading by `shockHalfLife`): past `staggerShock` it staggers, past
 *     `knockdownShock` (or hit in the legs running) it falls. One shot is a flinch;
 *   - IT NEVER DIES: its health is kept full, and a body down too long is got up (`downSeconds`).
 *
 * The NPC's own team (`team`) is what the others' senses filter on.
 */
export default class SandboxNpcNode extends SandboxCharacterNode {
    /** Shots fired within this distance (m) are heard. */
    @attribute('Senses', { min: 0, max: 120, step: 1 })
    public hearing: number = 35

    /** A shot whose line passes within this distance (m) of it nearly hit it. */
    @attribute('Senses', { min: 0, max: 10, step: 0.1 })
    public nearMiss: number = 2.5

    /** Its controller's sight: how far (m), how wide a cone (degrees, the full angle), how long before it notices (s). */
    @attribute('Senses', { min: 1, max: 100, step: 1 })
    public sightRange: number = 20

    @attribute('Senses', { min: 10, max: 360, step: 5 })
    public sightAngle: number = 140

    @attribute('Senses', { min: 0, max: 3, step: 0.05 })
    public noticeSeconds: number = 0.35

    /** Hits within the last moments (N·s, fading by half every `shockHalfLife` s) past which it staggers, and falls. */
    @attribute('Knock-downs', { min: 0, max: 400, step: 1 })
    public staggerShock: number = 24

    @attribute('Knock-downs', { min: 0, max: 400, step: 1 })
    public knockdownShock: number = 48

    @attribute('Knock-downs', { min: 0.05, max: 5, step: 0.05 })
    public shockHalfLife: number = 0.6

    /** Lying down longer than this (s), it is got up; reacting longer than `stuckSeconds`, put back on its feet. */
    @attribute('Knock-downs', { min: 1, max: 60, step: 0.5 })
    public downSeconds: number = 7

    @attribute('Knock-downs', { min: 5, max: 120, step: 1 })
    public stuckSeconds: number = 18

    protected _brain: ControllerNode | null = null
    /** Seconds since it started. */
    protected _now: number = 0
    /** The brain's state as this script last saw it, how long it has been in it, and how long it is to last. */
    private _entered: string = ''
    protected _stateTime: number = 0
    protected _stateFor: number = Infinity
    protected _gait: Gait = 'stand'
    /** The heading the body is to face standing (degrees), and the pitch it looks at (down +); null: as it goes. */
    protected _faceYaw: number | null = null
    protected _lookPitch: number = 0
    protected _crouch: boolean = false
    /** A step it takes itself this frame (world x, z, 0..1), instead of the controller's path. */
    protected _step: number[] | null = null
    /** The player (the character whose team is 'player'), found once. */
    protected _player: SandboxCharacterNode | null = null
    protected _sees: boolean = false
    protected _seenAt: number = -999
    protected _lastSeen: number[] | null = null
    /** Where it is going (`goTo`), and how its distance there last shrank (for being stuck); none found. */
    protected _goal: number[] | null = null
    protected _goalRadius: number = 1.2
    private _nowhere: boolean = false
    protected _bestDistance: number = Infinity
    protected _progressAt: number = 0
    /** The last threat: what, where, who, when. */
    protected _threatKind: ThreatKind | null = null
    protected _threatAt: number[] | null = null
    protected _threatFrom: Node | null = null
    protected _threatTime: number = -999
    /** Hits adding up, N·s; seconds lying down, and reacting. */
    protected _shock: number = 0
    protected _downFor: number = 0
    protected _reactingFor: number = 0
    /** Out of a car's way: a sideways sprint this way (x, z) until then. */
    protected _dodgeUntil: number = 0
    protected _dodgeDir: number[] = [0, 0]

    public get team(): string { return 'neutral' }

    /** What the brain is doing: its machine's state (its entry state before it first thinks), for the inspector and the tests. */
    public get state(): string {
        const brain = this._brain as any
        if (brain?.behaviorState) return brain.behaviorState
        const states: { name: string, isEntry?: boolean }[] = brain?.behavior?.states ?? []
        return (states.find(s => s.isEntry) ?? states[0])?.name ?? 'idle'
    }

    // ----- what the brain reads (its AI Brain's parameters, from this node) ---------------------------------

    /** Its reactions have the body: staggering, falling, down, getting up. */
    public get isKnocked(): boolean {
        const reactions = this.reactions
        return !!reactions?.reacting && reactions.state !== 'hitReact'
    }

    /** Where it was sent is reached, or there was nowhere to go. */
    public get atGoal(): boolean { return this._nowhere || this.arrived(this._goalRadius) }

    /** Going somewhere and getting no nearer for a few seconds. */
    public get isStuck(): boolean { return this.stuck(4) }

    /** This state's time is up: each state chooses how long it lasts on entry (a wait, a look, a peek). */
    public get restless(): boolean { return this._stateTime > this._stateFor }

    /** How far the last threat was (m, over the ground); far away when there was none. */
    public get threatDistance(): number { return this._threatAt ? this.planar(this.worldPosition, this._threatAt) : 999 }

    onStart() {
        super.onStart?.()
        this._brain = (this.children.find(c => c.nodeType === 'controller') as ControllerNode | undefined) ?? null
        const brain = this._brain as any
        if (brain) {
            // Its sight is the script's numbers (one place to tune them, beside the other senses).
            brain.perception = { ...brain.perception, range: this.sightRange, fieldOfView: this.sightAngle, reactionTime: this.noticeSeconds, memorySpan: 6 }
            // It sees the player alone: no ray is cast at another NPC (or at itself).
            brain.perceptionFilter = (c: any) => (c as any)?.team === 'player'
        }
        // Its shots sound where it is, not in the player's ears.
        const sounds = this.getChildByName('Sounds')[0]
        for (const cue of sounds?.children ?? []) {
            const s = cue as any
            if (s.nodeType !== 'sound') continue
            s.mode = 'spatial'
            s.refDistance = 4
            s.maxDistance = 90
        }
    }

    onUpdate(delta: number) {
        this._now += delta
        this._stateTime += delta
        // Online, the host runs every NPC; a player's machine draws it where the host has it.
        const net = (this as any).net
        if (net && net.isHost === false) { super.onUpdate(delta); return }
        this._keepAlive(delta)
        this._senses(delta)
        this._step = null
        const state = this.state
        if (state !== this._entered) {
            const from = this._entered
            this._entered = state
            this._stateTime = 0
            this._stateFor = Infinity
            this._nowhere = false
            this.crouch(false)
            this.face(null)
            this.enterState(state, from)
        }
        if (this._now < this._dodgeUntil && !this.isKnocked) {
            // Out of a car's way: a sideways sprint, whatever the brain is doing.
            this.crouch(false)
            this.face(null)
            this.moveWorld(this._dodgeDir[0], this._dodgeDir[1], 'sprint')
        } else this.inState(state, delta)
        this._drive()
        super.onUpdate(delta)
    }

    // ----- what the subclass does --------------------------------------------------------------------------

    /** The brain entered `state` (from `from`): where to go, how long to stay (`_stateFor`). */
    protected enterState(state: string, from: string): void {}
    /** Every frame in `state`: the pace, the crouch, where to look, the hands. */
    protected inState(state: string, delta: number): void {}
    /** A threat, from the senses (see the class). */
    protected threaten(kind: ThreatKind, at: number[], source: Node | null): void {}

    // ----- moving ----------------------------------------------------------------------------------------

    /**
     * Send it to `point` at `gait`: the brain's state walks there (a `path` goal to the controller's `goalPoint`, the
     * blackboard's `point`). `atGoal` once within `radius`; null: nowhere to go (`atGoal` at once).
     */
    protected goTo(point: ArrayLike<number> | null, gait: Gait = 'walk', radius: number = 1.2): void {
        this._gait = gait
        this._goalRadius = radius
        if (!point) { this._goal = null; this._nowhere = true; return }
        this._nowhere = false
        const p = [point[0], point[1], point[2]]
        if (!this._goal || Math.hypot(this._goal[0] - p[0], this._goal[2] - p[2]) > 0.3) {
            this._bestDistance = Infinity
            this._progressAt = this._now
        }
        this._goal = p
        const brain = this._brain as any
        if (brain) brain.goalPoint = [p[0], p[1], p[2]]
    }

    /** Stand where it is (the brain's state stands it still; this is the pace its body keeps). */
    protected stop(): void {
        this._goal = null
        this._gait = 'stand'
    }

    /** Step the body itself this frame, world direction (x, z) at `gait` (`share` of its speed): a strafe, a dodge. */
    protected moveWorld(x: number, z: number, gait: Gait = 'walk', share: number = 1): void {
        const n = Math.hypot(x, z)
        if (n < 1e-6) return
        this._gait = gait
        this._step = [x / n, z / n, Math.max(0, Math.min(1, share))]
    }

    /** Face heading `yaw` (degrees) standing, looking `pitch` (down +); null: face as it goes. */
    protected face(yaw: number | null, pitch: number = 0): void {
        this._faceYaw = yaw
        this._lookPitch = pitch
    }

    /** Face and look at `point`, from the eyes. */
    protected lookAt(point: ArrayLike<number>): void {
        const p = this.worldPosition
        const dx = point[0] - p[0], dz = point[2] - p[2]
        const eye = p[1] + (this.crouched ? 1.0 : 1.55)
        this.face(Math.atan2(dx, dz) * 180 / Math.PI, Math.atan2(eye - point[1], Math.max(0.1, Math.hypot(dx, dz))) * 180 / Math.PI)
    }

    /** Crouch (or stand up). */
    protected crouch(on: boolean): void { this._crouch = on }

    /** Within `radius` (m, over the ground) of where it was sent. */
    protected arrived(radius: number = 1.2): boolean {
        if (!this._goal) return true
        const p = this.worldPosition
        return Math.hypot(this._goal[0] - p[0], this._goal[2] - p[2]) <= radius
    }

    /** Going somewhere and getting no nearer for `seconds`: stuck (send it elsewhere). */
    protected stuck(seconds: number = 4): boolean {
        if (!this._goal) return false
        const p = this.worldPosition
        const d = Math.hypot(this._goal[0] - p[0], this._goal[2] - p[2])
        if (d < this._bestDistance - 0.5) { this._bestDistance = d; this._progressAt = this._now }
        return this._now - this._progressAt > seconds
    }

    /** This frame's intent, from the controller's (where its goal steers) and the script's pace, crouch, step and look. */
    private _drive(): void {
        const intent: any = this.drive()
        if (this._step) {
            setMoveWorld(intent, this._step[0], this._step[1])
            intent.speedScale = this._step[2]
        } else if (this._gait === 'stand') {
            intent.move[0] = 0
            intent.move[1] = 0
        }
        intent.sprint = this._gait === 'sprint'
        intent.crouch = this._crouch
        if (this._faceYaw !== null) intent.aimYaw = this._faceYaw
        intent.aimPitch = this._faceYaw !== null ? this._lookPitch : 0
    }

    // ----- the hooks the body asks (SandboxCharacter) -------------------------------------------------------

    /** Walking: the walk gait. */
    protected wantsWalk(): boolean { return this._gait === 'walk' }
    /** An NPC looks level at a pitch of 0 (no camera resting pitched down). */
    protected lookRest(): number { return 0 }

    // ----- the nav mesh ------------------------------------------------------------------------------------

    /** The scene's nav mesh, or null. */
    protected navMesh(): any {
        return (this.scene as any)?.ai?.navMeshFor?.(null)?.mesh ?? null
    }

    /** The route `name` of the scene's nav mesh node, its points; empty without one. */
    protected routePoints(name: string): number[][] {
        const source = (this.scene as any)?.ai?.navMeshFor?.(null)
        const pts = source?.routePoints?.(name) ?? []
        return pts.map((p: ArrayLike<number>) => [p[0], p[1], p[2]])
    }

    /** Every route of the scene's nav mesh node: its name and points. Gathered once a scene (see `sceneCache`). */
    protected routes(): { name: string, points: number[][] }[] {
        return this.sceneCache('routes', () => {
            for (const n of this.scene?.nodes ?? []) {
                const routes = (n as any).nodeType === 'navMesh' ? (n as any).routes : null
                if (Array.isArray(routes)) return routes.map((r: any) => ({ name: r.name, points: this.routePoints(r.name) }))
            }
            return []
        })
    }

    /** The scene's nodes whose names start with `prefix` (Look Point, Cover Point), gathered once a scene. */
    protected pointsNamed(prefix: string): Node[] {
        return this.sceneCache('named:' + prefix, () => Array.from(this.scene?.nodes ?? [] as Iterable<Node>).filter(n => n.name.startsWith(prefix)))
            .filter(n => !!n.scene)
    }

    /** `make()`, once per scene and key, shared by every NPC in it. */
    protected sceneCache<T>(key: string, make: () => T): T {
        const scene: any = this.scene
        if (!scene) return make()
        let cache = SCENE_CACHE.get(scene)
        if (!cache) { cache = new Map(); SCENE_CACHE.set(scene, cache) }
        if (!cache.has(key)) cache.set(key, make())
        return cache.get(key) as T
    }

    /**
     * The length of the walk from `a` to `b` on the nav mesh (straight without one), or Infinity when there is none.
     * Each is a search out of the scene's budget a frame (its `aiDetail.pathsPerFrame`, shared with the controllers'
     * own plans): with none left this frame, the straight line a fifth longer.
     */
    protected pathLength(a: ArrayLike<number>, b: ArrayLike<number>): number {
        const mesh = this.navMesh()
        const straight = Math.hypot(b[0] - a[0], b[2] - a[2])
        if (!mesh) return straight
        if ((this.scene as any)?.takePathSearch?.() === false) return straight * 1.2
        const path = mesh.findPath(a, b, [])
        if (!path || path.length === 0) return Infinity
        let length = 0
        let last = [a[0], a[1], a[2]]
        for (const p of path) { length += Math.hypot(p[0] - last[0], p[2] - last[2]); last = [p[0], p[1], p[2]] }
        return length
    }

    /**
     * A point to go to, `minRadius`..`maxRadius` m from `center` over the ground: on the nav mesh, inside the barrier,
     * reachable by a walk not much longer than the straight line, and passing `accept`. Null when none of `tries` was.
     */
    protected navPoint(center: ArrayLike<number>, minRadius: number, maxRadius: number, accept?: (p: number[]) => boolean, tries: number = 14): number[] | null {
        const mesh = this.navMesh()
        const physics: any = this.scene?.physics
        const from = this.worldPosition
        for (let i = 0; i < tries; i++) {
            const a = Math.random() * Math.PI * 2, r = minRadius + Math.random() * (maxRadius - minRadius)
            const x = center[0] + Math.sin(a) * r, z = center[2] + Math.cos(a) * r
            if (Math.abs(x) > 55 || Math.abs(z) > 55) continue
            let p: number[] | null = null
            if (mesh) {
                const at = mesh.locate([x, center[1] + 0.5, z], true) ?? mesh.locate([x, 0.2, z], true)
                if (at) p = [at.x, at.y, at.z]
            } else if (physics) {
                const hit = physics.raycast([x, center[1] + 4, z], [x, center[1] - 6, z], { groundOnly: true })
                if (hit && hit.normal[1] > 0.7) p = [hit.point[0], hit.point[1], hit.point[2]]
            }
            if (!p || (accept && !accept(p))) continue
            const straight = Math.hypot(p[0] - from[0], p[2] - from[2])
            if (this.pathLength(from, p) > straight * 1.8 + 6) continue
            return p
        }
        return null
    }

    // ----- the senses ------------------------------------------------------------------------------------

    /**
     * The player in sight (its controller's perception), where it was last seen, and the knocks adding up. The player
     * on foot is the blackboard's `target`, which the brain's senses read (in sight, how far, how long since seen);
     * one driving is no one to look at or shoot.
     */
    private _senses(delta: number): void {
        if (!this._player || !this._player.scene) {
            this._player = null
            for (const c of this.scene?.characters ?? []) if ((c as any).team === 'player') { this._player = c as any; break }
        }
        const brain = this._brain as any
        const player = this._player
        const onFoot = !!player && !(player as any).inVehicle
        if (brain) brain.setBlackboard('target', onFoot ? player!.id : undefined)
        let sees = false
        if (brain && onFoot) {
            for (const s of brain.sightings ?? []) {
                if (s.id !== player!.id) continue
                sees = !!(s.visible && s.noticed)
                break
            }
        }
        this._sees = sees
        if (sees && player) {
            const p = player.worldPosition
            this._seenAt = this._now
            this._lastSeen = [p[0], p[1], p[2]]
        }
        // The knocks fade.
        if (this._shock > 0 && delta > 0) this._shock *= Math.pow(0.5, delta / Math.max(0.05, this.shockHalfLife))
    }

    /** Seconds since the player was last in sight. */
    protected get sinceSeen(): number { return this._now - this._seenAt }

    /**
     * A shot fired anywhere (SandboxGun's `weapon:Shot`): not its own; heard within `hearing`, nearly hitting it when
     * its line passes within `nearMiss` of the body, hitting it when it struck it.
     */
    @onEvent('weapon:Shot')
    protected _heardShot(shot: { gun?: Node, hits?: ({ point: number[], node: Node | null } | null)[] }) {
        const gun = shot?.gun
        if (!gun || !this.scene) return
        let shooter: Node | null = null
        for (let n: Node | null = gun.parent; n; n = n.parent) if (n.nodeType === 'character') { shooter = n; break }
        if (shooter === this) return
        const from = gun.worldPosition
        const me = this.worldPosition
        const chest = [me[0], me[1] + 1.1, me[2]]
        let kind: ThreatKind | null = Math.hypot(from[0] - me[0], from[1] - me[1], from[2] - me[2]) <= this.hearing ? 'shot' : null
        for (const hit of shot.hits ?? []) {
            if (!hit) continue
            const struck = (hit.node as any)?.character ?? null
            if (struck === this || this._isMine(hit.node)) { kind = 'hit'; break }
            if (this.distanceToSegment(chest, from, hit.point) <= this.nearMiss) kind = 'nearMiss'
        }
        if (!kind) return
        // Where the shooter stands (its feet, as every threat is placed), else the gun.
        const at = shooter ? shooter.worldPosition : from
        this._threat(kind, [at[0], at[1], at[2]], shooter)
    }

    /** A hit on its body (its reactions'): the knock adds up; enough, and it staggers or falls. */
    @eventListener('reaction:Hit')
    protected _wasHit(info: { impulse?: number, partName?: string }) {
        this._shock += Math.max(0, info?.impulse ?? 0)
        const reactions = this.reactions
        // Lying down there is nothing more to knock over; getting up, a hit knocks it back (its reactions do that).
        if (!reactions || ['falling', 'tumble', 'down', 'dead', 'getUp'].includes(reactions.state)) return
        const away = this._awayFromThreat()
        const legs = /Thigh|Shin|Foot/.test(info?.partName ?? '') && this.groundSpeed > 3
        if (this._shock >= this.knockdownShock || legs) {
            this._shock = 0
            reactions.push([away[0] * 2.4, 0.3, away[1] * 2.4])
        } else if (this._shock >= this.staggerShock) {
            reactions.push([away[0] * 1.0, 0, away[1] * 1.0])
        }
    }

    /** Hit by a car: thrown by its reactions, and the car is the threat. */
    public struckByVehicle(vehicle: Node, velocity: ArrayLike<number>, speed: number): boolean {
        const thrown = super.struckByVehicle(vehicle, velocity, speed)
        const p = vehicle.worldPosition
        this._threat('vehicle', [p[0], p[1], p[2]], vehicle)
        return thrown
    }

    /**
     * A car bearing down on it (SandboxCar's warning): out of its way at once, a sideways sprint square to the car's
     * travel, away from its line, for a moment, whatever its brain is doing (a reflex, not a decision).
     */
    public dodgeVehicle(vehicle: Node, velocity: ArrayLike<number>): void {
        if (this.reactions?.isDown || this._now < this._dodgeUntil) return
        const p = vehicle.worldPosition
        this._threat('vehicle', [p[0], p[1], p[2]], vehicle)
        const speed = Math.hypot(velocity[0], velocity[2])
        if (speed < 0.1) return
        const along = [velocity[0] / speed, velocity[2] / speed]
        const me = this.worldPosition
        // The side of the car's line it is on: away from it.
        const side = (me[0] - p[0]) * along[1] - (me[2] - p[2]) * along[0] >= 0 ? 1 : -1
        this._dodgeDir = [along[1] * side, -along[0] * side]
        this._dodgeUntil = this._now + this.between(0.7, 1.1)
    }

    /** Which way is away from the last threat, over the ground (unit x, z); backwards when there is none. */
    protected _awayFromThreat(): number[] {
        const p = this.worldPosition
        const t = this._threatAt
        if (t) {
            const dx = p[0] - t[0], dz = p[2] - t[2], n = Math.hypot(dx, dz)
            if (n > 1e-3) return [dx / n, dz / n]
        }
        const f = this.worldForward
        return [-f[0], -f[2]]
    }

    private _threat(kind: ThreatKind, at: number[], source: Node | null): void {
        this._threatKind = kind
        this._threatAt = at
        this._threatFrom = source
        this._threatTime = this._now
        this.threaten(kind, at, source)
    }

    /** Whether `node` is part of this character (its capsule, its model, a limb of its ragdoll). */
    private _isMine(node: Node | null): boolean {
        for (let n: Node | null = node; n; n = n.parent) if (n === this || n === this.collider) return true
        return false
    }

    /** It never dies: health kept full, a body down too long got up, one reacting too long put back on its feet. */
    private _keepAlive(delta: number): void {
        const reactions = this.reactions
        if (!reactions) return
        reactions.health = 1
        if (!reactions.alive) { reactions.reset(); return }
        this._downFor = reactions.state === 'down' ? this._downFor + delta : 0
        this._reactingFor = reactions.reacting ? this._reactingFor + delta : 0
        if (this._downFor > this.downSeconds) { this._downFor = 0; reactions.getUp() }
        if (this._reactingFor > this.stuckSeconds) { this._reactingFor = 0; reactions.reset() }
    }

    // ----- small sums ------------------------------------------------------------------------------------

    /** The distance from point `p` to the segment `a`..`b`. */
    protected distanceToSegment(p: ArrayLike<number>, a: ArrayLike<number>, b: ArrayLike<number>): number {
        const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2]
        const len2 = abx * abx + aby * aby + abz * abz
        let t = len2 > 0 ? ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / len2 : 0
        t = Math.max(0, Math.min(1, t))
        return Math.hypot(p[0] - (a[0] + abx * t), p[1] - (a[1] + aby * t), p[2] - (a[2] + abz * t))
    }

    /** Degrees from `a` to `b` round the shorter way (-180..180). */
    protected angleDelta(a: number, b: number): number {
        return ((b - a + 180) % 360 + 360) % 360 - 180
    }

    /** The heading (degrees, 0 = +Z) from `from` to `to` over the ground. */
    protected yawTo(from: ArrayLike<number>, to: ArrayLike<number>): number {
        return Math.atan2(to[0] - from[0], to[2] - from[2]) * 180 / Math.PI
    }

    /** The heading the body faces now (degrees). */
    protected yawNow(): number {
        const f = this.worldForward
        return Math.atan2(f[0], f[2]) * 180 / Math.PI
    }

    /** Over-the-ground distance between two points. */
    protected planar(a: ArrayLike<number>, b: ArrayLike<number>): number {
        return Math.hypot(b[0] - a[0], b[2] - a[2])
    }

    /** A random number in `lo`..`hi`. */
    protected between(lo: number, hi: number): number {
        return lo + Math.random() * (hi - lo)
    }
}

/** What NPCs gather once per scene (its routes, its Look and Cover Points), keyed by scene. */
const SCENE_CACHE = new WeakMap<object, Map<string, unknown>>()
