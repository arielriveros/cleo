import type { Node } from 'cleo'
import { attribute } from 'cleo/decorators'
import SandboxNpcNode from '@/Characters/NPCs/Scripts/SandboxNpc'
import type { ThreatKind } from '@/Characters/NPCs/Scripts/SandboxNpc'

/**
 * A Sandbox civilian (the blue NPC): it goes about the whole map, stops to look at things, looks at the player and
 * moves on, and runs from danger. Attach to the **Character** node of the Civilian template (SandboxNpc's senses,
 * the player's body and animations underneath).
 *
 *   wait      stands a while at a Look Point (or wherever it got to), its head sweeping round what is there
 *   roam      walks to somewhere else on the nav mesh, 10 to 40 m off, often another Look Point
 *   watch     the player close by (`watchDistance`) and in sight, on foot: it faces the player and looks at them a
 *             few seconds, then moves on; it does not stare at the same player again for `watchCooldown`
 *   alert     a shot heard: looks toward it a moment (`alertSeconds`), then runs if it was close (`fleeDistance`),
 *             else jogs off
 *   flee      a shot that nearly hit it, a hit, a car: sprints away from it to somewhere reachable, for a while
 *   (a shot heard or one that nearly hit it is answered after a startle (`startleMin`..`startleMax`): an ordinary
 *   person takes a moment to understand what happened. A hit or a car is answered at once)
 *   cower     crouched behind wherever it fled to, facing the danger, then calm again
 *   (a car bearing down on it: a sideways sprint off the car's line (SandboxNpc), then flee)
 *   knocked   down (its reactions'): it waits; once up, it flees
 *
 * Look Points are nodes named "Look Point..." anywhere in the scene: what there is to look at.
 */
export default class SandboxCivilianNode extends SandboxNpcNode {
    /** The player this close (m) and in sight is looked at, for this long (s, a range), and not again for `watchCooldown` s. */
    @attribute('Behaviour', { min: 0, max: 30, step: 0.5 })
    public watchDistance: number = 6

    @attribute('Behaviour', { min: 0, max: 10, step: 0.1 })
    public watchMin: number = 2.5

    @attribute('Behaviour', { min: 0, max: 10, step: 0.1 })
    public watchMax: number = 4.5

    @attribute('Behaviour', { min: 0, max: 120, step: 1 })
    public watchCooldown: number = 20

    /** A shot heard closer than this (m) makes it run; farther, it walks off quicker. */
    @attribute('Behaviour', { min: 0, max: 100, step: 1 })
    public fleeDistance: number = 22

    /** How far it runs (m, a range), and for how long at least (s). */
    @attribute('Behaviour', { min: 1, max: 60, step: 1 })
    public fleeMin: number = 18

    @attribute('Behaviour', { min: 1, max: 80, step: 1 })
    public fleeMax: number = 30

    @attribute('Behaviour', { min: 0, max: 30, step: 0.5 })
    public fleeSeconds: number = 7

    /** How long it takes to answer a shot heard or one that nearly hit it (s, a range): a startle, then it acts. */
    @attribute('Behaviour', { min: 0, max: 3, step: 0.05 })
    public startleMin: number = 0.4

    @attribute('Behaviour', { min: 0, max: 3, step: 0.05 })
    public startleMax: number = 0.8

    /** How long it looks toward a shot it heard before it decides what to do (s). */
    @attribute('Behaviour', { min: 0, max: 10, step: 0.1 })
    public alertSeconds: number = 1.6

    private _lookPoints: Node[] | null = null
    /** Where it is waiting, the point it looks at there, how long it waits. */
    private _waitFor: number = 0
    private _waitAt: number[] | null = null
    private _sweepYaw: number = 0
    private _watchFor: number = 0
    private _watchedAt: number = -999
    private _fleeUntil: number = 0
    private _calmUntil: number = 0
    /** A shot heard or nearly hitting it, answered at `_startledAt` (after its startle); -1: none waiting. */
    private _startled: ThreatKind | null = null
    private _startledAt: number = -1

    public get team(): string { return 'civilian' }

