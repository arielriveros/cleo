import { Game, Logger, Node } from 'cleo'
import type { TemplateName } from 'cleo'
import { GAME_TYPES, distance3, fps, findByVariable, planarDistance } from '@/FPS/Scripts/FpsShared'

/**
 * FPS example — the match. Put ONE of these (the "FPS Game Manager" template) at the scene root and the
 * scene plays: it finds whatever combatants the scene holds, the player and any bot template instances,
 * deals them into teams by `gameType`, puts them on the spawn points, scores kills, respawns the dead and ends
 * the match at the score or time limit. Nothing here knows the scene's geometry; it only reads three things
 * a scene may hold, all of them optional:
 *
 *   Spawn Point (template)   where fighters start and come back. None: they stay where they are placed.
 *   Cover Point (template)   a spot a bot may duck behind. None: bots find cover themselves (see bestCover).
 *   a baked Nav Mesh         bots walk it; without one they walk straight lines.
 *
 * ## Game types (the `gameType` dropdown; GAME_TYPES in FpsShared)
 *
 *   ffa          everyone for themselves
 *   team2v2      two teams, split down the middle (the player and the first bot against the rest)
 *   oneVsThree   the player against everyone else (a scene with no player: the first fighter against the rest)
 *
 * ## For the other scripts
 *
 *   isHostile(a, b)         different teams (what a bot targets)
 *   canDamage(a, b)         hostile, or friendly fire is on
 *   makeNoise(pos, r, from) bots of other teams within `r` go and look
 *   callReinforcements(...) a team's idle bots within `reinforcementRadius` come to a point
 *   bestCover(...)          a spot out of a threat's sight, near a bot
 *   onKilled / onDamaged    the combatants report here
 *
 * It lives on its own node at the scene root, because its timers die with it.
 */
export default class FpsGameManagerNode extends Node {
  /** The game type: how the scene's fighters are dealt into teams (the dropdown lists GAME_TYPES in FpsShared). */
  public gameType: 'oneVsThree' | 'team2v2' | 'ffa' = 'oneVsThree'
  /**
   * Bot templates the manager spawns when the scene holds fewer fighters than the game type needs, cycling
   * through the list, at spawn points. A scene with enough bots of its own never uses it.
   */
  public botTemplates: TemplateName[] = ['FPS Bot', 'FPS Vanguard', 'FPS Raider', 'FPS Swat'] as TemplateName[]
  /** Team kills that win the match (0: none). */
  public scoreLimit: number = 20
  /** Minutes (0: none). */
  public timeLimit: number = 0
  public friendlyFire: boolean = false
  /** Seconds a fighter lies dead before it comes back. */
  public playerRespawnSeconds: number = 4
  public botRespawnSeconds: number = 6
  /** How long a bot's body stays before it fades. */
  public corpseSeconds: number = 9
  /** Seconds the match-over banner shows before the scene reloads. */
  public restartSeconds: number = 9
  /** Move every fighter onto a spawn point when the match starts (when the scene has spawn points). */
  public spawnAtStart: boolean = true
  /** Bullet holes kept in the world; older ones are removed. */
  public maxDecals: number = 90
  /** Bots of a team this close to a call for reinforcements answer it. */
  public reinforcementRadius: number = 55
  /** A spawn point this near a living enemy is passed over. */
  public spawnSafeDistance: number = 14

  // ----- runtime, read by the HUD ----------------------------------------------------------------------
  public matchOver: boolean = false
  public winner: string = ''
  public message: string = ''
  public timeLeft: number = 0
  public elapsed: number = 0

  private _fighters: Set<any> = new Set()
  private _scores: Map<string, number> = new Map()
  private _teamNames: Map<string, string> = new Map()
  private _decals: Node[] = []
  private _spawns: Node[] = []
  private _covers: Node[] = []
  private _started: boolean = false
  private _scan: number = 0
  private _feed: { text: string, until: number }[] = []
  private _usedSpawns: Set<Node> = new Set()
  private _snapshots: Map<any, any> = new Map()

  // =================================================================================================
  // Lifecycle
  // =================================================================================================

  onStart() {
    fps.gm = this
    this.setVariable('fpsManager', true, 'boolean', 'public')
    this.matchOver = false
    this.elapsed = 0
    this.timeLeft = this.timeLimit * 60
    // The fighters start on this same pass; deal them in just after.
    this.after(0.15, () => this._begin())
  }

  onDespawn() {
    if (fps.gm === this) fps.gm = null
  }

  onUpdate(delta: number) {
    this.elapsed += delta
    this._scan -= delta
    if (this._scan <= 0) { this._scan = 0.5; this._sweep() }
    this._feed = this._feed.filter(f => f.until > this.elapsed)
    if (this.matchOver || !this._started) return
    if (this.timeLimit > 0) {
      this.timeLeft = Math.max(0, this.timeLimit * 60 - this.elapsed)
      if (this.timeLeft <= 0) this._endMatch(this._leader())
    }
  }

