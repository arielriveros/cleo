import { Game, Input, MathUtils, lerp } from 'cleo'
import type { ColliderNode, Node, UIPanelNode, UITextNode } from 'cleo'
import { animTrigger, attribute, child } from 'cleo/decorators'
import SandboxCharacterNode from '@/Characters/Base/Scripts/SandboxCharacter'

/**
 * The Sandbox player: a Sandbox Character (SandboxCharacter: its body, its animator, its weapons, the car, its
 * reactions) driven by input. Attach to the **Character** node of the Player template (a variant of Sandbox Character).
 *
 *   Player Collider     capsule, friction 0 (the root of the Player template)
 *   └─ Character        THIS script, on a Character node
 *      ├─ Camera Rig    SandboxCamera: over the shoulder, third person while sprinting, or first person
 *      │  └─ Camera
 *      │     └─ Viewmodels   the first-person arms and weapons (Firing Line's), one per weapon
 *      ├─ Mannequin     the animated model: its Animator decides every pose
 *      ├─ Weapons       the pistol, the rifle and the shotgun, each on its grip socket on the right hand (SandboxGun)
 *      ├─ Sounds        the shots
 *      ├─ HUD           its own screen canvas: the crosshair, the ammunition, the reload (every copy has its own)
 *      └─ Player Controller   crouch toggles on the Crouch action
 *
 * The Player Controller reads Move / Look / Jump / Sprint and writes the intent the base turns into the body. What is
 * the player's own:
 *
 *   - the WANTS the base asks for: Walk held walks, Aim held aims, Fire pulls the trigger, Reload reloads; the shot goes
 *     along the camera's aim;
 *   - the WEAPON WHEEL: Equip held (`wheelHoldSeconds`) opens it (the HUD's Weapon Wheel, SandboxWeaponWheel): the
 *     game slows, the camera stops turning, and the mouse or the right stick points at none, the pistol, the rifle or
 *     the shotgun; letting go of Equip takes out the one pointed at. A tap of Equip swaps back to the last weapon;
 *   - the CAMERA's part of a shot: each one kicks the camera up and a little aside, most of which comes back
 *     (`recoilRecovery`); in third person, Aim held also zooms the camera in and blurs everything but what the
 *     crosshair is on (`aimingDown`);
 *   - the HUD: its Crosshair shows where a shot goes, its ticks spread as the shot does; its Ammunition counts what is
 *     left; Reloading shows while it reloads;
 *   - FIRST PERSON: View toggles it (`firstPerson`): the camera folds in to the eyes (`eyeHeight`), the body is drawn
 *     into the shadows alone, the weapon in the hands is its viewmodel, and the mechanics are Firing Line's: aiming
 *     down the sights (`ads`, a narrower lens and a slower mouse, the background softened), the Fire, AimFire, Pump,
 *     Equip and Reload clips, the viewmodel kept out of walls; the body faces the camera, sprinting only ahead;
 *   - the CAR: it is the one character that drives (`canDrive`);
 *   - its REACTIONS, for trying them out: Trip (T) fires the animator's Trip trigger, whose Ragdoll state takes its feet
 *     from under it (the graph has the body until its Get Up state stands it up), Shove (G) pushes it back off balance.
 *     Shots do not move it (`reactsToShots` false): an enemy's rounds would take the game from the hands playing it.
 */
/** The weapons' viewmodels under the camera: 1 the pistol, 2 the rifle, 3 the shotgun. */
const WEAPON_VIEWMODELS = ['Pistol Viewmodel', 'AK-47 Viewmodel', 'SAPS-12 Viewmodel']

/** What the player asks of the HUD's Weapon Wheel (SandboxWeaponWheel). */
interface WeaponWheel {
    openWheel(current: number, slots: { name: string, ammo: string }[]): void
    closeWheel(): number
    steer(x: number, y: number, stick: boolean): void
}

export default class SandboxPlayerNode extends SandboxCharacterNode {
    /** The share of the camera's kick that comes back, and how fast (per second, of what is left). */
    @attribute('Weapons', { min: 0, max: 1, step: 0.05 })
    private recoilRecovery: number = 0.7

    @attribute('Weapons', { min: 0.5, max: 30, step: 0.5 })
    private recoilRecoverySpeed: number = 6

