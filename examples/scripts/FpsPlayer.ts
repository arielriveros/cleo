import { CameraRigNode, Game, Input, ModelNode, Node } from 'cleo'
import { onAction, attribute, netcall } from 'cleo/decorators'
import type { Animator } from 'cleo'
import FpsCombatantNode from '@/FPS/Scripts/FpsCombatant'
import { WEAPONS, aimDirection, approach, clamp, combatantOf, findByVariable, findDescendant, lerp, manager, playCue } from '@/FPS/Scripts/FpsShared'

/** One weapon's state in the player's hands. */
interface Slot { key: string, ammo: number, reserve: number, view: ModelNode | null, muzzle: Node | null }

/**
 * FPS example — the player. The Character at the root of the "FPS Player" template, with a first-person camera
 * rig, the weapons' viewmodels under the camera, and a HUD. The Controller (last child) moves and looks; this
 * script does everything else:
 *
 *   crouch    hold Crouch: slower, the eye drops, and the body is only `crouchHeight` tall to a bullet
 *   sprint    hold Sprint: run speed; not while aiming, firing, reloading or crouched
 *   aim       hold Aim: field of view narrows, the weapon comes to the centre (its own aim clips, or a
 *             shift of the viewmodel where it has none), spread tightens, move speed falls
 *   fire      Fire: hip fire or aimed; semi-automatic weapons shoot once a press, automatic ones while held
 *   reload    Reload, or an empty magazine; a shotgun loads in three clips (start, shells, end)
 *   switch    1 2 3 or the wheel: the equip clip plays and the old weapon goes
 *
 * The weapons' animation is played straight on each viewmodel's animator by name (Idle, IdleAim, Walk,
 * WalkAim, Run, Fire, AimFire, Reload, Equip...): this script is the state machine, so a weapon with a clip
 * missing just keeps its idle.
 *
 * A bullet is `fireHitscan` (FpsCombatant): from the camera, along the rig's yaw and pitch, with the
 * current spread. The view recoils: a kick that mostly recovers, and a little shake.
 *
 * ## Online
 *
 * Every player's character runs this script on the host and on every machine; only its own player's machine
 * (`this.net.isOwner`) reads input, draws the viewmodel, moves the camera and keeps the magazine. A shot is a
 * `@netcall` to the host (`shot`), which fires the bullet and deals the damage; whether the player aims, fires
 * or reloads (which change how fast it walks) goes to the host as `stance`, so both sides move the character
 * alike. The host calls back to the player's machine for what only it shows: `hitMarker`, `hurtFeedback`,
 * `respawned`, `teleported`. Crouching comes with the controller's own intent, on both sides.
 */
export default class FpsPlayerNode extends FpsCombatantNode {
  @attribute
  public displayName: string = 'Player'
  @attribute
  public team: string = 'blue'
  /** The weapons carried, in slot order (WEAPONS keys). */
  @attribute
  public loadout: string[] = ['ak47', 'pistol', 'shotgun']

  // ----- movement --------------------------------------------------------------------------------------
  @attribute('Movement')
  public crouchSpeedScale: number = 0.5
  /** Seconds the eye takes to drop or rise. */
  @attribute('Movement')
  public crouchSmoothing: number = 0.09
  @attribute('Movement')
  public eyeStand: number = 1.66
  @attribute('Movement')
  public eyeCrouch: number = 1.05

  // ----- the view --------------------------------------------------------------------------------------
  @attribute('View')
  public hipFov: number = 78
  @attribute('View')
  public sprintFovBoost: number = 5
  @attribute('View')
  public adsSeconds: number = 0.14
  /** Mouse sensitivity share while aimed (1: the same). */
  @attribute('View')
  public adsSensitivity: number = 0.55

  // ----- health ----------------------------------------------------------------------------------------
  @attribute('Health')
  public regenDelay: number = 5
  @attribute('Health')
  public regenPerSecond: number = 16

