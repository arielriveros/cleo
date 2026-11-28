import { CameraRigNode, MathUtils, lerp } from 'cleo'
import type { Node } from 'cleo'
import { attribute } from 'cleo/decorators'

/** What the camera reads from the character it belongs to (SandboxPlayer). */
interface Framed {
    sprinting?: boolean
    aiming?: boolean
    /** Aim held in third person (not a shot from the hip): the camera zooms in. */
    aimingDown?: boolean
    crouched?: boolean
    inVehicle?: boolean
    /** The view the player asks for: first person, or third. */
    firstPerson?: boolean
    /** First person: the eye's height over the feet (m), and the field of view (degrees). */
    eyeHeight?: number
    viewFov?: number
}

/**
 * The Sandbox camera: one Camera Rig with its third-person framings, the aim's, and first person. It sits over the
 * shoulder, pulls out to third person while the character sprints, and moves in closer over the shoulder while it
 * aims a weapon; in first person it is at the character's eyes. Attach to the character's **Camera Rig**.
 *
 * The boom (arm length, the side offset of the camera, the height it orbits at) eases between the shoulder and third
 * person over `switchSeconds`, starting and ending gently either way. Where the camera looks stays the Controller's: it
 * turns the rig from the Look input, and this script never touches yaw or pitch. No action switches the third-person
 * framing; the character's sprint and aim do. They are read from the Character the rig belongs to (the one under the
 * Collider above it): its script's `sprinting` and `aiming`. The aim comes in quickly (`aimSeconds`), on top of
 * whichever of the two framings it is in; with Aim held (`aimingDown`, not a shot from the hip) the lens narrows to
 * `aimFov` as well (`zoomMix`), and the mouse slows with it (`zoomSensitivity`, read by the character). Crouched (the
 * Character's `crouched`), it orbits `crouchDrop` lower.
 *
 * FIRST PERSON (the character's `firstPerson`, which the View action toggles): the boom folds in to the eyes over
 * `viewSeconds` (eased), to the character's `eyeHeight` over its feet, with no follow damping and no collision (the
 * camera is inside the capsule), a wider pitch and the character's own field of view (`viewFov`: Firing Line's 78
 * degrees, narrowing as it aims). Once the camera is in at the head, the character's body and the weapons in its
 * hands are drawn into the shadows alone (`Node.shadowOnly`): gone from the view they would fill, their shadow still
 * on the ground. In a car it is third person whatever was asked: the car's camera sees the driver.
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

    /** How high over the character's feet the camera orbits (m), and how much lower crouched. */
    @attribute('Framing', { min: 0, max: 4, step: 0.05 })
    public pivotHeight: number = 1.45

    @attribute('Framing', { min: 0, max: 2, step: 0.05 })
    public crouchDrop: number = 0.45

    /** Seconds the switch between the two framings takes, either way. */
    @attribute('Switch', { min: 0, max: 5, step: 0.05 })
    private switchSeconds: number = 2

    /** Seconds the aim's framing takes to come in, and to go out. */
    @attribute('Switch', { min: 0, max: 2, step: 0.05 })
    private aimSeconds: number = 0.25

    /** Seconds the third-person framing stays after a sprint ends, so letting go for a moment does not swing it. */
    @attribute('Switch', { min: 0, max: 2, step: 0.05 })
    private sprintHold: number = 0.4

    /** Seconds the switch to first person (and back) takes. */
    @attribute('Switch', { min: 0, max: 2, step: 0.05 })
    private viewSeconds: number = 0.3

    /** Seconds the orbit takes to drop for a crouch, and to come back up. */
    @attribute('Switch', { min: 0, max: 2, step: 0.05 })
    private crouchSeconds: number = 0.25

    /** The field of view in third person (degrees). */
    @attribute('Switch', { min: 20, max: 120, step: 1 })
    private thirdPersonFov: number = 60

    /** Aim held in third person: the narrower field of view it zooms to (degrees). */
    @attribute('Switch', { min: 10, max: 120, step: 1 })
    private aimFov: number = 45

    /** First person: the pitch's reach, degrees up and down. */
    @attribute('Switch', { min: 30, max: 89, step: 1 })
    private firstPersonPitch: number = 85

    private _sinceSprint: number = 1e9
    /** Where the switch is: 0 over the shoulder, 1 third person. It moves at an even rate; the framing eases. */
    private _mix: number = 0
    /** Where the aim's framing is: 0 out, 1 in. */
    private _aimMix: number = 0
    private _aiming: boolean = false
    /** Where the switch to first person is: 0 third person, 1 at the eyes (even rate; eased into `firstPersonMix`). */
    private _fpMix: number = 0
    private _crouchMix: number = 0
    /** The rig as authored: what third person keeps. */
    private _authored: { damping: number[], pitchMin: number, pitchMax: number, collision: boolean } | null = null

    /** How far into first person the camera is: 0 third person, 1 at the eyes (eased). */
    public firstPersonMix: number = 0
    /** How far into the aim's zoom the third-person lens is: 0 `thirdPersonFov`, 1 `aimFov` (eased). */
    public zoomMix: number = 0
    /** The mouse's share of its speed under that zoom, so the view turns as fast on the screen (1 unzoomed). */
    public zoomSensitivity: number = 1
    private _zoom: number = 0

    onStart() {
        this._authored = {
            damping: [this.followDamping[0], this.followDamping[1], this.followDamping[2]],
            pitchMin: this.pitchMin, pitchMax: this.pitchMax, collision: this.collisionEnabled,
        }
        this.fovEnabled = true
        // Start framed, not easing in from the rig's authored values.
        this._frame(0, true)
    }

    onUpdate(delta: number) {
        this._frame(delta, false)
    }

    /** Whether the camera is (heading) out to third person: while sprinting, and `sprintHold` after. */
    get wide(): boolean {
        return this._sinceSprint <= this.sprintHold
    }

    private get _character(): Framed | null {
        return (this.collider?.character as unknown as Framed | null | undefined) ?? null
    }

    private _frame(delta: number, snap: boolean) {
        const character = this._character
        this._sinceSprint = character?.sprinting ? 0 : this._sinceSprint + delta
        this._aiming = !!character?.aiming
        const step = snap || this.switchSeconds <= 0 ? 1 : delta / this.switchSeconds
        const target = this.wide ? 1 : 0
        this._mix = target > this._mix ? Math.min(target, this._mix + step) : Math.max(target, this._mix - step)
        // Eased in and out: the boom sets off and arrives gently. A switch reversed half way turns back from where
        // it is.
        const k = MathUtils.smoothstep(0, 1, this._mix)
        const aimStep = snap || this.aimSeconds <= 0 ? 1 : delta / this.aimSeconds
        this._aimMix = this._aiming ? Math.min(1, this._aimMix + aimStep) : Math.max(0, this._aimMix - aimStep)
        const a = MathUtils.smoothstep(0, 1, this._aimMix)
        const fpStep = snap || this.viewSeconds <= 0 ? 1 : delta / this.viewSeconds
        const firstPerson = !!character?.firstPerson && !character?.inVehicle
        this._fpMix = firstPerson ? Math.min(1, this._fpMix + fpStep) : Math.max(0, this._fpMix - fpStep)
        const f = MathUtils.smoothstep(0, 1, this._fpMix)
        this.firstPersonMix = f
        const crouchStep = snap || this.crouchSeconds <= 0 ? 1 : delta / this.crouchSeconds
        this._crouchMix = character?.crouched ? Math.min(1, this._crouchMix + crouchStep) : Math.max(0, this._crouchMix - crouchStep)
        const c = MathUtils.smoothstep(0, 1, this._crouchMix)

        // Third person, then folded in toward the eyes by `f`.
        const arm = lerp(lerp(this.shoulderArm, this.thirdPersonArm, k), this.aimArm, a)
        this.armLength = lerp(arm, 0, f)
        // Socket +X is the rig's left: the right shoulder is negative.
        this.socketOffset[0] = lerp(lerp(lerp(-this.shoulderOffset, 0, k), -this.aimShoulderOffset, a), 0, f)
        this.socketOffset[1] = lerp(lerp(0.1, 0.15, k), 0, f)
        this.socketOffset[2] = 0
        const pivot = lerp(this.pivotHeight + 0.05, this.pivotHeight, k) - this.crouchDrop * c
        this.followOffset[1] = lerp(pivot, character?.eyeHeight ?? pivot, f)
        const authored = this._authored
        if (authored) {
            for (let i = 0; i < 3; i++) this.followDamping[i] = authored.damping[i] * (1 - f)
            this.pitchMin = lerp(authored.pitchMin, -this.firstPersonPitch, f)
            this.pitchMax = lerp(authored.pitchMax, this.firstPersonPitch, f)
            this.collisionEnabled = authored.collision && f < 0.5
        }
        // The aim's zoom (Aim held, third person), eased in and out over the aim's framing time.
        this._zoom = character?.aimingDown && !firstPerson ? Math.min(1, this._zoom + aimStep) : Math.max(0, this._zoom - aimStep)
        const z = MathUtils.smoothstep(0, 1, this._zoom)
        this.zoomMix = z * (1 - f)
        const thirdFov = lerp(this.thirdPersonFov, this.aimFov, z)
        const half = (deg: number) => Math.tan(deg * Math.PI / 360)
        this.zoomSensitivity = lerp(half(thirdFov) / half(this.thirdPersonFov), 1, f)
        this.fov = lerp(thirdFov, character?.viewFov ?? this.thirdPersonFov, f)

        // At the eyes, the body and the weapons it holds are drawn into the shadows only.
        const inside = f > 0.6
        const body = this.follow as Node | null
        if (body && body.shadowOnly !== inside) body.shadowOnly = inside
        const weapons = (this.collider?.character as unknown as Node | null)?.getChildByName('Weapons')[0]
        if (weapons && weapons.shadowOnly !== inside) weapons.shadowOnly = inside
    }
}
