import { brushFalloffExponent } from 'cleo'
import type { DecalColor, DecalRadialPattern } from 'cleo'
import { activeStrength, activeToolKey, strengthSpec } from './landscapeBrushStore'
import type { LandscapeBrushSettings } from './landscapeBrushStore'

// The landscape brush cursor, as data: what the editor-only decal under the mouse looks like for the brush
// the artist has set up. Pure functions, no GPU and no scene, so the mapping is testable and any brush UI can
// reuse it; the one runtime import is the brush store's per-tool strength table.
//
// THE POINT OF THE CURSOR: the gradient IS the brush. Its fill alpha is the weight the next dab applies at
// each distance from the centre, computed by the same curve the terrain uses (the decal's radial pattern is
// `curveWeight` from terrain/sculpt.ts, see `radialDecalWeight`), and its overall opacity is the tool's
// strength. So a hard brush reads as a flat disc, a feathered one as a soft glow, and a stronger one as a
// denser one — before anything is touched.

/** The weight curves the terrain brush offers. `soft` is the classic power curve (see brushFalloff.ts). */
export type BrushCurve = 'soft' | 'smooth' | 'linear' | 'sphere' | 'tip'

/** Everything about a brush that shows in its cursor. Deliberately UI-agnostic: build it from any brush store. */
export interface BrushLook {
    mode: 'sculpt' | 'paint' | 'foliage'
    /** The active tool within the mode — a sculpt tool ('raise', 'smooth', ...) or a paint tool. */
    tool: string
    strength: number
    /** The strength slider's range, so the cursor reads the same FRACTION whatever the tool's units. */
    strengthRange?: readonly [number, number]
    /** 0 hard .. 1 fully feathered; what it means depends on `curve`, exactly as for the terrain. */
    falloff: number
    curve?: BrushCurve
    shape?: 'circle' | 'square'
    /** The foliage brush erases instead of scattering. */
    erase?: boolean
}

/** A {@link BrushLook} plus where it lands: what `BrushCursor.show` takes. */
export interface BrushPlacement extends BrushLook {
    /** World units. */
    radius: number
    /** Degrees about Y, for a square brush — the terrain's own convention; see {@link brushCursorYaw}. */
    rotation?: number
}

type Rgb = readonly [number, number, number]

// One colour per kind of edit, so the cursor says what a click will do before it does it. Warm builds
// ground up, cool digs it out, green-blue relaxes it, violet levels it; paint is pink, anything that
// REMOVES (erase, clear to base, foliage erase) is red. sRGB, like every picker colour.
const AMBER: Rgb = [1.0, 0.72, 0.2]
const AZURE: Rgb = [0.3, 0.62, 1.0]
const MINT: Rgb = [0.4, 0.95, 0.7]
const VIOLET: Rgb = [0.72, 0.52, 1.0]
const SAND: Rgb = [0.9, 0.72, 0.5]
const WATER: Rgb = [0.35, 0.85, 1.0]
const PINK: Rgb = [1.0, 0.45, 0.75]
const RED: Rgb = [1.0, 0.32, 0.28]
const GREEN: Rgb = [0.45, 0.95, 0.35]
/** The old ring's yellow, for a tool this table does not know yet. */
const FALLBACK: Rgb = [1.0, 0.9, 0.2]

const TOOL_COLORS: Readonly<Record<string, Rgb>> = {
    raise: AMBER, stamp: AMBER, noise: AMBER,
    lower: AZURE,
    smooth: MINT,
    erode: SAND,
    hydro: WATER,
    flatten: VIOLET, setHeight: VIOLET, terrace: VIOLET, ramp: VIOLET,
    paint: PINK,
    erase: RED, clearToBase: RED,
}

/** The strength range of a rate tool (Raise, Lower): metres per second. The default for {@link strengthAlpha}. */
export const DEFAULT_STRENGTH_RANGE: readonly [number, number] = [0.5, 50]