  // ----- runtime, read by the HUD ----------------------------------------------------------------------
  public ads: number = 0
  /** Metres the viewmodel group rises while aimed with an aim clip: the clip's sights sit below the crosshair, where the shots go. */
  @attribute('Aiming')
  public aimClipRaise: number = 0.028
  /** Depth of field while aiming: the aperture f-stop, the blur cap (px), the metres nearer than which nothing blurs, and the focus reach. */
  @attribute('Aiming')
  public dofAperture: number = 2.0
  @attribute('Aiming')
  public dofMaxBlur: number = 14
  @attribute('Aiming')
  public dofNearCutoff: number = 1.2
  @attribute('Aiming')
  public dofFarFocus: number = 60
  private _dofOn: boolean = false
  private _dofKey: string = ''
  private _dofFocus: number = 30
  public reloading: boolean = false
  public sprinting: boolean = false
  public spreadNow: number = 0
  public respawnIn: number = 0
  public weaponIndex: number = 0
  public hitMarkerAt: number = -999
  public hitMarkerHead: boolean = false
  public hitMarkerKill: boolean = false

  private _rig: CameraRigNode | null = null
  private _slots: Slot[] = []
  private _viewmodels: Node | null = null
  private _anim: Animator | null = null
  private _clip: string = ''
  private _busyUntil: number = 0
  private _fireUntil: number = 0
  private _nextShot: number = 0
  private _reloadToken: number = 0
  private _bloom: number = 0
  private _pending: number = 0
  private _eye: number = 1.66
  private _fov: number = 78
  private _lastHurt: number = -999
  private _baseYawSens: number = 0
  private _basePitchSens: number = 0
  private _vmBase: number[] = [0, 0, 0]
  // Online: what the player's machine last told the host (there), and what the host was told (here).
  private _sentStance: string = ''
  private _remoteAds: boolean = false
  private _remoteFiring: boolean = false
  private _remoteReloading: boolean = false
  private _hostNextShot: number = 0

  // =================================================================================================
  // Lifecycle
  // =================================================================================================

  onStart() {
    // Before the base class registers with the manager: a player who joins a match under way is dealt in as one.
    this.setVariable('isPlayer', true, 'boolean', 'public')
    super.onStart()
    this._rig = this._findRig()
    if (this._rig) {
      this._baseYawSens = this._rig.yawSensitivity
      this._basePitchSens = this._rig.pitchSensitivity
      this._eye = this.eyeStand
      this._fov = this.hipFov
    }
    this._viewmodels = this.getChildByName('Viewmodels')[0] ?? (this._rig?.camera ? findDescendant(this._rig.camera, 'Viewmodels') : null)
    const views = this._viewmodels ? findByVariable(this._viewmodels, 'fpsViewmodel') : []
    // Set here as well as in the template: whatever rebuilt a node from the library must not lose them.
    for (const v of views) { v.viewmodel = true; v.motionBlur = 'none' }
    this._slots = this.loadout.filter(k => WEAPONS[k]).map((key) => {
      const view = (views.find(v => v.getVariable('fpsViewmodel') === key) as ModelNode) ?? null
      return { key, ammo: WEAPONS[key].mag, reserve: WEAPONS[key].reserve, view, muzzle: view ? findDescendant(view, 'Muzzle') : null }
    })
    if (this._viewmodels) this._vmBase = Array.from(this._viewmodels.position as ArrayLike<number>)
    this.weaponIndex = 0
    this._select(0, false)
    this.hp = this.maxHp
  }

  private _findRig(): CameraRigNode | null {
    let rig: CameraRigNode | null = null
    const visit = (n: Node) => { for (const c of n.children) { if (!rig && c instanceof CameraRigNode) rig = c; else if (!rig) visit(c) } }
    visit(this)
    return rig
  }

  public get slot(): Slot { return this._slots[this.weaponIndex] }

  // =================================================================================================
  // The frame
  // =================================================================================================

