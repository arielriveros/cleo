import { Input, Logger, Node } from 'cleo'
import type { TemplateName } from 'cleo'
import { clamp, forwardYaw, num } from '@/Core/Scripts/SoulsMath'
import { playSound, stopSound } from '@/Core/Scripts/SoulsAudio'

/**
 * Hollow Keep — the game manager. Attach to an empty node named `GameManager` at the scene root.
 *
 * The hub of the demo. The engine has no gameplay event bus, so every gameplay object finds this node
 * once in `onStart` and talks to it through plain method calls (shared PURE helpers live in the
 * SoulsMath module instead, which every script imports):
 *
 *   enemies        registerEnemy / unregisterEnemy        (SoulsEnemy)
 *   interactables  registerInteractable / unregister...   (bonfire, pickups, lever, signs, fog gate...)
 *   spawn points   registerSpawn                          (SoulsEnemySpawn)
 *
 * UI never gets called; it POLLS public fields here and on the player every frame.
 *
 * ## What it does NOT own
 *
 * Nobody's data. Each fighter owns its own: the player its attributes, HP, stamina, flasks and the curves
 * between them (SoulsPlayer); each enemy type its stats (SoulsHollow, SoulsEliteKnight…); each weapon its
 * numbers, hitbox, moveset and damage maths (SoulsWeapon and its subclasses). Damage goes from the weapon
 * straight to the target's `receiveHit` — it never passes through here. The manager is the WORLD: who is
 * registered, where you respawn, what happens when someone dies, and the shared sounds and effects.
 *
 * ## Game flow it owns
 *
 *   rest(bonfire)          heal, refill flasks, respawn the non-boss enemies, set the respawn point
 *   onPlayerDied()         drop a bloodstain, YOU DIED, then respawnAtBonfire()
 *   startBossFight(gate)   wake the boss, show its bar, start the music
 *   onBossDefeated(boss)   dissolve the fog, banner, reward
 *
 * ## Sounds and effects
 *
 * Every sound is OWNED: the Player's, an enemy's or a lever's cues are SoundNodes in a `Sounds` group of
 * its own template, played through SoulsAudio. The manager owns only the game-flow cues (Bonfire Lit,
 * Rest, Death, Victory and the music), in its own `Sounds` child. `fx('Hit Spark', p)` instantiates a
 * template at a point. Both are silent no-ops when the node or template is missing, so a level with no
 * audio assigned yet plays exactly the same — just quietly. See SOULS_DEMO.md for the list.
 */
export default class SoulsGameManagerNode extends Node {
  // ----- flow -------------------------------------------------------------------------------------
  /** Seconds between the killing blow and the YOU DIED banner. */
  public deathBannerDelay: number = 1.2
  /** Seconds between the killing blow and the respawn at the bonfire. */
  public respawnDelay: number = 5
  /** Template instantiated where the player died, carrying their souls. */
  public bloodstainTemplate: TemplateName = 'Bloodstain'

  // ----- blood (see bleed) -------------------------------------------------------------------------
  /** Off, no blood at all: no spray and no decals. */
  public bloodEnabled: boolean = true
  /** Droplets thrown off a wound (particles). */
  public bloodSprayTemplate: TemplateName = 'Blood Spray'
  /** The pool decal left under a wounded body. */
  public bloodSplatTemplate: TemplateName = 'Blood Splat'
  /** The spatter decal thrown along the blow. */
  public bloodDropsTemplate: TemplateName = 'Blood Drops'
  /** Blood decals alive at once. The oldest goes first, so a long fight cannot pile up draws. */
  public maxBloodDecals: number = 24
  /** Damage that leaves a full-size splat; less shrinks it, more grows it (0.6x to 1.6x). */
  public bloodReferenceDamage: number = 120
  /** Name of the reward pickup revealed once the boss falls. */
  public bossRewardName: string = 'Boss Reward'
  /** Name of the lore message revealed once the boss falls. */
  public bossEpilogueName: string = 'Epilogue Message'
  /** Log a one-off warning when the project's input map lacks the souls actions. */
  public checkInputMap: boolean = true

  // ----- runtime state (read by the HUD, which reads the boss's own name and health off `boss`) ----
  public bossActive: boolean = false
  public bossDefeated: boolean = false

