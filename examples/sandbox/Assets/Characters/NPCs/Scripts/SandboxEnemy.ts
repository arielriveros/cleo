import type { Node } from 'cleo'
import { attribute } from 'cleo/decorators'
import SandboxNpcNode from '@/Characters/NPCs/Scripts/SandboxNpc'
import type { ThreatKind } from '@/Characters/NPCs/Scripts/SandboxNpc'

/** Cover points taken, per scene: two enemies do not crouch behind the same crate. */
const CLAIMS = new WeakMap<object, Map<string, Node>>()

/**
 * A Sandbox enemy (the red NPC): it patrols a part of the map with a weapon, shoots the player on sight, and takes
 * cover when shot at. Attach to the **Character** node of the Enemy template (SandboxNpc's senses, the player's body,
 * animations and weapons underneath).
 *
 *   patrol    walks the nav mesh route nearest where it was placed (the NavMesh node's routes), its weapon at the
 *             low ready, stopping at each point to look round. Two placed together patrol as a pair: the one with the
 *             lower id leads, the other keeps a few metres behind it to the right
 *   alert     a shot heard, or its partner calling: faces the noise with its weapon up, a moment
 *   engage    the player in sight: aims, fires in bursts (`burstMin`..`burstMax` s, `gapMin`..`gapMax` between), keeps
 *             between `nearest` and `farthest` m, side-steps now and then; holds fire when someone else is in the line.
 *             It aims worse far away and at a moving target, and better the longer it holds it in its sights
 *   cover     hit, or nearly hit twice: sprints to a spot the player cannot see (a Cover Point, or a ring of probes)
 *   in cover  crouched there, reloading, then
 *   peek      stands up and fires a burst, and back down; after a few, it moves on or engages in the open
 *   search    lost the player: goes to where it was last seen and looks round
 *   return    back to its route
 *   knocked   down (its reactions'): it waits; once up, it takes cover
 *
 * Its weapon never runs dry (the reserve is kept full). Its rounds hit the player but do not move it (the player's
 * `reactsToShots`), and the Sandbox's player has no health. Cover Points are nodes named "Cover Point..." anywhere in
 * the scene.
 */
export default class SandboxEnemyNode extends SandboxNpcNode {
    /** The weapon it carries: 1 the pistol, 2 the rifle, 3 the shotgun. */
    @attribute('Combat', { min: 1, max: 3, step: 1 })
    public preferredWeapon: number = 2

    /** The distance it keeps from the player while it fights in the open (m). */
    @attribute('Combat', { min: 2, max: 40, step: 0.5 })
    public nearest: number = 8

    @attribute('Combat', { min: 2, max: 60, step: 0.5 })
    public farthest: number = 22

    /** A burst: how long the trigger is held (s), and the gap between two. */
    @attribute('Combat', { min: 0.05, max: 3, step: 0.05 })
    public burstMin: number = 0.3

    @attribute('Combat', { min: 0.05, max: 3, step: 0.05 })
    public burstMax: number = 0.6

    @attribute('Combat', { min: 0, max: 5, step: 0.05 })
    public gapMin: number = 0.5

    @attribute('Combat', { min: 0, max: 5, step: 0.05 })
    public gapMax: number = 1.2

    /** The aim's error at 15 m (m, off the target), and how much a moving target adds a m/s. */
    @attribute('Combat', { min: 0, max: 5, step: 0.05 })
    public aimError: number = 0.6

    @attribute('Combat', { min: 0, max: 2, step: 0.05 })
    public movingError: number = 0.25

    /** Seconds behind cover before it looks out, and the most looks before it moves. */
    @attribute('Combat', { min: 0.2, max: 10, step: 0.1 })
    public coverMin: number = 1.5

    @attribute('Combat', { min: 0.2, max: 10, step: 0.1 })
    public coverMax: number = 3

    @attribute('Combat', { min: 1, max: 10, step: 1 })
    public peeks: number = 3

    /** The route it patrols, by name ('': the one nearest where it was placed). */
    @attribute('Patrol')
    public route: string = ''

