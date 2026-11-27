import { CharacterNode, MathUtils } from 'cleo'
import type { Animator, CameraRigNode, ColliderNode, ControllerNode, LayerName, Node, TriggerName } from 'cleo'
import { animTrigger, attribute, eventListener, observable } from 'cleo/decorators'

/**
 * A Sandbox character's body: everything the Mannequin's animator is told, whoever drives it. The base of the player
 * (SandboxPlayer: its input, camera, first person and HUD) and of the NPCs (SandboxNpc: their brain), and the script
 * of the Sandbox Character template they are all variants of. Attach to the **Character** node ("Character").
 *
 *   Sandbox Character   capsule Collider, friction 0 (the root of the template)
 *   └─ Character        THIS script (or a subclass), on a Character node
 *      ├─ Mannequin     the animated model: its Animator decides every pose
 *      ├─ Weapons       the pistol, the rifle and the shotgun, each on its grip socket on the right hand (SandboxGun)
 *      └─ Sounds        the shots
 *
 * A Controller (the player's, or an AI one) writes this frame's intent; the Character turns it into velocity, facing,
 * the jump and the turn-in-place request; the Mannequin's Animator reads all of that by itself (Linked parameters,
 * read off this node). What is left for a script is what only the game knows, in the style of Advanced Locomotion
 * System v4. What the character WANTS beyond the intent (to walk, to aim, to pull the trigger, which weapon, where it
 * shoots from) are hooks a subclass answers (`wantsWalk`, `wantsAim`, `triggerHeld`, `pickWeapon`, `aimRay`...): the
 * player from its input and camera, an NPC from its brain. This class wants nothing: on its own it stands idle.
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
 *     (`lookWeight`, up standing still; crouched, the Look Head layer's `lookHeadWeight` instead: the head alone
 *     turns), and the turn in place held back `turnDelay` seconds so the head turns first;
 *   - the CAR: a car hands it its seat (`boardVehicle`) and takes it back (`leaveVehicle`): it lets go of its own
 *     Controller, takes its body out of the physics world and rides in the seat, getting in and out by the animator's
 *     root motion (`enterTrigger`, `exitTrigger`), and takes its Controller back once on its feet (SandboxCar);
 *   - the STAIRS: whether the body is on a flight (`onStairs`, the ramp under it on `stairsLayer`) and which way it
 *     goes along it (`stairs`, +1 up, -1 down, from the climb under its travel), the flight's pace (one tread a
 *     step, slowing down BEFORE the first riser, seen ahead), facing where it goes on the flight, and `stairRate`,
 *     how much faster the stair clips play while the body still slows onto it;
 *   - the WEAPONS: Equip (or the mouse wheel) cycles none, the pistol, the rifle, the shotgun: the one in the hands
 *     goes down and is put away, the next is shown and comes up (its layer's weight, `pistolWeight` / `rifleWeight` /
 *     `shotgunWeight`), and the body takes its STANCE as it does (`stance`: 0 unarmed, 1 the pistol pack's moves, 2
 *     the rifle pack's, which the shotgun shares); Aim held aims it (`aiming`, the aim layers' weights, where the
 *     aim goes off the body in `aimYaw` / `aimPitch`), facing the aim and strafing, turning in place sooner; not
 *     aimed, it is held at the low ready, the aim's own hold turned muzzle-down (`loweredWeight`, the Lowered layer),
 *     and a sprint carries it as the sprint clip does (the pistol one-handed: `supportHand`); in third person, Aim
 *     held also zooms the camera in and blurs everything but what the crosshair is on (`aimingDown`);
 *   - FIRING: the trigger of the weapon in the hands (its SandboxGun shoots by raycast along `aimRay`, a round off its
 *     magazine, and a character it hits reacts). Fired from the hip, the weapon comes up first and stays up
 *     `fireAimHold` seconds after the last shot, and the body takes the weapon's recoil (its gun's `fireTrigger`);
 *   - RELOADING: Reload, or a pull on an empty magazine, fills the magazine from the reserve (`reloading`: the weapon
 *     layer's Reload in third person, the viewmodel's reload clips in first person); out of the reserve, the weapon is
 *     dry;
 *   - CROUCHING: the Crouch action toggles it (the Controller's), the Character shortens its capsule (`crouched`, which
 *     the animator reads), and the eye drops in first person;
 *   - the REACTIONS: hit (unless shots do not move it: `reactsToShots`), shoved or run over (`struckByVehicle`, its
 *     reactions' `impact`), the body is its reactions' (physics/reactive/): it stumbles, staggers, falls and gets up,
 *     and nothing it is asked does anything meanwhile;
 *   - the TEAM (`team`): who it is to the others (the player, a civilian, an enemy), what an NPC's senses filter on.
 *
 * It names no clip, no state and no key, and plays no animation (a car is got into by firing a trigger by name).
 *
 * The attributes the CHARACTER decides are public (how fast its clips go backwards, where its foot placement eases
 * off, how long it takes to turn round to the camera), so every copy and variant can set its own; how the behaviour
 * feels (the stick, the lean, the running turn) is protected, set once here.
 */
/** The weapons' grip holders (their SandboxGun) on the hand: 1 the pistol, 2 the rifle, 3 the shotgun. */
const WEAPON_GRIPS = ['Pistol Grip', 'Rifle Grip', 'Shotgun Grip']
/** The body's stance with each weapon in the hands: the pistol's, then the rifle's for both long guns. */
const STANCES = [1, 2, 2]

