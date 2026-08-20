/**
 * The node type registry: the discriminator every serialized node carries in its `type` field.
 *
 * A leaf module with no imports at all, deliberately. `NodeType` is referenced by the base class, by every
 * subclass constructor and by the parse dispatcher, so anything it depended on would be dragged into all of
 * them — and it sits at the bottom of a module graph that already has more cycles than it should.
 *
 * The string VALUES are a public contract well beyond this file: they are persisted in every saved scene,
 * hand-mirrored by the editor's `ScriptBaseType`, and compared as literals by roughly twenty editor modules
 * and by user game scripts. Adding one is cheap; renaming one is not.
 */


export type NodeType = 'node' | 'model' | 'light' | 'lightProbe' | 'skybox' | 'camera' | 'sprite' | 'animatedSprite' | 'landscape' | 'tilemap' | 'volumetricClouds' | 'skyAtmosphere' | 'lodGroup' | 'cameraRig'
  | 'uiRoot' | 'uiPanel' | 'uiText' | 'uiImage' | 'uiButton' | 'uiStack' | 'uiSpacer'
  | 'uiProgressBar' | 'uiSlider' | 'uiToggle' | 'uiTextInput';

/** The UI node family — every type whose layout is resolved by the scene's UI pass. */
const UI_NODE_TYPES: ReadonlySet<string> = new Set<NodeType>([
  'uiRoot', 'uiPanel', 'uiText', 'uiImage', 'uiButton', 'uiStack', 'uiSpacer',
  'uiProgressBar', 'uiSlider', 'uiToggle', 'uiTextInput',
]);

/**
 * Whether a serialized `type` string belongs to the UI family.
 *
 * Backed by a Set rather than a `startsWith('ui')` test on purpose: the prefix would also claim any
 * future non-UI type that happens to begin with those two letters, and this predicate gates publish
 * stripping, picking and the editor's inspector routing.
 */
export function isUINodeType(type: string): boolean { return UI_NODE_TYPES.has(type); }
