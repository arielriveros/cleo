import { Node, resolveSocketOwner } from 'cleo'
import { num } from '@/Core/Scripts/SoulsMath'

/**
 * Hollow Keep — hitboxes and hurtboxes. A script MODULE (never attached to a node), shared by the
 * player, the enemies, the bolt and the breakables.
 *
 * Both are TRIGGER VOLUMES, separate from the rigid bodies characters walk with, and the engine reports
 * when one enters the other (a trigger that `detectTriggers`; see Trigger in the engine). With the eye
 * menu's Triggers ▸ Runtime on, Play draws them live: the blade's hitbox appears on `hit` and vanishes on
 * `hitEnd`, and a rolling player's hurtbox blinks out for exactly its i-frames.
 *
 * ## Hurtboxes
 *
 * A child node named `Hurtbox` of each character (and breakable), carrying one capsule trigger in its
 * team's layer (`LAYER.PLAYER_HURTBOX` / `LAYER.ENEMY_HURTBOX`) that detects only hitboxes. The
 * generator authors it the size of the walking capsule; a character without one gets one built from its
 * body on its first frame. `hurtboxActive` false switches it OFF — that is what i-frames ARE: a roll does
 * not make the player "ignore" a hit, for those frames there is nothing there to hit.
 *
 * ## Hitboxes
 *
 * A weapon's hitbox is a capsule along its blade, from `bladeStart` to `bladeEnd` with `bladeRadius`,
 * measured in the weapon's `Mesh` child space — the same space the blade's boxes are modelled in, so
 * re-gripping or swapping the mesh carries the hitbox with it. It is a `Hitbox` child of the `Mesh`,
 * made the first time the weapon swings, and switched on by the attack's clip events: `hit` arms it
 * (`openSwing`), `hitEnd` disarms it (`closeSwing`). It is CONTINUOUS — tested along its path from last
 * frame to this one — so a fast swing cannot pass through an arm between two frames. Each target is hit
 * once per swing.
 *
 * ## Swing blockers
 *
 * A solid body whose node has the variable `blocksSwings` = true (walls, pillars, gates) stops a swing
 * that reaches it before any enemy: the blade bounces, and the attacker recoils. Walls are not triggers,
 * so while a window is open the blade is also swept against blockers alone, over the same frame's path.
 * Floors are not swing blockers, so an overhead never bounces off the ground.
 */

/**
 * The collision layers (trigger group/mask bits) of the combat volumes. Layer 1 is every ordinary body and
 * 2 the ragdoll bones; these stay clear of both, so a hurtbox never even reaches a contact test with its
 * own character's capsule.
 */
export const LAYER = { PLAYER_HURTBOX: 1 << 8, ENEMY_HURTBOX: 1 << 9, HITBOX: 1 << 10 }

/** The hurtbox layer of a team ('player' or 'enemy'). */
export function hurtboxLayer(team: string): number {
  return team === 'player' ? LAYER.PLAYER_HURTBOX : LAYER.ENEMY_HURTBOX
}

export interface Capsule { a: number[]; b: number[]; radius: number }

/** One hurtbox the armed hitbox entered: where, and how far through that frame's sweep (0..1). */
export interface HitboxContact { node: Node; point: number[] | null; fraction: number }

/** The swing state an attacker keeps between frames. Reset with `openSwing` when a window opens. */
export interface Swing {
  /** Last frame's blade, or null on the window's first frame. For the blocker sweep. */
  prev: Capsule | null
  /** Every node this swing has already damaged. */
  hit: Node[]
  open: boolean
  /** The weapon whose hitbox is armed for this window, and the remover of its contact listener. */
  weapon: Node | null
  off: (() => void) | null
  /** What the armed hitbox entered since the last `stepSwing`, as physics reported it. */
  pending: HitboxContact[]
}

export function newSwing(): Swing { return { prev: null, hit: [], open: false, weapon: null, off: null, pending: [] } }

