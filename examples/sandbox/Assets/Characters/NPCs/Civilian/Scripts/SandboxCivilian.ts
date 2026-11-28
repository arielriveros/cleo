import type { Node } from 'cleo'
import { attribute } from 'cleo/decorators'
import SandboxNpcNode from '@/Characters/NPCs/Scripts/SandboxNpc'
import type { ThreatKind } from '@/Characters/NPCs/Scripts/SandboxNpc'

/**
 * A Sandbox civilian (the blue NPC): it goes about the whole map, stops to look at things, looks at the player and
 * moves on, and runs from danger. Attach to the **Character** node of the Civilian template (SandboxNpc's senses,
 * the player's body and animations underneath). Its AI Controller thinks with the **Civilian Brain**
 * (Characters/NPCs/Civilian), whose states are:
 *
 *   wait      stands a while (3 to 8 s) at a Look Point (or wherever it got to), its head sweeping round what is there
 *   roam      walks the nav mesh to somewhere else, 10 to 40 m off, often another Look Point
 *   watch     the player close by and in sight, on foot: it faces the player and looks at them a few seconds
 *             (`watchMin`..`watchMax`), then moves on; it does not stare again for a while
 *   alert     a shot heard: looks toward it a moment, then runs if it was close, else jogs off
 *   flee      a shot that nearly hit it, a hit, a car: sprints away from it to somewhere reachable, for a while
 *   cower     crouched behind wherever it fled to, facing the danger, then calm again
 *   knocked   down (its reactions'): it waits; once up, it flees
 *
 * Which state, and when, is the brain's (its transitions, with their distances and times: edit them in its AI Brain
 * tab). This script chooses where each goes and how long each lasts, and reads the senses to it as ages:
 * `sinceShot` (a shot heard), `sinceDanger` (one that nearly hit it, a hit, a car), `sinceWatched`. A shot heard or one
 * that nearly hit it reaches the brain after a startle (`startleMin`..`startleMax`): an ordinary person takes a moment
 * to understand what happened. A hit or a car reaches it at once (and a car bearing down on it gets a sideways sprint
 * off its line first: SandboxNpc).
 *
 * Look Points are nodes named "Look Point..." anywhere in the scene: what there is to look at.
 */
export default class SandboxCivilianNode extends SandboxNpcNode {
    /** How long it looks at the player (s, a range). */
    @attribute('Behaviour', { min: 0, max: 10, step: 0.1 })
    public watchMin: number = 2.5

    @attribute('Behaviour', { min: 0, max: 10, step: 0.1 })
    public watchMax: number = 4.5

    /** How far it runs (m, a range). */
    @attribute('Behaviour', { min: 1, max: 60, step: 1 })
    public fleeMin: number = 18

    @attribute('Behaviour', { min: 1, max: 80, step: 1 })
    public fleeMax: number = 30

    /** How long it takes to answer a shot heard or one that nearly hit it (s, a range): a startle, then it acts. */
    @attribute('Behaviour', { min: 0, max: 3, step: 0.05 })
    public startleMin: number = 0.4

    @attribute('Behaviour', { min: 0, max: 3, step: 0.05 })
    public startleMax: number = 0.8

    /** How long it looks toward a shot it heard before it decides what to do (s). */
    @attribute('Behaviour', { min: 0, max: 10, step: 0.1 })
    public alertSeconds: number = 1.6

    /** Where it is waiting, the point it looks at there, the heading it sweeps round. */
    private _waitAt: number[] | null = null
    private _sweepYaw: number = 0
    private _shotAt: number = -999
    private _dangerAt: number = -999
    private _watchedAt: number = -999
    /** After a fright it jogs where it would have walked, until then. */
    private _calmUntil: number = 0
    /** A flee point is chosen again on arrival while the danger is fresh: not more often than this. */
    private _replanAt: number = 0
    private _first: boolean = true
    /** A shot heard or nearly hitting it, answered at `_startledAt` (after its startle). */
    private _startled: ThreatKind | null = null
    private _startledAt: number = -1

    public get team(): string { return 'civilian' }

    // ----- what the brain reads ------------------------------------------------------------------------------

    /** Seconds since it understood a shot was fired near it (heard, after its startle). */
    public get sinceShot(): number { return this._now - this._shotAt }
    /** Seconds since a danger to run from: a shot that nearly hit it (after its startle), a hit, a car. */
    public get sinceDanger(): number { return this._now - this._dangerAt }
    /** Seconds since it last looked at the player. */
    public get sinceWatched(): number { return this._now - this._watchedAt }

    onUpdate(delta: number) {
        // A startle runs out: what it heard or what nearly hit it reaches the brain now.
        if (this._startled && this._now >= this._startledAt) {
            if (this._startled === 'nearMiss') this._dangerAt = this._now
            else this._shotAt = this._now
            this._startled = null
        }
        super.onUpdate(delta)
    }

