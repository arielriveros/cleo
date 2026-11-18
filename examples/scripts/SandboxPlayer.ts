import { CharacterNode, Input, attribute } from 'cleo'

/**
 * The Sandbox player: input only. Attach to the **Character** node ("Player").
 *
 *   Player Collider     capsule, friction 0 (the root of the Player template)
 *   └─ Player           THIS script, on a Character node
 *      ├─ Camera Rig    SandboxCamera: over the shoulder, third person while sprinting
 *      ├─ Mannequin     the animated model: its Animator decides every pose
 *      └─ Player Controller
 *
 * The Controller reads Move / Look / Jump / Sprint and writes this frame's intent; the Character turns it into
 * velocity, facing, the jump and the turn-in-place request; the Mannequin's Animator reads all of that by itself
 * (Linked parameters). What is left for a script is what only the game knows, in the style of Advanced
 * Locomotion System v4:
 *
 *   - the GAIT: jog by default (the Character's walkSpeed), Walk held for a walk, Sprint held for a sprint (its
 *     runSpeed), a stick picking walk or jog by how far it is pushed;
 *   - the ROTATION MODE: walking and jogging face the camera and strafe (facing `aim`), sprinting faces where it
 *     goes, in any direction (facing `velocity`); after a sprint the body stays as it stopped until the camera moves;
 *   - the RUNNING TURN: a sprint reversed holds `runTurn` (-1 left, +1 right) while the animator's turn clip turns
 *     the body by its root motion;
 *   - the LEAN: the sideways acceleration in the body's frame, as two layer weights (`leanLeft`, `leanRight`), and
 *     the forward one as a third (`leanForward`), weight into the step as it sets off and speeds up;
 *   - travel eased down when going backwards, to the speed the backward clips cover, so their feet do not slide;
 *   - `hasMoveInput`, `running`, `sprinting` and `moveAngle`, which the animator cannot measure (a Stop needs "the
 *     player let go", the start "a sprint, set off the way the body faces");
 *   - `groundSpeed`, the body's speed unsmoothed, for the blend space (the measured one lags a speeding body);
 *   - `footPlacement`, the foot IK weight while moving: full at a walk, light at a run (the solver plants the
 *     lower foot whenever it nears the ground, which a run's flight phase between strides must not do);
 *   - the LOOK-AT: where the camera faces off the body (`lookYaw`, `lookPitch`) and the Look layer's weight
 *     (`lookWeight`, up standing still), and the turn in place held back `turnDelay` seconds so the head turns first.
 *
 * It names no clip, no state and no key, and plays no animation.
 *
 * The attributes the CHARACTER decides are public (how fast its clips go backwards, where its foot placement eases
 * off, how long it takes to turn round to the camera), so every copy of the Player template can set its own; how the behavior feels (the stick, the lean, the
 * running turn) is private, set once here.
 */
export default class SandboxPlayerNode extends CharacterNode {
    /** Walk speed as a share of the jog (the Character's walkSpeed): the walk clips' speed over the jog's. */
    @attribute('Gait', { min: 0, max: 1, step: 0.01 })
    public walkScale: number = 0.38

    /** A stick pushed less than this walks; past it, it jogs. */
    @attribute('Gait', { min: 0, max: 1, step: 0.05 })
    private walkDeflection: number = 0.6

    /** Speed share travelling straight back: the backward clips cover less ground than the forward ones. */
    @attribute('Gait', { min: 0.1, max: 1, step: 0.01 })
    public backScale: number = 0.73

    /** Speed share travelling diagonally back at a jog (the back-diagonal clip's speed), and at a walk. */
    @attribute('Gait', { min: 0.1, max: 1, step: 0.01 })
    public backDiagonalScale: number = 0.48

    @attribute('Gait', { min: 0.1, max: 1, step: 0.01 })
    public walkBackDiagonalScale: number = 0.86

    /** Seconds the speed share takes to follow a change of direction. */
    @attribute('Gait', { min: 0, max: 1, step: 0.01 })
    private directionEase: number = 0.15