  private _player: Node = null
  private _hud: Node = null
  private _banner: Node = null
  private _menu: Node = null
  private _lockOn: Node = null
  private _enemies: Node[] = []
  private _interactables: Node[] = []
  private _spawns: Node[] = []
  private _bonfires: Node[] = []
  private _restBonfire: Node = null
  private _respawnPoint: number[] = null
  private _respawnYaw: number = 0
  private _bloodstain: Node = null
  private _bloodDecals: Node[] = []
  private _boss: Node = null
  private _fogGate: Node = null
  private _dying: boolean = false

  onStart() {
    this._player = this.findNode('Player')
    // Every UI belongs to someone: the player's HUD and level-up menu are the PLAYER's children, the
    // world banners (YOU DIED, BONFIRE LIT, VICTORY) are this manager's own — the game flow it runs.
    this._hud = this._player?.getChildByName('HUD')[0] ?? null
    this._menu = this._player?.getChildByName('BonfireMenu')[0] ?? null
    this._banner = this.getChildByName('Banner')[0] ?? null
    if (this._player) {
      const p = this._player.worldPosition
      this._respawnPoint = [p[0], p[1], p[2]]
      const f = this._player.worldForward
      this._respawnYaw = Math.atan2(f[0], f[2]) * 180 / Math.PI
    }
    if (this.checkInputMap) this._checkInputMap()
  }

  // =================================================================================================
  // Registries
  // =================================================================================================

  public registerEnemy(enemy: Node): void { if (enemy && !this._enemies.includes(enemy)) this._enemies.push(enemy) }
  public unregisterEnemy(enemy: Node): void { this._enemies = this._enemies.filter(e => e !== enemy) }
  /** Every enemy that is spawned and not dead. */
  public liveEnemies(): Node[] { return this._enemies.filter(e => e && (e as any).spawned !== false && !(e as any).isDead) }

  public registerInteractable(node: Node): void {
    if (node && !this._interactables.includes(node)) this._interactables.push(node)
    if (node && (node as any).isBonfire && !this._bonfires.includes(node)) this._bonfires.push(node)
    if (node && (node as any).isFogGate) this._fogGate = node
  }
  public unregisterInteractable(node: Node): void { this._interactables = this._interactables.filter(n => n !== node) }
  public interactables(): Node[] { return this._interactables }

  public registerSpawn(spawn: Node): void { if (spawn && !this._spawns.includes(spawn)) this._spawns.push(spawn) }

  public get player(): Node { return this._player }
  public get boss(): Node { return this._boss }

  // =================================================================================================
  // Zones (the player's trigger overlaps, forwarded by SoulsPlayer)
  // =================================================================================================

  /** The player walked into a trigger zone. The boss arena's zone starts the fight. */
  public onPlayerEnteredZone(zone: Node): void {
    if (!zone || !(zone as any).getVariable?.('isBossArena')) return
    const player = this._player as any
    if (!this.bossActive && !this.bossDefeated && player && !player.isDead) this.startBossFight(this._fogGate)
  }

  /** The player left a trigger zone. Leaving a message's zone closes the message it opened. */
  public onPlayerLeftZone(zone: Node): void {
    const hud = this._hud as any
    hud?.closeMessageFrom?.(zone)
  }

  public awardSouls(amount: number): void {
    const player = this._player as any
    if (player?.addSouls) player.addSouls(amount)
  }

  /** An enemy reached 0 HP. Bosses route on to `onBossDefeated`. */
  public onEnemyKilled(enemy: Node): void {
    const e = enemy as any
    this.awardSouls(num(e.soulsReward, 0))
    this._lockOnNode()?.onTargetDied?.(enemy)
    if (e.isBoss) this.onBossDefeated(enemy)
  }

  // =================================================================================================
  // Bonfires, death and respawn
  // =================================================================================================

  public lightBonfire(bonfire: Node): void {
    this.showBanner('BONFIRE LIT', 'gold')
    this.sfx('Bonfire Lit')
    this._setRespawn(bonfire)
  }

  /**
   * Rest at a bonfire: the souls checkpoint. Heals and refills, respawns every enemy that is not a
   * defeated boss, makes this bonfire the respawn point, and opens the level-up menu.
   */
  public rest(bonfire: Node): void {
    const player = this._player as any
    if (!player) return
    this._setRespawn(bonfire)
    player.restoreAll?.()
    this.respawnEnemies(false)
    this._lockOnNode()?.unlock?.()
    this.sfx('Rest')
    ;(this._menu as any)?.open?.(this, player, bonfire)
  }