    /** Seconds Equip is held before the weapon wheel opens (real time); a shorter press swaps back to the last weapon. */
    @attribute('Weapons', { min: 0.05, max: 1, step: 0.01 })
    private wheelHoldSeconds: number = 0.2

    /** First person: the eye's height over the feet standing, and crouched (m). The character's own, so public. */
    @attribute('First Person', { min: 0.3, max: 2.5, step: 0.01 })
    public eyeStand: number = 1.62

    @attribute('First Person', { min: 0.3, max: 2.5, step: 0.01 })
    public eyeCrouch: number = 1.1

    /** Seconds the eye takes to drop for a crouch, and to come back up. */
    @attribute('First Person', { min: 0.01, max: 1, step: 0.01 })
    private crouchSmoothing: number = 0.09

    /** First person: the field of view from the hip, degrees, and how much wider at a sprint. */
    @attribute('First Person', { min: 30, max: 120, step: 1 })
    private hipFov: number = 78

    @attribute('First Person', { min: 0, max: 30, step: 1 })
    private sprintFovBoost: number = 5

    /** Seconds the aim down the sights takes, and the mouse's speed down them (a share of its speed from the hip). */
    @attribute('First Person', { min: 0.03, max: 1, step: 0.01 })
    private adsSeconds: number = 0.14

    @attribute('First Person', { min: 0.1, max: 1, step: 0.05 })
    private adsSensitivity: number = 0.55

    /** The lens the viewmodels are drawn at (degrees), and how far in front of the camera they reach (m: what a wall must leave room for). */
    @attribute('First Person', { min: 20, max: 120, step: 1 })
    private viewmodelFov: number = 58

    @attribute('First Person', { min: 0.2, max: 3, step: 0.05 })
    private viewmodelReach: number = 0.95

    /** Aimed with aim clips, how far the viewmodel comes up (m). */
    @attribute('First Person', { min: 0, max: 0.2, step: 0.001 })
    private aimClipRaise: number = 0.028

    /** Down the sights: the depth of field's aperture, its widest blur (px), what stays sharp near (m), its farthest focus (m). */
    @attribute('First Person', { min: 0.5, max: 32, step: 0.5 })
    private dofAperture: number = 2

    @attribute('First Person', { min: 0, max: 64, step: 1 })
    private dofMaxBlur: number = 14

    @attribute('First Person', { min: 0, max: 10, step: 0.1 })
    private dofNearCutoff: number = 1.2

    @attribute('First Person', { min: 5, max: 500, step: 5 })
    private dofFarFocus: number = 60

    /**
     * Aimed in third person (Aim held), a hard depth of field: its aperture (wide open), its widest blur (px), and how
     * deep the sharp band round what the crosshair is on (m).
     */
    @attribute('Third Person Aim', { min: 0.7, max: 16, step: 0.1 })
    private aimDofAperture: number = 1.2

    @attribute('Third Person Aim', { min: 0, max: 64, step: 1 })
    private aimDofMaxBlur: number = 32

    @attribute('Third Person Aim', { min: 0, max: 10, step: 0.1 })
    private aimDofRange: number = 1

    /** First person: a sprint goes only this far off straight ahead (degrees); past it, the body jogs. */
    @attribute('First Person', { min: 10, max: 180, step: 5 })
    private sprintAngle: number = 50

    // ----- the camera's (SandboxCamera reads these) -------------------------------------------------------------