export default class SandboxCharacterNode extends CharacterNode {
    /** Walk speed as a share of the jog (the Character's walkSpeed): the walk clips' speed over the jog's. */
    @attribute('Gait', { min: 0, max: 1, step: 0.01 })
    public walkScale: number = 0.38

    /** A stick pushed less than this walks; past it, it jogs. */
    @attribute('Gait', { min: 0, max: 1, step: 0.05 })
    protected walkDeflection: number = 0.6

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
    protected directionEase: number = 0.15

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
    protected runTurnAngle: number = 135

    /** The turn lets go once the body is this close to the way it is asked to go (degrees), or after `runTurnSeconds`. */
    @attribute('Running Turn', { min: 0, max: 90, step: 1 })
    protected runTurnRelease: number = 30

    @attribute('Running Turn', { min: 0.2, max: 3, step: 0.05 })
    protected runTurnSeconds: number = 1.2

    /** Taking off faster than this over the ground (m/s), a jump faces the way it flies; slower, as it stood. */
    @attribute('Jump', { min: 0, max: 5, step: 0.1 })
    protected jumpTurnSpeed: number = 1

    /** Sideways acceleration (m/s2) that leans the body all the way. */
    @attribute('Lean', { min: 0.5, max: 20, step: 0.5 })
    protected leanAcceleration: number = 4

    /** How fast the lean follows, per second (ALS's lean interpolation speed). */
    @attribute('Lean', { min: 0.5, max: 20, step: 0.5 })
    protected leanSpeed: number = 4

    /** Forward acceleration (m/s2) that leans the body forward all the way: setting off, speeding up. */
    @attribute('Lean', { min: 0.5, max: 30, step: 0.5 })
    protected leanForwardAcceleration: number = 8

    /** How fast the forward lean follows, per second: a start is over in half a second. */
    @attribute('Lean', { min: 0.5, max: 30, step: 0.5 })
    protected leanForwardSpeed: number = 8

    /** After a sprint, how far the camera must swing (degrees) before standing still turns to face it again. */
    @attribute('Turn In Place', { min: 0, max: 180, step: 1 })
    protected lookAroundAngle: number = 20

    /**
     * Seconds the camera must stay round past the turn threshold before the body turns in place to it: meanwhile
     * the head looks round (the Look layer). A character's own reaction time, so public.
     */
    @attribute('Turn In Place', { min: 0, max: 3, step: 0.05 })
    public turnDelay: number = 1

    /** The share of `turnDelay` waited before a turn to a camera swung right round behind (past 135 degrees). */
    @attribute('Turn In Place', { min: 0, max: 1, step: 0.05 })
    protected farTurnShare: number = 0.35

    /** How fast the look-at comes in standing still, and goes as the body moves off, per second. */
    @attribute('Look', { min: 0.5, max: 20, step: 0.5 })
    protected lookSpeed: number = 5

    /**
     * The camera pitch (degrees, down +) that is a level look: the rig's resting pitch, which looks a little down
     * at the character. Pitched further down the head looks down, pitched up it looks up.
     */
    @attribute('Look', { min: -45, max: 45, step: 1 })
    protected lookPitchRest: number = 12

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
    public stairsLayer: LayerName = 'Stair Ramp'

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
    protected stairGrade: number = 0.25

    /** Seconds a flight still counts after the ramp last showed under the body (it meets the ground at its foot). */
    @attribute('Stairs', { min: 0, max: 1, step: 0.01 })
    protected stairGrace: number = 0.15

    /**
     * How much harder than its Acceleration the body brakes for a flight ahead: it starts slowing that much later,
     * and still reaches the flight's pace by its first step.
     */
    @attribute('Stairs', { min: 1, max: 4, step: 0.05 })
    protected stairBrake: number = 1.5

    /** The animator's trigger that plays getting into a car, and the one that plays getting out of it. */
    @attribute('Car')
    public enterTrigger: TriggerName = 'EnterCar'

    @attribute('Car')
    public exitTrigger: TriggerName = 'ExitCar'

    /**
     * Seconds a metre the body takes to step onto where getting in starts, from where it stood when the player
     * pressed Interact (the clip reaches for the door meanwhile), and the most it may take.
     */
    /** Seconds a weapon takes to come up into the hands, and to go down out of them. */
    @attribute('Weapons', { min: 0.05, max: 2, step: 0.05 })
    protected equipSeconds: number = 0.3

    /** Seconds the aim takes to come up, and to go down. */
    @attribute('Weapons', { min: 0.02, max: 1, step: 0.01 })
    protected aimSeconds: number = 0.15

    /** Aiming and standing still, the camera turned further than this (degrees) turns the body in place to it, at once. */
    @attribute('Weapons', { min: 10, max: 120, step: 1 })
    protected aimTurnThreshold: number = 45

    /** Fired from the hip, the weapon stays up (aimed) this many seconds after the last shot. */
    @attribute('Weapons', { min: 0, max: 3, step: 0.05 })
    protected fireAimHold: number = 0.6

    /** How far up the weapon must be (its aim's weight) before a shot goes. */
    @attribute('Weapons', { min: 0, max: 1, step: 0.05 })
    protected fireAimReady: number = 0.7

    @attribute('Car', { min: 0, max: 2, step: 0.05 })
    protected alignSeconds: number = 0.35

    @attribute('Car', { min: 0, max: 2, step: 0.05 })
    protected alignMaxSeconds: number = 0.6

