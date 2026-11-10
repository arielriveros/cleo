import { SoundNode } from 'cleo'
import type { Node } from 'cleo'

/**
 * FPS example — shared data and helpers. A script MODULE: it exports, it is never attached to a node, and it
 * is evaluated once per game and shared (so it holds no per-node state; see `fps` below for the one global).
 *
 * Angles follow the engine's convention: yaw in degrees, 0 is +Z, counter-clockwise positive (a character's
 * RIGHT is a negative turn). A camera rig's pitch is positive DOWN.
 */

// ----- the weapons ------------------------------------------------------------------------------------

export interface WeaponSpec {
  key: string
  name: string
  /** Damage per bullet (per pellet for a shotgun). */
  damage: number
  /** Rounds per minute. */
  rpm: number
  /** Hold to keep firing. */
  auto: boolean
  mag: number
  reserve: number
  pellets: number
  /** Cone half-angle, degrees: hip, aimed down sights. Movement and crouch scale it (FpsPlayer.spreadNow). */
  hipSpread: number
  adsSpread: number
  /** Camera kick per shot, degrees (pitch up, yaw random +/-), and how fast it settles. */
  recoilPitch: number
  recoilYaw: number
  range: number
  /** Distance (m) over which damage falls to `falloff` of itself. */
  falloffRange: number
  falloff: number
  /** The aimed-down-sights field of view and the move speed scale while aimed. */
  adsFov: number
  adsMove: number
  /** Where the viewmodel sits when aimed (metres, in the camera's frame) for a weapon with no aim clip. */
  adsOffset: [number, number, number]
  /** Seconds, used where the clip's own length is not known yet. */
  reloadSeconds: number
  equipSeconds: number
  /** Whether the weapon has its own aimed clips (Idle/Walk/Fire aim variants). */
  hasAimClips: boolean
  /** Bots: how far from a target they will open fire, and their burst length. */
  botRange: number
  botBurst: [number, number]
}

export const WEAPONS: Record<string, WeaponSpec> = {
  pistol: {
    key: 'pistol', name: 'Pistol', damage: 26, rpm: 380, auto: false, mag: 12, reserve: 84, pellets: 1,
    hipSpread: 1.6, adsSpread: 0.25, recoilPitch: 1.5, recoilYaw: 0.45, range: 140, falloffRange: 70, falloff: 0.55,
    adsFov: 62, adsMove: 0.7, adsOffset: [0, 0.012, 0], reloadSeconds: 2.2, equipSeconds: 1.2, hasAimClips: true,
    botRange: 30, botBurst: [1, 3],
  },
  ak47: {
    key: 'ak47', name: 'AK-47', damage: 31, rpm: 600, auto: true, mag: 30, reserve: 150, pellets: 1,
    hipSpread: 2.6, adsSpread: 0.4, recoilPitch: 1.1, recoilYaw: 0.5, range: 220, falloffRange: 110, falloff: 0.6,
    adsFov: 52, adsMove: 0.6, adsOffset: [0, 0.032, 0], reloadSeconds: 4.4, equipSeconds: 1.6, hasAimClips: true,
    botRange: 45, botBurst: [3, 7],
  },
  shotgun: {
    key: 'shotgun', name: 'SAPS-12', damage: 12, rpm: 76, auto: false, mag: 6, reserve: 36, pellets: 9,
    hipSpread: 4.2, adsSpread: 2.6, recoilPitch: 4.2, recoilYaw: 0.9, range: 60, falloffRange: 22, falloff: 0.25,
    adsFov: 62, adsMove: 0.75, adsOffset: [-0.09, 0.045, 0.1], reloadSeconds: 3.6, equipSeconds: 1.1, hasAimClips: false,
    botRange: 16, botBurst: [1, 2],
  },
}

export const WEAPON_ORDER = ['pistol', 'ak47', 'shotgun']

// ----- the match --------------------------------------------------------------------------------------

export type FpsGameType = 'oneVsAll' | 'teamDeathmatch' | 'ffa'

/** The Game Manager's list of game types: what the dropdown offers, and what each needs of the scene. */
export const GAME_TYPES: Record<FpsGameType, { label: string, minFighters: number }> = {
  oneVsAll: { label: 'One against all', minFighters: 12 },
  teamDeathmatch: { label: 'Team deathmatch', minFighters: 12 },
  ffa: { label: 'Free for all', minFighters: 12 },
}

/** Game type keys an older project may still hold, and what they are called now. */
export const GAME_TYPE_ALIASES: Record<string, FpsGameType> = { oneVsThree: 'oneVsAll', team2v2: 'teamDeathmatch' }

/**
 * The one global: the scene's Game Manager. Module state survives `Game.loadScene`, so the manager sets it in
 * `onStart` and clears it in `onDespawn`, and a combatant reads it through {@link manager} (never caches it).
 */
export const fps: { gm: any } = { gm: null }

/** The match's manager, or null when the scene has none (combatants then fall back to their own `team`). */
export function manager(): any {
  const gm = fps.gm
  return gm && gm.scene && !gm.markForRemoval ? gm : null
}

/** Whether `a` may hurt `b`: different teams, or the manager allows friendly fire. */
export function hostile(a: any, b: any): boolean {
  if (!a || !b || a === b) return false
  const gm = manager()
  if (gm) return gm.isHostile(a, b)
  return a.team !== b.team
}

/** Whether `a`'s bullets hurt `b`: hostile, or the manager has friendly fire on. */
export function canDamage(a: any, b: any): boolean {
  if (!a || !b || a === b) return false
  const gm = manager()
  return gm ? gm.canDamage(a, b) : a.team !== b.team
}