    /** A sprint faster than this (m/s) that is asked to go more than `runTurnAngle` the other way turns round. */
    @attribute('Running Turn', { min: 0, max: 10, step: 0.1 })
    public runTurnSpeed: number = 3.5

    /**
     * The acceleration (m/s2) a sprint takes off at, from a standstill or speeding up the way it already goes: the
     * start clip's own, so it plays at its own speed and is seen. Everything else (a jog, a walk, braking, a turn)
     * keeps the Character's Acceleration.
     */
    @attribute('Gait', { min: 0.5, max: 30, step: 0.1 })
    public sprintTakeoff: number = 5

    @attribute('Running Turn', { min: 90, max: 180, step: 1 })
    private runTurnAngle: number = 135

    /** The turn lets go once the body is this close to the way it is asked to go (degrees), or after `runTurnSeconds`. */
    @attribute('Running Turn', { min: 0, max: 90, step: 1 })
    private runTurnRelease: number = 30

    @attribute('Running Turn', { min: 0.2, max: 3, step: 0.05 })
    private runTurnSeconds: number = 1.2

    /** Sideways acceleration (m/s2) that leans the body all the way. */
    @attribute('Lean', { min: 0.5, max: 20, step: 0.5 })
    private leanAcceleration: number = 4

    /** How fast the lean follows, per second (ALS's lean interpolation speed). */
    @attribute('Lean', { min: 0.5, max: 20, step: 0.5 })
    private leanSpeed: number = 4

    /** Forward acceleration (m/s2) that leans the body forward all the way: setting off, speeding up. */
    @attribute('Lean', { min: 0.5, max: 30, step: 0.5 })
    private leanForwardAcceleration: number = 8

    /** How fast the forward lean follows, per second: a start is over in half a second. */
    @attribute('Lean', { min: 0.5, max: 30, step: 0.5 })
    private leanForwardSpeed: number = 8

    /** After a sprint, how far the camera must swing (degrees) before standing still turns to face it again. */
    @attribute('Turn In Place', { min: 0, max: 180, step: 1 })
    private lookAroundAngle: number = 20

    /**
     * Seconds the camera must stay round past the turn threshold before the body turns in place to it: meanwhile
     * the head looks round (the Look layer). A character's own reaction time, so public.
     */
    @attribute('Turn In Place', { min: 0, max: 3, step: 0.05 })
    public turnDelay: number = 1

    /** The share of `turnDelay` waited before a turn to a camera swung right round behind (past 135 degrees). */
    @attribute('Turn In Place', { min: 0, max: 1, step: 0.05 })
    private farTurnShare: number = 0.35

    /** How fast the look-at comes in standing still, and goes as the body moves off, per second. */
    @attribute('Look', { min: 0.5, max: 20, step: 0.5 })
    private lookSpeed: number = 5

    /**
     * The camera pitch (degrees, down +) that is a level look: the rig's resting pitch, which looks a little down
     * at the character. Pitched further down the head looks down, pitched up it looks up.
     */
    @attribute('Look', { min: -45, max: 45, step: 1 })
    private lookPitchRest: number = 12

    /** Foot placement is full up to this speed (m/s)... */
    @attribute('Foot Placement', { min: 0, max: 10, step: 0.1 })
    public walkFootSpeed: number = 1.9

    /** ...and down to `runFootWeight` from this one. The lean fades in over the same range. */
    @attribute('Foot Placement', { min: 0, max: 10, step: 0.1 })
    public runFootSpeed: number = 3.8

    @attribute('Foot Placement', { min: 0, max: 1, step: 0.05 })
    public runFootWeight: number = 0.3

    // ----- read by the animator (Linked parameters) -----------------------------------------------------------

