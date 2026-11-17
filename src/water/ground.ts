import type { Scene } from '../core/scene/scene';
import type { GroundSampler } from './waterInfo';

/** World x, z rectangle the landscapes cover. */
export interface GroundBounds { min: [number, number]; max: [number, number]; }

/**
 * A content key of a landscape's heights under the world rectangle `rect` ([x0, z0, x1, z1]), from the heights
 * as its save stores them (Terrain.quantizedHeights: `u16` across [min, max], `resolution` squared samples
 * over `size` metres centred on (originX, originZ)). The same heights give the same key wherever it is worked
 * out: in the editor, or in a tool that wrote the save. Empty when the landscape is not under the rectangle.
 */
export function heightsRegionKey(u16: ArrayLike<number>, min: number, max: number, resolution: number, size: number,
                                 originX: number, originZ: number, rect: readonly number[]): string {
    const half = size / 2, step = size / (resolution - 1);
    const c0 = Math.max(0, Math.floor((rect[0] - originX + half) / step)), c1 = Math.min(resolution - 1, Math.ceil((rect[2] - originX + half) / step));
    const r0 = Math.max(0, Math.floor((rect[1] - originZ + half) / step)), r1 = Math.min(resolution - 1, Math.ceil((rect[3] - originZ + half) / step));
    if (c0 > c1 || r0 > r1) return '';
    const span = (max - min) || 1;
    let h = 2166136261;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        // Millimetres of the stored height: the key of what the ground is there, whatever its range.
        const mm = Math.round((min + u16[r * resolution + c] / 65535 * span) * 1000);
        h = Math.imul(h ^ (mm & 0xffff), 16777619) >>> 0;
        h = Math.imul(h ^ ((mm >>> 16) & 0xffff), 16777619) >>> 0;
    }
    return `${c0},${r0},${c1},${r1}:${h.toString(36)}`;
}

/** The content key of every landscape's ground under `rect` (see heightsRegionKey). */
export function groundRegionKey(scene: Scene, rect: readonly number[]): string {
    const keys: string[] = [];
    for (const land of scene.landscapes) {
        const t = land.terrain;
        if (!t) continue;
        const q = t.quantizedHeights();
        const key = heightsRegionKey(q.u16, q.min, q.max, t.resolution, t.size, t.origin[0], t.origin[2], rect);
        if (key) keys.push(`${t.origin[1]}:${key}`);
    }
    return keys.join(';');
}

/**
 * The ground under a scene's water: the highest landscape at each world (x, z), null where there is none,
 * the rectangle the landscapes cover, and a key that changes whenever any landscape is sculpted or moved
 * (what the water info is rebuilt on).
 */
export function sceneGround(scene: Scene): { sample: GroundSampler | null; key: string; bounds: GroundBounds | null } {
    const terrains = [...scene.landscapes].map(l => l.terrain).filter(t => !!t);
    if (!terrains.length) return { sample: null, key: '', bounds: null };
    const bounds: GroundBounds = { min: [Infinity, Infinity], max: [-Infinity, -Infinity] };
    for (const t of terrains) {
        const half = t.size / 2;
        bounds.min[0] = Math.min(bounds.min[0], t.origin[0] - half); bounds.max[0] = Math.max(bounds.max[0], t.origin[0] + half);
        bounds.min[1] = Math.min(bounds.min[1], t.origin[2] - half); bounds.max[1] = Math.max(bounds.max[1], t.origin[2] + half);
    }
    const key = terrains.map(t => `${t.heightsVersion}@${t.origin[0]},${t.origin[1]},${t.origin[2]}`).join(';');
    const sample: GroundSampler = (x, z) => {
        let best: number | null = null;
        for (const t of terrains) {
            const lx = x - t.origin[0], lz = z - t.origin[2], half = t.size / 2;
            if (lx < -half || lx > half || lz < -half || lz > half) continue;
            const h = t.heightAt(lx, lz) + t.origin[1];
            if (best === null || h > best) best = h;
        }
        return best;
    };
    return { sample, key, bounds };
}
