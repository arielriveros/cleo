import type { Scene } from '../core/scene/scene';
import type { GroundSampler } from './waterInfo';

/**
 * The ground under a scene's water: the highest landscape at each world (x, z), null where there is none,
 * and a key that changes whenever any landscape is sculpted or moved (what the water info is rebuilt on).
 */
export function sceneGround(scene: Scene): { sample: GroundSampler | null; key: string } {
    const terrains = [...scene.landscapes].map(l => l.terrain).filter(t => !!t);
    if (!terrains.length) return { sample: null, key: '' };
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
    return { sample, key };
}