  onUpdate(delta: number) {
    this._time += delta
    const intent = this.drive()
    if (!this._rig) return
    // This player's own machine (offline: always): input, the view, the weapon in hand.
    const local = this.net.isOwner
    if (this._viewmodels && this._viewmodels.visible !== local) this._viewmodels.visible = local
    if (this.isDead) {
      intent.move[0] = 0; intent.move[1] = 0; intent.speedScale = 0
      this.respawnIn = Math.max(0, this.respawnIn - delta)
      if (local) this._deadCamera(delta)
      return
    }
    const gm = manager(this)
    if (gm?.matchOver) { intent.move[0] = 0; intent.move[1] = 0; return }

    const spec = this.spec
    const moving = this.planarSpeed > 0.4
    // ----- stance: crouch is in the controller's intent (Crouch), so the host has it too
    const wantCrouch = !!intent.crouch
    this.isCrouching = wantCrouch
    // ----- aim and trigger: read here on the player's machine; the host has them from `stance`
    let wantAds: boolean, firing: boolean, reloading: boolean
    if (local) {
      wantAds = Input.pressed('Aim') && !this.reloading && this._time >= this._equipUntil()
      firing = Input.pressed('Fire') && this._nextShot - this._time > -0.4
      reloading = this.reloading
      const stance = (wantAds ? 'a' : '-') + (firing ? 'f' : '-') + (reloading ? 'r' : '-')
      if (this.net.isPeer && stance !== this._sentStance) { this._sentStance = stance; this.stance(wantAds, firing, reloading) }
    } else {
      wantAds = this._remoteAds; firing = this._remoteFiring; reloading = this._remoteReloading
    }
    this.ads = approach(this.ads, wantAds ? 1 : 0, 1 / Math.max(0.03, this.adsSeconds) * 3, delta)
    this.sprinting = intent.sprint && moving && !wantCrouch && !wantAds && !firing && !reloading
    intent.sprint = this.sprinting
    intent.speedScale = (wantCrouch ? this.crouchSpeedScale : 1) * lerp(1, spec.adsMove, this.ads)
    if (!local) {
      // The host for another machine's player: it walks as the player does there; health comes back here.
      if (this.net.isHost) this._regen(delta)
      return
    }

    // ----- the camera: eye height, field of view, sensitivity
    this._eye = approach(this._eye, wantCrouch ? this.eyeCrouch : this.eyeStand, 1 / Math.max(0.02, this.crouchSmoothing) * 2.2, delta)
    const offset = this._rig.followOffset as any
    if (offset) offset[1] = this._eye
    const fovGoal = lerp(this.hipFov + (this.sprinting ? this.sprintFovBoost : 0), spec.adsFov, this.ads)
    this._fov = approach(this._fov, fovGoal, 14, delta)
    this._rig.fov = this._fov
    const sens = lerp(1, this.adsSensitivity, this.ads)
    this._rig.yawSensitivity = this._baseYawSens * sens
    this._rig.pitchSensitivity = this._basePitchSens * sens

    // ----- weapons
    this._reloadInput()
    this._fireInput()
    this._recover(delta)
    this._viewmodelPose(delta, moving)
    this._viewmodelClearance(delta)
    this._viewmodelClip(moving)
    this._depthOfField(delta)

    // ----- spread (read by the HUD's crosshair)
    this.spreadNow = this._spread(moving)
    this._bloom = Math.max(0, this._bloom - 5 * delta)

    // ----- health (the host's to keep)
    if (this.net.isHost) this._regen(delta)
  }

  private _regen(delta: number): void {
    if (this._time - this._lastHurt > this.regenDelay && this.hp < this.maxHp) this.hp = Math.min(this.maxHp, this.hp + this.regenPerSecond * delta)
  }

  /** The player's machine says whether its player aims, fires and reloads: they change how it walks. */
  @netcall({ to: 'host' })
  public stance(aim: boolean, firing: boolean, reloading: boolean): void {
    this._remoteAds = !!aim
    this._remoteFiring = !!firing
    this._remoteReloading = !!reloading
  }

  /**
   * A shot, from the player's machine: the host fires the bullet (and deals the damage) from `origin` along `dir`
   * with `cone` degrees of spread, with `weapon`, against the world as the player saw it at host tick `seen` (lag
   * compensation: what it aimed at, where it was then). Refused when the player is dead, the weapon is not one it
   * carries, the muzzle is far from the player, or it comes faster than the weapon fires.
   */
  @netcall({ to: 'host' })
  public shot(origin: number[], dir: number[], cone: number, weapon: string, seen: number = 0): void {
    const spec = WEAPONS[weapon]
    if (this.isDead || !spec || !this.loadout.includes(weapon)) return
    if (!Array.isArray(origin) || !Array.isArray(dir) || origin.length < 3 || dir.length < 3) return
    const p = this.worldPosition
    if (Math.hypot(origin[0] - p[0], origin[1] - p[1], origin[2] - p[2]) > 3.5) return
    if (this.net.online && this._time < this._hostNextShot) return
    this._hostNextShot = this._time + 60 / spec.rpm * 0.75
    this.weapon = weapon
    this.net.rewound(seen, () => this.fireHitscan(origin, dir, clamp(cone, 0, 30), 1))
  }

