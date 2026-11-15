// What the core sees of a scene's falling rain and snow (`scene.precipitation`): the weather feature's
// PrecipitationRig (src/modules/weather), or, in a game built without weather, a stand-in where nothing falls.
// A leaf: the rig itself is only ever named as a type here.
import type { PrecipitationRig } from './precipitationRig';

export type ScenePrecipitation = Pick<PrecipitationRig, 'density' | 'clock' | 'systems' | 'systemOf' | 'haze' | 'update' | 'dispose'>;

/** Nothing falls: no systems, no haze, a clock that stays at zero. `density` keeps what it is set to. */
export function createNullPrecipitation(): ScenePrecipitation {
    return { density: 1, clock: 0, systems: [], haze: null, systemOf: () => null, update() {}, dispose() {} };
}
