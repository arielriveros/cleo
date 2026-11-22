// @ts-check
// What the editor's Add catalog and asset libraries hold, as the tools name them. Plain data with no
// imports: the editor's suite reads this file and fails when it drifts from the real catalog
// (applications/editor/tests/agentCatalog.test.ts checks it against ADD_ITEMS and the asset.list kinds).

/** Every Add-catalog id a scene_edit create takes as `type`, by the catalog's own categories. */
export const ADD_TYPES = {
    gameplay: ['empty', 'character', 'controller', 'sequence', 'navMesh'],
    cameras: ['perspectiveCamera', 'orthographicCamera', 'camera2D', 'cameraRig'],
    lights: ['directionalLight', 'pointLight', 'spotlight', 'areaLight', 'skyLight'],
    audio: ['spatialSound', 'ambientSound'],
    sprites: ['sprite', 'animatedSprite', 'tilemap', 'characterBody2D', 'room2D', 'parallaxLayer'],
    primitives: ['cube', 'sphere', 'capsule', 'cylinder', 'cone', 'torus', 'pyramid', 'quad', 'plane', 'circle', 'triangle'],
    complex: ['ramp', 'cornerRamp', 'stairs', 'spiralStairs', 'arch', 'tube', 'hollowBox'],
    environment: ['skybox', 'skyAtmosphere', 'lightProbe', 'exposureVolume', 'giVolume', 'volumetricFog', 'occlusionVolume', 'volumetricClouds', 'landscape'],
    effects: ['decal', 'particleSystem', 'forceField'],
    simulation: ['collider', 'body2D', 'trigger', 'waterVolume', 'wind', 'weather', 'vehicle', 'cloth'],
    ui: ['uiCanvas', 'uiWorldRoot', 'uiStackColumn', 'uiStackRow', 'uiSpacer', 'uiPanel', 'uiText', 'uiImage', 'uiButton', 'uiProgressBar', 'uiSlider', 'uiToggle', 'uiTextInput'],
};

/**
 * The Add-catalog ids whose feature is experimental (src/modules/catalog.ts FeatureDef.experimental): they work,
 * but their settings and look may still change between versions. The editor's suite checks the list against it.
 */
export const EXPERIMENTAL_TYPES = ['waterVolume'];

/** The types a 2D scene is built from (its physics, camera and world). 3D meshes and lights are not drawn there. */
export const TYPES_2D = ['camera2D', 'sprite', 'animatedSprite', 'tilemap', 'characterBody2D', 'body2D', 'room2D', 'parallaxLayer', 'trigger'];

/** Every id, flat. */
export const ALL_ADD_TYPES = Object.values(ADD_TYPES).flat();

/** The `type` field's text: grouped, so an agent finds the right kind of thing without a lookup. */
export function addTypesText() {
    return Object.entries(ADD_TYPES).map(([cat, ids]) => `${cat}: ${ids.join(', ')}`).join('; ')
        + `. A 2D scene uses ${TYPES_2D.join(', ')}.`
        + ` Experimental (works, but may change between versions): ${EXPERIMENTAL_TYPES.join(', ')}.`;
}

/** The asset libraries asset_list reads, by the names it takes as `kind`. */
export const ASSET_KINDS = [
    'template', 'model', 'material', 'terrainMaterial', 'script', 'animation', 'animationField', 'animController',
    'rig', 'aiBrain', 'particleSystem', 'sequence', 'sound', 'texture', 'tileset',
];