/** Cursor opacity at the brush centre for the weakest and the strongest setting. */
export const MIN_CENTRE_ALPHA = 0.25
export const MAX_CENTRE_ALPHA = 0.75
/** Foliage scatters and erases at a flat density — there is no strength to show. */
export const FOLIAGE_CENTRE_ALPHA = 0.35

/** The colour a brush's cursor is drawn in. */
export function brushColor(look: BrushLook): Rgb {
    if (look.mode === 'foliage') return look.erase ? RED : GREEN
    return TOOL_COLORS[look.tool] ?? FALLBACK
}

/**
 * The centre opacity for a strength: logarithmic across the slider's range, because strength is a RATE
 * and the difference between 1 and 2 m/s matters as much as between 20 and 40.
 */
export function strengthAlpha(strength: number, range: readonly [number, number] = DEFAULT_STRENGTH_RANGE): number {
    const [lo, hi] = range
    let f: number
    if (lo > 0 && hi > lo) f = Math.log(Math.max(strength, lo) / lo) / Math.log(hi / lo)
    else f = hi > lo ? (strength - lo) / (hi - lo) : 1
    f = Math.min(1, Math.max(0, f))
    return MIN_CENTRE_ALPHA + (MAX_CENTRE_ALPHA - MIN_CENTRE_ALPHA) * f
}

const toward = (c: Rgb, target: number, amount: number): [number, number, number] =>
    [c[0] + (target - c[0]) * amount, c[1] + (target - c[1]) * amount, c[2] + (target - c[2]) * amount]

/**
 * The radial pattern for a brush. Complete, not partial, so switching curve never inherits a stale
 * exponent or falloff from the previous one.
 */
export function brushDecalStyle(look: BrushLook): DecalRadialPattern {
    const color = brushColor(look)
    const foliage = look.mode === 'foliage'
    const alpha = foliage ? FOLIAGE_CENTRE_ALPHA : strengthAlpha(look.strength, look.strengthRange)
    const curve = look.curve ?? 'soft'
    // Foliage scatter and erase are HARD discs (uniform density out to the radius), whatever the falloff
    // slider says — so that is what the cursor shows.
    const weight: Pick<DecalRadialPattern, 'curve' | 'exponent' | 'falloff'> = foliage
        ? { curve: 'power', exponent: 0, falloff: 0 }
        : curve === 'soft'
            ? { curve: 'power', exponent: brushFalloffExponent(look.falloff), falloff: look.falloff }
            : { curve, exponent: 1, falloff: look.falloff }
    const inner: DecalColor = [...toward(color, 1, 0.35), alpha]
    // Outer alpha 0: the fill's coverage falls exactly as the brush weight does, to nothing at the rim.
    const outer: DecalColor = [...toward(color, 0, 0.4), 0]
    return {
        innerColor: inner,
        outerColor: outer,
        ...weight,
        shape: foliage ? 'circle' : (look.shape ?? 'circle'),
        // The rim is always drawn crisp, so the radius reads even where a soft brush has faded out.
        ringColor: [color[0], color[1], color[2], 0.95],
        ringWidthPx: 1.5,
        emissive: 0,
    }
}

/**
 * The landscape brush store's settings as a {@link BrushPlacement}: the active tool, its remembered
 * strength read against THAT tool's slider range (a Smooth strength of 0.4 out of 1 and a Raise of 20
 * out of 50 are both "fairly strong"), and the curve, shape and rotation the terrain applies.
 */
export function lookFromSettings(s: LandscapeBrushSettings): BrushPlacement {
    const spec = strengthSpec(activeToolKey(s))
    return {
        mode: s.mode,
        tool: s.mode === 'sculpt' ? s.sculptTool : s.mode === 'paint' ? s.paintTool : 'foliage',
        radius: s.radius,
        strength: activeStrength(s),
        strengthRange: [spec.min, spec.max],
        falloff: s.falloff,
        curve: s.curve,
        shape: s.shape,
        rotation: s.rotation,
        erase: s.foliageErase,
    }
}