    /** First person (View toggles it), the eye's height over the feet, and the field of view the camera takes there. */
    public firstPerson: boolean = false
    public eyeHeight: number = 1.62
    public viewFov: number = 78
    /** First person: how far down the sights the aim is, 0..1. */
    public ads: number = 0
    /**
     * Third person: Aim held (not a shot from the hip), which zooms the camera in (SandboxCamera's `aimFov`) and blurs
     * everything but what the crosshair is on.
     */
    public aimingDown: boolean = false
    private _views: any[] = []
    private _viewmodels: Node | null = null
    /** Where the Viewmodels group sits, before the aim brings it in. */
    private _vmBase: number[] = [0, 0, 0]
    /** The share of its true distance the viewmodel is drawn at (kept out of walls). */
    private _vmDepth: number = 1
    /** The viewmodels' animator bools as last sent. */
    private _viewParams: Record<string, boolean> = {}
    /** The weapon wheel (the HUD's, SandboxWeaponWheel): open while Equip is held past `wheelHoldSeconds`. */
    @child('HUD/Weapon Wheel')
    private _weaponWheel: (Node & WeaponWheel) | null = null
    public weaponWheelOpen: boolean = false
    /** Equip down (since its press), and for how long (real seconds). */
    private _equipDown: boolean = false
    private _equipHeldFor: number = 0
    /** The weapon a tap of Equip swaps back to. */
    private _lastWeaponPick: number = 1
    /** What `pickWeapon` last answered: `current` comes back otherwise only when the base put the weapon away (a car). */
    private _pickAnswered: number = 0
    /** The Controller the wheel took the camera's turning from, to give it back. */
    private _wheelController: any = null
    /** The rig's mouse speeds as authored: the aim down the sights slows them. */
    private _baseYawSens: number = -1
    private _basePitchSens: number = -1
    /** Depth of field down the sights: on, its last settings, its focus. */
    private _dofOn: boolean = false
    private _dofKey: string = ''
    private _dofFocus: number = 20
    /** The camera's kick still to come back, degrees. */
    private _recoilBack: number = 0
    /**
     * Its own HUD (the HUD canvas under it, not the scene's): the crosshair and its four ticks, the ammunition (the
     * magazine, the reserve, the weapon's name) and the reload. And the crosshair's gap as last laid out.
     */
    @child('HUD/Crosshair')
    private _crosshair: UIPanelNode | null = null
    @child('HUD/Crosshair Top')
    private _tickTop: UIPanelNode | null = null
    @child('HUD/Crosshair Bottom')
    private _tickBottom: UIPanelNode | null = null
    @child('HUD/Crosshair Left')
    private _tickLeft: UIPanelNode | null = null
    @child('HUD/Crosshair Right')
    private _tickRight: UIPanelNode | null = null
    @child('HUD/Ammunition')
    private _ammunition: UIPanelNode | null = null
    @child('HUD/Ammo')
    private _ammoText: UITextNode | null = null
    @child('HUD/Reserve')
    private _reserveText: UITextNode | null = null
    @child('HUD/Weapon Name')
    private _weaponName: UITextNode | null = null
    @child('HUD/Reloading')
    private _reloadingText: UITextNode | null = null
    private _gap: number = -1

    public get team(): string { return 'player' }
    public get canDrive(): boolean { return true }
    /** Shots do not knock the player about: it would take the game from the hands holding it. */
    public get reactsToShots(): boolean { return false }

    // ----- what it wants: its input ---------------------------------------------------------------------------

    protected wantsWalk(): boolean { return Input.pressed('Walk') }
    /** With the weapon wheel open the weapon in the hands rests: no aim, no shot, no reload. */
    protected wantsAim(): boolean { return !this.weaponWheelOpen && Input.pressed('Aim') }
    protected triggerHeld(): boolean { return !this.weaponWheelOpen && Input.pressed('Fire') }
    protected triggerStarted(): boolean { return !this.weaponWheelOpen && Input.started('Fire') }
    protected wantsReload(): boolean { return !this.weaponWheelOpen && Input.started('Reload') }

    /**
     * The weapon wheel: Equip held past `wheelHoldSeconds` opens it, Look points it while it is open, and letting go
     * takes out the weapon it points at. A tap (let go sooner) swaps back to the last weapon (none, at first, swaps
     * to the pistol). `current`: the weapon the hands go to now.
     */
    protected pickWeapon(delta: number, current: number): number {
        // Put away without a pick (in a car): a tap takes it back out.
        if (current !== this._pickAnswered) {
            if (this._pickAnswered !== 0) this._lastWeaponPick = this._pickAnswered
            this._pickAnswered = current
        }
        // Real time: the open wheel slows the game.
        const real = Game.unscaledDelta > 0 ? Game.unscaledDelta : delta
        if (Input.started('Equip')) { this._equipDown = true; this._equipHeldFor = 0 }
        if (this._equipDown && Input.pressed('Equip')) {
            this._equipHeldFor += real
            if (!this.weaponWheelOpen && this._equipHeldFor >= this.wheelHoldSeconds) this._openWeaponWheel(current)
            const wheel = this._weaponWheel
            if (this.weaponWheelOpen && wheel) {
                const look = Input.vector('Look')
                wheel.steer(look[0], look[1], Input.device('Look') === 'gamepadAxis')
            }
            return current
        }
        if (!this._equipDown) return current
        // Let go: the wheel's pick, or a tap's swap (with nothing to swap back to, none or the pistol).
        this._equipDown = false
        const fromWheel = this.weaponWheelOpen
        let next = fromWheel ? this._closeWeaponWheel() : this._lastWeaponPick
        if (!fromWheel && next === current) next = current === 0 ? 1 : 0
        if (next !== current) this._lastWeaponPick = current
        this._pickAnswered = next
        return next
    }

