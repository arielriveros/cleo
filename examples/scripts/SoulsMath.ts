import type { Node } from 'cleo'

/**
 * Hollow Keep — shared maths for the Souls* scripts. A script MODULE: it exports helpers and is never
 * attached to a node. Every script that needs these imports them by path:
 *
 *   import { num, yawTo, angleDiff } from '@/Core/Scripts/SoulsMath'
 *
 * (the project-root form; a path relative to the importing script works too).
 *
 * Evaluated once per game and shared, so it holds no per-node state.
 *
 * Angles follow the engine's convention: yaw in degrees, 0 is +Z, counter-clockwise positive (the
 * character's RIGHT is a negative turn).
 */

/** `value` if it is a finite number, else `fallback` — for reading tunables off other scripts' nodes. */
export function num(value: any, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** Distance on the ground plane, ignoring height. */
export function planarDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return Math.hypot(b[0] - a[0], b[2] - a[2])
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

/** The yaw a node faces, from its world forward. */
export function forwardYaw(node: Node): number {
  const f = node.worldForward
  return Math.atan2(f[0], f[2]) * 180 / Math.PI
}

/**
 * How much a stat adds to a weapon that scales with it fully: 0 at 10, 0.6 at 30, 0.9 at 50, then a
 * quarter of a percent per point. Soft caps are the whole reason a build has to choose.
 */
export function statBonus(stat: number): number {
  if (stat <= 10) return 0
  if (stat <= 30) return (stat - 10) / 20 * 0.6
  if (stat <= 50) return 0.6 + (stat - 30) / 20 * 0.3
  return 0.9 + (stat - 50) * 0.0025
}