// ----- maths ------------------------------------------------------------------------------------------

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Frame-rate independent approach: the share of the gap closed in `dt` at `rate` per second. */
export function approach(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt))
}

export function planarDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return Math.hypot(b[0] - a[0], b[2] - a[2])
}

export function distance3(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
}

/** World yaw in degrees from `a` toward `b`. */
export function yawTo(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return Math.atan2(b[0] - a[0], b[2] - a[2]) * 180 / Math.PI
}

/** Signed shortest difference `a - b` in degrees, in (-180, 180]. */
export function angleDiff(a: number, b: number): number {
  let d = (a - b) % 360
  if (d > 180) d -= 360
  else if (d <= -180) d += 360
  return d
}

/** The unit direction a camera rig looks along: yaw as above, pitch positive DOWN. */
export function aimDirection(yawDeg: number, pitchDeg: number, out: number[] = [0, 0, 0]): number[] {
  const y = yawDeg * Math.PI / 180, p = pitchDeg * Math.PI / 180
  const c = Math.cos(p)
  out[0] = Math.sin(y) * c
  out[1] = -Math.sin(p)
  out[2] = Math.cos(y) * c
  return out
}

/** A direction `coneDeg` off `dir` at most, uniformly over the cone's disc. */
export function spreadDirection(dir: ArrayLike<number>, coneDeg: number, out: number[] = [0, 0, 0]): number[] {
  const ang = Math.sqrt(Math.random()) * coneDeg * Math.PI / 180
  const roll = Math.random() * Math.PI * 2
  // An orthonormal basis around `dir`.
  let ux = 0, uy = 1, uz = 0
  if (Math.abs(dir[1]) > 0.95) { ux = 1; uy = 0 }
  let rx = dir[1] * uz - dir[2] * uy, ry = dir[2] * ux - dir[0] * uz, rz = dir[0] * uy - dir[1] * ux
  const rl = Math.hypot(rx, ry, rz) || 1
  rx /= rl; ry /= rl; rz /= rl
  const vx = ry * dir[2] - rz * dir[1], vy = rz * dir[0] - rx * dir[2], vz = rx * dir[1] - ry * dir[0]
  const s = Math.sin(ang), c = Math.cos(ang), cr = Math.cos(roll) * s, sr = Math.sin(roll) * s
  out[0] = dir[0] * c + rx * cr + vx * sr
  out[1] = dir[1] * c + ry * cr + vy * sr
  out[2] = dir[2] * c + rz * cr + vz * sr
  const l = Math.hypot(out[0], out[1], out[2]) || 1
  out[0] /= l; out[1] /= l; out[2] /= l
  return out
}

/** Euler degrees [pitch, yaw, 0] that turn a node's local +Y onto `normal` (decals project down their -Y). */
export function rotationOntoNormal(normal: ArrayLike<number>): number[] {
  const ny = clamp(normal[1], -1, 1)
  return [Math.acos(ny) * 180 / Math.PI, Math.atan2(normal[0], normal[2]) * 180 / Math.PI, 0]
}

// ----- nodes ------------------------------------------------------------------------------------------

/** The combatant (a node with `receiveHit` and the `fpsCombatant` variable) that owns `node`, or null. */
export function combatantOf(node: Node | null | undefined): any {
  for (let n: any = node; n; n = n.parent) if (n.getVariable?.('fpsCombatant')) return n
  return null
}

/** Every descendant of `root` (depth first), `fn` returning true stops the walk. */
export function walk(root: Node, fn: (n: Node) => boolean | void): void {
  const visit = (n: Node): boolean => {
    for (const c of n.children) { if (fn(c) === true) return true; if (visit(c)) return true }
    return false
  }
  visit(root)
}

export function findDescendant(root: Node, name: string): Node | null {
  let found: Node | null = null
  walk(root, n => { if (n.name === name) { found = n; return true } })
  return found
}

export function findByVariable(root: Node, variable: string): Node[] {
  const out: Node[] = []
  walk(root, n => { if ((n as any).getVariable?.(variable)) out.push(n) })
  return out
}

/** Spare emitters per cue, so a new shot rings over the tail of the last one instead of cutting it off. */
const overlaps = new WeakMap<Node, SoundNode[]>()
const MAX_OVERLAP = 6

/**
 * Play a SoundNode cue by name from the nearest `Sounds` group at or above `from`. Silent when absent. A
 * SoundNode restarts when played while sounding, so a cue that is still playing is handed to a spare emitter
 * (copied from it, made on first need) and the earlier shot rings out.
 */
export function playCue(from: Node, name: string): void {
  for (let n: Node | null = from; n; n = n.parent) {
    const group = n.getChildByName('Sounds')[0]
    if (!group) continue
    const cue = group.getChildByName(name)[0] as SoundNode | undefined
    if (!cue?.play) return
    if (!cue.isPlaying) { cue.play(); return }
    let pool = overlaps.get(cue)
    if (!pool) { pool = []; overlaps.set(cue, pool) }
    let spare = pool.find(s => !s.isPlaying)
    if (!spare && pool.length < MAX_OVERLAP) {
      spare = new SoundNode(name + ' (overlap)', {
        mode: cue.mode, sampleId: cue.sampleId ?? undefined, volume: cue.volume, loopMode: cue.loopMode, playOnStart: false,
        distanceModel: cue.distanceModel, refDistance: cue.refDistance, maxDistance: cue.maxDistance, rolloffFactor: cue.rolloffFactor,
      })
      group.addChild(spare)
      pool.push(spare)
    }
    if (spare) spare.play(); else cue.play()
    return
  }
}