    /** The wheel opens on the weapon in the hands; the camera stops turning (Look points the wheel). */
    private _openWeaponWheel(current: number) {
        const wheel = this._weaponWheel
        if (!wheel) return
        const guns = this._weaponGuns()
        const slots = [{ name: 'Unarmed', ammo: 'Holster' }]
        for (const gun of guns) slots.push({ name: gun?.displayName ?? '', ammo: gun ? `${gun.ammo} / ${gun.reserve}` : '' })
        wheel.openWheel(current, slots)
        this.weaponWheelOpen = true
        const controller: any = this.controller
        if (controller && controller.driveAimTarget) { controller.driveAimTarget = false; this._wheelController = controller }
    }

    /** Close the wheel, giving the camera its turning back; returns the weapon it points at. */
    private _closeWeaponWheel(): number {
        this.weaponWheelOpen = false
        if (this._wheelController) { this._wheelController.driveAimTarget = true; this._wheelController = null }
        return this._weaponWheel ? this._weaponWheel.closeWheel() : this.weapon
    }

    /** The SandboxGun of each weapon (the pistol, the rifle, the shotgun), or null. */
    private _weaponGuns(): any[] {
        const weapons = this.getChildByName('Weapons')[0]
        return ['Pistol Grip', 'Rifle Grip', 'Shotgun Grip'].map(n => weapons?.getChildByName(n)[0] ?? null)
    }

    /** Out of the hands' reach (in a car, knocked down): the wheel closes, picking nothing. */
    onUpdate(delta: number) {
        super.onUpdate(delta)
        if (this.weaponWheelOpen && (this._carPhase !== 'none' || !Input.pressed('Equip'))) {
            this._closeWeaponWheel()
            this._equipDown = false
        }
    }

    protected firstPersonView(): boolean { return this.firstPerson }

    /** The view: first person or third (not in a car, where the car's camera has it). */
    protected beforeLocomotion(delta: number): void {
        if (Input.started('View')) this.firstPerson = !this.firstPerson
    }

    /** First person sprints only ahead. */
    protected sprintAllowed(fp: boolean): boolean { return !fp || Math.abs(this.moveAngle) <= this.sprintAngle }

    /** First person: the body faces the camera, always (its shadow is all that shows of it), and walks slower aimed. */
    protected faceFirstPerson(intent: any): void {
        this.facingMode = 'none'
        this.setWorldYaw(intent.aimYaw)
        const gun = this._gun
        if (gun && this.ads > 0) intent.speedScale *= lerp(1, gun.aimMove, this.ads)
    }

    /** The weapons, and their viewmodels under the camera. */
    protected resolveWeapons(): void {
        super.resolveWeapons()
        const rig = this.cameraRig()
        const camera = rig?.children.find(c => c.nodeType === 'camera') ?? null
        this._viewmodels = camera?.getChildByName('Viewmodels')[0] ?? null
        this._views = WEAPON_VIEWMODELS.map(n => this._viewmodels?.getChildByName(n)[0] ?? null)
        for (const v of this._views) if (v) { v.viewmodel = true; v.motionBlur = 'none' }
        if (this._viewmodels) this._vmBase = [this._viewmodels.position[0], this._viewmodels.position[1], this._viewmodels.position[2]]
    }