    private _route: number[][] = []
    private _routeIndex: number = 0
    private _pause: number = 0
    private _partner: SandboxEnemyNode | null = null
    private _leads: boolean = true
    private _paired: boolean = false
    /** Firing: the trigger held, until when; the next burst, when. */
    private _firing: boolean = false
    private _burstUntil: number = 0
    private _nextBurst: number = 0
    /** The aim's error now (m, world, at the target) and how long the target has been held in sight. */
    private _error: number[] = [0, 0, 0]
    private _onTarget: number = 0
    private _sideUntil: number = 0
    private _side: number = 1
    private _nearMisses: number[] = []
    private _cover: number[] | null = null
    private _coverKey: string = ''
    private _coverFor: number = 0
    private _peeksDone: number = 0
    private _followAt: number = 0

    public get team(): string { return 'enemy' }

    onStart() {
        super.onStart()
        if (this.turnDelay > 0.35) this.turnDelay = 0.35
        this.enter('patrol')
    }

    onDespawn() {
        this._releaseCover()
        super.onDespawn?.()
    }

    // ----- what the body asks (SandboxCharacter) -------------------------------------------------------------

    /** It carries its weapon from the start. */
    protected pickWeapon(delta: number, current: number): number { return this.preferredWeapon }
    /** Up when it fights, looks out of cover or answers a noise; at the low ready otherwise. */
    protected wantsAim(): boolean {
        return (this.state === 'engage' || this.state === 'peek' || this.state === 'alert') && this._gait !== 'sprint'
    }
    protected triggerHeld(): boolean { return this._firing }
    protected triggerStarted(): boolean { return false }
    protected wantsReload(): boolean {
        const gun: any = this._gun
        if (!gun || this._gait === 'sprint') return false
        return gun.ammo <= 0 || (this.state === 'in cover' && gun.ammo < (gun.magazine ?? gun.ammo + 1) * 0.6)
    }

    /** From its eyes to the player's chest, off by its aim's error. */
    protected aimRay(eye: number[], look: number[]): boolean {
        const player = this._player
        if (!player) return false
        const me = this.worldPosition
        eye[0] = me[0]; eye[1] = me[1] + (this.crouched ? 1.05 : 1.5); eye[2] = me[2]
        const p = player.worldPosition
        const t = [p[0] + this._error[0], p[1] + 1.25 + this._error[1], p[2] + this._error[2]]
        const dx = t[0] - eye[0], dy = t[1] - eye[1], dz = t[2] - eye[2], n = Math.hypot(dx, dy, dz) || 1
        look[0] = dx / n; look[1] = dy / n; look[2] = dz / n
        return true
    }

    // ----- the brain ---------------------------------------------------------------------------------------

    protected think(delta: number): void {
        this._pairUp()
        this._keepAmmo()
        this._firing = false
        this._nearMisses = this._nearMisses.filter(t => this._now - t < 2.5)
        if (this.state !== 'in cover' && this.state !== 'peek' && this.state !== 'cover') this.crouch(false)
        if (this._sees && this.state !== 'engage' && this.state !== 'cover' && this.state !== 'in cover' && this.state !== 'peek') this._engage()
        switch (this.state) {
            case 'patrol': this._patrol(delta); break
            case 'alert': {
                this.stop()
                if (this._threatAt) this.lookAt([this._threatAt[0], this._threatAt[1] + 1.2, this._threatAt[2]])
                if (this._stateTime > 1) this.enter('search')
                break
            }
            case 'engage': this._fight(delta); break
            case 'cover': {
                this.face(null)
                if (this.arrived(0.6)) { this.stop(); this._coverFor = this.between(this.coverMin, this.coverMax); this.enter('in cover') }
                else if (this.stuck(3)) this._engage()
                break
            }
            case 'in cover': {
                this.stop()
                this.crouch(true)
                this._faceThreat()
                if (this._stateTime > 0.5 && Math.floor(this._stateTime * 2) !== Math.floor((this._stateTime - delta) * 2) && !this._hidden(this.worldPosition)) { this._takeCover(); break }
                if (this._stateTime > this._coverFor && !this.reloading) { this.crouch(false); this.enter('peek') }
                break
            }
            case 'peek': {
                this.stop()
                this.crouch(false)
                this._faceThreat()
                if (this._sees) this._shoot(delta)
                if (this._stateTime > this.between(1.2, 2)) {
                    this._peeksDone++
                    if (this._peeksDone >= this.peeks) { this._peeksDone = 0; this._releaseCover(); this._engage() }
                    else { this._coverFor = this.between(this.coverMin, this.coverMax); this.enter('in cover') }
                }
                break
            }
            case 'search': {
                const at = this._lastSeen ?? this._threatAt
                if (!at) { this.enter('return'); break }
                if (this.planar(this.worldPosition, at) > 2) {
                    this.face(null)
                    this.goTo(at, 'jog')
                    if (this.stuck(4) || this._stateTime > 20) this.enter('return')
                } else {
                    this.stop()
                    this.face(this.yawNow() + Math.sin(this._stateTime * 1.2) * 80)
                    if (this._stateTime > 6) { this._lastSeen = null; this.enter('return') }
                }
                break
            }
            case 'return': {
                const p = this._nearestRoutePoint()
                if (!p) { this.enter('patrol'); break }
                this.face(null)
                this.goTo(this._route[p], 'walk')
                if (this.arrived(1.2) || this.stuck(5)) { this._routeIndex = p; this.enter('patrol') }
                break
            }
            case 'knocked': break
            default: this.enter('patrol')
        }
    }