    /** MoveInput: the player is asking to move. */
    public hasMoveInput: boolean = false
    /**
     * GroundSpeed: how fast the body crosses the ground this frame, as the physics has it. The blend space's
     * speed: the measured `planarSpeed` is smoothed, and reads a body speeding up into a sprint a metre a second
     * slow, which slides the feet forward.
     */
    public groundSpeed: number = 0
    /** Running: at a jog or a sprint, not a walk. */
    public running: boolean = false
    /** Sprinting: Sprint held with the stick all the way, which is what the start clip sets off into. */
    public sprinting: boolean = false
    /** MoveAngle: degrees from the body's facing to the input, unsmoothed (+ left, - right). */
    public moveAngle: number = 0
    /** RunTurn: -1 a running turn to the left, +1 to the right, 0 none. */
    public runTurn: number = 0
    /** LeanLeft, LeanRight, LeanForward: the lean layers' weights. */
    public leanLeft: number = 0
    public leanRight: number = 0
    public leanForward: number = 0
    /** FootPlacement: the locomotion's foot IK weight. */
    public footPlacement: number = 1
    /**
     * LookYaw, LookPitch: where the camera faces, off the body (degrees; yaw + left, pitch + down), clamped to the
     * Look blend space's range. LookWeight: the Look layer's weight, up while standing still.
     */
    public lookYaw: number = 0
    public lookPitch: number = 0
    public lookWeight: number = 0

    private _directionScale: number = 1
    private _lean: number = 0
    private _lastVelocity: number[] = [0, 0]
    private _turnTime: number = 0
    private _wasSprinting: boolean = false
    private _afterSprint: boolean = false
    private _stopYaw: number = 0
    /** The Character's own Acceleration, as authored: what everything but a sprint take-off uses. */
    private _acceleration: number = -1

    onUpdate(delta: number) {
        if (this._acceleration < 0) this._acceleration = this.acceleration
        const v = this.velocity
        this.groundSpeed = Math.hypot(v[0], v[2])
        const intent = this.drive()
        const [right, forward] = intent.move
        const amount = Math.min(1, Math.hypot(right, forward))
        this.hasMoveInput = amount > 0.1
        const run = Math.min(1, Math.max(0, (this.planarSpeed - this.walkFootSpeed) / Math.max(0.01, this.runFootSpeed - this.walkFootSpeed)))
        this.footPlacement = 1 + (this.runFootWeight - 1) * run

        const facing = this.worldForward
        const bodyYaw = Math.atan2(facing[0], facing[2]) * 180 / Math.PI
        // The input as a world heading (angles are counter-clockwise: right is negative), then off the body.
        const inputYaw = intent.basisYaw + Math.atan2(-right, forward) * 180 / Math.PI
        this.moveAngle = this.hasMoveInput ? this._wrap(inputYaw - bodyYaw) : 0
        this._lean = this._leanToward(delta, facing, run)
        this._lookToward(delta, intent.aimYaw - bodyYaw, intent.aimPitch)
        // The turn in place waits for the head: it engages only once the camera has stayed round this long.
        this.turnSettleSeconds = this.turnDelay
        this.turnSettleFarSeconds = this.turnDelay * this.farTurnShare

        if (!this.hasMoveInput) {
            this.acceleration = this._acceleration
            this.running = false
            this.sprinting = false
            this.runTurn = 0
            // Stopping out of a sprint: stay as stopped until the camera is swung, rather than turning to it at once.
            if (this._wasSprinting) { this._afterSprint = true; this._stopYaw = intent.aimYaw; this._wasSprinting = false }
            if (this._afterSprint && Math.abs(this._wrap(intent.aimYaw - this._stopYaw)) > this.lookAroundAngle) this._afterSprint = false
            this.facingMode = this._afterSprint ? 'none' : 'aim'
            return
        }

        // Sprint: in any direction, with the stick (nearly) all the way.
        const sprinting = intent.sprint && amount > 0.9
        intent.sprint = sprinting
        this.sprinting = sprinting
        // The take-off: speeding up into a sprint from a standstill, or along the way the body already goes (not
        // braking to reverse, which the running turn and the stop expect at the Character's own rate).
        const along = this.groundSpeed < 0.5 || Math.abs(this._wrap(inputYaw - Math.atan2(v[0], v[2]) * 180 / Math.PI)) < 60
        this.acceleration = sprinting && along && this.groundSpeed < this.runSpeed - 0.05 ? this.sprintTakeoff : this._acceleration

        // The running turn: a fast sprint asked to go back the way it came.
        if (sprinting && this.runTurn === 0 && this.planarSpeed > this.runTurnSpeed && Math.abs(this.moveAngle) > this.runTurnAngle) {
            this.runTurn = this.moveAngle > 0 ? -1 : 1
            this._turnTime = 0
        }
        if (this.runTurn !== 0) {
            this._turnTime += delta
            if (!sprinting || Math.abs(this.moveAngle) < this.runTurnRelease || this._turnTime > this.runTurnSeconds) this.runTurn = 0
        }
        // While the turn clip turns the body, nothing else may.
        this.facingMode = this.runTurn !== 0 ? 'none' : sprinting ? 'velocity' : 'aim'
        this._wasSprinting = sprinting
        this._afterSprint = false

        // Walk: the Walk action, or a stick pushed less than walkDeflection (scaled up to a full walk at it).
        let scale = 1
        const walking = !sprinting && (Input.pressed('Walk') || amount < this.walkDeflection)
        if (walking) scale = Input.pressed('Walk') ? this.walkScale : this.walkScale * Math.min(1, amount / this.walkDeflection) / amount
        this.running = !walking

        // Strafing backwards: full speed up to the side, the diagonal share at 135 degrees, the back share straight
        // back: the speeds the backward clips cover. A sprint faces where it goes, so it is always "forward".
        const angle = Math.abs(Math.atan2(right, forward) * 180 / Math.PI)
        const diagonal = walking ? this.walkBackDiagonalScale : this.backDiagonalScale
        const target = sprinting || angle <= 90 ? 1
            : angle <= 135 ? 1 + (diagonal - 1) * (angle - 90) / 45
            : diagonal + (this.backScale - diagonal) * (angle - 135) / 45
        const k = this.directionEase > 0 ? 1 - Math.exp(-delta / this.directionEase) : 1
        this._directionScale += (target - this._directionScale) * k

        intent.speedScale *= scale * this._directionScale
    }