/**
 * Open an active window (the `hit` event). With a `weapon` — only pass one that is in the attacker's own
 * hand, see wieldedBy — its hitbox is switched on against `target`'s hurtboxes (the TEAM being attacked:
 * 'enemy' for the player's blade, 'player' for an enemy's) and starts collecting contacts.
 */
export function openSwing(swing: Swing, weapon: Node | null = null, target: 'player' | 'enemy' = 'enemy'): void {
  closeSwing(swing)
  swing.hit.length = 0
  swing.open = true
  if (!weapon) return
  const trigger = armHitbox(weapon, target)
  if (!trigger) return
  swing.weapon = weapon
  swing.off = trigger.onContact((c: any) => {
    if (c.phase === 'enter' && swing.open && c.node) swing.pending.push({ node: c.node, point: c.point, fraction: c.fraction })
  })
}

/** Close the window (the `hitEnd` event, a fallback timer, a state change): the hitbox switches off. */
export function closeSwing(swing: Swing): void {
  swing.prev = null
  swing.open = false
  swing.off?.()
  swing.off = null
  if (swing.weapon) disarmHitbox(swing.weapon)
  swing.weapon = null
  swing.pending.length = 0
}

/** Transform a point by a column-major 4x4 matrix. */
function transformPoint(m: ArrayLike<number>, p: ArrayLike<number>): number[] {
  const x = p[0], y = p[1], z = p[2]
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]]
}

/** A weapon field: a script field (SoulsWeapon), or a plain node VARIABLE (a script-less weapon). */
function field(weapon: Node, name: string): any {
  return (weapon as any)[name] ?? (weapon as any).getVariable?.(name)
}

/** The space the blade fields are measured in: the weapon's `Mesh` child, else the weapon itself. */
function bladeSpace(weapon: Node): Node {
  return weapon.getChildByName?.('Mesh')?.[0] ?? weapon
}

/**
 * The weapon's blade capsule in world space, or null when it has none. Read from the `Mesh` child's world
 * transform (falling back to the weapon node itself), so the radius scales with a big enemy's weapon.
 */
export function bladeCapsule(weapon: Node): Capsule | null {
  if (!weapon) return null
  const start = field(weapon, 'bladeStart'), end = field(weapon, 'bladeEnd')
  if (!start || !end || start.length < 3 || end.length < 3) return null
  const m = bladeSpace(weapon).worldTransform as ArrayLike<number>
  const scale = Math.hypot(m[0], m[1], m[2])
  return { a: transformPoint(m, start), b: transformPoint(m, end), radius: num(field(weapon, 'bladeRadius'), 0.1) * scale }
}

// =====================================================================================================
// Hitboxes
// =====================================================================================================

const HITBOX = 'Hitbox'

/**
 * The weapon's hitbox trigger, made on first use: a `Hitbox` child of its `Mesh` holding a capsule along
 * the blade. Reshaped when the blade fields or the mesh's scale change (a weapon re-gripped, a big enemy's
 * club), never otherwise. Null for a weapon with no blade.
 */
export function weaponHitbox(weapon: Node): any {
  if (!weapon) return null
  const start = field(weapon, 'bladeStart'), end = field(weapon, 'bladeEnd')
  if (!start || !end || start.length < 3 || end.length < 3) return null
  const space = bladeSpace(weapon)
  let node = space.getChildByName(HITBOX)[0] as any
  if (!node) {
    node = new Node(HITBOX)
    space.addChild(node)
  }
  // The trigger lives in the Hitbox node's space, which is the mesh's minus its scale: physics places
  // triggers by position and rotation only, so the scale goes into the shape.
  const m = space.worldTransform as ArrayLike<number>
  const scale = Math.hypot(m[0], m[1], m[2]) || 1
  const radius = num(field(weapon, 'bladeRadius'), 0.1)
  const key = `${start.join(',')}|${end.join(',')}|${radius}|${scale.toFixed(4)}`
  if (!node.trigger || node._bladeKey !== key) {
    const trigger = node.trigger ?? node.setTrigger({ enabled: false, continuous: true, detectTriggers: true, group: LAYER.HITBOX, mask: 0 })
    trigger.setCapsule([start[0] * scale, start[1] * scale, start[2] * scale], [end[0] * scale, end[1] * scale, end[2] * scale], radius * scale)
    node._bladeKey = key
  }
  return node.trigger
}

