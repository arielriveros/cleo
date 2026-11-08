// The engine's own sprites for falling rain and snow: sprite sheets generated from code, so a weather
// volume looks right with no texture asset at all, in the editor and in a published game alike.
//
// Pure (bytes only, no GPU): src/graphics/particles/builtinSprites.ts uploads them. RGB is white
// everywhere and the shape lives in the alpha, so the particle's colour tints them and their mipmaps
// never fringe dark. Every cell keeps a transparent border, so neighbouring cells never bleed in.
//
// NOT ASSETS. Their ids start with BUILTIN_SPRITE_PREFIX, which no texture asset id can (they are
// uuids or file names): they are never registered with the TextureManager, never listed in a picker,
// never saved, never published. The particle renderer resolves them itself.

/** What every built-in sprite id starts with. */
export const BUILTIN_SPRITE_PREFIX = '__builtin__/';
/** Four rain streaks, 4 x 1 cells. A cell's TOP is the drop's leading end. */
export const BUILTIN_RAIN_SPRITE = '__builtin__/rain';
/** Eight snowflakes, 4 x 2 cells: soft discs, clumps and two six-armed crystals. */
export const BUILTIN_SNOW_SPRITE = '__builtin__/snow';

/** Whether `id` names one of the engine's own sprites rather than a texture asset. */
export function isBuiltinTextureId(id: unknown): boolean {
    return typeof id === 'string' && id.startsWith(BUILTIN_SPRITE_PREFIX);
}

/** A generated sprite sheet: `columns` x `rows` cells, rows top-down as an image, RGBA8. */
export interface BuiltinSpriteSheet {
    width: number;
    height: number;
    columns: number;
    rows: number;
    frames: number;
    pixels: Uint8ClampedArray;
}

/** Transparent pixels round every cell. */
export const SPRITE_BORDER = 2;

/** The layout of each built-in sheet (what the precipitation builder sets the flipbook to). */
export const BUILTIN_SPRITE_LAYOUT: Readonly<Record<string, { width: number; height: number; columns: number; rows: number; frames: number }>> = {
    [BUILTIN_RAIN_SPRITE]: { width: 128, height: 128, columns: 4, rows: 1, frames: 4 },
    [BUILTIN_SNOW_SPRITE]: { width: 256, height: 128, columns: 4, rows: 2, frames: 8 },
};

const cache = new Map<string, BuiltinSpriteSheet>();

/** The sheet for a built-in id (generated once), or null for any other id. */
export function builtinSpriteSheet(id: string): BuiltinSpriteSheet | null {
    const layout = BUILTIN_SPRITE_LAYOUT[id];
    if (!layout) return null;
    let sheet = cache.get(id);
    if (!sheet) {
        const pixels = new Uint8ClampedArray(layout.width * layout.height * 4);
        const cellW = layout.width / layout.columns, cellH = layout.height / layout.rows;
        const alpha = new Float32Array(cellW * cellH);
        for (let cell = 0; cell < layout.frames; cell++) {
            alpha.fill(0);
            const rng = lcg(0x5eed + cell * 7919 + (id === BUILTIN_SNOW_SPRITE ? 104729 : 0));
            if (id === BUILTIN_RAIN_SPRITE) rainStreak(alpha, cellW, cellH, cell, rng);
            else snowflake(alpha, cellW, cellH, cell, rng);
            const ox = (cell % layout.columns) * cellW, oy = Math.floor(cell / layout.columns) * cellH;
            for (let y = 0; y < cellH; y++) {
                for (let x = 0; x < cellW; x++) {
                    const inside = x >= SPRITE_BORDER && y >= SPRITE_BORDER && x < cellW - SPRITE_BORDER && y < cellH - SPRITE_BORDER;
                    const a = inside ? Math.min(1, Math.max(0, alpha[y * cellW + x])) : 0;
                    const i = ((oy + y) * layout.width + ox + x) * 4;
                    pixels[i] = 255; pixels[i + 1] = 255; pixels[i + 2] = 255;
                    pixels[i + 3] = Math.round(a * 255);
                }
            }
        }
        // The white RGB holds outside the cells too (the gaps between them are all border).
        for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 255; pixels[i + 1] = 255; pixels[i + 2] = 255; }
        sheet = { ...layout, pixels };
        cache.set(id, sheet);
    }
    return sheet;
}

/** A seeded linear congruential stream in [0, 1): the same sheet on every machine, every run. */
function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

const smoothstep = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
};

/**
 * A rain streak down the cell: a drop's motion blur over one frame, Gaussian across, sharp at its
 * leading end (the TOP of the cell, which a velocity-aligned particle points along its motion) and
 * thinning to its tail. Variants: thin and long, with a second faint highlight, broken, wide and soft.
 */