    /** A shot goes from the camera along its aim. */
    protected aimRay(eye: number[], look: number[]): boolean {
        const rig = this.cameraRig()
        const camera = rig?.children.find(c => c.nodeType === 'camera') ?? rig
        if (!rig || !camera) return false
        camera.updateTransforms(camera.parent ? camera.parent.worldTransform : null)
        const p = camera.worldPosition
        eye[0] = p[0]; eye[1] = p[1]; eye[2] = p[2]
        MathUtils.directionFromAim(look, rig.yaw, rig.pitch)
        return true
    }

    protected spreadAim(fp: boolean): number { return fp ? this.ads : this._aim }

    protected shotView(fp: boolean): any { return { firstPerson: fp, muzzle: fp ? this._muzzleDrawn() : null } }

    /** Down the sights in first person, Firing Line's way (exponential, about adsSeconds); Aim held in third person zooms in and blurs all but the target (not a shot from the hip). */
    protected afterAim(delta: number, fp: boolean): void {
        this.ads = MathUtils.damp(this.ads, this.aiming && fp ? 1 : 0, 3 / Math.max(0.03, this.adsSeconds), delta)
        this.aimingDown = this.aiming && !fp && Input.pressed('Aim')
    }

    protected afterWeapons(delta: number, fp: boolean): void {
        this._firstPersonToward(delta, fp)
        this._hudToward(fp)
    }

    /** In first person the viewmodel plays the shot (its Fire clip, or AimFire down the sights; the shotgun pumps after). */
    protected onFired(recoil: any, fp: boolean): void {
        const gun = this._gun
        if (!fp || !gun) return
        const clip = this.ads > 0.5 && gun.aimClips ? 'AimFire' : 'Fire'
        this._playClip(this._view, clip)
        if (gun.pellets > 1) {
            const token = this._reloadToken
            this.after(0.35, () => { if (token === this._reloadToken && !this.reloading) this._playClip(this._view, 'Pump') })
        }
    }

    /** The camera's kick coming back: a share of it, faster the more is left (Firing Line's). */
    protected afterFire(delta: number): void {
        const rig = this.cameraRig()
        if (rig && this._recoilBack > 5e-4 && delta > 0) {
            const back = Math.min(this._recoilBack, (this._recoilBack * this.recoilRecoverySpeed + 0.4) * delta)
            rig.pitch = rig.pitch + back
            this._recoilBack -= back
        }
    }

    /** A shot's recoil kicks the camera up and aside (less crouched and down the sights) and shakes it. */
    protected onRecoil(recoil: { pitch: number, yaw: number, kick: number, shake?: number }): void {
        const rig = this.cameraRig()
        if (!rig) return
        const pitch = recoil.pitch * (this.crouched ? 0.75 : 1) * (1 - this.ads * 0.35)
        rig.pitch = rig.pitch - pitch
        rig.yaw = rig.yaw + recoil.yaw
        if (recoil.shake) rig.shake(recoil.shake)
        this._recoilBack += pitch * this.recoilRecovery
    }

    /** Trip (T) knocks its feet from under it, Shove (G) pushes it back off balance: for trying the reactions out. */
    protected provoke(reactions: any): void {
        if (Input.started('Trip')) this._trip()
        else if (Input.started('Shove')) {
            const f = this.worldForward
            reactions.push([-f[0] * 1.3, 0.1, -f[2] * 1.3])
        }
    }

    /**
     * Trip: the animator's Ragdoll state, entered on its Trip trigger, takes the feet from under the character as it
     * is entered (its Starts), and keeps the body until the graph's Get Up state stands it up.
     */
    @animTrigger('Trip')
    private _trip() {}

    /** The viewmodel of the weapon in the hands, or null. */
    private get _view(): any {
        return this.weapon > 0 ? this._views[this.weapon - 1] ?? null : null
    }

    /** Seconds the weapon coming into the hands keeps them busy: its Equip clip in first person, the layer's fade in third. */
    protected _equipTime(fp: boolean): number {
        if (this.weapon === 0 || !fp) return super._equipTime(fp)
        const secs = this._playClip(this._view, 'Equip')
        return Math.max(0.3, secs ?? this._gun?.equipSeconds ?? 0.5)
    }