    protected threaten(kind: ThreatKind, at: number[], source: Node | null): void {
        if (kind === 'shot' || kind === 'nearMiss') {
            // Running already: it runs on, for longer.
            if (this.state === 'flee') { this._dangerAt = this._now; return }
            if (!this._startled) this._startledAt = this._now + this.between(this.startleMin, Math.max(this.startleMin, this.startleMax))
            // A near miss outranks a shot heard.
            if (this._startled !== 'nearMiss') this._startled = kind
            return
        }
        // A hit, a car: at once.
        this._startled = null
        this._dangerAt = this._now
    }

    // ----- each state: entering it, and in it -----------------------------------------------------------------

    protected enterState(state: string, from: string): void {
        const me = this.worldPosition
        if (from === 'watch') this._watchedAt = this._now
        if (from === 'alert' || from === 'cower') this._calmUntil = this._now + 10
        switch (state) {
            case 'wait':
                this.stop()
                this._stateFor = this._first ? this.between(1, 4) : this.between(3, 8)
                this._waitAt = this._nearestLookPoint(me, 6)
                this._sweepYaw = this.yawNow()
                break
            case 'roam': this.goTo(this._roamPoint(), this._now < this._calmUntil ? 'jog' : 'walk'); break
            case 'watch': this.stop(); this._stateFor = this.between(this.watchMin, this.watchMax); break
            case 'alert': this.stop(); this._stateFor = this.alertSeconds; break
            case 'flee': this._replanAt = 0; this._flee(); break
            case 'cower': this.stop(); this._stateFor = this.between(2, 4); break
            default: this.stop()
        }
        this._first = false
    }

    protected inState(state: string, delta: number): void {
        const threat = this._threatAt
        switch (state) {
            case 'wait': {
                // The head sweeps round what it looks at, slowly, without turning the body.
                const t = this._stateTime
                if (this._waitAt) this.lookAt([this._waitAt[0], this._waitAt[1] + Math.sin(t * 0.7) * 0.4, this._waitAt[2]])
                else this.face(this._sweepYaw + Math.sin(t * 0.5) * 55, Math.sin(t * 0.3) * 6)
                break
            }
            case 'watch': {
                const p = this._player?.worldPosition
                if (p) this.lookAt([p[0], p[1] + 1.55, p[2]])
                break
            }
            case 'alert': if (threat) this.lookAt([threat[0], threat[1] + 1.2, threat[2]]); break
            case 'flee':
                // There, or stuck, while the danger is fresh: on to somewhere farther (the brain cowers once it is not).
                if ((this.arrived(1.5) || this.stuck(3)) && this._now >= this._replanAt) this._flee()
                break
            case 'cower':
                this.crouch(true)
                if (threat) this.lookAt([threat[0], threat[1] + 1.2, threat[2]])
                break
        }
    }

    // ----- where to go ----------------------------------------------------------------------------------------

    /** Often to something to look at, a few metres off it; else anywhere 10 to 40 m off. Null: nowhere found. */
    private _roamPoint(): number[] | null {
        const me = this.worldPosition
        const points = this.pointsNamed('Look Point')
        let goal: number[] | null = null
        if (points.length && Math.random() < 0.6) {
            for (let i = 0; i < 4 && !goal; i++) {
                const p = points[Math.floor(Math.random() * points.length)].worldPosition
                if (this.planar(me, p) < 6) continue
                goal = this.navPoint(p, 2.5, 4, undefined, 6)
            }
        }
        return goal ?? this.navPoint(me, 10, 40, undefined, 8) ?? this.navPoint(me, 4, 12, undefined, 6)
    }

    /** Somewhere reachable away from the danger, at a sprint: farther from it than it is now, not past it. */
    private _flee(): void {
        this._replanAt = this._now + 1
        const me = this.worldPosition
        const threat = this._threatAt
        const away = this._awayFromThreat()
        const center = [me[0] + away[0] * (this.fleeMin + this.fleeMax) * 0.5, me[1], me[2] + away[1] * (this.fleeMin + this.fleeMax) * 0.5]
        const ok = (p: number[]) => !threat || (this.planar(p, threat) > this.planar(me, threat) + 6
            && this.distanceToSegment([p[0], 0, p[2]], [me[0], 0, me[2]], [threat[0], 0, threat[2]]) > 3)
        const goal = this.navPoint(center, 0, (this.fleeMax - this.fleeMin) * 0.5 + 6, ok, 10)
            ?? this.navPoint(me, this.fleeMin * 0.5, this.fleeMax, ok, 10)
            ?? this.navPoint(me, 6, 20, undefined, 6)
        // Nowhere found: a straight dash away; the brain's path goal then has the spot ahead to run to.
        this.goTo(goal ?? [me[0] + away[0] * 12, me[1], me[2] + away[1] * 12], 'sprint', 1.5)
    }

    /** The Look Point within `within` m nearest `at`, or null. */
    private _nearestLookPoint(at: ArrayLike<number>, within: number): number[] | null {
        let best: number[] | null = null, bestD = within
        for (const n of this.pointsNamed('Look Point')) {
            const p = n.worldPosition
            const d = this.planar(at, p)
            if (d < bestD) { bestD = d; best = [p[0], p[1], p[2]] }
        }
        return best
    }
}