    protected threaten(kind: ThreatKind, at: number[], source: Node | null): void {
        if (kind === 'nearMiss') this._nearMisses.push(this._now)
        const fighting = this.state === 'engage' || this.state === 'peek'
        if (kind === 'hit' || (kind === 'nearMiss' && this._nearMisses.length >= 2)) {
            if (this.state !== 'cover' && this.state !== 'in cover') this._takeCover()
            return
        }
        if (kind === 'vehicle') return
        if (!fighting && this.state !== 'cover' && this.state !== 'in cover') {
            this.enter('alert')
            this._partner?.hearFromPartner(at)
        }
    }

    /** Its partner heard or saw something at `at`: come and look. */
    public hearFromPartner(at: ArrayLike<number>): void {
        if (this.state !== 'patrol' && this.state !== 'return') return
        this._lastSeen = [at[0], at[1], at[2]]
        this.enter('alert')
    }

    /** Out of a car's way: if the player drives it, fight; else back to what it was doing. */
    protected afterDodge(): void {
        if (this._sees) this._engage()
    }

    protected whileKnocked(): void {
        this._firing = false
        this.crouch(false)
        this.enter('knocked')
    }

    protected afterKnockdown(): void {
        this._takeCover()
    }

    // ----- patrol --------------------------------------------------------------------------------------------

    private _patrol(delta: number): void {
        if (!this._route.length) this._pickRoute()
        // The follower keeps behind its leader, a little to the right.
        if (this._paired && !this._leads && this._partner?.scene && this._partner.state === 'patrol') {
            const leader = this._partner
            if (this._now >= this._followAt) {
                this._followAt = this._now + 0.5
                const lp = leader.worldPosition, lf = leader.worldForward
                const spot = [lp[0] - lf[0] * 2.5 - lf[2] * 1.2, lp[1], lp[2] - lf[2] * 2.5 + lf[0] * 1.2]
                if (this.planar(this.worldPosition, spot) > 1.2) { this.face(null); this.goTo(spot, leader.state === 'patrol' && (leader as any)._gait === 'stand' ? 'walk' : 'walk') }
                else { this.stop(); this.face(leader.yawNow() + Math.sin(this._now * 0.6) * 60) }
            }
            return
        }
        if (!this._route.length) { this.stop(); this.face(this.yawNow() + Math.sin(this._now * 0.4) * 70); return }
        if (this._pause > 0) {
            this._pause -= delta
            this.stop()
            this.face(this._pauseYaw + Math.sin(this._stateTime * 0.8) * 70)
            return
        }
        const goal = this._route[this._routeIndex % this._route.length]
        this.face(null)
        this.goTo(goal, 'walk')
        if (this.arrived(1.2) || this.stuck(5)) {
            this._routeIndex = (this._routeIndex + 1) % this._route.length
            this._pause = this.between(1.5, 3.5)
            this._pauseYaw = this.yawNow()
        }
    }
    private _pauseYaw: number = 0

    /** The route it patrols: `route` by name, else the one with a point nearest where it stands; from its nearest point. */
    private _pickRoute(): void {
        const me = this.worldPosition
        let best: number[][] = [], bestD = Infinity
        for (const r of this.routes()) {
            if (this.route && r.name !== this.route) continue
            for (const p of r.points) {
                const d = this.planar(me, p)
                if (d < bestD) { bestD = d; best = r.points }
            }
        }
        this._route = best
        this._routeIndex = this._nearestRoutePoint() ?? 0
    }