    /** Seconds what is left of getting in (a few millimetres) eases out over once seated. */
    @attribute('Car', { min: 0, max: 2, step: 0.05 })
    protected settleSeconds: number = 0.3

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
     * Look blend space's range. LookWeight: the Look layer's weight, up while standing still. LookHeadWeight: the Look
     * Head layer's, which takes over crouched: the head alone turns, not the trunk.
     */
    public lookYaw: number = 0
    public lookPitch: number = 0
    public lookWeight: number = 0
    public lookHeadWeight: number = 0
    /** OnStairs: standing or moving on a flight of stairs (its ramp is under the body). */
    public onStairs: boolean = false
    /** Stairs: on a flight, the way along it: +1 up, -1 down, 0 across it or off it. */
    public stairs: number = 0
    /** StairRate: how much faster the stair clips play while the body is still faster than their pace. */
    public stairRate: number = 1
    /**
     * The weapon in the hands: 0 none, 1 the pistol, 2 the rifle, 3 the shotgun (the one shown; Equip picks the next).
     * Setting it tells `weapon:Equipped` (the weapon and the one before), which shows the model in the hand.
     */
    @observable('weapon:Equipped')
    public weapon: number = 0
    /** PistolWeight, RifleWeight, ShotgunWeight: the weapon layers' weights, the one in the hands up, faded in and out. */
    public pistolWeight: number = 0
    public rifleWeight: number = 0
    public shotgunWeight: number = 0
    /**
     * Stance: how the body moves with what it holds, the animator's sets of moves: 0 unarmed, 1 the pistol, 2 a long gun
     * (the rifle and the shotgun). It changes once the weapon coming up is halfway in the hands.
     */
    public stance: number = 0
    /** Aiming: Aim held with a weapon in the hands, not sprinting. PistolAimWeight, RifleAimWeight, ShotgunAimWeight: the aim layers'. */
    public aiming: boolean = false
    public pistolAimWeight: number = 0
    public rifleAimWeight: number = 0
    public shotgunAimWeight: number = 0
    /**
     * LoweredWeight: the Lowered layer's weight: the weapon in the hands at the low ready (its aim's own hold turned
     * muzzle-down), all the way while it is not aimed, lifting as it aims.
     */
    public loweredWeight: number = 0
    /** SupportHand: the pistol's left hand on it (the Pistol layer's hand IK), let go over a sprint. */
    public supportHand: number = 1
    /** Reloading: the weapon in the hands is being reloaded (the Reload pose). */
    public reloading: boolean = false
    /** The spread of the weapon in the hands now, degrees (the crosshair's). */
    public spreadNow: number = 0
    /** AimYaw, AimPitch: where the camera aims, off the body (degrees; yaw + left, pitch + down), for the aim blend spaces. */
    public aimYaw: number = 0
    public aimPitch: number = 0

    protected _directionScale: number = 1
    protected _lean: number = 0
    protected _lastVelocity: number[] = [0, 0]
    protected _turnTime: number = 0
    protected _wasSprinting: boolean = false
    protected _afterSprint: boolean = false
    protected _stopYaw: number = 0
    /** The heading the jump in flight faces (degrees); null a jump that keeps facing, undefined on the ground. */
    protected _jumpYaw: number | null | undefined = undefined
    /** The Character's own Acceleration, as authored: what everything but a sprint take-off uses. */
    protected _acceleration: number = -1
    /** The stairs' collision layer bit (`stairsLayer`), looked up once. */
    protected _stairBit: number = -1
    /** The horizontal pace the stairs ask for this frame (`_stairsToward`), m/s. */
    protected _stairPace: number = 0
    /** Seconds since the ramp of a flight was last under the body, and its normal then. */
    protected _offStairs: number = Infinity
    protected _stairNormal: number[] = [0, 1, 0]

    /** The car: what this character is doing in one, and what that needs. */
    protected _carPhase: 'none' | 'entering' | 'seated' | 'exiting' = 'none'
    /** The seat it rides on, and its own Controller, given back once it is out. */
    protected _seat: Node | null = null
    protected _ownController: ControllerNode | null = null
    /** Stepping onto where getting in starts: the body's pose when it sat down to it, the step, and how far along. */
    protected _alignFrom: MathUtils.YawPose = [0, 0, 0, 0]
    protected _alignStep: MathUtils.YawPose = [0, 0, 0, 0]
    protected _alignT: number = 1
    protected _alignTime: number = 0
    /** Seconds since getting in started, and how long its clip plays. */
    protected _carTime: number = 0
    protected _enterSeconds: number = 0

    /** The weapon the hands go to next (Equip): 0 none, 1 the pistol, 2 the rifle, 3 the shotgun. */
    protected _weaponWanted: number = 0
    /** The aim's weight, before the weapon's own scales it. */
    protected _aim: number = 0
    /** The look-at's weight before the crouch splits it, and how far into the crouch's head-only look it is (0..1). */
    protected _lookAmount: number = 0
    protected _lookCrouch: number = 0
    /** The Character's turn threshold as authored: aiming turns in place sooner. */
    protected _turnThreshold: number = -1
    /** The weapons' nodes on the hand: the grip holders (their SandboxGun), and their viewmodels under the camera. */
    protected _weaponNodes: (Node | null)[] | null = null
    /** Seconds played, and until when the weapon in the hands is busy (coming up, reloading). */
    protected _time: number = 0
    protected _busyUntil: number = 0
    /** Bumped by a weapon change: a reload it cuts short leaves the magazine as it was. */
    protected _reloadToken: number = 0
    /** Seconds the weapon stays up for a shot from the hip. */
    protected _fireHold: number = 0
    protected readonly _look: number[] = [0, 0, 1]
    /** Where the shot is fired from (`aimRay`). */
    protected readonly _eye: number[] = [0, 0, 0]

