/**
 * The node type registry: the discriminator every serialized node carries in its `type` field.
 *
 * Must stay a leaf with no imports — it sits at the bottom of a module graph full of cycles.
 * The string values are persisted in saved scenes and compared as literals by the editor: adding one is
 * safe, renaming one is not.
 */


export type NodeType = 'node' | 'model' | 'light' | 'lightProbe' | 'skybox' | 'camera' | 'sprite' | 'animatedSprite' | 'landscape' | 'tilemap' | 'volumetricClouds' | 'skyAtmosphere' | 'skyLight' | 'lodGroup' | 'cameraRig'
  | 'uiRoot' | 'uiPanel' | 'uiText' | 'uiImage' | 'uiButton' | 'uiStack' | 'uiSpacer'
  | 'uiProgressBar' | 'uiSlider' | 'uiToggle' | 'uiTextInput';

/** The UI node family — every type whose layout is resolved by the scene's UI pass. */
const UI_NODE_TYPES: ReadonlySet<string> = new Set<NodeType>([
  'uiRoot', 'uiPanel', 'uiText', 'uiImage', 'uiButton', 'uiStack', 'uiSpacer',
  'uiProgressBar', 'uiSlider', 'uiToggle', 'uiTextInput',
]);

/** Whether a serialized `type` string belongs to the UI family. */
export function isUINodeType(type: string): boolean { return UI_NODE_TYPES.has(type); }