/** Switch the weapon's hitbox on against `target`'s hurtboxes. Returns its trigger, or null (no blade). */
export function armHitbox(weapon: Node, target: 'player' | 'enemy'): any {
  const trigger = weaponHitbox(weapon)
  if (!trigger) return null
  trigger.mask = hurtboxLayer(target)
  trigger.enabled = true
  return trigger
}

/** Switch the weapon's hitbox off (if it has one). */
export function disarmHitbox(weapon: Node): void {
  const node = bladeSpace(weapon)?.getChildByName?.(HITBOX)?.[0] as any
  if (node?.trigger) node.trigger.enabled = false
}

// =====================================================================================================
// Hurtboxes
// =====================================================================================================

const HURTBOX = 'Hurtbox'

/** The `Hurtbox` child of a character or breakable, or null. */
export function hurtboxOf(owner: Node): any {
  return owner?.getChildByName?.(HURTBOX)?.[0] ?? null
}

/**
 * The owner's hurtbox, built from its body when the template has none: a capsule as tall and as wide as
 * the body's bounds, in the layer of the owner's `team`. Null for an owner with no body.
 */
export function ensureHurtbox(owner: Node): any {
  const existing = hurtboxOf(owner)
  if (existing?.trigger) return existing
  const body = (owner as any).body
  if (!body) return null
  const [lx, ly, lz, hx, hy, hz] = body.getAabb([0, 0, 0, 0, 0, 0])
  const radius = Math.max(0.05, Math.min(hx - lx, hz - lz) / 2)
  const base = owner.worldPosition
  const bottom = ly - base[1], top = hy - base[1]
  const node = existing ?? new Node(HURTBOX)
  if (!existing) owner.addChild(node)
  node.setTrigger({ group: hurtboxLayer((owner as any).team), mask: LAYER.HITBOX, detectTriggers: true })
    .setCapsule([0, bottom + radius, 0], [0, Math.max(bottom + radius, top - radius), 0], radius)
  return node
}

/** Switch the owner's hurtbox on or off; only touches it on a change. */
export function setHurtboxEnabled(owner: Node, on: boolean): void {
  const trigger = hurtboxOf(owner)?.trigger
  if (trigger && trigger.enabled !== on) trigger.enabled = on
}

/** The character (or breakable) a hurtbox belongs to: the nearest node at or above it that takes hits. */
export function characterOf(node: Node): Node | null {
  for (let n: Node = node; n; n = n.parent) if (typeof (n as any).receiveHit === 'function') return n
  return null
}

// =====================================================================================================
// Who may hit whom
// =====================================================================================================

function isWithin(node: Node, ancestor: Node): boolean {
  for (let n: Node = node; n; n = n.parent) if (n === ancestor) return true
  return false
}

/**
 * Whether `weapon` is actually in `wielder`'s hand: pinned to a socket that resolves on a model INSIDE the
 * wielder. A weapon's hitbox is only armed when it is.
 *
 * The safety net under a model swap: a character whose new rig has no hand socket used to have its weapon
 * ride whichever model in the scene did have one, and its swings landed there — a sword hurting a
 * knight across the level, enemy blades never reaching the player. A weapon not in its wielder's hand now
 * simply hits nothing.
 */
export function wieldedBy(weapon: Node, wielder: Node): boolean {
  if (!weapon || !wielder) return false
  const attachment = (weapon as any).socketAttachment
  // Unpinned (a user's own weapon parented straight to a bone node): it is the wielder's if it is under it.
  if (!attachment) return isWithin(weapon, wielder)
  const owner: any = resolveSocketOwner(weapon, attachment, (id: string) => weapon.scene?.getNodeById(id) ?? null)
  return !!owner && isWithin(owner, wielder) && (owner.socketNames ?? []).includes(attachment.socket)
}

