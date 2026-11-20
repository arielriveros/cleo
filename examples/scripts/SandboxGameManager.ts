import { Input, Node } from 'cleo'
import type { ActionName, LightProbeNode, UITextNode } from 'cleo'
import { attribute } from 'cleo/decorators'

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
    public sunName: string = 'Sun'
    @attribute('Scene')
    public hudLineName: string = 'Light Setup'
    @attribute('Scene')
    public probeName: string = 'Light Probe'
    /**
     * Seconds after a switch the light probe is lit again. It relights itself as soon as the sun turns, but the sky
     * it reflects is baked again over the next frames: lit at once, it keeps the last setup's sky.
     */
    @attribute('Scene', { min: 0, max: 5, step: 0.1 })
    public probeRelightDelay: number = 1

    @attribute('Input')
    public dayAction: ActionName = 'Day'
    @attribute('Input')
    public sunsetAction: ActionName = 'Sunset'
    @attribute('Input')
    public nightAction: ActionName = 'Night'

    /** The setup on now: 1 day, 2 sunset, 3 night (0 before the first frame). */
    public setup: number = 0

    private _sun: Node | null = null
    private _hudLine: UITextNode | null = null
    private _probe: LightProbeNode | null = null
    /** Seconds until the light probe is lit again (negative: nothing pending). */
    private _relightIn: number = -1

    onStart() {
        this._sun = this.findNode(this.sunName) ?? null
        this._hudLine = (this.findNode(this.hudLineName) as UITextNode | null) ?? null
        this._probe = (this.findNode(this.probeName) as LightProbeNode | null) ?? null
        this.applySetup(this.startSetup)
    }

    onUpdate(delta: number) {
        if (this._relightIn >= 0) {
            this._relightIn -= delta
            if (this._relightIn < 0) this._probe?.relight()
        }
        if (this.dayAction && Input.started(this.dayAction)) this.applySetup(1)
        else if (this.sunsetAction && Input.started(this.sunsetAction)) this.applySetup(2)
        else if (this.nightAction && Input.started(this.nightAction)) this.applySetup(3)
    }

    /** The three setups, in key order. */
    public get setups(): LightSetup[] {
        return [
            { name: 'Day', elevation: this.dayElevation },
            { name: 'Sunset', elevation: this.sunsetElevation },
            { name: 'Night', elevation: this.nightElevation },
        ]
    }

    /** Switch to setup `index` (1 day, 2 sunset, 3 night): the sun there, and the HUD saying so. */
    public applySetup(index: number) {
        const i = Math.min(3, Math.max(1, Math.round(index)))
        const s = this.setups[i - 1]
        this.setup = i
        // A directional light shines along its +Z: pitched down by the elevation, turned to the heading.
        this._sun?.setRotation([s.elevation, this.sunHeading, 0])
        if (this._hudLine) this._hudLine.text = `Light: ${s.name}`
        this._relightIn = this.probeRelightDelay
    }
}