  private _begin(): void {
    this._sweep()
    this._spawns = findByVariable(this.scene!.root, 'fpsSpawn')
    this._covers = findByVariable(this.scene!.root, 'fpsCover')
    // A scene with too few fighters for the game type gets bots from `botTemplates`; they register on their
    // first tick, so the teams are dealt just after.
    if (this._fillIn()) this.after(0.15, () => { this._sweep(); this._deal() })
    else this._deal()
  }

  /** Spawn bots until the scene holds the game type's minimum. Returns whether any were spawned. */
  private _fillIn(): boolean {
    const need = (GAME_TYPES[this.gameType] ?? GAME_TYPES.oneVsThree).minFighters - this._fighters.size
    const templates = (this.botTemplates ?? []).filter(Boolean)
    if (need <= 0 || !templates.length) return false
    const parent = this.scene!.root.getChildByName('Bots')[0] ?? undefined
    let made = 0
    for (let i = 0; i < need; i++) {
      const spawn = this._spawns.length ? this._spawns[(this._usedSpawns.size + i) % this._spawns.length] : null
      const at = spawn ? spawn.worldPosition : [i * 2, 0, 0]
      const bot = (this.scene as any).instantiate(templates[i % templates.length], { position: [at[0], at[1] + 0.05, at[2]], ...(parent ? { parent } : {}) })
      if (bot) made++
      else Logger.warn(`FPS: no "${templates[i % templates.length]}" template to fill the match with`, 'Script')
    }
    return made > 0
  }

  private _deal(): void {
    this._assignTeams()
    if (this.spawnAtStart && this._spawns.length) {
      for (const f of this._ordered()) this._place(f, this._pickSpawn(f))
    }
    this._started = true
    this._announce(`${this._modeName()} - ${this._fighters.size} fighters`)
  }

  /** Register every combatant the scene holds that has not reported in. */
  private _sweep(): void {
    for (const c of this.scene?.characters ?? []) if ((c as any).getVariable?.('fpsCombatant')) this.register(c)
    for (const f of [...this._fighters]) if (!f.scene || f.markForRemoval) this._fighters.delete(f)
  }

  // =================================================================================================
  // Combatants and teams
  // =================================================================================================

  public register(c: any): void {
    if (this._fighters.has(c)) return
    this._fighters.add(c)
    // One that arrives mid-match (a respawn) joins the team it was given, or the smaller one.
    if (this._started && !this._snapshots.has(c)) this._joinLate(c)
  }

  public unregister(c: any): void { this._fighters.delete(c) }

  public get fighters(): any[] { return [...this._fighters] }

  /** The player first, then the bots in scene order: the order teams are dealt in. */
  private _ordered(): any[] {
    return [...this._fighters].sort((a, b) => (b.getVariable?.('isPlayer') ? 1 : 0) - (a.getVariable?.('isPlayer') ? 1 : 0))
  }

  private _assignTeams(): void {
    const list = this._ordered()
    const n = list.length
    this._teamNames.clear()
    list.forEach((f, i) => {
      let team: string
      if (this.gameType === 'ffa') team = `solo-${i}`
      else if (this.gameType === 'oneVsThree') team = i === 0 ? 'blue' : 'red'
      else team = i < Math.ceil(n / 2) ? 'blue' : 'red'
      f.team = team
      this._scores.set(team, 0)
      this._teamNames.set(team, this.gameType === 'ffa' ? (f.displayName || `Fighter ${i + 1}`) : team === 'blue' ? 'Blue' : 'Red')
    })
  }

  private _joinLate(c: any): void {
    if (this.gameType === 'ffa') {
      const team = `solo-${this._scores.size}`
      c.team = team
      this._scores.set(team, 0)
      this._teamNames.set(team, c.displayName || 'Fighter')
      return
    }
    const counts = new Map<string, number>()
    for (const f of this._fighters) if (f !== c) counts.set(f.team, (counts.get(f.team) ?? 0) + 1)
    if (this.gameType === 'oneVsThree') c.team = 'red'
    else c.team = (counts.get('blue') ?? 0) <= (counts.get('red') ?? 0) ? 'blue' : 'red'
    if (!this._scores.has(c.team)) this._scores.set(c.team, 0)
  }

  public isHostile(a: any, b: any): boolean { return !!a && !!b && a !== b && a.team !== b.team }

  public canDamage(a: any, b: any): boolean {
    if (!a || !b || a === b) return false
    return a.team !== b.team || this.friendlyFire
  }