  private _spread(moving: boolean): number {
    const spec = this.spec
    const base = lerp(spec.hipSpread, spec.adsSpread, this.ads)
    return base * (moving ? (this.sprinting ? 2.2 : 1.5) : 1) * (this.isCrouching ? 0.7 : 1) * (this.isGrounded ? 1 : 2.5) + this._bloom * (1 - this.ads * 0.6)
  }

  // =================================================================================================
  // Weapons
  // =================================================================================================

  /** Make slot `i` the weapon in hand; `play` runs its equip clip. */
  private _select(i: number, play: boolean = true): void {
    if (!this._slots.length) return
    const old = this.slot
    if (old) { old.ammo = this.ammo; old.reserve = this.reserve }
    this._reloadToken++
    this.reloading = false
    this.weaponIndex = ((i % this._slots.length) + this._slots.length) % this._slots.length
    const s = this.slot
    this.weapon = s.key
    for (const o of this._slots) if (o.view) o.view.visible = o === s
    this._anim = (s.view as any)?.animator ?? null
    this._clip = ''
    this.ammo = s.ammo
    this.reserve = s.reserve
    this._bloom = 0
    this._busyUntil = 0
    this._fireUntil = 0
    if (play) {
      const secs = this._playClip('Equip', false, s.view) ?? this.spec.equipSeconds
      this._busyUntil = this._time + Math.max(0.3, secs)
    }
  }

  private _equipUntil(): number { return this._busyUntil }

  @onAction('Slot1')
  private _slot1(): void { this._switchTo(0) }
  @onAction('Slot2')
  private _slot2(): void { this._switchTo(1) }
  @onAction('Slot3')
  private _slot3(): void { this._switchTo(2) }
  @onAction('NextWeapon')
  private _nextWeapon(): void { this._switchTo(this.weaponIndex + 1) }
  @onAction('PrevWeapon')
  private _prevWeapon(): void { this._switchTo(this.weaponIndex - 1) }

  private _switchTo(to: number): void {
    if (to < 0 || to >= 99) return
    to = ((to % this._slots.length) + this._slots.length) % this._slots.length
    if (to !== this.weaponIndex && this._slots[to]) this._select(to)
  }

  @onAction('Reload')
  private _onReload(): void { this._tryReload(true) }

  /** Reload on the press of Reload, or on a trigger pull with an empty magazine. */
  private _reloadInput(): void {
    this._tryReload(this.ammo <= 0 && Input.started('Fire'))
  }

  private _tryReload(want: boolean): void {
    const spec = this.spec
    if (this.reloading || this._time < this._busyUntil) return
    if (want && this.ammo < spec.mag && this.reserve > 0) this._reload()
  }

  private _reload(): void {
    const spec = this.spec
    const slot = this.slot
    const token = ++this._reloadToken
    this.reloading = true
    this._fireUntil = 0
    // The reload sound is the `reload` marker on the weapon's reload clip.
    const done = () => {
      if (token !== this._reloadToken) return
      const take = Math.min(spec.mag - this.ammo, this.reserve)
      this.ammo += take
      this.reserve -= take
    }
    const finish = () => { if (token === this._reloadToken) { this.reloading = false; this._clip = '' } }
    if (spec.key === 'shotgun') {
      const a = this._playClip('ReloadStart', false, slot.view) ?? 1
      this.after(a, () => {
        if (token !== this._reloadToken) return
        const b = this._playClip('Reload', false, slot.view) ?? 1.6
        this.after(b * 0.9, () => {
          if (token !== this._reloadToken) return
          done()
          const c = this._playClip('ReloadEnd', false, slot.view) ?? 0.9
          this._busyUntil = this._time + c
          this.after(c, finish)
        })
      })
    } else {
      const secs = this._playClip('Reload', false, slot.view) ?? spec.reloadSeconds
      this._busyUntil = this._time + secs
      this.after(secs * 0.82, done)
      this.after(secs, finish)
    }
  }