    onStart() {
        super.onStart()
        this._startWait(this.between(1, 4))
    }

    protected think(delta: number): void {
        const player = this._player
        const me = this.worldPosition
        // A startle runs out: what it heard or what nearly hit it is answered now.
        if (this._startled && this._now >= this._startledAt) { const kind = this._startled; this._startled = null; this._answer(kind) }
        switch (this.state) {
            case 'wait': {
                // The head sweeps round what it looks at, slowly, without turning the body.
                const t = this._stateTime
                if (this._waitAt) this.lookAt([this._waitAt[0], this._waitAt[1] + Math.sin(t * 0.7) * 0.4, this._waitAt[2]])
                else this.face(this._sweepYaw + Math.sin(t * 0.5) * 55, Math.sin(t * 0.3) * 6)
                if (this._wantsToWatch()) { this._startWatch(); break }
                if (t > this._waitFor) this._startRoam()
                break
            }
            case 'roam': {
                this.face(null)
                if (this._wantsToWatch()) { this._startWatch(); break }
                if (this.arrived(1.2)) { this._startWait(this.between(3, 8)); break }
                if (this.stuck(4)) this._startRoam()
                break
            }
            case 'watch': {
                this.stop()
                if (player) this.lookAt([player.worldPosition[0], player.worldPosition[1] + 1.55, player.worldPosition[2]])
                const far = !player || this.planar(me, player.worldPosition) > this.watchDistance * 1.6
                if (this._stateTime > this._watchFor || far || (player as any)?.inVehicle) { this._watchedAt = this._now; this._startRoam() }
                break
            }
            case 'alert': {
                this.stop()
                if (this._threatAt) this.lookAt([this._threatAt[0], this._threatAt[1] + 1.2, this._threatAt[2]])
                if (this._stateTime > this.alertSeconds) {
                    const near = this._threatAt && this.planar(me, this._threatAt) < this.fleeDistance
                    if (near) this._startFlee(this.fleeSeconds)
                    else { this._calmUntil = this._now + 10; this._startRoam() }
                }
                break
            }
            case 'flee': {
                this.face(null)
                if (this.arrived(1.5) || this.stuck(3)) {
                    if (this._now < this._fleeUntil) this._pickFleePoint()
                    else this._startCower()
                }
                break
            }
            case 'cower': {
                this.stop()
                this.crouch(true)
                if (this._threatAt) this.lookAt([this._threatAt[0], this._threatAt[1] + 1.2, this._threatAt[2]])
                if (this._stateTime > this._waitFor) {
                    this.crouch(false)
                    this._calmUntil = this._now + 10
                    this._startRoam()
                }
                break
            }
            default:
                this._startWait(this.between(1, 3))
        }
    }

    protected threaten(kind: ThreatKind, at: number[], source: Node | null): void {
        // A shot heard, or one that nearly hit it: answered after a startle (a near miss outranks a shot heard).
        if (kind === 'shot' || kind === 'nearMiss') {
            if (this.state === 'flee') { this._fleeUntil = Math.max(this._fleeUntil, this._now + this.fleeSeconds); return }
            if (!this._startled) this._startledAt = this._now + this.between(this.startleMin, Math.max(this.startleMin, this.startleMax))
            if (this._startled !== 'nearMiss') this._startled = kind
            return
        }
        // A hit, a car: at once.
        this._startled = null
        this._startFlee(this.fleeSeconds)
    }

    /** What a shot heard (look, then decide) or a near miss (run) makes it do, once its startle is over. */
    private _answer(kind: ThreatKind): void {
        if (kind === 'nearMiss') { this._startFlee(this.fleeSeconds); return }
        // Heard: look first, unless already running.
        if (this.state === 'wait' || this.state === 'roam' || this.state === 'watch') { this.crouch(false); this.enter('alert') }
        else if (this.state === 'flee') this._fleeUntil = Math.max(this._fleeUntil, this._now + this.fleeSeconds)
    }

    /** Out of a car's way: and away from it. */
    protected afterDodge(): void {
        this._startFlee(this.fleeSeconds)
    }

