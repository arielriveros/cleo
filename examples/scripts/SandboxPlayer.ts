import { CharacterNode, Input, MathUtils } from 'cleo'
import type { Animator, CameraRigNode, ColliderNode, ControllerNode, Node, TriggerName } from 'cleo'
import { attribute } from 'cleo/decorators'

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
 *   - the JUMP's facing: a jump taken off on the move faces the way it flies, not the camera (as on the stairs, and
 *     as ALS's in-air rotation), turning to its velocity through the flight; a standing jump keeps facing;
 *   - the LEAN: the sideways acceleration in the body's frame, as two layer weights (`leanLeft`, `leanRight`), and
 *     the forward one as a third (`leanForward`), weight into the step as it sets off and speeds up;
 *   - travel eased down when going backwards, to the speed the backward clips cover, so their feet do not slide;
 *   - `hasMoveInput`, `running`, `sprinting` and `moveAngle`, which the animator cannot measure (a Stop needs "the
 *     player let go", the start "a sprint, set off the way the body faces");
 *   - `groundSpeed`, the body's speed unsmoothed, for the blend space (the measured one lags a speeding body);
 *   - `footPlacement`, the foot IK weight while moving: full at a walk, light at a run (the solver plants the
 *     lower foot whenever it nears the ground, which a run's flight phase between strides must not do);
 *   - the LOOK-AT: where the camera faces off the body (`lookYaw`, `lookPitch`) and the Look layer's weight
 *     (`lookWeight`, up standing still), and the turn in place held back `turnDelay` seconds so the head turns first;
 *   - the CAR: a car hands it its seat (`boardVehicle`) and takes it back (`leaveVehicle`): it lets go of its own
 *     Controller, takes its body out of the physics world and rides in the seat, getting in and out by the animator's
 *     root motion (`enterTrigger`, `exitTrigger`), and takes its Controller back once on its feet (SandboxCar);
 *   - the STAIRS: whether the body is on a flight (`onStairs`, the ramp under it on `stairsLayer`) and which way it
 *     goes along it (`stairs`, +1 up, -1 down, from the climb under its travel), the flight's pace (one tread a
 *     step, slowing down BEFORE the first riser, seen ahead), facing where it goes on the flight, and `stairRate`,
 *     how much faster the stair clips play while the body still slows onto it.
 *
 * It names no clip, no state and no key, and plays no animation (a car is got into by firing a trigger by name).
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

    /** Taking off faster than this over the ground (m/s), a jump faces the way it flies; slower, as it stood. */
    @attribute('Jump', { min: 0, max: 5, step: 0.1 })
    private jumpTurnSpeed: number = 1

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

    /** The collision layer of the ramps laid over flights of stairs: what the capsule climbs, and how a flight is known. */
    @attribute('Stairs')
    public stairsLayer: string = 'Stair Ramp'

    /**
     * A flight's pace, horizontal m/s, walking and running, up and down: one tread a step at the stair clips'
     * rate (the build fits them to the clips and the course's treads). Faster, and the feet slide on the treads.
     */
    @attribute('Stairs', { min: 0.1, max: 5, step: 0.01 })
    public stairUpWalkSpeed: number = 0.55

    @attribute('Stairs', { min: 0.1, max: 5, step: 0.01 })
    public stairUpRunSpeed: number = 1.25

    @attribute('Stairs', { min: 0.1, max: 5, step: 0.01 })
    public stairDownWalkSpeed: number = 0.8

    @attribute('Stairs', { min: 0.1, max: 5, step: 0.01 })
    public stairDownRunSpeed: number = 1.88

    /** The climb along the travel (rise over run) that counts as going up or down a flight; it lets go at 60% of it. */
    @attribute('Stairs', { min: 0.05, max: 1, step: 0.01 })
    private stairGrade: number = 0.25

    /** Seconds a flight still counts after the ramp last showed under the body (it meets the ground at its foot). */
    @attribute('Stairs', { min: 0, max: 1, step: 0.01 })
    private stairGrace: number = 0.15

    /**
     * How much harder than its Acceleration the body brakes for a flight ahead: it starts slowing that much later,
     * and still reaches the flight's pace by its first step.
     */
    @attribute('Stairs', { min: 1, max: 4, step: 0.05 })
    private stairBrake: number = 1.5

    /** The animator's trigger that plays getting into a car, and the one that plays getting out of it. */
    @attribute('Car')
    public enterTrigger: TriggerName = 'EnterCar'

    @attribute('Car')
    public exitTrigger: TriggerName = 'ExitCar'

    /**
     * Seconds a metre the body takes to step onto where getting in starts, from where it stood when the player
     * pressed Interact (the clip reaches for the door meanwhile), and the most it may take.
     */
    @attribute('Car', { min: 0, max: 2, step: 0.05 })
    private alignSeconds: number = 0.35

    @attribute('Car', { min: 0, max: 2, step: 0.05 })
    private alignMaxSeconds: number = 0.6

    /** Seconds what is left of getting in (a few millimetres) eases out over once seated. */
    @attribute('Car', { min: 0, max: 2, step: 0.05 })
    private settleSeconds: number = 0.3

    // ----- read by the car (SandboxCar) -----------------------------------------------------------------------

    /** In a car: getting in, seated or getting out. */
    public inVehicle: boolean = false
    /** Seated: done getting in. The car may drive off. */
    public seated: boolean = false

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
    /** OnStairs: standing or moving on a flight of stairs (its ramp is under the body). */
    public onStairs: boolean = false
    /** Stairs: on a flight, the way along it: +1 up, -1 down, 0 across it or off it. */
    public stairs: number = 0
    /** StairRate: how much faster the stair clips play while the body is still faster than their pace. */
    public stairRate: number = 1

    private _directionScale: number = 1
    private _lean: number = 0
    private _lastVelocity: number[] = [0, 0]
    private _turnTime: number = 0
    private _wasSprinting: boolean = false
    private _afterSprint: boolean = false
    private _stopYaw: number = 0
    /** The heading the jump in flight faces (degrees); null a jump that keeps facing, undefined on the ground. */
    private _jumpYaw: number | null | undefined = undefined
    /** The Character's own Acceleration, as authored: what everything but a sprint take-off uses. */
    private _acceleration: number = -1
    /** The stairs' collision layer bit (`stairsLayer`), looked up once. */
    private _stairBit: number = -1
    /** The horizontal pace the stairs ask for this frame (`_stairsToward`), m/s. */
    private _stairPace: number = 0
    /** Seconds since the ramp of a flight was last under the body, and its normal then. */
    private _offStairs: number = Infinity
    private _stairNormal: number[] = [0, 1, 0]

    /** The car: what this character is doing in one, and what that needs. */
    private _carPhase: 'none' | 'entering' | 'seated' | 'exiting' = 'none'
    /** The seat it rides on, and its own Controller, given back once it is out. */
    private _seat: Node | null = null
    private _ownController: ControllerNode | null = null
    /** Stepping onto where getting in starts: the body's pose when it sat down to it, the step, and how far along. */
    private _alignFrom: MathUtils.YawPose = [0, 0, 0, 0]
    private _alignStep: MathUtils.YawPose = [0, 0, 0, 0]
    private _alignT: number = 1
    private _alignTime: number = 0
    /** Seconds since getting in started, and how long its clip plays. */
    private _carTime: number = 0
    private _enterSeconds: number = 0
    /** Getting out: whether the animator has been seen playing it. */
    private _exitSeen: boolean = false

    onUpdate(delta: number) {
        if (this._carPhase !== 'none') { this._ride(delta); return }
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
        // The way it goes over the ground: the stick's, or while it brakes with none, its travel's.
        const travel = this.hasMoveInput ? [Math.sin(inputYaw * Math.PI / 180), Math.cos(inputYaw * Math.PI / 180)]
            : this.groundSpeed > 0.3 ? [v[0] / this.groundSpeed, v[2] / this.groundSpeed] : null
        // The gait the stick asks for, as below: a run (a jog or a sprint) or a walk; the stairs brake to its pace.
        const runGait = (intent.sprint && amount > 0.9) || !(Input.pressed('Walk') || amount < this.walkDeflection)
        const pace = this._stairsToward(delta, travel, runGait)
        this._lean = this._leanToward(delta, facing, run)
        this._lookToward(delta, intent.aimYaw - bodyYaw, intent.aimPitch)
        // In a jump taken off on the move, the body faces the way it flies, whatever the stick and the camera do.
        const jumpFacing = this._jumpTurn(delta, v, bodyYaw)
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
            // Standing on a flight: no turning in place on the steps.
            this.facingMode = jumpFacing || this._afterSprint || this.onStairs ? 'none' : 'aim'
            return
        }

        // Sprint: in any direction, with the stick (nearly) all the way.
        const sprinting = intent.sprint && amount > 0.9
        intent.sprint = sprinting
        this.sprinting = sprinting
        // The take-off: speeding up into a sprint from a standstill, or along the way the body already goes (not
        // braking to reverse, which the running turn and the stop expect at the Character's own rate).
        const along = this.groundSpeed < 0.5 || Math.abs(this._wrap(inputYaw - Math.atan2(v[0], v[2]) * 180 / Math.PI)) < 60
        // Onto or on a flight, the Character's own: a sprint's gentle take-off would carry it up the steps too fast.
        // Slowing for one, `stairBrake` times harder, which is what lets the slowing start that late.
        this.acceleration = pace !== 0 && this.groundSpeed > this._stairPace + 0.05 ? this._acceleration * this.stairBrake
            : sprinting && along && pace === 0 && this.groundSpeed < this.runSpeed - 0.05 ? this.sprintTakeoff : this._acceleration

        // The running turn: a fast sprint asked to go back the way it came.
        if (sprinting && this.runTurn === 0 && this.planarSpeed > this.runTurnSpeed && Math.abs(this.moveAngle) > this.runTurnAngle) {
            this.runTurn = this.moveAngle > 0 ? -1 : 1
            this._turnTime = 0
        }
        if (this.runTurn !== 0) {
            this._turnTime += delta
            if (!sprinting || Math.abs(this.moveAngle) < this.runTurnRelease || this._turnTime > this.runTurnSeconds) this.runTurn = 0
        }
        // While the turn clip turns the body, nothing else may. On a flight it faces the way it goes: the stair
        // clips go forward only.
        this.facingMode = jumpFacing || this.runTurn !== 0 ? 'none' : sprinting || this.stairs !== 0 ? 'velocity' : 'aim'
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

        if (pace !== 0) {
            // A flight, or one ahead: its pace, walking or running as on the flat. The Character's speed runs along
            // the ground, the pace over it: sqrt(1 + grade^2) of it along a flight's slope (on the flat before one, 1).
            const up = pace > 0
            const flat = walking ? (up ? this.stairUpWalkSpeed : this.stairDownWalkSpeed) * (Input.pressed('Walk') ? 1 : Math.min(1, amount / this.walkDeflection))
                : up ? this.stairUpRunSpeed : this.stairDownRunSpeed
            const nominal = sprinting ? this.runSpeed : this.walkSpeed
            const slope = this.onStairs ? Math.hypot(1, this._grade(travel)) : 1
            intent.speedScale *= Math.min(1, flat * slope / Math.max(0.01, nominal))
            return
        }
        intent.speedScale *= scale * this._directionScale
    }

    /**
     * The jump's facing. Decided at take-off (`isJumping` comes up the frame after the jump launches, with its
     * velocity): faster than `jumpTurnSpeed` over the ground, the body turns toward its horizontal velocity at the
     * Character's turnSpeed until it lands, as `velocity` facing turns it on the stairs (holding the last heading
     * while the velocity is too slow to read, against a wall); slower, nothing turns it. True while it turns the
     * body itself, which the Character must then leave alone (`facingMode` 'none').
     */
    private _jumpTurn(delta: number, v: ArrayLike<number>, bodyYaw: number): boolean {
        if (!this.isJumping) { this._jumpYaw = undefined; return false }
        const speed = Math.hypot(v[0], v[2])
        if (this._jumpYaw === undefined) this._jumpYaw = speed > this.jumpTurnSpeed ? Math.atan2(v[0], v[2]) * 180 / Math.PI : null
        if (this._jumpYaw === null) return false
        if (speed > 0.3) this._jumpYaw = Math.atan2(v[0], v[2]) * 180 / Math.PI
        const diff = this._wrap(this._jumpYaw - bodyYaw)
        const step = Math.min(Math.abs(diff), this.turnSpeed * delta)
        if (step > 1e-4) this.setWorldYaw(bodyYaw + Math.sign(diff) * step)
        return true
    }

    /**
     * The stairs, every frame: whether a flight is under the body (`onStairs`), which way the travel goes along it
     * (`stairs`), how much faster the stair clips play while the body is still faster than their pace
     * (`stairRate`), and the pace to keep: +1 a flight going up (under the body or ahead of it, as close as braking
     * to the gait's pace at `stairBrake` takes), -1 down, 0 none.
     */
    private _stairsToward(delta: number, travel: number[] | null, run: boolean): number {
        const physics = this.scene?.physics as any
        if (this._stairBit < 0) this._stairBit = physics?.layer?.(this.stairsLayer) ?? 0
        const p = this.worldPosition
        // Straight down onto the stairs' ramps alone (their layer), `reach` above and below the feet, and only onto
        // the top of one: a ramp's end, where it meets a landing, leans the other way.
        const ramp = (x: number, z: number, y: number, reach: number) => {
            const hit = this._stairBit && physics ? physics.raycast([x, y + reach, z], [x, y - reach, z], { layerMask: this._stairBit }) : null
            return hit && hit.normal[1] >= 0.7 ? hit : null
        }
        const here = ramp(p[0], p[2], p[1], 0.6)
        if (here) { this._offStairs = 0; this._stairNormal = [here.normal[0], here.normal[1], here.normal[2]] }
        else this._offStairs += delta
        this.onStairs = this.isGrounded && this._offStairs <= this.stairGrace
        // Up or down it, by the climb under the travel: let go below 60% of the grade, not at once.
        if (!this.onStairs) this.stairs = 0
        else if (travel) {
            const grade = this._grade(travel)
            if (Math.abs(grade) >= this.stairGrade) this.stairs = Math.sign(grade)
            else if (Math.abs(grade) < this.stairGrade * 0.6) this.stairs = 0
        }
        // No travel on a flight: it keeps the way it went, so a stop there settles into Idle, not the walk.
        const fastest = this.stairs > 0 ? this.stairUpRunSpeed : this.stairDownRunSpeed
        this.stairRate = this.stairs !== 0 ? Math.max(1, this.groundSpeed / Math.max(0.01, fastest)) : 1
        // The gait's pace: up or down once known, else the slower of the two (up).
        const paceOf = (dir: number) => run ? (dir < 0 ? this.stairDownRunSpeed : dir > 0 ? this.stairUpRunSpeed : Math.min(this.stairUpRunSpeed, this.stairDownRunSpeed))
            : (dir < 0 ? this.stairDownWalkSpeed : dir > 0 ? this.stairUpWalkSpeed : Math.min(this.stairUpWalkSpeed, this.stairDownWalkSpeed))
        this._stairPace = paceOf(this.stairs)
        if (this.stairs !== 0) return this.stairs
        if (this.onStairs || !travel || !this.hasMoveInput) return 0
        // Ahead: as far as braking from this speed to the gait's pace takes at `stairBrake`, no further (at least
        // past the capsule's front).
        const brake = 2 * Math.max(0.5, this._acceleration * this.stairBrake)
        const reach = Math.max(0.3, (this.groundSpeed ** 2 - this._stairPace ** 2) / brake)
        // Tall enough to meet a ramp that far up (or down) a flight at its steepest.
        const ahead = ramp(p[0] + travel[0] * reach, p[2] + travel[1] * reach, p[1], 0.5 + reach)
        if (!ahead) return 0
        const n = ahead.normal
        const grade = -(travel[0] * n[0] + travel[1] * n[2]) / Math.max(1e-3, n[1])
        if (Math.abs(grade) < this.stairGrade) return 0
        this._stairPace = paceOf(Math.sign(grade))
        return Math.sign(grade)
    }

    /** The climb along `travel` (rise over run, + up) of the flight last under the body. */
    private _grade(travel: number[] | null): number {
        if (!travel) return 0
        const n = this._stairNormal
        return -(travel[0] * n[0] + travel[1] * n[2]) / Math.max(1e-3, n[1])
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

    // ----- the car ------------------------------------------------------------------------------------------------

    /** The Mannequin's animator (the model under this Character). */
    private get _animator(): Animator | null {
        for (const c of this.children) {
            const animator = (c as unknown as { animator?: Animator | null }).animator
            if (animator) return animator
        }
        return null
    }

    /** The camera rig this character is seen through: its Controller's aim. */
    public cameraRig(): CameraRigNode | null {
        return (this._ownController ?? this.controller)?.aimRig ?? null
    }

    /**
     * A car hands this character its seat: it gets in. It lets go of its Controller, takes its body out of the
     * physics world (`physicsEnabled`) and moves under `seat`, keeping where it stands; fires `enterTrigger`, and
     * steps onto `enterPoint` (a child of the seat: where getting in starts) while the clip reaches for the door.
     * The clip's root motion then carries it into the seat. False, and nothing done, when it cannot: in the air,
     * already in a car, or with an animator that has no such trigger.
     */
    public boardVehicle(seat: Node, enterPoint: Node): boolean {
        const body = this.collider as ColliderNode | null
        const animator = this._animator
        const info = animator?.triggerInfo(this.enterTrigger)
        if (this._carPhase !== 'none' || !body || !animator || !info || !this.isGrounded || this.isJumping) return false
        this._ownController = this.controller
        this._ownController?.release()
        body.physicsEnabled = false
        // Where the character faces is its own turn (the Character turns itself, not its Collider), and the step
        // and the clip's root motion turn the Collider: fold the one into the other first, so they turn all of it.
        const facing = this.worldForward
        const heading = Math.atan2(facing[0], facing[2]) * 180 / Math.PI
        body.setWorldYaw(heading)
        body.updateTransforms(body.parent ? body.parent.worldTransform : null)
        // The same heading in the world: no turn of its own left under the Collider.
        this.setWorldYaw(heading)
        this.updateTransforms(body.worldTransform)
        body.reparent(seat)
        this._seat = seat
        // The step: from where it stands to where the clip starts, both in the seat's frame, eased in over the
        // first part of the clip (time by distance).
        this._alignFrom = this._localPose(body)
        // Onto the start along the ground, at the height it stands at: the car may sit lower or higher on its springs
        // than modelled (the backends' springs differ), and once seated the body eases onto the Seat itself.
        const to: MathUtils.YawPose = this._localPose(enterPoint)
        to[1] = this._alignFrom[1]
        this._alignStep = MathUtils.yawPoseMul(MathUtils.yawPoseInvert(this._alignFrom), to)
        const distance = Math.hypot(this._alignStep[0], this._alignStep[2])
        this._alignTime = Math.min(this.alignMaxSeconds, this.alignSeconds * distance + 0.1)
        this._alignT = 0
        animator.setTrigger(this.enterTrigger)
        this._enterSeconds = info.clipLength / Math.max(0.01, info.speed)
        this._carTime = 0
        this._carPhase = 'entering'
        this.inVehicle = true
        this.seated = false
        return true
    }

    /** The car lets this character out: it gets out (`exitTrigger`), carried by the clip to the car's side. False when not seated. */
    public leaveVehicle(): boolean {
        const animator = this._animator
        if (this._carPhase !== 'seated' || !animator || !animator.triggerInfo(this.exitTrigger)) return false
        animator.setTrigger(this.exitTrigger)
        this._carPhase = 'exiting'
        this._exitSeen = false
        this.seated = false
        return true
    }

    /** In a car: no walking (no intent asked for), nothing for the animator but the car's clips. */
    private _ride(delta: number) {
        const body = this.collider as ColliderNode | null
        if (!body) return
        this.hasMoveInput = false
        this.running = false
        this.sprinting = false
        this.runTurn = 0
        this.groundSpeed = 0
        this.onStairs = false
        this.stairs = 0
        this.stairRate = 1
        this.footPlacement = 0
        this.facingMode = 'none'
        const ease = delta > 0 ? 1 - Math.exp(-this.lookSpeed * delta) : 0
        this.leanLeft = 0
        this.leanRight = 0
        this.leanForward = 0
        this.lookWeight -= this.lookWeight * ease
        this._carTime += delta

        if (this._carPhase === 'entering') {
            // The step onto the start, as a correction under the root motion that is already carrying the body:
            // pose = start * step(t) * motion, applied by how much further along the step is this frame.
            if (this._alignT < 1) {
                const t0 = MathUtils.smoothstep(0, 1, this._alignT)
                this._alignT = this._alignTime > 0 ? Math.min(1, this._alignT + delta / this._alignTime) : 1
                const t1 = MathUtils.smoothstep(0, 1, this._alignT)
                const none: MathUtils.YawPose = [0, 0, 0, 0]
                const from = MathUtils.yawPoseLerp(none, this._alignStep, t0)
                const to = MathUtils.yawPoseLerp(none, this._alignStep, t1)
                const start = this._alignFrom
                const shift = MathUtils.yawPoseMul(start, MathUtils.yawPoseMul(to, MathUtils.yawPoseMul(MathUtils.yawPoseInvert(from), MathUtils.yawPoseInvert(start))))
                this._setLocalPose(body, MathUtils.yawPoseMul(shift, this._localPose(body)))
            }
            if (this._carTime >= this._enterSeconds) { this._carPhase = 'seated'; this.seated = true }
            return
        }
        if (this._carPhase === 'seated') {
            // On the seat: what the clip's travel left over (a few millimetres) eased out.
            const k = this.settleSeconds > 0 && delta > 0 ? 1 - Math.exp(-3 * delta / this.settleSeconds) : 1
            const pose = this._localPose(body)
            if (Math.hypot(pose[0], pose[1], pose[2]) > 1e-4 || Math.abs(pose[3]) > 0.01)
                this._setLocalPose(body, MathUtils.yawPoseLerp(pose, [0, 0, 0, 0], k))
            return
        }
        // Getting out: done once the animator is back where it rests (it has left the trigger's states).
        const playing = this._animator?.activeTrigger() === this.exitTrigger
        if (playing) this._exitSeen = true
        else if (this._exitSeen) this._standUp(body)
    }

    /** Out of the car: on its feet in the world again, upright, its body back in the physics world, its Controller back. */
    private _standUp(body: ColliderNode) {
        const scene = this.scene
        if (!scene) return
        const f = body.worldForward
        const yaw = Math.atan2(f[0], f[2]) * 180 / Math.PI
        body.reparent(scene.root)
        body.setRotation([0, yaw, 0])
        // On the ground under it: the clip stands it at the Seat's floor, which is the car's (on its springs).
        const p = body.worldPosition, physics = scene.physics
        const ground = physics?.raycast([p[0], p[1] + 1, p[2]], [p[0], p[1] - 1.5, p[2]], { collidingWith: body.body, groundOnly: true })
        if (ground) body.setPosition([p[0], ground.point[1] + 0.02, p[2]])
        body.updateTransforms(null)
        body.physicsEnabled = true
        this._ownController?.possess(this)
        this._ownController = null
        this._seat = null
        this._carPhase = 'none'
        this.inVehicle = false
        this.seated = false
    }

    /** A node's upright pose in its parent's frame: `[x, y, z, yaw]`. */
    private _localPose(node: Node): MathUtils.YawPose {
        const p = node.position, q = node.quaternion
        // +Z turned by the rotation: its heading is the yaw.
        const fx = 2 * (q[0] * q[2] + q[3] * q[1]), fz = 1 - 2 * (q[0] * q[0] + q[1] * q[1])
        return [p[0], p[1], p[2], Math.atan2(fx, fz) * 180 / Math.PI]
    }

    /** Places `node` at an upright pose in its parent's frame, its world transform brought up to date at once. */
    private _setLocalPose(node: Node, pose: MathUtils.YawPose) {
        node.setPosition([pose[0], pose[1], pose[2]])
        node.setRotation([0, pose[3], 0])
        node.updateTransforms(node.parent ? node.parent.worldTransform : null)
    }
}