    /**
     * The lean: the body's sideways acceleration (its velocity's change, on the body's left axis), as a share of
     * `leanAcceleration`, faded in from a walk to a run and followed at `leanSpeed`. Positive leans left.
     */
    private _leanToward(delta: number, facing: ArrayLike<number>, run: number): number {
        const v = this.velocity
        if (!(delta > 0)) return this._lean
        const ax = (v[0] - this._lastVelocity[0]) / delta, az = (v[2] - this._lastVelocity[1]) / delta
        this._lastVelocity = [v[0], v[2]]
        // The body's left is (forward.z, 0, -forward.x): +X when it faces +Z.
        const sideways = ax * facing[2] - az * facing[0]
        // Forward: speeding up along the way the body faces. Never back: a stop has its own clip.
        const ahead = ax * facing[0] + az * facing[2]
        const forwardTarget = !this.isGrounded ? 0 : Math.max(0, Math.min(1, ahead / this.leanForwardAcceleration))
        this.leanForward += (forwardTarget - this.leanForward) * (1 - Math.exp(-this.leanForwardSpeed * delta))
        const target = this.runTurn !== 0 || !this.isGrounded ? 0 : Math.max(-1, Math.min(1, sideways / this.leanAcceleration)) * run
        const lean = this._lean + (target - this._lean) * (1 - Math.exp(-this.leanSpeed * delta))
        this.leanLeft = Math.max(0, lean)
        this.leanRight = Math.max(0, -lean)
        return lean
    }

    /**
     * ALS's look-at: the head (and the trunk under it) toward where the camera faces, at full weight standing still
     * and faded out once the body moves, for the Look layer.
     */
    private _lookToward(delta: number, yaw: number, pitch: number) {
        this.lookYaw = Math.max(-90, Math.min(90, this._wrap(yaw)))
        this.lookPitch = Math.max(-45, Math.min(45, pitch - this.lookPitchRest))
        const still = !this.hasMoveInput && this.isGrounded && this.groundSpeed < 0.3
        if (delta > 0) this.lookWeight += ((still ? 1 : 0) - this.lookWeight) * (1 - Math.exp(-this.lookSpeed * delta))
    }

    /** An angle into -180..180 degrees. */
    private _wrap(degrees: number): number {
        return ((degrees + 180) % 360 + 360) % 360 - 180
    }
}
