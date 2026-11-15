// Every optional feature, installed: what the full engine (src/cleo.ts) runs on -- the editor, Play in window, the
// Creator and the tests. A published game's player never imports this (vite.player.config.ts fails its build if
// it does): it loads only the features the game was built with, through ./loaders.ts.
import { installFeatures } from "../core/features/registry";
import sequencer from "./sequencer/index";
import gameUi from "./gameUi/index";
import landscape from "./landscape/index";
import weather from "./weather/index";
import particles from "./particles/index";
import physics2d from "./physics2d/index";
import world2d from "./world2d/index";
import volumetricFog from "./volumetricFog/index";
import gi from "./gi/index";
import volumetricClouds from "./volumetricClouds/index";
import fluids from "./fluids/index";
import decals from "./decals/index";
import cloth from "./cloth/index";
import water from "./water/index";

/** The feature modules, in a stable order (installFeatures puts dependencies first). */
export const ALL_FEATURE_MODULES = [sequencer, water, cloth, decals, fluids, volumetricClouds, gi, volumetricFog, world2d, physics2d, particles, weather, landscape, gameUi];

installFeatures(ALL_FEATURE_MODULES);