/**
 * Whether `node` (a character, or a breakable) is a live target `attacker` may hit. `kind` is the TEAM
 * being attacked (a fighter's `team` field, SoulsCharacter): the player's blade hits 'enemy', an enemy's
 * hits 'player'.
 */
export function isHurtbox(node: Node, attacker: Node, kind: 'player' | 'enemy'): boolean {
  const n = node as any
  if (!node || node === attacker || n.isDead || n.hurtboxActive === false || n.spawned === false) return false
  return n.team === kind && typeof n.receiveHit === 'function'
}

/** Whether a body stops a swing: solid, and its node opted in with the `blocksSwings` variable. */
export function blocksSwings(node: Node, body: any): boolean {
  if (!node || !body || body.isTrigger || body.collisionResponse === false) return false
  return !!(node as any).getVariable?.('blocksSwings')
}

/**
 * Overlap/sweep options that find only `team`'s hurtboxes, mapped back to the targets they belong to by
 * `hurtboxTargets`. For a slam or a bolt: a switched-off hurtbox (a roll's i-frames) is never found.
 */
export function hurtboxQuery(team: 'player' | 'enemy', attacker: Node | null): any {
  return {
    includeTriggers: true,
    layerMask: hurtboxLayer(team),
    ignore: attacker,
    filter: (node: Node) => { const target = characterOf(node); return !!target && target !== attacker && isHurtbox(target, attacker, team) },
  }
}

/** A query's hits as the targets they hurt, each once, in the order the query reached them. */
export function hurtboxTargets(hits: { node: Node; point: number[] }[]): { node: Node; point: number[] }[] {
  const out: { node: Node; point: number[] }[] = []
  for (const h of hits) {
    const target = characterOf(h.node)
    if (target && !out.some(o => o.node === target)) out.push({ node: target, point: h.point })
  }
  return out
}

export interface SwingContact {
  /** New targets reached this frame, in the order the blade reached them. */
  targets: { node: Node; point: number[] }[]
  /** Where the blade met a swing blocker BEFORE any of those targets, or null. */
  blockedAt: number[] | null
}

/**
 * Advance a swing by one frame: take the hurtboxes its hitbox entered (physics reported them at the start
 * of this frame, for the blade's path from two frames ago to last frame), sweep that same path against
 * swing blockers, and report the new targets and whether a blocker got in the way first. Targets already
 * hit this swing are not reported again. With `bounces` false, blockers are ignored (a heavy slam ploughs
 * on through).
 */
export function stepSwing(physics: any, swing: Swing, blade: Capsule, attacker: Node,
  kind: 'player' | 'enemy', bounces: boolean): SwingContact {
  const result: SwingContact = { targets: [], blockedAt: null }
  if (!swing.open) return result

  const reached: HitboxContact[] = []
  for (const c of swing.pending.splice(0)) {
    const target = characterOf(c.node)
    if (!target || !isHurtbox(target, attacker, kind) || swing.hit.includes(target) || reached.some(r => r.node === target)) continue
    const p = target.worldPosition
    reached.push({ node: target, point: c.point ?? [p[0], p[1], p[2]], fraction: c.fraction })
  }
  reached.sort((a, b) => a.fraction - b.fraction)

  // The blockers, over the same path. On the window's first frame the path is the blade where it is.
  let blockedFraction = Infinity
  if (bounces && physics && blade) {
    const prev = swing.prev ?? blade
    const hits = physics.sweepCapsule(prev.a, prev.b, blade.a, blade.b, blade.radius, {
      ignore: attacker, filter: (node: Node, body: any) => blocksSwings(node, body),
    }) as { node: Node; point: number[]; fraction: number }[]
    if (hits.length) { blockedFraction = hits[0].fraction; result.blockedAt = hits[0].point }
  }
  if (blade) swing.prev = blade

  // Targets the blade reached before the wall still take the hit; the ones after it are spared.
  for (const r of reached) {
    if (r.fraction > blockedFraction) break
    swing.hit.push(r.node)
    result.targets.push({ node: r.node, point: r.point as number[] })
  }
  return result
}
