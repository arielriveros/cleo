import type { Scene } from '../core/scene/scene';
import type { GroundSampler } from './waterInfo';

/** World x, z rectangle the landscapes cover. */
export interface GroundBounds { min: [number, number]; max: [number, number]; }

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