    /**
     * A reload, if one would fill anything and the weapon is up and not reloading already: in first person the
     * viewmodel's clips (the shotgun's three: into the reload, the shells, out of it), the magazine filled near their
     * end; in third person the Reload pose held for the gun's `reloadSeconds`.
     */
    protected _tryReload(fp: boolean) {
        if (!fp) return super._tryReload(fp)
        const gun = this._gun
        if (!gun || this.reloading || this._time < this._busyUntil || !gun.canReload) return
        const token = ++this._reloadToken
        this.reloading = true
        const view = fp ? this._view : null
        const fill = () => { if (token === this._reloadToken) gun.reload() }
        const finish = () => { if (token === this._reloadToken) { this.reloading = false } }
        const start = fp ? this._playClip(view, 'ReloadStart') : undefined
        if (start !== undefined) {
            this.after(start, () => {
                if (token !== this._reloadToken) return
                const shells = this._playClip(view, 'Reload') ?? 1.6
                this.after(shells * 0.9, () => {
                    if (token !== this._reloadToken) return
                    fill()
                    const end = this._playClip(view, 'ReloadEnd') ?? 0.9
                    this._busyUntil = this._time + end
                    this.after(end, finish)
                })
            })
            this._busyUntil = Infinity
            return
        }
        const secs = (fp ? this._playClip(view, 'Reload') : undefined) ?? gun.reloadSeconds
        this._busyUntil = this._time + secs
        this.after(secs * 0.82, fill)
        this.after(secs, finish)
    }

    /**
     * First person, every frame: the viewmodel of the weapon in the hands shown once the camera is in at the eyes, its
     * animator told what the body does (Moving, Sprinting, Aim), brought in to the sights as it aims, kept out of walls,
     * the lens narrowed and the mouse slowed down the sights, the background softened (depth of field).
     */
    private _firstPersonToward(delta: number, fp: boolean) {
        const rig = this.cameraRig() as any
        const mix = rig?.firstPersonMix ?? (fp ? 1 : 0)
        const shown = fp && mix > 0.8
        this._views.forEach((v, k) => { if (v && v.visible !== (shown && this.weapon === k + 1)) v.visible = shown && this.weapon === k + 1 })
        // The eye: standing or crouched, eased; the lens: Firing Line's, narrowing down the sights.
        this.eyeHeight = MathUtils.damp(this.eyeHeight, this.crouched ? this.eyeCrouch : this.eyeStand, 2.2 / Math.max(0.02, this.crouchSmoothing), delta)
        const gun = this._gun
        const fovGoal = this.hipFov + (this.sprinting ? this.sprintFovBoost : 0)
        this.viewFov = MathUtils.damp(this.viewFov, gun ? lerp(fovGoal, gun.aimFov, this.ads) : fovGoal, 14, delta)
        if (rig) {
            if (this._baseYawSens < 0) { this._baseYawSens = rig.yawSensitivity; this._basePitchSens = rig.pitchSensitivity }
            // Slower down the sights, and with the third person's zoom (the view turning as fast on the screen).
            const sens = lerp(1, this.adsSensitivity, this.ads) * (rig.zoomSensitivity ?? 1)
            rig.yawSensitivity = this._baseYawSens * sens
            rig.pitchSensitivity = this._basePitchSens * sens
        }
        if (!shown) { this._depthOfField(delta, 0, rig?.zoomMix ?? 0); return }
        const moving = this.planarSpeed > 0.4
        this._setViewParam('Moving', moving)
        this._setViewParam('Sprinting', moving && this.sprinting)
        this._setViewParam('Aim', this.ads > 0.4 && !!gun?.aimClips)
        // Aimed without aim clips, the whole viewmodel comes in to the sights; with them, a touch up.
        const g = this._viewmodels
        if (g && gun) {
            const shift = gun.aimClips ? [0, this.aimClipRaise, 0] : gun.aimOffset
            const t = this.ads
            g.setPosition([this._vmBase[0] + shift[0] * t, this._vmBase[1] + shift[1] * t, this._vmBase[2] + shift[2] * t])
        }
        this._viewmodelClearance(delta)
        this._depthOfField(delta, this.ads, 0)
    }