    private _nearestRoutePoint(): number | null {
        if (!this._route.length) this._pickRoute()
        const me = this.worldPosition
        let best: number | null = null, bestD = Infinity
        this._route.forEach((p, i) => { const d = this.planar(me, p); if (d < bestD) { bestD = d; best = i } })
        return best
    }

    /** Its partner: the nearest other enemy placed within 10 m of it; the lower id leads. */
    private _pairUp(): void {
        if (this._paired || this._now < 0.2) return
        this._paired = true
        const me = this.worldPosition
        let best: SandboxEnemyNode | null = null, bestD = 10
        for (const c of this.scene?.characters ?? []) {
            if (c === (this as any) || (c as any).team !== 'enemy') continue
            const d = this.planar(me, c.worldPosition)
            if (d < bestD) { bestD = d; best = c as any }
        }
        this._partner = best
        this._leads = !best || this.id < best.id
    }

    // ----- fight ---------------------------------------------------------------------------------------------

    private _engage(): void {
        if (this.state !== 'engage') this._partner?.hearFromPartner(this._lastSeen ?? this.worldPosition)
        this.enter('engage')
        this._nextBurst = Math.max(this._nextBurst, this._now + 0.4)
    }

    private _fight(delta: number): void {
        const player = this._player
        if (!player || this.sinceSeen > 1.5) { this.enter('search'); return }
        const me = this.worldPosition, p = player.worldPosition
        const d = this.planar(me, p)
        this.lookAt([p[0], p[1] + 1.25, p[2]])
        // Keep its distance: closer than `nearest`, back off; farther than `farthest`, close in; else side-step now and then.
        const to = [(p[0] - me[0]) / Math.max(0.01, d), (p[2] - me[2]) / Math.max(0.01, d)]
        if (this._now < this._sideUntil) this.moveWorld(to[1] * this._side, -to[0] * this._side, 'walk')
        else if (d < this.nearest) this.moveWorld(-to[0], -to[1], 'walk')
        else if (d > this.farthest) this.goTo(p, 'jog')
        else {
            this.stop()
            if (Math.random() < delta / 3) { this._side = Math.random() < 0.5 ? -1 : 1; this._sideUntil = this._now + this.between(0.8, 1.4) }
        }
        this._shoot(delta)
    }

    /** Bursts while the player is in sight and nobody else in the line; the aim settles the longer it holds it. */
    private _shoot(delta: number): void {
        const player = this._player
        if (!player || !this._sees) { this._onTarget = 0; return }
        this._onTarget += delta
        if (this._now >= this._burstUntil && this._now >= this._nextBurst) {
            this._burstUntil = this._now + this.between(this.burstMin, this.burstMax)
            this._nextBurst = this._burstUntil + this.between(this.gapMin, this.gapMax)
            this._rollError()
        }
        this._firing = this._now < this._burstUntil && this._clearLine()
    }

    /** A new aim error for a burst: larger far away and at a moving target, smaller the longer it has aimed. */
    private _rollError(): void {
        const player: any = this._player
        if (!player) return
        const d = this.planar(this.worldPosition, player.worldPosition)
        const v = player.velocity ?? [0, 0, 0]
        const speed = Math.hypot(v[0], v[2])
        const settle = 1 - 0.6 * Math.min(1, this._onTarget / 1.5)
        const r = this.aimError * (d / 15) * (1 + this.movingError * speed) * settle
        const a = Math.random() * Math.PI * 2, k = Math.sqrt(Math.random()) * r
        this._error = [Math.cos(a) * k, Math.sin(a) * k * 0.6, Math.sin(a + 1.3) * k]
    }

    /** Nobody but the player between it and the player. */
    private _clearLine(): boolean {
        const physics: any = this.scene?.physics
        const player = this._player
        if (!physics || !player) return false
        const me = this.worldPosition, p = player.worldPosition
        const hit = physics.raycast([me[0], me[1] + 1.5, me[2]], [p[0], p[1] + 1.25, p[2]], { ignore: this.ownBodies() as any })
        const who = (hit?.node as any)?.character ?? null
        return !who || who === player || (who as any).team === undefined
    }

    private _faceThreat(): void {
        const at = this._lastSeen ?? this._threatAt
        if (at) this.lookAt([at[0], at[1] + 1.25, at[2]])
    }

    // ----- cover ---------------------------------------------------------------------------------------------