function rainStreak(out: Float32Array, w: number, h: number, variant: number, rng: () => number): void {
    const top = SPRITE_BORDER + 1, bottom = h - SPRITE_BORDER - 1;
    // Wide in the cell (a third of it): a streak is drawn a few millimetres across, so a thinner line
    // would be a sub-texel sliver every mip of which fades to nothing.
    const cx = w / 2 + (rng() - 0.5) * 2;
    const sigma = variant === 3 ? 4.6 : variant === 1 ? 2.6 : 3.2;
    const peak = variant === 3 ? 0.65 : 1;
    // Where a broken streak breaks: two gaps along its length.
    const gaps = [0.3 + rng() * 0.15, 0.62 + rng() * 0.15];
    for (let y = top; y < bottom; y++) {
        const t = (y - top) / (bottom - top);
        let along = smoothstep(0, 0.05, t) * Math.pow(1 - t, 0.65);
        if (variant === 2) for (const g of gaps) along *= smoothstep(0.02, 0.06, Math.abs(t - g));
        // A slight wobble down its length: a drop is never a ruled line.
        const x0 = cx + Math.sin(t * 5.1 + variant) * 0.6;
        for (let x = 0; x < w; x++) {
            const dx = x + 0.5 - x0;
            let across = Math.exp(-(dx * dx) / (2 * sigma * sigma));
            // The second highlight: light refracted through the far side of the drop.
            if (variant === 1) {
                const d2 = dx - 6;
                across += 0.35 * Math.exp(-(d2 * d2) / (2 * 1.8 * 1.8));
            }
            out[y * w + x] = Math.max(out[y * w + x], across * along * peak);
        }
    }
}

/** Value noise over an angle, period 2 pi: the irregular rim of a soft flake. */
function angularNoise(rng: () => number, lobes: number): (angle: number) => number {
    const knots = Array.from({ length: lobes }, () => rng());
    return angle => {
        const f = ((angle / (2 * Math.PI)) % 1 + 1) % 1 * lobes;
        const i = Math.floor(f), t = f - i;
        const a = knots[i % lobes], b = knots[(i + 1) % lobes];
        const s = t * t * (3 - 2 * t);
        return a + (b - a) * s;
    };
}

/**
 * A snowflake in the cell. 0..2: soft discs with an irregular rim (what a flake looks like at the size
 * it is seen falling); 3..5: clumps of a few stuck together; 6, 7: six-armed crystals with side
 * branches, seen up close.
 */
function snowflake(out: Float32Array, w: number, h: number, variant: number, rng: () => number): void {
    const cx = w / 2, cy = h / 2;
    const reach = Math.min(w, h) / 2 - SPRITE_BORDER - 1;
    const disc = (x0: number, y0: number, r: number, softness: number, rim: (a: number) => number, rimAmount: number, peak: number) => {
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const dx = x + 0.5 - x0, dy = y + 0.5 - y0;
                const d = Math.hypot(dx, dy);
                const edge = r * (1 - rimAmount + rimAmount * rim(Math.atan2(dy, dx)));
                const a = (1 - smoothstep(edge * (1 - softness), edge, d)) * peak;
                out[y * w + x] = Math.max(out[y * w + x], a);
            }
        }
    };
    if (variant <= 2) {
        const r = reach * (0.55 + 0.12 * variant);
        disc(cx, cy, r, 0.65, angularNoise(rng, 7), 0.3, 1);
        return;
    }
    if (variant <= 5) {
        const count = 3 + (variant - 3);
        for (let i = 0; i < count; i++) {
            const a = rng() * Math.PI * 2, along = rng() * reach * 0.45;
            const r = reach * (0.28 + rng() * 0.18);
            disc(cx + Math.cos(a) * along, cy + Math.sin(a) * along, Math.min(r, reach - along), 0.6, angularNoise(rng, 5), 0.25, 0.85 + rng() * 0.15);
        }
        return;
    }
    // A six-armed crystal: arms, side branches two thirds out, and a soft core.
    const spin = rng() * Math.PI / 3;
    const armLength = reach * 0.95;
    const width = variant === 6 ? 1.3 : 1.0;
    const branch = (x0: number, y0: number, angle: number, length: number, sigma: number, peak: number) => {
        const ux = Math.cos(angle), uy = Math.sin(angle);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const dx = x + 0.5 - x0, dy = y + 0.5 - y0;
                const s = dx * ux + dy * uy;
                if (s < 0 || s > length) continue;
                const p = dx * -uy + dy * ux;
                const taper = 1 - 0.6 * (s / length);
                const a = Math.exp(-(p * p) / (2 * sigma * sigma * taper * taper)) * peak * smoothstep(length, length * 0.85, s);
                out[y * w + x] = Math.max(out[y * w + x], a);
            }
        }
    };
    for (let k = 0; k < 6; k++) {
        const a = spin + k * Math.PI / 3;
        branch(cx, cy, a, armLength, width, 1);
        const at = armLength * (variant === 6 ? 0.55 : 0.45);
        const bx = cx + Math.cos(a) * at, by = cy + Math.sin(a) * at;
        const side = armLength * (variant === 6 ? 0.32 : 0.4);
        branch(bx, by, a + Math.PI / 4, side, width * 0.8, 0.85);
        branch(bx, by, a - Math.PI / 4, side, width * 0.8, 0.85);
    }
    disc(cx, cy, reach * 0.18, 0.7, () => 1, 0, 1);
}