    /** A viewmodel animator's bool, sent down to the viewmodels when it changes. */
    private _setViewParam(name: string, value: boolean) {
        if (this._viewParams[name] === value) return
        this._viewParams[name] = value
        this._viewmodels?.dispatchDown('animator:SetParam', name, value)
    }

    /**
     * Fire the one-shot `name` on a viewmodel's animator (its Actions layer state of that name) and return how long
     * it lasts in seconds, or undefined when the weapon has no such clip.
     */
    private _playClip(view: any, name: string): number | undefined {
        const info = view?.animator?.triggerInfo?.(name)
        if (!view || !info) return undefined
        view.dispatchDown('animator:SetTrigger', name)
        return info.seconds > 0 ? info.seconds : info.clipLength
    }

    /**
     * Where the viewmodel's muzzle is DRAWN: the viewmodel is drawn through the camera's viewmodel lens and at a share
     * of its true distance, so its muzzle is not where its node is. The tracer starts there.
     */
    private _muzzleDrawn(): number[] | null {
        const muzzle = this._view?.getChildByName('Muzzle')[0]
        const camera: any = this.cameraRig()?.children.find(c => c.nodeType === 'camera')
        if (!muzzle || !camera) return null
        const w = muzzle.worldPosition, t = camera.worldTransform
        const dx = w[0] - t[12], dy = w[1] - t[13], dz = w[2] - t[14]
        const x = t[0] * dx + t[1] * dy + t[2] * dz, y = t[4] * dx + t[5] * dy + t[6] * dz, z = t[8] * dx + t[9] * dy + t[10] * dz
        const k = this._vmDepth
        const f = Math.tan(this.viewFov * Math.PI / 360) / Math.tan(this.viewmodelFov * Math.PI / 360)
        const lx = x * f * k, ly = y * f * k, lz = z * k
        return [t[0] * lx + t[4] * ly + t[8] * lz + t[12], t[1] * lx + t[5] * ly + t[9] * lz + t[13], t[2] * lx + t[6] * ly + t[10] * lz + t[14]]
    }

    /**
     * Keep the viewmodel out of a wall: the share of its true distance it is drawn at, from the clearest of a few rays
     * ahead of the camera. It shrinks toward the camera along every view ray, so it stays the same size on the screen.
     */
    private _viewmodelClearance(delta: number) {
        const camera: any = this.cameraRig()?.children.find(c => c.nodeType === 'camera')
        const physics: any = this.scene?.physics
        if (!camera || !physics) return
        camera.viewmodelFov = this.viewmodelFov
        const p = camera.worldPosition, t = camera.worldTransform
        const body = (this.collider as ColliderNode | null)?.body ?? null
        let nearest = Infinity
        // Camera-local +Z is forward, +X left, +Y up: a ray for the middle and four about it.
        for (const [lx, ly] of [[0, 0], [0.22, 0], [-0.22, 0], [0, 0.18], [0, -0.22]]) {
            const dir = [t[8] + t[0] * lx + t[4] * ly, t[9] + t[1] * lx + t[5] * ly, t[10] + t[2] * lx + t[6] * ly]
            const len = Math.hypot(dir[0], dir[1], dir[2])
            const reach = this.viewmodelReach + 0.1
            const hit = physics.raycast([p[0], p[1], p[2]], [p[0] + dir[0] / len * reach, p[1] + dir[1] / len * reach, p[2] + dir[2] / len * reach], { ignore: body })
            if (hit) nearest = Math.min(nearest, hit.distance)
        }
        const want = nearest === Infinity ? 1 : Math.max(0.3, Math.min(1, (nearest - 0.05) / this.viewmodelReach))
        // In fast (never through a wall), out a little slower.
        this._vmDepth = MathUtils.damp(this._vmDepth, want, want < this._vmDepth ? 40 : 9, delta)
        camera.viewmodelDepth = this._vmDepth
    }