    protected whileKnocked(): void {
        this.crouch(false)
        this.enter('knocked')
    }

    protected afterKnockdown(): void {
        this._startFlee(this.fleeSeconds)
    }

    // ----- the states' starts --------------------------------------------------------------------------------

    private _startWait(seconds: number): void {
        this.stop()
        this.crouch(false)
        this._waitFor = seconds
        const look = this._nearestLookPoint(this.worldPosition, 6)
        this._waitAt = look
        this._sweepYaw = this.yawNow()
        this.enter('wait')
    }

    private _startRoam(): void {
        const me = this.worldPosition
        const gait = this._now < this._calmUntil ? 'jog' : 'walk'
        // Often to something to look at; else anywhere 10 to 40 m off.
        const points = this._looks()
        let goal: number[] | null = null
        if (points.length && Math.random() < 0.6) {
            for (let i = 0; i < 4 && !goal; i++) {
                const p = points[Math.floor(Math.random() * points.length)].worldPosition
                if (this.planar(me, p) < 6) continue
                // Stand a few metres off it, not on it.
                goal = this.navPoint(p, 2.5, 4)
            }
        }
        goal = goal ?? this.navPoint(me, 10, 40) ?? this.navPoint(me, 4, 12)
        if (!goal) { this._startWait(this.between(2, 4)); return }
        this.goTo(goal, gait)
        this.enter('roam')
    }

    private _startWatch(): void {
        this.stop()
        this._watchFor = this.between(this.watchMin, this.watchMax)
        this.enter('watch')
    }

    private _startFlee(seconds: number): void {
        this.crouch(false)
        this._fleeUntil = Math.max(this._fleeUntil, this._now + seconds)
        this.enter('flee')
        this._pickFleePoint()
    }

    private _startCower(): void {
        this.stop()
        this._waitFor = this.between(2, 4)
        this.enter('cower')
    }

    /** Somewhere reachable away from the danger: farther from it than it is now, not past it. */
    private _pickFleePoint(): void {
        const me = this.worldPosition
        const threat = this._threatAt
        const away = this._awayFromThreat()
        const center = [me[0] + away[0] * (this.fleeMin + this.fleeMax) * 0.5, me[1], me[2] + away[1] * (this.fleeMin + this.fleeMax) * 0.5]
        const ok = (p: number[]) => !threat || (this.planar(p, threat) > this.planar(me, threat) + 6
            && this.distanceToSegment([p[0], 0, p[2]], [me[0], 0, me[2]], [threat[0], 0, threat[2]]) > 3)
        const goal = this.navPoint(center, 0, (this.fleeMax - this.fleeMin) * 0.5 + 6, ok, 16)
            ?? this.navPoint(me, this.fleeMin * 0.5, this.fleeMax, ok, 16)
            ?? this.navPoint(me, 6, 20)
        if (goal) this.goTo(goal, 'sprint')
        else this.moveWorld(away[0], away[1], 'sprint')
    }

    // ----- what there is to look at -------------------------------------------------------------------------

    private _looks(): Node[] {
        if (!this._lookPoints) this._lookPoints = Array.from(this.scene?.nodes ?? [] as Iterable<Node>).filter(n => n.name.startsWith('Look Point'))
        return this._lookPoints.filter(n => !!n.scene)
    }

    /** The Look Point within `within` m nearest `at`, or null. */
    private _nearestLookPoint(at: ArrayLike<number>, within: number): number[] | null {
        let best: number[] | null = null, bestD = within
        for (const n of this._looks()) {
            const p = n.worldPosition
            const d = this.planar(at, p)
            if (d < bestD) { bestD = d; best = [p[0], p[1], p[2]] }
        }
        return best
    }

    /** The player near, in sight, on foot, and not stared at a moment ago. */
    private _wantsToWatch(): boolean {
        const player = this._player
        if (!player || !this._sees || (player as any).inVehicle) return false
        if (this._now - this._watchedAt < this.watchCooldown) return false
        return this.planar(this.worldPosition, player.worldPosition) <= this.watchDistance
    }
}