  private _fireInput(): void {
    const spec = this.spec
    if (this.reloading || this._time < this._busyUntil) return
    if (this.sprinting) return
    const trigger = spec.auto ? Input.pressed('Fire') : Input.started('Fire')
    if (!trigger || this._time < this._nextShot) return
    if (this.ammo <= 0) { this._nextShot = this._time + 0.25; playCue(this, 'Empty'); return }
    this._shoot()
  }

  private _shoot(): void {
    const spec = this.spec
    const rig = this._rig!
    const cam = rig.camera
    if (!cam) return
    this.ammo--
    this._nextShot = this._time + 60 / spec.rpm
    const p = cam.worldPosition
    const origin = [p[0], p[1], p[2]]
    const dir = aimDirection(rig.yaw, rig.pitch)
    const cone = this._spread(this.planarSpeed > 0.4)
    // The bullet is the host's (offline, this machine's): it judges what it hits, as this machine saw the world.
    this.shot(origin, [dir[0], dir[1], dir[2]], cone, this.weapon, this.net.viewTick)
    this._bloom = Math.min(spec.hipSpread * 1.6, this._bloom + spec.hipSpread * 0.12)

    // The view kicks up and a little aside; most of the pitch comes back (_recover).
    const kick = spec.recoilPitch * (this.isCrouching ? 0.75 : 1) * (1 - this.ads * 0.35)
    rig.pitch = rig.pitch - kick
    rig.yaw = rig.yaw + (Math.random() - 0.5) * 2 * spec.recoilYaw
    this._pending += kick * 0.7
    rig.shake(spec.key === 'shotgun' ? 0.18 : 0.04)

    // The shot clip; held for most of its length, shorter than the shot interval so the idle returns between.
    const clip = this.ads > 0.5 && spec.hasAimClips ? 'AimFire' : 'Fire'
    const secs = this._playClip(clip, false, this.slot.view, true) ?? 0.4
    this._fireUntil = this._time + Math.min(secs * 0.9, 60 / spec.rpm * 1.1 + 0.05)
    // The flash and the shot's sound are the weapon's `shot` marker on its Fire clip (Event Actions on its controller).
    if (spec.key === 'shotgun') this.after(0.35, () => { if (!this.reloading && !this.isDead) { const s = this.slot; this._playClip('Pump', false, s.view, true); this._fireUntil = this._time + 0.7 } })
  }

  protected muzzleWorld(origin: number[]): number[] {
    const m: any = this.slot?.muzzle
    const cam: any = this._rig?.camera
    if (!m?.worldPosition || !cam) return origin
    // The viewmodel is drawn through the camera's viewmodel lens and at a share of its true distance
    // (Node.viewmodel), so its muzzle is not where its node is: it is at the same point squeezed the way the
    // renderer squeezes it, about the camera and in its frame (x and y by lens x depth, z by depth).
    const w = m.worldPosition
    const t = cam.worldTransform
    const dx = w[0] - t[12], dy = w[1] - t[13], dz = w[2] - t[14]
    const x = t[0] * dx + t[1] * dy + t[2] * dz, y = t[4] * dx + t[5] * dy + t[6] * dz, z = t[8] * dx + t[9] * dy + t[10] * dz
    const k = this._vmDepth
    const f = Math.tan(this._fov * Math.PI / 360) / Math.tan(this.viewmodelFov * Math.PI / 360)
    const lx = x * f * k, ly = y * f * k, lz = z * k
    return [t[0] * lx + t[4] * ly + t[8] * lz + t[12], t[1] * lx + t[5] * ly + t[9] * lz + t[13], t[2] * lx + t[6] * ly + t[10] * lz + t[14]]
  }

  /** The lens the viewmodels are drawn at (the camera's `viewmodelFov`), degrees. */
  @attribute('Health')
  public viewmodelFov: number = 58
  /** How far in front of the camera the viewmodel reaches (its muzzle), metres: what a wall must leave room for. */
  @attribute('Health')
  public viewmodelReach: number = 0.95
  private _vmDepth: number = 1