    /**
     * Depth of field, focused where the crosshair points. Down the sights in first person (`amount`): the background
     * softens, the weapon (nearer than `dofNearCutoff`) stays sharp. Aimed in third person (`zoom`, the camera's zoom):
     * hard, only what the crosshair is on sharp, the character in front of it blurred too. Off the rest of the time, so
     * it costs nothing; written only on a change.
     */
    private _depthOfField(delta: number, amount: number, zoom: number) {
        const third = zoom > amount
        const level = Math.max(amount, zoom)
        if (level < 0.01) {
            if (this._dofOn) { Game.updateRenderSettings({ dofEnabled: false }); this._dofOn = false }
            return
        }
        const camera: any = this.cameraRig()?.children.find(c => c.nodeType === 'camera')
        const physics: any = this.scene?.physics
        let focus = this.dofFarFocus
        if (camera && physics) {
            const p = camera.worldPosition, t = camera.worldTransform
            const len = Math.hypot(t[8], t[9], t[10]) || 1
            const hit = physics.raycast([p[0], p[1], p[2]], [p[0] + t[8] / len * focus, p[1] + t[9] / len * focus, p[2] + t[10] / len * focus],
                { ignore: (this.collider as ColliderNode | null)?.body ?? null })
            if (hit) focus = Math.max(1.5, hit.distance)
        }
        this._dofFocus = MathUtils.damp(this._dofFocus, focus, 8, delta)
        const q = Math.round(level * 20) / 20, f = Math.round(this._dofFocus * 10) / 10
        const key = (third ? 'third:' : 'first:') + q + ':' + f
        if (this._dofOn && key === this._dofKey) return
        this._dofOn = true
        this._dofKey = key
        Game.updateRenderSettings(third ? {
            dofEnabled: true, dofNearCutoff: 0, dofFocusDistance: f,
            dofFocusRange: lerp(12, this.aimDofRange, q), dofAperture: lerp(16, this.aimDofAperture, q), dofMaxBlur: lerp(0.5, this.aimDofMaxBlur, q),
        } : {
            dofEnabled: true, dofNearCutoff: this.dofNearCutoff, dofFocusDistance: f,
            dofFocusRange: lerp(12, 2, q), dofAperture: lerp(16, this.dofAperture, q), dofMaxBlur: lerp(0.5, this.dofMaxBlur, q),
        })
    }

    /**
     * The HUD: the crosshair (shown with a weapon out, brighter aimed, its ticks as far out as the shot spreads; gone
     * down the sights in first person), the ammunition (the magazine, the reserve, the weapon's name) and the reload.
     */
    private _hudToward(fp: boolean) {
        const gun = this._gun
        const out = Math.max(this.pistolWeight, this.rifleWeight, this.shotgunWeight, fp && gun ? 1 : 0)
        const crosshair = this._crosshair
        if (crosshair) {
            const aimed = fp && this.ads > 0.6 && !!gun?.aimClips
            crosshair.opacity = aimed || (fp && this.sprinting) ? 0 : out * (fp ? 0.9 : 0.5 + 0.5 * this._aim)
            // Pixels from the middle: the spread's angle at the screen's scale (1080 px over the field of view).
            const fov = fp ? this.viewFov : ((this.cameraRig() as any)?.fov ?? 60)
            const perDegree = 540 / Math.tan(fov * Math.PI / 360) * Math.PI / 180
            const gap = Math.round(4 + this.spreadNow * perDegree)
            if (gap !== this._gap) {
                this._gap = gap
                const top = this._tickTop, bottom = this._tickBottom, left = this._tickLeft, right = this._tickRight
                if (top) { top.offsetMin = [-1, -gap - 7]; top.offsetMax = [1, -gap] }
                if (bottom) { bottom.offsetMin = [-1, gap]; bottom.offsetMax = [1, gap + 7] }
                if (left) { left.offsetMin = [-gap - 7, -1]; left.offsetMax = [-gap, 1] }
                if (right) { right.offsetMin = [gap, -1]; right.offsetMax = [gap + 7, 1] }
            }
        }
        const shown = !!gun && this._carPhase === 'none'
        const ammunition = this._ammunition
        if (ammunition && ammunition.visible !== shown) ammunition.visible = shown
        if (shown) {
            if (this._ammoText) this._ammoText.text = String(gun.ammo)
            if (this._reserveText) this._reserveText.text = `/ ${gun.reserve}`
            if (this._weaponName) this._weaponName.text = gun.displayName
        }
        const reloading = shown && this.reloading
        const reload = this._reloadingText
        if (reload && reload.visible !== reloading) reload.visible = reloading
    }
}