    /** To the best spot the threat cannot see, at a sprint; none: fight in the open. */
    private _takeCover(): void {
        this._releaseCover()
        const spot = this._bestCover()
        if (!spot) { this._engage(); return }
        this._cover = spot
        this.crouch(false)
        this._peeksDone = 0
        this.goTo(spot, 'sprint')
        this.enter('cover')
    }

    /**
     * Firing Line's cover finder: the Cover Points within 15 m, and probes on rings round it set down on the ground;
     * hidden from the threat's eye at a crouched head's height, reachable without a long way round, not taken by
     * another enemy. The nearest wins, with a bonus for being farther from the threat.
     */
    private _bestCover(): number[] | null {
        const physics: any = this.scene?.physics
        const threat = this._lastSeen ?? this._threatAt ?? this._player?.worldPosition
        if (!physics || !threat) return null
        const me = this.worldPosition
        const claims = this._claims()
        const candidates: { p: number[], key: string }[] = []
        for (const n of this.scene?.nodes ?? []) {
            if (!n.name.startsWith('Cover Point') || !n.scene) continue
            const p = n.worldPosition
            const key = n.id
            if (this.planar(me, p) <= 15 && (!claims.has(key) || claims.get(key) === (this as any))) candidates.push({ p: [p[0], p[1], p[2]], key })
        }
        for (let ring = 1; ring <= 3; ring++) for (let i = 0; i < 10; i++) {
            const a = (i / 10 + ring * 0.07) * Math.PI * 2, r = 2.5 + ring * 3
            const x = me[0] + Math.sin(a) * r, z = me[2] + Math.cos(a) * r
            const ground = physics.raycast([x, me[1] + 2, z], [x, me[1] - 4, z], { groundOnly: true })
            if (ground && ground.normal[1] > 0.7) {
                const key = `${Math.round(ground.point[0])},${Math.round(ground.point[2])}`
                if (!claims.has(key)) candidates.push({ p: [ground.point[0], ground.point[1], ground.point[2]], key })
            }
        }
        let best: { p: number[], key: string } | null = null, bestScore = -Infinity
        for (const c of candidates) {
            if (!this._hidden(c.p, threat)) continue
            const near = this.planar(me, c.p)
            const walk = this.pathLength(me, c.p)
            if (walk > near * 2.2 + 4) continue
            const score = -walk + 0.25 * this.planar(threat, c.p)
            if (score > bestScore) { bestScore = score; best = c }
        }
        if (!best) return null
        this._coverKey = best.key
        claims.set(best.key, this as any)
        return best.p
    }

    /**
     * Whether the threat's eye cannot see a crouched head at `p`, nor one a shoulder's width to either side of it:
     * a spot only just behind an edge is no cover (and where it stops is never exactly the spot).
     */
    private _hidden(p: ArrayLike<number>, threat?: ArrayLike<number>): boolean {
        const physics: any = this.scene?.physics
        const t = threat ?? this._lastSeen ?? this._threatAt ?? this._player?.worldPosition
        if (!physics || !t) return true
        const eye = [t[0], t[1] + 1.55, t[2]]
        const dx = p[0] - t[0], dz = p[2] - t[2], n = Math.hypot(dx, dz) || 1
        // No character is cover: not its capsule, not the limbs of one reacting (the threat's own, say).
        const reject = (owner: any, body: any) => !!owner?.character || owner?.nodeType === 'character' || !!physics.ragdollPartOf?.(body)
        for (const k of [0, -0.35, 0.35]) {
            const head = [p[0] - dz / n * k, p[1] + 1.0, p[2] + dx / n * k]
            const hit = physics.raycast(eye, head, { reject })
            if (!hit || Math.hypot(hit.point[0] - head[0], hit.point[1] - head[1], hit.point[2] - head[2]) <= 0.35) return false
        }
        return true
    }

    private _claims(): Map<string, Node> {
        const scene: any = this.scene
        if (!scene) return new Map()
        let m = CLAIMS.get(scene)
        if (!m) { m = new Map(); CLAIMS.set(scene, m) }
        return m
    }

    private _releaseCover(): void {
        if (this._coverKey) {
            const claims = this._claims()
            if (claims.get(this._coverKey) === (this as any)) claims.delete(this._coverKey)
        }
        this._coverKey = ''
        this._cover = null
    }

    /** Its weapon never runs dry: the reserve kept topped up. */
    private _keepAmmo(): void {
        const gun: any = this._gun
        if (gun && typeof gun.reserve === 'number' && gun.reserve < 60) gun.reserve = 120
    }
}