  /**
   * Keep the weapon out of a wall: the share of its true distance the renderer draws the viewmodel at, from
   * the clearest of a few rays ahead. The weapon shrinks toward the camera along every view ray, so it stays
   * the same size on the screen and lies in front of the wall, lit as the place it is drawn at.
   */
  private _viewmodelClearance(delta: number): void {
    const cam: any = this._rig?.camera
    const physics: any = this.scene?.physics
    if (!cam || !physics) return
    cam.viewmodelFov = this.viewmodelFov
    const p = cam.worldPosition
    const t = cam.worldTransform
    // Camera-local +Z is forward, +X left, +Y up; a ray each for the centre and four points about it.
    const rays: number[][] = [[0, 0], [0.22, 0], [-0.22, 0], [0, 0.18], [0, -0.22]]
    let nearest = Infinity
    for (const [lx, ly] of rays) {
      const dir = [t[8] + t[0] * lx + t[4] * ly, t[9] + t[1] * lx + t[5] * ly, t[10] + t[2] * lx + t[6] * ly]
      const len = Math.hypot(dir[0], dir[1], dir[2])
      const reach = this.viewmodelReach + 0.1
      const hit = physics.raycast([p[0], p[1], p[2]], [p[0] + dir[0] / len * reach, p[1] + dir[1] / len * reach, p[2] + dir[2] / len * reach],
        { reject: (owner: Node | null) => combatantOf(owner) === this })
      if (hit) nearest = Math.min(nearest, hit.distance)
    }
    const want = nearest === Infinity ? 1 : clamp((nearest - 0.05) / this.viewmodelReach, 0.3, 1)
    // In fast (never through a wall), out a little slower.
    this._vmDepth = approach(this._vmDepth, want, want < this._vmDepth ? 40 : 9, delta)
    cam.viewmodelDepth = this._vmDepth
  }

  /**
   * Depth of field while aiming: the background softens and the focal plane sits where the crosshair points; the
   * weapon (nearer than `dofNearCutoff`) stays sharp. The pass costs nothing when it is off, so it is only
   * enabled while the aim amount is above zero, and settings are written only when they change.
   */
  private _depthOfField(delta: number): void {
    const cam: any = this._rig?.camera
    const physics: any = this.scene?.physics
    const a = this.ads
    if (a < 0.01) {
      if (this._dofOn) { Game.updateRenderSettings({ dofEnabled: false }); this._dofOn = false }
      return
    }
    let focus = this.dofFarFocus
    if (cam && physics) {
      const p = cam.worldPosition, t = cam.worldTransform
      const len = Math.hypot(t[8], t[9], t[10]) || 1
      const reach = this.dofFarFocus
      const hit = physics.raycast([p[0], p[1], p[2]], [p[0] + t[8] / len * reach, p[1] + t[9] / len * reach, p[2] + t[10] / len * reach],
        { reject: (owner: Node | null) => combatantOf(owner) === this })
      if (hit) focus = Math.max(1.5, hit.distance)
    }
    this._dofFocus = approach(this._dofFocus, focus, 8, delta)
    const q = Math.round(a * 20) / 20, f = Math.round(this._dofFocus * 10) / 10
    const key = q + ':' + f
    if (this._dofOn && key === this._dofKey) return
    this._dofOn = true
    this._dofKey = key
    Game.updateRenderSettings({
      dofEnabled: true, dofNearCutoff: this.dofNearCutoff, dofFocusDistance: f,
      dofFocusRange: lerp(12, 2, q), dofAperture: lerp(16, this.dofAperture, q), dofMaxBlur: lerp(0.5, this.dofMaxBlur, q),
    })
  }

  /** The view comes back down by a share of what the kick took, while no shot is firing. */
  private _recover(delta: number): void {
    if (this._pending <= 0.0005 || !this._rig) return
    const r = Math.min(this._pending, (this._pending * 6 + 0.4) * delta)
    this._rig.pitch = this._rig.pitch + r
    this._pending -= r
  }

  // =================================================================================================
  // The viewmodel
  // =================================================================================================

  /**
   * Fire the one-shot `name` on a viewmodel's animator (its Actions layer state of that name; a second fire while
   * it plays restarts it) and return how long it lasts in seconds, or undefined when the weapon has no such clip.
   * A weapon's graph is built by tools/fps/characters.mjs viewmodelMachine.
   */
  private _playClip(name: string, _loop: boolean, view: ModelNode | null, _restart: boolean = false): number | undefined {
    const anim: any = (view as any)?.animator
    const info = anim?.triggerInfo?.(name)
    if (!info) return undefined
    anim.setTrigger(name)
    this._clip = name
    return info.seconds > 0 ? info.seconds : info.clipLength
  }