  /** Called by the menu when the player stands up again. */
  public leaveBonfire(): void {
    (this._player as any)?.standUp?.()
  }

  public onPlayerDied(player: Node): void {
    if (this._dying) return
    this._dying = true
    const p = player as any
    this._lockOnNode()?.unlock?.()

    // The souls go into the ground where you fell — at the last SAFE spot if you fell off the world.
    const at = p.lastSafePosition ?? player.worldPosition
    this.dropBloodstain(at, num(p.souls, 0))
    p.souls = 0

    this.after(this.deathBannerDelay, () => {
      this.showBanner('YOU DIED', 'red')
      this.sfx('Death')
    })
    this.after(this.respawnDelay, () => this.respawnAtBonfire())
  }

  /** A new stain replaces the old one, and the souls in the old one are gone for good. */
  public dropBloodstain(at: ArrayLike<number>, souls: number): void {
    if (this._bloodstain) {
      try { this._bloodstain.remove() } catch { /* already gone */ }
      this._bloodstain = null
    }
    if (souls <= 0) return
    const stain = this.scene?.instantiate(this.bloodstainTemplate, { position: [at[0], at[1], at[2]] })
    if (!stain) return
    ;(stain as any).souls = souls
    this._bloodstain = stain
  }

  /** The stain was touched. Clears our handle so a later death does not try to remove it. */
  public onBloodstainRecovered(stain: Node): void {
    if (this._bloodstain === stain) this._bloodstain = null
  }

  public get bloodstain(): Node { return this._bloodstain }

  public respawnAtBonfire(): void {
    const player = this._player as any
    this._dying = false
    if (!player) return
    this._resetBossFight()
    this.respawnEnemies(false)
    const at = this._respawnPoint ?? [0, 0, 0]
    player.respawnAt?.(at, this._respawnYaw)
    ;(this._banner as any)?.hideBanner?.()
  }

  /** Re-create every enemy from its spawn point. Bosses only when `includeBoss` — never a defeated one. */
  public respawnEnemies(includeBoss: boolean): void {
    for (const spawn of this._spawns) {
      const s = spawn as any
      if (s.isBossSpawn && (!includeBoss || this.bossDefeated)) continue
      s.respawnEnemy?.()
    }
  }

  private _setRespawn(bonfire: Node): void {
    if (!bonfire) return
    this._restBonfire = bonfire
    const b = bonfire as any
    const point: Node = b.respawnPoint?.() ?? bonfire
    const p = point.worldPosition
    this._respawnPoint = [p[0], p[1] + 0.1, p[2]]
    this._respawnYaw = forwardYaw(point)
  }

  // =================================================================================================
  // The boss
  // =================================================================================================

  /** The boss spawn calls this every time it creates a boss, so the manager always holds the live one. */
  public registerBoss(boss: Node): void {
    this._boss = boss
  }

  public startBossFight(gate: Node): void {
    if (this.bossActive || this.bossDefeated) return
    if (gate) this._fogGate = gate
    const boss = this._boss as any
    if (!boss || boss.isDead) return
    this.bossActive = true
    boss.awaken?.()
    this._music('Boss Music', true)
    this._music('Ambience', false)
  }

  public onBossDefeated(boss: Node): void {
    this.bossDefeated = true
    this.bossActive = false
    this._music('Boss Music', false)
    this._music('Ambience', true)
    ;(this._fogGate as any)?.dissolve?.()
    this.after(2.5, () => {
      this.showBanner('VICTORY ACHIEVED', 'gold')
      this.sfx('Victory')
    })
    for (const name of [this.bossRewardName, this.bossEpilogueName]) {
      const node = this.findNode(name) as any
      if (node?.reveal) node.reveal()
    }
  }

  /** The player died mid-fight: the boss goes back to sleep at full health and the fog lets you in again. */
  private _resetBossFight(): void {
    if (this.bossDefeated) return
    const wasActive = this.bossActive
    this.bossActive = false
    if (wasActive) {
      this._music('Boss Music', false)
      this._music('Ambience', true)
    }
    ;(this._fogGate as any)?.resetGate?.()
    this.respawnEnemies(true)
  }

  // =================================================================================================
  // Presentation helpers
  // =================================================================================================

  public showBanner(text: string, kind: string): void {
    const banner = this._banner as any
    if (banner?.showBanner) banner.showBanner(text, kind)
  }

