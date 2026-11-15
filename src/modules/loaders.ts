// How a published game's player loads the optional features it was built with: each one a chunk of its own,
// reached only through these imports. Keep each one exactly `() => import(...)`: Rollup builds the feature's chunk
// from what that import may read, and an import awaited for its default alone would let it drop the feature's
// script names (its `export * from './api'`).
import type { FeatureModule } from "../core/features/registry";

export const FEATURE_LOADERS: Readonly<Record<string, () => Promise<{ default: FeatureModule }>>> = {
    sequencer: () => import("./sequencer/index"),
    water: () => import("./water/index"),
    cloth: () => import("./cloth/index"),
    decals: () => import("./decals/index"),
    fluids: () => import("./fluids/index"),
    volumetricClouds: () => import("./volumetricClouds/index"),
    gi: () => import("./gi/index"),
    volumetricFog: () => import("./volumetricFog/index"),
    world2d: () => import("./world2d/index"),
    physics2d: () => import("./physics2d/index"),
    particles: () => import("./particles/index"),
    weather: () => import("./weather/index"),
};
