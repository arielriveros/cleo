import { CameraRigNode, MathUtils, lerp } from 'cleo'
import { attribute } from 'cleo/decorators'

/**
 * The Sandbox camera: one Camera Rig with two framings, and the aim's. It sits over the shoulder, pulls out to third
 * person while the character sprints, and moves in closer over the shoulder while it aims a weapon. Attach to the
 * character's **Camera Rig**.
 *
 * The boom (arm length, the side offset of the camera, the height it orbits at) eases between the two over
 * `switchSeconds`, starting and ending gently either way. Where the camera looks stays the Controller's: it turns the rig from the Look input, and this
 * script never touches yaw or pitch. No action switches the framing; the character's sprint and aim do. They are read
 * from the Character the rig belongs to (the one under the Collider above it): its script's `sprinting` and
 * `aiming`. The aim comes in quickly (`aimSeconds`), on top of whichever of the two framings it is in.
 *
 * The framing distances are the character's (a taller one wants a higher pivot and a longer arm), so they are
 * public: each copy of the Player template can set its own. How the switch feels is the behavior's, so it is
 * private: set once, here.
 */
export default class SandboxCameraNode extends CameraRigNode {
    /** Third person (while sprinting): how far behind the character the camera sits (m). */
    @attribute('Framing', { min: 0.5, max: 12, step: 0.05 })
    public thirdPersonArm: number = 3.4

    /** Over the shoulder: how far behind (m). */
    @attribute('Framing', { min: 0.5, max: 12, step: 0.05 })
    public shoulderArm: number = 1.9

    /** Over the shoulder: how far to the right of the character the camera sits (m). */
    @attribute('Framing', { min: 0, max: 2, step: 0.05 })
    public shoulderOffset: number = 0.5

    /** Aiming: how far behind the character the camera sits (m), and how far to the right. */
    @attribute('Framing', { min: 0.3, max: 12, step: 0.05 })
    public aimArm: number = 1.25

    @attribute('Framing', { min: 0, max: 2, step: 0.05 })
    public aimShoulderOffset: number = 0.6

    /** How high over the character's feet the camera orbits (m). */
    @attribute('Framing', { min: 0, max: 4, step: 0.05 })
    public pivotHeight: number = 1.45

    /** Seconds the switch between the two framings takes, either way. */
    @attribute('Switch', { min: 0, max: 5, step: 0.05 })
    private switchSeconds: number = 2

    /** Seconds the aim's framing takes to come in, and to go out. */
    @attribute('Switch', { min: 0, max: 2, step: 0.05 })
    private aimSeconds: number = 0.25

    /** Seconds the third-person framing stays after a sprint ends, so letting go for a moment does not swing it. */
    @attribute('Switch', { min: 0, max: 2, step: 0.05 })
    private sprintHold: number = 0.4

    private _sinceSprint: number = 1e9
    /** Where the switch is: 0 over the shoulder, 1 third person. It moves at an even rate; the framing eases. */
    private _mix: number = 0
    /** Where the aim's framing is: 0 out, 1 in. */
    private _aimMix: number = 0
    private _aiming: boolean = false

    onStart() {
        // Start framed, not easing in from the rig's authored values.
        this._frame(0, true)
    }

    onUpdate(delta: number) {
        const character = this.collider?.character as unknown as { sprinting?: boolean; aiming?: boolean } | null | undefined
        this._sinceSprint = character?.sprinting ? 0 : this._sinceSprint + delta
        this._aiming = !!character?.aiming
        this._frame(delta, false)
    }

    /** Whether the camera is (heading) out to third person: while sprinting, and `sprintHold` after. */
    get wide(): boolean {
        return this._sinceSprint <= this.sprintHold
    }

    private _frame(delta: number, snap: boolean) {
        const target = this.wide ? 1 : 0
        const step = snap || this.switchSeconds <= 0 ? 1 : delta / this.switchSeconds
        this._mix = target > this._mix ? Math.min(target, this._mix + step) : Math.max(target, this._mix - step)
        // Eased in and out: the boom sets off and arrives gently. A switch reversed half way turns back from where
        // it is.
        const k = MathUtils.smoothstep(0, 1, this._mix)
        const aimStep = snap || this.aimSeconds <= 0 ? 1 : delta / this.aimSeconds
        this._aimMix = this._aiming ? Math.min(1, this._aimMix + aimStep) : Math.max(0, this._aimMix - aimStep)
        const a = MathUtils.smoothstep(0, 1, this._aimMix)
        this.armLength = lerp(lerp(this.shoulderArm, this.thirdPersonArm, k), this.aimArm, a)
        // Socket +X is the rig's left: the right shoulder is negative.
        this.socketOffset[0] = lerp(lerp(-this.shoulderOffset, 0, k), -this.aimShoulderOffset, a)
        this.socketOffset[1] = lerp(0.1, 0.15, k)
        this.socketOffset[2] = 0
        this.followOffset[1] = lerp(this.pivotHeight + 0.05, this.pivotHeight, k)
    }
}