  /** A short line under the HUD prompt: "Picked up Estus Shard", "Opens from the other side". */
  public notice(text: string): void {
    const hud = this._hud as any
    if (hud?.showNotice) hud.showNotice(text)
  }

  /** Show a readable message (title + body) until the player walks away or presses Interact again. */
  public showMessage(title: string, body: string, source: Node): void {
    const hud = this._hud as any
    if (hud?.showMessage) hud.showMessage(title, body, source)
  }

  /** Play one of the manager's own cues (its `Sounds` child). Silent when there is none. */
  public sfx(name: string): void {
    playSound(this, name)
  }

  /** Instantiate an effect template at a world point. Silent when the template does not exist. */
  public fx(template: string, at: ArrayLike<number>): Node {
    if (!template) return null
    return this.scene?.instantiate(template, { position: [at[0], at[1], at[2]] }) ?? null
  }

  /**
   * A hit drew blood: droplets fly off `target`, a pool lands under it and a spatter along the blow,
   * from `from` toward `target`. Called by SoulsCharacter.receiveHit when a hit lands. `amount` (the damage dealt) sizes the splat.
   */
  public bleed(target: Node, from: Node, amount: number): void {
    if (!this.bloodEnabled || !target || !(amount > 0)) return
    const at = target.worldPosition
    const src = from?.worldPosition
    let dx = src ? at[0] - src[0] : 0
    let dz = src ? at[2] - src[2] : 1
    const len = Math.hypot(dx, dz)
    if (len < 1e-4) { dx = 0; dz = 1 } else { dx /= len; dz /= len }
    const t = target as any
    const height = num(t.bodyHeight, 1.8)
    const scale = clamp(amount / Math.max(1, this.bloodReferenceDamage), 0.6, 1.6)

    this.fx(this.bloodSprayTemplate, [at[0], at[1] + height * 0.6, at[2]])
    // Spawned a little above the ground: each decal finds the floor itself (SoulsBloodSplat).
    this._splat(this.bloodSplatTemplate, [at[0], at[1] + 0.5, at[2]], NaN, scale)
    this._splat(this.bloodDropsTemplate, [at[0] + dx * 0.9 * scale, at[1] + 0.5, at[2] + dz * 0.9 * scale],
                Math.atan2(dx, dz) * 180 / Math.PI, scale)
  }

  /** The blood decals currently on the ground, oldest first. */
  public get bloodDecals(): readonly Node[] { return this._bloodDecals }

  private _splat(template: string, at: number[], yaw: number, scale: number): void {
    if (!template) return
    const splat = this.scene?.instantiate(template, { position: at }) as any
    if (!splat) return
    splat.yaw = yaw
    splat.sizeScale = scale
    // Splats remove themselves when they fade out; forget those, then retire the oldest past the cap.
    this._bloodDecals = this._bloodDecals.filter(d => !!d.scene)
    this._bloodDecals.push(splat)
    while (this._bloodDecals.length > Math.max(0, this.maxBloodDecals)) {
      const old = this._bloodDecals.shift()
      try { old.remove() } catch { /* already gone */ }
    }
  }

  /** Shake the player's camera. 0.2 is a hit, 0.6 a boss slam. */
  public shake(amount: number): void {
    const rig = this._lockOnNode() as any
    if (rig?.shake) rig.shake(amount)
  }

  private _music(name: string, on: boolean): void {
    if (on) playSound(this, name)
    else stopSound(this, name)
  }

  private _lockOnNode(): any {
    if (!this._lockOn && this._player) {
      this._lockOn = this._player.children.find(c => c.nodeType === 'cameraRig') ?? null
    }
    return this._lockOn
  }

  private _checkInputMap(): void {
    const map: any = (Input as any).map
    const names = new Set<string>()
    for (const m of map?.maps ?? []) for (const a of m.actions ?? []) names.add(a.name)
    const missing = ['LightAttack', 'HeavyAttack', 'Roll', 'LockOn', 'UseItem', 'SwapWeapon', 'Interact']
      .filter(n => !names.has(n))
    if (missing.length) {
      Logger.warn('Hollow Keep: the input map has no ' + missing.join(', ') + ' action(s). Import the '
        + 'example again, or add them in the Input panel — see SOULS_DEMO.md "Controls".', 'Script')
    }
  }
}