  public teamName(team: string): string { return this._teamNames.get(team) ?? team }

  public scoreOf(team: string): number { return this._scores.get(team) ?? 0 }

  /** [team, score] best first. */
  public standings(): { team: string, name: string, score: number }[] {
    return [...this._scores].map(([team, score]) => ({ team, name: this.teamName(team), score })).sort((a, b) => b.score - a.score)
  }

  private _modeName(): string {
    return (GAME_TYPES[this.gameType] ?? GAME_TYPES.oneVsThree).label
  }

  private _leader(): string {
    const s = this.standings()
    return s.length ? (s.length > 1 && s[0].score === s[1].score ? 'Draw' : s[0].name) : 'Draw'
  }

  // =================================================================================================
  // Kills, score, respawn
  // =================================================================================================

  public onDamaged(victim: any, attacker: any, damage: number, zone: string): void {
    attacker?.hitMarker?.(zone, victim.isDead)
  }

  public onKilled(victim: any, killer: any, zone: string): void {
    if (this.matchOver) return
    if (killer && killer !== victim && killer.team !== victim.team) {
      const total = this.scoreOf(killer.team) + 1
      this._scores.set(killer.team, total)
      this._feed.push({ text: `${killer.displayName} > ${victim.displayName}${zone === 'head' ? '  [headshot]' : ''}`, until: this.elapsed + 6 })
      if (this.scoreLimit > 0 && total >= this.scoreLimit) { this._endMatch(this.teamName(killer.team)); return }
    } else {
      // A kill by a teammate or by the world costs the victim's team a point.
      this._scores.set(victim.team, this.scoreOf(victim.team) - 1)
      this._feed.push({ text: `${victim.displayName} died`, until: this.elapsed + 6 })
    }
    const isPlayer = !!victim.getVariable?.('isPlayer')
    const delay = isPlayer ? this.playerRespawnSeconds : this.botRespawnSeconds
    if (isPlayer) victim.respawnIn = delay
    this._snapshots.set(victim, { team: victim.team, weapon: victim.weapon, displayName: victim.displayName, template: victim.respawnTemplate, skill: victim.skill })
    this.after(delay, () => this._respawn(victim))
  }

  private _respawn(victim: any): void {
    if (this.matchOver) return
    const spawn = this._pickSpawn(victim)
    if (victim.getVariable?.('isPlayer') || !victim.respawnTemplate) {
      // The player (and any fighter without a template) is reset in place.
      if (!victim.scene) return
      victim.resetForRespawn()
      this._place(victim, spawn)
      victim.respawned?.()
      return
    }
    const snap = this._snapshots.get(victim)
    this._snapshots.delete(victim)
    const at = spawn ? Array.from(spawn.worldPosition as ArrayLike<number>) : Array.from(victim.worldPosition as ArrayLike<number>)
    const node: any = this.scene?.instantiate(victim.respawnTemplate as string, {
      position: at, rotation: [0, spawn ? this._yawOf(spawn) : 0, 0],
    })
    if (!node) return
    if (snap) {
      node.team = snap.team
      node.weapon = snap.weapon
      node.displayName = snap.displayName
      if (snap.skill !== undefined) node.skill = snap.skill
    }
    node.kills = victim.kills
    node.deaths = victim.deaths
    this._snapshots.set(node, snap)
    this.register(node)
    node.setWorldPosition?.(at)
  }

  private _yawOf(n: Node): number {
    const f = (n as any).worldForward
    return Math.atan2(f[0], f[2]) * 180 / Math.PI
  }

  private _place(f: any, spawn: Node | null): void {
    if (!spawn) return
    const at = spawn.worldPosition
    f.setWorldPosition([at[0], at[1] + 0.05, at[2]])
    f.setRotation([0, this._yawOf(spawn), 0])
    f.teleported?.(this._yawOf(spawn))
  }

  /** A spawn point away from living enemies, rotating through the rest so two fighters do not stack. */
  private _pickSpawn(f: any): Node | null {
    const points = this._spawns.filter(s => s.scene)
    if (!points.length) return null
    const enemies = [...this._fighters].filter(o => o !== f && !o.isDead && this.isHostile(f, o))
    const scored = points.map(p => {
      const pos = p.worldPosition
      let nearest = Infinity
      for (const e of enemies) nearest = Math.min(nearest, distance3(pos, e.worldPosition))
      const used = this._usedSpawns.has(p) ? -30 : 0
      return { p, score: Math.min(nearest, 60) + used + Math.random() * 8 }
    }).filter(s => enemies.length === 0 || s.score > this.spawnSafeDistance - 30).sort((a, b) => b.score - a.score)
    const pick = (scored[0] ?? { p: points[Math.floor(Math.random() * points.length)] }).p
    this._usedSpawns.add(pick)
    if (this._usedSpawns.size >= points.length) this._usedSpawns.clear()
    return pick
  }