    // ----- who it is -------------------------------------------------------------------------------------------

    /** Who this character is to the others: 'player', 'civilian', 'enemy' ('neutral' here). What NPCs' senses filter on. */
    public get team(): string { return 'neutral' }

    /** Whether a car lets it in (SandboxCar boards only a character that drives). */
    public get canDrive(): boolean { return false }

    /** Whether a gunshot moves it (SandboxGun asks): every character's does but the player's. */
    public get reactsToShots(): boolean { return true }

    /**
     * Hit by a vehicle closing on it at `speed` m/s, the vehicle going at `velocity`: its reactions' `impact`, the legs
     * taken out at the car's speed and the trunk thrown over the bonnet, bracing with its knees bent and its arms
     * round its head. False, and nothing done, when it has none, rides in a car or is down already.
     */
    public struckByVehicle(vehicle: Node, velocity: ArrayLike<number>, speed: number): boolean {
        const reactions = this.reactions
        if (!reactions || this._carPhase !== 'none' || reactions.isDown || !(speed > 0)) return false
        reactions.impact({ velocity: [velocity[0], 0, velocity[2]] })
        return true
    }

    // ----- what it wants (the hooks: the player answers from its input and camera, an NPC from its brain) --------

    /** Walk rather than jog. */
    protected wantsWalk(): boolean { return false }
    /** Aim the weapon in the hands. */
    protected wantsAim(): boolean { return false }
    /** The trigger held this frame, and pulled this frame. */
    protected triggerHeld(): boolean { return false }
    protected triggerStarted(): boolean { return false }
    /** Reload the weapon in the hands. */
    protected wantsReload(): boolean { return false }
    /** The weapon the hands go to next (`current` the one they are going to now): 0 none, 1 the pistol, 2 the rifle, 3 the shotgun. */
    protected pickWeapon(delta: number, current: number): number { return current }
    /** Seen from its own eyes (the player's first person). */
    protected firstPersonView(): boolean { return false }
    /** Before the frame's locomotion (the player's view toggle). */
    protected beforeLocomotion(delta: number): void {}
    /** Whether the way it moves now may be sprinted (the player's first person sprints only ahead). */
    protected sprintAllowed(fp: boolean): boolean { return true }
    /** In first person: how the body faces (the player's: the camera, always). */
    protected faceFirstPerson(intent: any): void {}
    /** The aim pitch that is a level look (degrees, down +): the player's camera rests pitched down at it. */
    protected lookRest(): number { return this.lookPitchRest }
    /** Find the weapons in the hands: the grips under Weapons (none: it carries none). */
    protected resolveWeapons(): void {
        const weapons = this.getChildByName('Weapons')[0]
        this._weaponNodes = WEAPON_GRIPS.map(n => weapons?.getChildByName(n)[0] ?? null)
    }
    /** Where a shot goes from and along: written into `eye` and `look` (unit); false, and no shot, without one. */
    protected aimRay(eye: number[], look: number[]): boolean { return false }
    /** How far up the aim is, for the gun's spread (the player's first person: down the sights). */
    protected spreadAim(fp: boolean): number { return this._aim }
    /** How SandboxGun draws the shot (`view`). */
    protected shotView(fp: boolean): any { return { firstPerson: false } }
    /** After the aim's weight (the player's sights and zoom). */
    protected afterAim(delta: number, fp: boolean): void {}
    /** After the weapons, every frame (the player's viewmodel and HUD). */
    protected afterWeapons(delta: number, fp: boolean): void {}
    /** A shot just went (the player's viewmodel clip). */
    protected onFired(recoil: any, fp: boolean): void {}
    /** After the trigger, every frame (the player's camera coming back from its kick). */
    protected afterFire(delta: number): void {}
    /** A shot's recoil (the player's camera kick); the body's is taken here. */
    protected onRecoil(recoil: any): void {}
    /** Set off a reaction of its own, standing (the player's Trip and Shove keys). */
    protected provoke(reactions: any): void {}

