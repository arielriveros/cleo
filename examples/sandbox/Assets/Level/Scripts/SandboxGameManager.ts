import { Node } from 'cleo'
import type { LightNode, LightProbeNode, UITextNode } from 'cleo'
import { attribute, eventListener, observable, onAction } from 'cleo/decorators'

/** One of the light setups: what it is called on the HUD, and where it puts the sun. */
interface LightSetup {
    name: string
    /** Degrees over the horizon (under it when negative). */
    elevation: number
}

/**
 * The Sandbox's game manager: its three light setups, switched by the keys 1, 2 and 3 (the Day, Sunset and Night
 * actions; the d-pad's left, up and right on a pad), and the HUD line that says which is on.
 *
 * A light setup is where the sun is. Everything else follows it on its own: the sky and its clouds, the moon (it
 * stands opposite the sun, so it is up at night), the Sky Light's fill, the GI Volume (it relights its probes), the
 * Light Probe (relit a moment after each switch, once the sky has caught up), and the eye (auto exposure, with the
 * project's compensation curve deciding how dark the dusk and the night look). The sun keeps its real brightness: it
 * is the sky that changes, never the lamps.
 *
 *   Day     the sun high in the afternoon
 *   Sunset  the sun just under the horizon: the blue hour, its glow still on the sky (the scene as authored)
 *   Night   the sun far under it: moonlight, and the car's lamps
 *
 * It also sets how often the NPCs' brains do their costly parts (the scene's `aiDetail`): each looks and feels
 * for obstacles every other frame (on a frame of its own), they plan no more than two paths a frame between
 * them, and one farther than 35 m from the camera does all of it three times less often again.
 */
export default class SandboxGameManagerNode extends Node {
    /** The setup the scene starts in: 1 day, 2 sunset, 3 night. */
    @attribute('Light setups', { min: 1, max: 3, step: 1 })
    public startSetup: number = 2

    /** The sun's elevation in each setup, degrees over the horizon. */
    @attribute('Light setups', { min: -90, max: 90, step: 0.5 })
    public dayElevation: number = 52
    @attribute('Light setups', { min: -90, max: 90, step: 0.5 })
    public sunsetElevation: number = -9
    @attribute('Light setups', { min: -90, max: 90, step: 0.5 })
    public nightElevation: number = -40
    /** The sun's heading in every setup, degrees (0 faces +Z). */
    @attribute('Light setups', { min: -180, max: 180, step: 1 })
    public sunHeading: number = 35

    /** The directional light that is the sun, the HUD text that names the setup, and the light probe to relight. */
    @attribute('Scene')
    public sun: LightNode | null = null
    @attribute('Scene')
    public hudLine?: UITextNode | null = null
    @attribute('Scene')
    public probe?: LightProbeNode | null = null
    /**
     * Seconds after a switch the light probe is lit again. It relights itself as soon as the sun turns, but the sky
     * it reflects is baked again over the next frames: lit at once, it keeps the last setup's sky.
     */
    @attribute('Scene', { min: 0, max: 5, step: 0.1 })
    public probeRelightDelay: number = 1

    /**
     * The setup on now: 1 day, 2 sunset, 3 night (0 before the first frame). Setting it tells `sandbox:LightSetup`
     * (the setup and the one before): the HUD line answers here, and anything else may with
     * `@onEvent('sandbox:LightSetup')`.
     */
    @observable('sandbox:LightSetup')
    public setup: number = 0

    /** Cancels the light probe's pending relight, or null when none is pending. */
    private _cancelRelight: (() => void) | null = null

    onStart() {
        this.scene.aiDetail = { perceiveEvery: 2, probeEvery: 2, pathsPerFrame: 2, farDistance: 35, farFactor: 3 }
        this.applySetup(this.startSetup)
    }

    /** The keys 1, 2 and 3 (the d-pad's left, up and right). */
    @onAction('Day')
    private _day() { this.applySetup(1) }
    @onAction('Sunset')
    private _sunset() { this.applySetup(2) }
    @onAction('Night')
    private _night() { this.applySetup(3) }

    /** The three setups, in key order. */
    public get setups(): LightSetup[] {
        return [
            { name: 'Day', elevation: this.dayElevation },
            { name: 'Sunset', elevation: this.sunsetElevation },
            { name: 'Night', elevation: this.nightElevation },
        ]
    }

    /** Switch to setup `index` (1 day, 2 sunset, 3 night): the sun there, and (through `sandbox:LightSetup`) the HUD. */
    public applySetup(index: number) {
        const i = Math.min(3, Math.max(1, Math.round(index)))
        const s = this.setups[i - 1]
        // A directional light shines along its +Z: pitched down by the elevation, turned to the heading.
        this.sun?.setRotation([s.elevation, this.sunHeading, 0])
        // The probe once the sky has caught up; a switch before then starts the wait again.
        this._cancelRelight?.()
        this._cancelRelight = this.after(this.probeRelightDelay, () => {
            this._cancelRelight = null
            this.probe?.relight()
        })
        this.setup = i
    }

    /** The setup changed: the HUD says which. */
    @eventListener('sandbox:LightSetup')
    private _setupShown(setup: number) {
        const s = this.setups[setup - 1]
        if (this.hudLine && s) this.hudLine.text = `Light: ${s.name}`
    }
}
