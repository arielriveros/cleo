import type { Node } from 'cleo'
import { num } from './SoulsMath'

/**
 * Hollow Keep — hitboxes and hurtboxes. A script MODULE (never attached to a node), shared by the
 * player, the enemies and the bolt.
 *
 * ## Hurtboxes
 *
 * A character's hurtbox is its physics capsule — the body it already walks with. Nothing extra to author.
 * A character whose `hurtboxActive` is false is invisible to every attack: that is what i-frames ARE. A
 * roll does not make the player "ignore" a hit; for those frames the blade passes through nothing.
 *
 * ## Hitboxes
 *
 * A weapon's hitbox is a capsule along its blade, from `bladeStart` to `bladeEnd` with `bladeRadius`,
 * measured in the weapon's `Mesh` child space — the same space the blade's boxes are modelled in, so
 * re-gripping or swapping the mesh carries the hitbox with it. While an attack's ACTIVE WINDOW is open
 * (clip events `hit` → `hitEnd`), the blade is swept every frame from where it was last frame to where it
 * is now (`physics.sweepCapsule`), so a fast swing cannot pass through a target between two frames, and
 * each target is hit once per swing.
 *
 * ## Swing blockers
 *
 * A solid body whose node has the variable `blocksSwings` = true (walls, pillars, gates) stops a swing
 * that reaches it before any enemy: the blade bounces, and the attacker recoils. Floors are not swing
 * blockers, so an overhead never bounces off the ground.
 */

export interface Capsule { a: number[]; b: number[]; radius: number }

/** The swing state an attacker keeps between frames. Reset with `openSwing` when a window opens. */
export interface Swing {
  /** Last frame's blade, or null on the window's first frame. */
  prev: Capsule | null
  /** Every node this swing has already damaged. */
  hit: Node[]
  open: boolean
}

export function newSwing(): Swing { return { prev: null, hit: [], open: false } }

export function openSwing(swing: Swing): void { swing.prev = null; swing.hit.length = 0; swing.open = true }
export function closeSwing(swing: Swing): void { swing.prev = null; swing.open = false }

/** Transform a point by a column-major 4x4 matrix. */
function transformPoint(m: ArrayLike<number>, p: ArrayLike<number>): number[] {
  const x = p[0], y = p[1], z = p[2]
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]]
}

/**
 * The weapon's blade capsule in world space, or null when it has none. Read from the `Mesh` child's world
 * transform (falling back to the weapon node itself), so the radius scales with a big enemy's weapon.
 */
export function bladeCapsule(weapon: Node): Capsule | null {
  if (!weapon) return null
  // A script field (SoulsWeapon), or a plain node VARIABLE (an enemy's script-less Weapon node).
  const field = (name: string) => (weapon as any)[name] ?? (weapon as any).getVariable?.(name)
  const start = field('bladeStart'), end = field('bladeEnd')
  if (!start || !end || start.length < 3 || end.length < 3) return null
  const space = weapon.getChildByName?.('Mesh')?.[0] ?? weapon
  const m = space.worldTransform as ArrayLike<number>
  const scale = Math.hypot(m[0], m[1], m[2])
  return { a: transformPoint(m, start), b: transformPoint(m, end), radius: num(field('bladeRadius'), 0.1) * scale }
}

/** Whether `node` is a live hurtbox `attacker` may hit. `kind` picks the side: the player or enemies. */
export function isHurtbox(node: Node, attacker: Node, kind: 'player' | 'enemy'): boolean {
  const n = node as any
  if (!node || node === attacker || n.isDead || n.hurtboxActive === false || n.spawned === false) return false
  return kind === 'player' ? typeof n.receiveDamage === 'function' : typeof n.receiveHit === 'function'
}

/** Whether a body stops a swing: solid, and its node opted in with the `blocksSwings` variable. */
export function blocksSwings(node: Node, body: any): boolean {
  if (!node || !body || body.isTrigger || body.collisionResponse === false) return false
  return !!(node as any).getVariable?.('blocksSwings')
}

export interface SwingContact {
  /** New hurtboxes touched this frame, in the order the blade reached them. */
  targets: { node: Node; point: number[] }[]
  /** Where the blade met a swing blocker BEFORE any of those targets, or null. */
  blockedAt: number[] | null
}

/**
 * Advance a swing by one frame: sweep the blade from last frame's pose to `blade`, and report the new
 * targets and whether a blocker got in the way first. Targets already hit this swing are not reported
 * again. With `bounces` false, blockers are ignored (a heavy slam ploughs on through).
 */
export function stepSwing(physics: any, swing: Swing, blade: Capsule, attacker: Node,
  kind: 'player' | 'enemy', bounces: boolean): SwingContact {
  const result: SwingContact = { targets: [], blockedAt: null }
  if (!physics || !swing.open || !blade) return result
  const prev = swing.prev ?? blade
  swing.prev = blade
  const hits = physics.sweepCapsule(prev.a, prev.b, blade.a, blade.b, blade.radius, {
    ignore: attacker,
    filter: (node: Node, body: any) => isHurtbox(node, attacker, kind) || (bounces && blocksSwings(node, body)),
  }) as { node: Node; body: any; point: number[]; fraction: number }[]

  for (const h of hits) {
    if (bounces && blocksSwings(h.node, h.body)) {
      // A blocker reached before (or at the same moment as) every new target ends the swing here.
      result.blockedAt = h.point
      break
    }
    if (swing.hit.includes(h.node)) continue
    swing.hit.push(h.node)
    result.targets.push({ node: h.node, point: h.point })
  }
  // Targets the blade reached before the wall still take the hit; the ones after it are spared.
  return result
}