    onUpdate(delta: number) {
        if (this._carPhase !== 'none') { this._ride(delta); return }
        if (this._reacting(delta)) return
        if (this._acceleration < 0) this._acceleration = this.acceleration
        if (this._turnThreshold < 0) this._turnThreshold = this.turnThreshold
        const v = this.velocity
        this.groundSpeed = Math.hypot(v[0], v[2])
        const intent = this.drive()
        const [right, forward] = intent.move
        const amount = Math.min(1, Math.hypot(right, forward))
        this.hasMoveInput = amount > 0.1
        const run = Math.min(1, Math.max(0, (this.planarSpeed - this.walkFootSpeed) / Math.max(0.01, this.runFootSpeed - this.walkFootSpeed)))
        this.footPlacement = 1 + (this.runFootWeight - 1) * run

        // The view: first person or third (not in a car, where the car's camera has it).
        this.beforeLocomotion(delta)
        const fp = this.firstPersonView()

        const facing = this.worldForward
        const bodyYaw = Math.atan2(facing[0], facing[2]) * 180 / Math.PI
        // The input as a world heading (angles are counter-clockwise: right is negative), then off the body.
        const inputYaw = intent.basisYaw + Math.atan2(-right, forward) * 180 / Math.PI
        this.moveAngle = this.hasMoveInput ? this._wrap(inputYaw - bodyYaw) : 0
        // The way it goes over the ground: the stick's, or while it brakes with none, its travel's.
        const travel = this.hasMoveInput ? [Math.sin(inputYaw * Math.PI / 180), Math.cos(inputYaw * Math.PI / 180)]
            : this.groundSpeed > 0.3 ? [v[0] / this.groundSpeed, v[2] / this.groundSpeed] : null
        // The gait the stick asks for, as below: a run (a jog or a sprint) or a walk; the stairs brake to its pace.
        const runGait = (intent.sprint && amount > 0.9) || !(this.wantsWalk() || amount < this.walkDeflection)
        const pace = this._stairsToward(delta, travel, runGait)
        this._lean = this._leanToward(delta, facing, run)
        // The weapons: what is in the hands, and whether it aims (a sprint lowers it). No sprint crouched, reloading or
        // aiming down the sights; in first person, only ahead.
        const ahead = this.sprintAllowed(fp)
        const sprintAsked = intent.sprint && amount > 0.9 && this.hasMoveInput && !this.crouched && ahead
            && !(fp && (this.reloading || this.wantsAim()))
        this._weaponsToward(delta, false, sprintAsked, intent.aimYaw - bodyYaw, intent.aimPitch)
        this._lookToward(delta, intent.aimYaw - bodyYaw, intent.aimPitch)
        // In a jump taken off on the move, the body faces the way it flies, whatever the stick and the camera do.
        const jumpFacing = this._jumpTurn(delta, v, bodyYaw)
        // The turn in place waits for the head: it engages only once the camera has stayed round this long. Aiming,
        // it turns at once, and sooner.
        this.turnSettleSeconds = this.aiming ? 0.05 : this.turnDelay
        this.turnSettleFarSeconds = this.aiming ? 0.05 : this.turnDelay * this.farTurnShare
        this.turnThreshold = this.aiming ? this.aimTurnThreshold : this._turnThreshold

        // First person: the body faces the camera, always (its shadow is all that shows of it), and walks slower aimed.
        if (fp) this.faceFirstPerson(intent)

        if (!this.hasMoveInput) {
            this.acceleration = this._acceleration
            this.running = false
            this.sprinting = false
            this.runTurn = 0
            // Stopping out of a sprint: stay as stopped until the camera is swung, rather than turning to it at once
            // (or aiming).
            if (this._wasSprinting) { this._afterSprint = true; this._stopYaw = intent.aimYaw; this._wasSprinting = false }
            if (this._afterSprint && (this.aiming || Math.abs(this._wrap(intent.aimYaw - this._stopYaw)) > this.lookAroundAngle)) this._afterSprint = false
            // Standing on a flight: no turning in place on the steps.
            if (!fp) this.facingMode = jumpFacing || this._afterSprint || this.onStairs ? 'none' : 'aim'
            return
        }

        // Sprint: in any direction, with the stick (nearly) all the way (not crouched; in first person, only ahead).
        const sprinting = sprintAsked
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
        // clips go forward only. In first person it faces the camera (above).
        if (!fp) this.facingMode = jumpFacing || this.runTurn !== 0 ? 'none' : sprinting || this.stairs !== 0 ? 'velocity' : 'aim'
        else if (this.runTurn !== 0) this.runTurn = 0
        this._wasSprinting = sprinting
        this._afterSprint = false

        // Walk: the Walk action, or a stick pushed less than walkDeflection (scaled up to a full walk at it).
        let scale = 1
        const walking = !sprinting && (this.wantsWalk() || amount < this.walkDeflection)
        if (walking) scale = this.wantsWalk() ? this.walkScale : this.walkScale * Math.min(1, amount / this.walkDeflection) / amount
        this.running = !walking

        // Strafing backwards: full speed up to the side, the diagonal share at 135 degrees, the back share straight
        // back: the speeds the backward clips cover. A sprint faces where it goes, so it is always "forward".
        // Each stance's clips have their own: the rifle pack moves as fast every way, as does every crouch; the pistol
        // pack backs off at 0.7 (its diagonals are the rifle's legs, at 0.85).
        const angle = Math.abs(Math.atan2(right, forward) * 180 / Math.PI)
        const [backShare, diagonal] = this.crouched || this.stance === 2 ? [1, 1]
            : this.stance === 1 ? [0.7, 0.85]
            : [this.backScale, walking ? this.walkBackDiagonalScale : this.backDiagonalScale]
        const target = sprinting || angle <= 90 ? 1
            : angle <= 135 ? 1 + (diagonal - 1) * (angle - 90) / 45
            : diagonal + (backShare - diagonal) * (angle - 135) / 45
        const k = this.directionEase > 0 ? 1 - Math.exp(-delta / this.directionEase) : 1
        this._directionScale += (target - this._directionScale) * k

        if (pace !== 0) {
            // A flight, or one ahead: its pace, walking or running as on the flat. The Character's speed runs along
            // the ground, the pace over it: sqrt(1 + grade^2) of it along a flight's slope (on the flat before one, 1).
            const up = pace > 0
            const flat = walking ? (up ? this.stairUpWalkSpeed : this.stairDownWalkSpeed) * (this.wantsWalk() ? 1 : Math.min(1, amount / this.walkDeflection))
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
    protected _jumpTurn(delta: number, v: ArrayLike<number>, bodyYaw: number): boolean {
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
    protected _stairsToward(delta: number, travel: number[] | null, run: boolean): number {
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
    protected _grade(travel: number[] | null): number {
        if (!travel) return 0
        const n = this._stairNormal
        return -(travel[0] * n[0] + travel[1] * n[2]) / Math.max(1e-3, n[1])
    }

    /**
     * The lean: the body's sideways acceleration (its velocity's change, on the body's left axis), as a share of
     * `leanAcceleration`, faded in from a walk to a run and followed at `leanSpeed`. Positive leans left.
     */
    protected _leanToward(delta: number, facing: ArrayLike<number>, run: number): number {
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
    protected _lookToward(delta: number, yaw: number, pitch: number) {
        this.lookYaw = Math.max(-90, Math.min(90, this._wrap(yaw)))
        this.lookPitch = Math.max(-45, Math.min(45, pitch - this.lookRest()))
        // Aiming, the aim turns the head with the weapon.
        const still = !this.hasMoveInput && this.isGrounded && this.groundSpeed < 0.3 && !this.aiming
        if (delta > 0) {
            this._lookAmount += ((still ? 1 : 0) - this._lookAmount) * (1 - Math.exp(-this.lookSpeed * delta))
            // Crouched, the head alone turns (the Look Head layer); standing, the trunk under it too (Look).
            this._lookCrouch = Math.max(0, Math.min(1, this._lookCrouch + (this.crouched ? delta : -delta) / 0.25))
        }
        this._lookWeights()
    }

    /** The look-at's weight split between the trunk's look (Look) and the head's alone (Look Head, crouched). */
    protected _lookWeights() {
        const c = MathUtils.smoothstep(0, 1, this._lookCrouch)
        this.lookWeight = this._lookAmount * (1 - c)
        this.lookHeadWeight = this._lookAmount * c
    }

    /**
     * The weapons, every frame, in either view. Equip (or the mouse wheel) picks the next weapon (none, the pistol,
     * the rifle, the shotgun, round again): the one in the hands goes down and away, the next comes up (its layer's
     * weight in third person over `equipSeconds`; its viewmodel's Equip clip in first person) and fires once it is up.
     * Reload, or a pull on an empty magazine, reloads it (the Reload pose held in third person, the viewmodel's
     * reload clips in first person), filling the magazine from the reserve near the end. Aim held with one up aims it
     * (third person: the aim layers, facing the camera and strafing, turning in place sooner; first person: down the
     * sights, Firing Line's way), unless the body sprints, reloads or is told to put it away (`holster`: in a car).
     * `yaw` and `pitch`: where the camera aims, off the body.
     */
    protected _weaponsToward(delta: number, holster: boolean, sprinting: boolean, yaw: number, pitch: number) {
        if (!this._weaponNodes) {
            this.resolveWeapons()
            this._showWeapon(this.weapon)
        }
        this._time += delta
        const fp = this.firstPersonView() && !holster
        // Picking the next weapon (or the last, the wheel turned back).
        this._weaponWanted = holster ? 0 : this.pickWeapon(delta, this._weaponWanted)
        const gun = this._gun
        // A reload: asked for, or a pull with nothing in the magazine.
        if (!holster && gun && this.weapon === this._weaponWanted && (this.wantsReload() || (gun.ammo <= 0 && this.triggerStarted()))) this._tryReload(fp)
        // Fired from the hip in third person: up it comes, and stays up a moment after.
        const firing = !holster && !fp && this.weapon > 0 && this.weapon === this._weaponWanted && !sprinting && !this.reloading && this.triggerHeld()
        this._fireHold = firing ? this.fireAimHold : Math.max(0, this._fireHold - delta)
        const step = delta > 0 ? delta / Math.max(0.01, this.equipSeconds) : 0
        const weights = [this.pistolWeight, this.rifleWeight, this.shotgunWeight]
        if (this.weapon !== this._weaponWanted) {
            // Down out of the hands, then away; the next one shown, coming up.
            const k = this.weapon - 1
            if (k >= 0) weights[k] = Math.max(0, weights[k] - step)
            if (k < 0 || weights[k] < 0.35 || fp) {
                if (k >= 0) weights[k] = 0
                this._reloadToken++
                this.reloading = false
                this.weapon = this._weaponWanted   // weapon:Equipped shows it
                this._busyUntil = this._time + this._equipTime(fp)
            }
        } else if (this.weapon > 0) weights[this.weapon - 1] = Math.min(1, weights[this.weapon - 1] + step)
        ;[this.pistolWeight, this.rifleWeight, this.shotgunWeight] = weights
        // The stance follows the weapon more than halfway in the hands; with none, the body is unarmed. Between two
        // weapons it keeps the last one's, so a swap is one cross-fade, not two.
        const top = weights.indexOf(Math.max(...weights))
        if (weights[top] >= 0.5) this.stance = STANCES[top]
        else if (weights[top] < 0.05) this.stance = 0
        const up = this.weapon > 0 && this.weapon === this._weaponWanted && this._time >= this._busyUntil
        // Aiming: Aim held (or, in third person, a shot from the hip), the weapon up, not sprinting or reloading.
        this.aiming = !holster && up && !sprinting && !this.reloading && (this.wantsAim() || this._fireHold > 0)
        const aimStep = delta > 0 ? delta / Math.max(0.01, this.aimSeconds) : 0
        this._aim = Math.max(0, Math.min(1, this._aim + (this.aiming && !fp ? aimStep : -aimStep)))
        this.afterAim(delta, fp)
        this.pistolAimWeight = this._aim * this.pistolWeight
        this.rifleAimWeight = this._aim * this.rifleWeight
        this.shotgunAimWeight = this._aim * this.shotgunWeight
        // Not aimed, the weapon is held at the low ready: the aim's own hold, turned muzzle-down (the Lowered layer).
        this.loweredWeight = Math.max(...weights) * (1 - this._aim)
        // The pistol's left hand lets go over a sprint, as the arms go over to the sprint's (0.3 s, as their blend).
        const supportStep = delta > 0 ? delta / 0.3 : 0
        this.supportHand = Math.max(0, Math.min(1, this.supportHand + (this.sprinting && !this.aiming ? -supportStep : supportStep)))
        // Where the camera aims off the body: the aim layers' blend.
        this.aimYaw = Math.max(-90, Math.min(90, this._wrap(yaw)))
        this.aimPitch = Math.max(-60, Math.min(60, pitch))
        this._fire(delta, holster, sprinting, fp, up)
        this.afterWeapons(delta, fp)
    }

    /** The SandboxGun of the weapon in the hands, or null. */
    protected get _gun(): any {
        return this.weapon > 0 ? this._weaponNodes?.[this.weapon - 1] ?? null : null
    }

    /** Seconds the weapon coming into the hands keeps them busy: its layer's fade (the player's first person: its clip). */
    protected _equipTime(fp: boolean): number {
        if (this.weapon === 0) return 0
        return this.equipSeconds
    }

    /**
     * A reload, if one would fill anything and the weapon is up and not reloading already: the Reload pose held for
     * the gun's `reloadSeconds`, the magazine filled near its end (the player's first person: its viewmodel's clips).
     */
    protected _tryReload(fp: boolean) {
        const gun = this._gun
        if (!gun || this.reloading || this._time < this._busyUntil || !gun.canReload) return
        const token = ++this._reloadToken
        this.reloading = true
        const secs = gun.reloadSeconds
        this._busyUntil = this._time + secs
        this.after(secs * 0.82, () => { if (token === this._reloadToken) gun.reload() })
        this.after(secs, () => { if (token === this._reloadToken) this.reloading = false })
    }

    /**
     * The trigger: the weapon in the hands (its SandboxGun) fires along `aimRay` (the player's camera, an NPC's eye on
     * its target) once it is up, a round off its magazine a shot. Each shot comes back as `weapon:Shot`, whose recoil
     * the body takes (`_shot`).
     */
    protected _fire(delta: number, holster: boolean, sprinting: boolean, fp: boolean, up: boolean) {
        const gun = this._gun
        const moving = this.planarSpeed > 0.4
        this.spreadNow = gun ? gun.spread(this.spreadAim(fp), moving, this.sprinting, this.crouched, this.isGrounded) : 0
        if (gun?.pull && this.aimRay(this._eye, this._look)) {
            const weight = [this.pistolWeight, this.rifleWeight, this.shotgunWeight][this.weapon - 1] ?? 0
            const ready = !holster && !sprinting && up && !this.reloading && (fp || (weight >= 0.95 && this._aim >= this.fireAimReady))
            const recoil = gun.pull(!holster && this.triggerHeld(), ready, this._eye, this._look, this.spreadNow,
                this.ownBodies(), this.shotView(fp))
            if (recoil) this.onFired(recoil, fp)
        }
        this.afterFire(delta)
    }

    /**
     * What its own shots pass through: its capsule, and its limbs while its reactions hold them (a flinch keeps the
     * gun in hand, and a shot from behind its head would meet its own powered ragdoll).
     */
    public ownBodies(): unknown {
        const body = (this.collider as ColliderNode | null)?.body ?? null
        const parts = this.reactions?.ragdoll?.parts
        if (!parts?.length) return body
        const all: unknown[] = body ? [body] : []
        for (const p of parts) all.push(p.body)
        return all
    }

    /**
     * A shot from the weapon in the hands (SandboxGun's `weapon:Shot`, bubbling up from the grip): the body takes the
     * gun's recoil clip, and the player's camera its kick (`onRecoil`). A shot fired some other way carries no recoil.
     */
    @eventListener('weapon:Shot')
    protected _shot(shot: { recoil?: { pitch: number, yaw: number, kick: number, shake?: number } | null }) {
        const recoil = shot?.recoil
        if (!recoil) return
        this.onRecoil(recoil)
        this._bodyRecoil()
    }

    /** The body's recoil for the shot just fired: the gun's `fireTrigger`, sent down to the animator under this character. */
    @animTrigger()
    protected _bodyRecoil() {
        return this._gun?.fireTrigger ?? ''
    }

    /** The weapon in the hands changed (`weapon:Equipped`, from setting `weapon`): its model shown, the others hidden. */
    @eventListener('weapon:Equipped')
    protected _equipped(weapon: number) {
        this._showWeapon(weapon)
    }

    /** Show the weapon `weapon` (1 the pistol, 2 the rifle, 3 the shotgun) on the hand, and hide the others; 0 hides them all. */
    protected _showWeapon(weapon: number) {
        this._weaponNodes?.forEach((n, k) => { if (n) n.visible = weapon === k + 1 })
    }

    /** An angle into -180..180 degrees. */
    protected _wrap(degrees: number): number {
        return ((degrees + 180) % 360 + 360) % 360 - 180
    }

    // ----- the car ------------------------------------------------------------------------------------------------

    /** The Mannequin's animator (the model under this Character). */
    protected get _animator(): Animator | null {
        for (const c of this.children) {
            const animator = (c as unknown as { animator?: Animator | null }).animator
            if (animator) return animator
        }
        return null
    }

    /**
     * Thrown out of the car at speed (it was asked to stop going faster than its `bailSpeed`): out of the seat at
     * once and into the world, its body its reactions' from there, leaving with the car's `velocity` out through
     * `exitDirection`, clear of the car for a moment; it tumbles, comes to rest and gets up where it lies. Its own
     * Controller has it again (it ignores the stick until it is up). False, and nothing done, when it has no reactions
     * or is not seated.
     */
    public bailOut(velocity: ArrayLike<number>, exitDirection: ArrayLike<number>, vehicle: Node): boolean {
        const reactions = this.reactions
        const body = this.collider as ColliderNode | null
        const scene = this.scene
        if (this._carPhase !== 'seated' || !reactions || !body || !scene) return false
        // Out of the seat where it sits, upright; its body stays out of the world (the reaction has it now).
        const f = body.worldForward
        body.reparent(scene.root)
        body.setRotation([0, Math.atan2(f[0], f[2]) * 180 / Math.PI, 0])
        body.updateTransforms(null)
        this._ownController?.possess(this)
        this._ownController = null
        this._seat = null
        this._carPhase = 'none'
        this.inVehicle = false
        this.seated = false
        // Out of the seated clip: the body flies on whatever the animator stands it in.
        this._animator?.forceState('Idle', 0.2)
        reactions.bail({ velocity, exitDirection, vehicle })
        return true
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
     * already in a car, with an animator that has no such trigger, or a character that does not drive (`canDrive`).
     */
    public boardVehicle(seat: Node, enterPoint: Node): boolean {
        const body = this.collider as ColliderNode | null
        const animator = this._animator
        const info = animator?.triggerInfo(this.enterTrigger)
        if (!this.canDrive || this._carPhase !== 'none' || !body || !animator || !info || !this.isGrounded || this.isJumping) return false
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
        this._getIn()
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
        this._getOut()
        this._carPhase = 'exiting'
        this.seated = false
        return true
    }

    /** The animator's getting-in clip: `enterTrigger`, sent down to the animator under this character. */
    @animTrigger()
    protected _getIn() {
        return this.enterTrigger
    }

    /** The animator's getting-out clip: `exitTrigger`, the same way. */
    @animTrigger()
    protected _getOut() {
        return this.exitTrigger
    }

    /**
     * Getting out is over once the animator has left the exit trigger's states (back where it rests): it says so
     * with `animation:TriggerEnded`, bubbling up from the model, and the character stands up.
     */
    @eventListener('animation:TriggerEnded')
    protected _triggerEnded(info: { trigger?: string, layer?: string | null }) {
        if (this._carPhase !== 'exiting' || info?.trigger !== this.exitTrigger || info.layer) return
        const body = this.collider as ColliderNode | null
        if (body) this._standUp(body)
    }

    /** In a car: no walking (no intent asked for), nothing for the animator but the car's clips. */
    protected _ride(delta: number) {
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
        this._lookAmount -= this._lookAmount * ease
        this._lookWeights()
        // No weapon in a car: put away.
        this._weaponsToward(delta, true, false, 0, 0)
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
        // Getting out: the clip carries the body; `_triggerEnded` stands it up when the animator is done.
    }

    /** Out of the car: on its feet in the world again, upright, its body back in the physics world, its Controller back. */
    protected _standUp(body: ColliderNode) {
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

    // ----- reactions ------------------------------------------------------------------------------------------------

    /**
     * Its reactions (the skeleton's, physics/reactive/): what sets one off is a hit, a car, or the subclass's own
     * (`provoke`: the player's Trip and Shove keys). While a reaction has the body (it staggers, falls, lies, gets up) the body
     * is the physics', not the stick's: nothing it is asked does anything, and its weapon is put away. A flinch it
     * stands through keeps it in hand. True while it sits a reaction out.
     */
    protected _reacting(delta: number): boolean {
        const reactions = this.reactions
        if (!reactions) return false
        if (!reactions.reacting && this.isGrounded && !this.isJumping) this.provoke(reactions)
        if (!reactions.reacting || reactions.state === 'hitReact') return false
        this.hasMoveInput = false
        this.running = false
        this.sprinting = false
        this.runTurn = 0
        this.groundSpeed = 0
        this.facingMode = 'none'
        this._weaponsToward(delta, true, false, 0, 0)
        return true
    }

    /** A node's upright pose in its parent's frame: `[x, y, z, yaw]`. */
    protected _localPose(node: Node): MathUtils.YawPose {
        const p = node.position, q = node.quaternion
        // +Z turned by the rotation: its heading is the yaw.
        const fx = 2 * (q[0] * q[2] + q[3] * q[1]), fz = 1 - 2 * (q[0] * q[0] + q[1] * q[1])
        return [p[0], p[1], p[2], Math.atan2(fx, fz) * 180 / Math.PI]
    }

    /** Places `node` at an upright pose in its parent's frame, its world transform brought up to date at once. */
    protected _setLocalPose(node: Node, pose: MathUtils.YawPose) {
        node.setPosition([pose[0], pose[1], pose[2]])
        node.setRotation([0, pose[3], 0])
        node.updateTransforms(node.parent ? node.parent.worldTransform : null)
    }
}
