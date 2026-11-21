import { CameraRigNode, Input, MathUtils, lerp } from 'cleo'
import type { Node } from 'cleo'
import { attribute } from 'cleo/decorators'

/**
 * The Sandbox car's camera: a chase camera that takes over from the driver's own, and gives the view back. Attach to
 * the car's **Car Camera Rig**, which follows the car's **Camera Target** (a sibling under the car).
 *
 * Getting in, it starts exactly where the driver's camera is (its pivot, arm, side offset, yaw and pitch), then
 * eases out to the chase framing: higher, farther. Getting out, it eases back toward the driver's camera as it
 * moves with the character, and hands the view back the moment the character is out, seen from where this one
 * looks. While the car drives on, the camera swings back behind it unless the player has looked round lately.
 *
 * The Controller that drives the car turns this rig from the Look input; the script only frames it. SandboxCar
 * calls takeOver, handBack and release.
 */
export default class SandboxCarCameraNode extends CameraRigNode {
    /** The chase framing: how far behind the camera sits (m), and how high over the car's floor it orbits. */
    @attribute('Framing', { min: 1, max: 20, step: 0.1 })
    public chaseArm: number = 6.5

    @attribute('Framing', { min: 0, max: 5, step: 0.05 })
    public chaseHeight: number = 1.6

    /** Seconds the view takes to ease out to the chase framing once the driver's camera hands over. */
    @attribute('Switch', { min: 0, max: 5, step: 0.05 })
    private blendSeconds: number = 1.6

    /** Seconds it takes to ease back to the driver's camera while getting out (the clip is longer). */
    @attribute('Switch', { min: 0, max: 8, step: 0.05 })
    private returnSeconds: number = 3.5

    /** Faster than this (m/s), and not looked round for `recentreDelay` seconds, the camera swings back behind. */
    @attribute('Chase', { min: 0, max: 20, step: 0.1 })
    private recentreSpeed: number = 2

    @attribute('Chase', { min: 0, max: 5, step: 0.05 })
    private recentreDelay: number = 1.2

    /** How quickly it swings back (a time constant, seconds). */
    @attribute('Chase', { min: 0.05, max: 5, step: 0.05 })
    private recentreTime: number = 0.8

    /** The driver's camera while it has the view, and how far the switch is: 0 its framing, 1 the chase. */
    private _player: CameraRigNode | null = null
    private _mode: 'idle' | 'in' | 'out' = 'idle'
    private _mix: number = 0
    /** The driver's framing when it handed over: its pivot in the car's frame, its arm, its side offset. */
    private _fromTarget: number[] = [0, 0, 0]
    private _fromArm: number = 3
    private _fromSocket: number[] = [0, 0, 0]
    private _sinceLook: number = 0

    /** The node this rig follows: the car's Camera Target. */
    private get _target(): Node | null {
        return this.parent?.getChildByName('Camera Target')[0] ?? null
    }

    /** Take the view from `rig` (the driver's), from exactly where it is, and ease out to the chase framing. */
    public takeOver(rig: CameraRigNode) {
        const target = this._target
        if (!target) return
        this._player = rig
        this.setOrbit(rig.yaw, rig.pitch)
        target.setWorldPosition(rig.pivotPosition)
        target.updateTransforms(target.parent ? target.parent.worldTransform : null)
        const p = target.position
        this._fromTarget = [p[0], p[1], p[2]]
        this._fromArm = rig.currentArmLength
        const s = rig.socketOffset
        this._fromSocket = [s[0], s[1], s[2]]
        this._mix = 0
        this._mode = 'in'
        this._frame()
        this.snapToTarget()
        this._swap(true)
    }

    /** Ease back toward the driver's camera (it gets out). */
    public handBack() {
        if (this._player) this._mode = 'out'
    }

    /** Give the view back: the driver's camera looks where this one does, and is the one shown. */
    public release() {
        const player = this._player
        if (!player) return
        player.setOrbit(this.yaw, this.pitch)
        player.snapToTarget()
        this._swap(false)
        this._player = null
        this._mode = 'idle'
    }

    onUpdate(delta: number) {
        if (this._mode === 'idle') return
        const step = (seconds: number) => (seconds > 0 ? delta / seconds : 1)
        this._mix = this._mode === 'in' ? Math.min(1, this._mix + step(this.blendSeconds)) : Math.max(0, this._mix - step(this.returnSeconds))
        if (this._mode === 'out') this._follow()
        this._frame()
        if (this._mode === 'in' && this._mix >= 1) this._recentre(delta)
    }

    /** The driver's live framing, as getting out moves the character: where its camera now orbits, and how. */
    private _follow() {
        const player = this._player, target = this._target
        if (!player || !target) return
        target.setWorldPosition(player.pivotPosition)
        target.updateTransforms(target.parent ? target.parent.worldTransform : null)
        const p = target.position
        this._fromTarget = [p[0], p[1], p[2]]
        this._fromArm = player.currentArmLength
        const s = player.socketOffset
        this._fromSocket = [s[0], s[1], s[2]]
    }

    /** Between the driver's framing (0) and the chase (1), eased in and out. */
    private _frame() {
        const target = this._target
        const k = MathUtils.smoothstep(0, 1, this._mix)
        const a = this._fromTarget
        target?.setPosition([lerp(a[0], 0, k), lerp(a[1], this.chaseHeight, k), lerp(a[2], 0, k)])
        this.armLength = lerp(this._fromArm, this.chaseArm, k)
        this.socketOffset[0] = lerp(this._fromSocket[0], 0, k)
        this.socketOffset[1] = lerp(this._fromSocket[1], 0.3, k)
        this.socketOffset[2] = lerp(this._fromSocket[2], 0, k)
    }

    /** Behind the car again once it drives on and the player has not looked round for a while. */
    private _recentre(delta: number) {
        const look = Input.vector('Look')
        this._sinceLook = Math.hypot(look[0], look[1]) > 1e-3 ? 0 : this._sinceLook + delta
        const car = this.collider
        const speed = (car as unknown as { currentSpeed?: number } | null)?.currentSpeed ?? 0
        if (!car || this._sinceLook < this.recentreDelay || speed < this.recentreSpeed) return
        const f = car.worldForward
        const heading = Math.atan2(f[0], f[2]) * 180 / Math.PI
        this.setOrbit(MathUtils.dampAngleDeg(this.yaw, heading, this.recentreTime, delta), this.pitch)
    }

    /** Show this rig's camera (true) or the driver's (false). */
    private _swap(mine: boolean) {
        const own = this.camera, theirs = this._player?.camera
        if (own) own.active = mine
        if (theirs) theirs.active = !mine
    }
}
