// What the core sees of the spray a scene's flowing water throws (`scene.waterSpray`): the water feature's
// WaterSprayRig (src/water/spray), or, in a game built without water, a stand-in that throws none. A leaf: the
// rig itself is only ever named as a type here.
import type { WaterSprayRig } from '../../water/spray/waterSprayRig';

export type SceneWaterSpray = Pick<WaterSprayRig, 'density' | 'systems' | 'update' | 'dispose'>;

/** No spray: no systems. `density` keeps what it is set to. */
export function createNullWaterSpray(): SceneWaterSpray {
    return { density: 1, systems: [], update() {}, dispose() {} };
}