  /** The base layer follows what the player is doing: Idle / IdleAim / Walk / WalkAim / Run, by three bools. */
  private _viewmodelClip(moving: boolean): void {
    const anim: any = (this.slot?.view as any)?.animator
    if (!anim) return
    anim.setBool('Moving', moving)
    anim.setBool('Sprinting', moving && this.sprinting)
    anim.setBool('Aim', this.ads > 0.4 && this.spec.hasAimClips)
  }

  /** A weapon with no aim clip comes to the centre by shifting the whole viewmodel group. */
  private _viewmodelPose(delta: number, moving: boolean): void {
    const g = this._viewmodels
    if (!g) return
    const spec = this.spec
    const shift = spec.hasAimClips ? [0, this.aimClipRaise, 0] : spec.adsOffset
    const t = this.ads
    g.setPosition([this._vmBase[0] + shift[0] * t, this._vmBase[1] + shift[1] * t, this._vmBase[2] + shift[2] * t])
  }

  // =================================================================================================
  // Hurt, dead, alive
  // =================================================================================================

  protected onHurt(damage: number, from: Node | null, zone: string): void {
    this._lastHurt = this._time
    const f = (from as any)?.worldPosition
    this.hurtFeedback(damage, f ? [f[0], f[1], f[2]] : null)
  }

  /** The host to the player's machine: a hit landed on it (the shake, the sound, the damage indicator). */
  @netcall({ to: 'owner' })
  public hurtFeedback(damage: number, from: number[] | null): void {
    if (from) { this.lastHitFrom = from; this.lastHitAt = this._time }
    this._rig?.shake(clamp(damage / 80, 0.05, 0.35))
    playCue(this, 'Hurt')
  }

  protected onDeath(killer: any, zone: string): void {
    this.respawnIn = manager(this)?.playerRespawnSeconds ?? 0
    if (this.net.isOwner) this._deathHere()
  }

  /** On the player's own machine online: the host has said it died. */
  protected onDeadSeen(dead: boolean): void {
    if (!dead || !this.net.isOwner) return
    this.respawnIn = manager(this)?.playerRespawnSeconds ?? 0
    this._deathHere()
  }

  /** What the player's machine shows of its death: no weapon, no aim, the sound. */
  private _deathHere(): void {
    for (const s of this._slots) if (s.view) s.view.visible = false
    this.ads = 0
    if (this._dofOn) { Game.updateRenderSettings({ dofEnabled: false }); this._dofOn = false }
    this.reloading = false
    this._reloadToken++
    playCue(this, 'Death')
  }

  private _deadCamera(delta: number): void {
    const rig = this._rig!
    this._eye = approach(this._eye, 0.35, 5, delta)
    const offset = rig.followOffset as any
    if (offset) offset[1] = this._eye
    rig.fov = approach(rig.fov, 62, 3, delta)
  }

  /** The manager has moved the body onto a spawn point and reset health: back on its feet. (Runs on the player's machine.) */
  @netcall({ to: 'owner' })
  public respawned(): void {
    this.isCrouching = false
    this._eye = this.eyeStand
    this._pending = 0
    for (const s of this._slots) { s.ammo = WEAPONS[s.key].mag; s.reserve = WEAPONS[s.key].reserve }
    this._select(this.weaponIndex % Math.max(1, this._slots.length))
    this._rig?.snapToTarget()
  }

  /** The manager placed this body facing `yaw`: the camera faces the same way. (Runs on the player's machine.) */
  @netcall({ to: 'owner' })
  public teleported(yaw: number): void {
    this._rig?.setOrbit(yaw, 0)
    this._rig?.snapToTarget()
  }

  /** A shot of ours landed: the HUD flashes its hit marker. (The host tells the player's machine.) */
  @netcall({ to: 'owner' })
  public hitMarker(zone: string, killed: boolean): void {
    this.hitMarkerAt = this._time
    this.hitMarkerHead = zone === 'head'
    this.hitMarkerKill = killed
    playCue(this, killed ? 'Kill' : 'Hit')
  }

  public resetForRespawn(): void {
    super.resetForRespawn()
    this._lastHurt = -999
  }
}