/**
 * The node yaw, in degrees, that turns a square brush cursor to match the terrain's `rotation`.
 * `brushWeight` in terrain/sculpt.ts maps a WORLD offset into the brush frame by rotating it through
 * +rotation, so the brush frame itself is turned by -rotation — which is the yaw the decal node needs.
 */
export function brushCursorYaw(rotation: number): number {
    return -rotation
}

/** The slice of `Terrain` the cursor box needs, so it can be tested without a GPU. */
export interface BrushTerrain {
    readonly origin: ArrayLike<number>
    readonly size: number
    /** Samples per side, when known: the box then reads every height node in the footprint. */
    readonly resolution?: number
    /** Terrain-local height, as `Terrain.heightAt` (0 outside the footprint). */
    heightAt(localX: number, localZ: number): number
}

/** The most height nodes a side of the footprint samples before striding; bounds the hover cost. */
const MAX_SAMPLES_PER_SIDE = 64
/** Samples per side when the terrain's resolution is unknown. */
const FALLBACK_SAMPLES_PER_SIDE = 9

/**
 * The vertical extent of the cursor box: the lowest and highest ground under the brush, padded.
 *
 * The decal projects onto whatever lies inside its box, so the box must enclose all the relief under the
 * brush — a flat box at the hit height would cut the gradient off on every slope, which is exactly what
 * the old flat ring did. Heights are read at the terrain's own grid nodes when the resolution is known
 * (the surface between nodes is bilinear, so its extremes ARE node values), clamped to the terrain; a
 * brush wider than `MAX_SAMPLES_PER_SIDE` nodes strides, and leans on the padding.
 */
export function brushDecalBox(terrain: BrushTerrain, point: ArrayLike<number>, radius: number,
                              shape: 'circle' | 'square' = 'circle'): { center: [number, number, number]; height: number } {
    const ox = terrain.origin[0], oy = terrain.origin[1], oz = terrain.origin[2]
    const half = terrain.size / 2
    // A rotated square reaches √2 x its radius along its diagonal.
    const reach = shape === 'square' ? radius * Math.SQRT2 : radius
    const clampLocal = (v: number) => Math.min(half, Math.max(-half, v))
    const x0 = clampLocal(point[0] - reach - ox), x1 = clampLocal(point[0] + reach - ox)
    const z0 = clampLocal(point[2] - reach - oz), z1 = clampLocal(point[2] + reach - oz)

    let lo = point[1], hi = point[1]
    const sample = (lx: number, lz: number) => {
        const h = oy + terrain.heightAt(lx, lz)
        if (h < lo) lo = h
        if (h > hi) hi = h
    }
    const R = terrain.resolution ?? 0
    if (R > 1) {
        // The grid NODES around the footprint, one ring beyond it on each side: the surface between nodes
        // is bilinear, so it never leaves the range of the nodes that surround it. A huge brush strides.
        const e = terrain.size / (R - 1)
        const node = (v: number, round: (x: number) => number) => Math.min(R - 1, Math.max(0, round((v + half) / e)))
        const c0 = node(x0, Math.floor), c1 = node(x1, Math.ceil)
        const r0 = node(z0, Math.floor), r1 = node(z1, Math.ceil)
        const stride = Math.max(1, Math.ceil(Math.max(c1 - c0, r1 - r0) / MAX_SAMPLES_PER_SIDE))
        for (let c = c0; ; c = Math.min(c1, c + stride)) {
            for (let r = r0; ; r = Math.min(r1, r + stride)) {
                sample(-half + c * e, -half + r * e)
                if (r === r1) break
            }
            if (c === c1) break
        }
    } else {
        const n = FALLBACK_SAMPLES_PER_SIDE
        for (let i = 0; i < n; i++)
            for (let j = 0; j < n; j++)
                sample(x0 + ((x1 - x0) * i) / (n - 1), z0 + ((z1 - z0) * j) / (n - 1))
    }
    const pad = Math.max(1, 0.1 * radius)
    return { center: [point[0], (lo + hi) / 2, point[2]], height: hi - lo + 2 * pad }
}