  private _endMatch(winner: string): void {
    if (this.matchOver) return
    this.matchOver = true
    this.winner = winner
    this.message = winner === 'Draw' ? 'DRAW' : `${winner.toUpperCase()} WINS`
    this.after(this.restartSeconds, () => { Game.loadScene(Game.sceneName).catch(e => Logger.warn('FPS: could not restart the match: ' + e, 'Script')) })
  }

  // =================================================================================================
  // HUD helpers
  // =================================================================================================

  private _announce(text: string): void {
    this._feed.push({ text, until: this.elapsed + 5 })
  }

  public get feed(): string[] { return this._feed.map(f => f.text) }

  // =================================================================================================
  // Noise, reinforcements
  // =================================================================================================

  /** A gunshot: bots of other teams within `radius` go to look. */
  public makeNoise(at: ArrayLike<number>, radius: number, source: any): void {
    for (const f of this._fighters) {
      if (f === source || f.isDead || !f.hear || !this.isHostile(source, f)) continue
      if (distance3(at, f.worldPosition) <= radius) f.hear(at, source)
    }
  }

  /** A bot's cry for help: its team's bots in range that are not already fighting come to `at`. */
  public callReinforcements(team: string, at: ArrayLike<number>, caller: any): number {
    let answered = 0
    for (const f of this._fighters) {
      if (f === caller || f.isDead || f.team !== team || !f.respondTo) continue
      if (planarDistance(at, f.worldPosition) > this.reinforcementRadius) continue
      if (f.respondTo(at, caller)) answered++
    }
    if (answered) this._announce(`${caller.displayName} calls for help`)
    return answered
  }

  // =================================================================================================
  // Cover
  // =================================================================================================

  /**
   * A spot near `from` where `threat` (a world point) cannot see: the Cover Points the scene has, then
   * a ring of probes around `from`. Out of sight is a ray from the threat's eye to a point crouched height
   * above the spot that something blocks; a candidate is also kept within `maxDistance` and, with a navmesh,
   * reachable. The best is the nearest to `from`, with a bonus for being farther from the threat.
   */
  public bestCover(from: ArrayLike<number>, threat: ArrayLike<number>, maxDistance: number = 24): number[] | null {
    const physics = this.scene?.physics as any
    if (!physics) return null
    const eye = [threat[0], threat[1] + 1.55, threat[2]]
    const hidden = (p: number[]) => {
      const target = [p[0], p[1] + 1.0, p[2]]
      const hit = physics.raycast(eye, target, { reject: (owner: any) => !!owner?.getVariable?.('fpsCombatant') })
      return !!hit && distance3(hit.point, target) > 0.35
    }
    const candidates: number[][] = []
    for (const c of this._covers) if (c.scene) {
      const p = c.worldPosition
      if (planarDistance(from, p) <= maxDistance) candidates.push([p[0], p[1], p[2]])
    }
    // Probes: points on rings round the bot, set down on the ground.
    for (let ring = 1; ring <= 3; ring++) for (let i = 0; i < 10; i++) {
      const a = (i / 10 + ring * 0.07) * Math.PI * 2, r = 3 + ring * 3.5
      const x = from[0] + Math.sin(a) * r, z = from[2] + Math.cos(a) * r
      const ground = physics.raycast([x, from[1] + 2, z], [x, from[1] - 6, z])
      if (ground && ground.normal[1] > 0.7) candidates.push([ground.point[0], ground.point[1], ground.point[2]])
    }
    const ai = (this.scene as any)?.ai
    let best: number[] | null = null
    let bestScore = -Infinity
    for (const p of candidates) {
      if (!hidden(p)) continue
      const near = planarDistance(from, p)
      let reach = near
      if (ai?.hasNavigation) {
        const route = ai.findPath(ai.navMeshFor(null), from as any, p as any)
        if (!route || route.length === 0) continue
        let len = 0
        for (let i = 1; i < route.length; i++) len += distance3(route[i - 1], route[i])
        if (len > near * 2.2 + 4) continue
        reach = len
      }
      const score = -reach + 0.25 * planarDistance(threat, p)
      if (score > bestScore) { bestScore = score; best = p }
    }
    return best
  }

  // =================================================================================================
  // Decals
  // =================================================================================================

  /** Keep the world's bullet holes to `maxDecals`: the oldest is removed. */
  public registerDecal(decal: Node): void {
    this._decals.push(decal)
    while (this._decals.length > this.maxDecals) {
      const old = this._decals.shift()
      try { (old as any)?.remove?.({ immediate: true }) } catch { /* already gone */ }
    }
  }
}
