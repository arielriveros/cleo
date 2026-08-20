import {
  Geometry,
  Material,
  Model,
  Node,
  ModelNode,
  LightNode,
  LightProbeNode,
  DirectionalLight,
  PointLight,
  SkyboxNode,
  Skybox,
  CameraNode,
  CameraRigNode,
  Camera,
  Spotlight,
  SpriteNode,
  Sprite,
  AnimatedSpriteNode,
  VolumetricCloudsNode,
  SkyAtmosphereNode,
  TilemapNode,
  Tilemap,
  LandscapeNode,
  Terrain,
  Scene,
  Node as CleoNode,
  UINode,
  UIRootNode,
  UIPanelNode,
  UITextNode,
  UIImageNode,
  UIButtonNode,
  UIStackNode,
  UISpacerNode,
  UIProgressBarNode,
  UISliderNode,
  UIToggleNode,
  UITextInputNode,
} from 'cleo'
import type EventEmitter from 'events'
import type { ShapeDescription } from '../EngineContext'
import CameraIcon from '../../icons/camera.png'
import CameraRigIcon from '../../icons/camera-rig.png'
import SkyboxIcon from '../../icons/skybox.png'
import CubeIcon from '../../icons/cube.png'
import PlaneIcon from '../../icons/plane.png'
import SphereIcon from '../../icons/sphere.png'
import CylinderIcon from '../../icons/cylinder.png'
import EmptyIcon from '../../icons/empty.png'
import TriggerIcon from '../../icons/trigger.png'
import PointLightIcon from '../../icons/point-light.png'
import DirectionalLightIcon from '../../icons/directional-light.png'
import SpotlightIcon from '../../icons/spotlight.png'
import SpriteIcon from '../../icons/static-sprite.png'
import AnimatedSpriteIcon from '../../icons/animated-sprite.png'
import CloudsIcon from '../../icons/clouds.png'
import SkyAtmosphereIcon from '../../icons/sky-atmosphere.png'
import TilemapIcon from '../../icons/tilemap.png'
import LandscapeIcon from '../../icons/landscape.png'
import {
  CanvasIcon, WorldUIIcon, PanelIcon, StackIcon, SpacerIcon, TextIcon, ImageIcon,
  ButtonIcon, ProgressIcon, SliderIcon, ToggleIcon, TextInputIcon,
} from './uiIcons'

// The catalog of addable node types. It is data rather than a set of closures inside AddNew because the
// same item can now be created from three places: the Add grid's click, a drop on the scene tree, and a
// drop into the viewport — the latter two only receive the item's `id` through a DataTransfer.
export const NEW_NODE_MIME = 'text/cleo-new-node';

export type AddCategory = 'common' | 'cameras' | 'lights' | 'sprites' | 'primitives' | 'environment'
  | 'uiLayout' | 'uiCore' | 'uiWidgets';

export const ADD_CATEGORIES: { value: AddCategory, label: string }[] = [
  { value: 'common', label: 'Common' },
  { value: 'cameras', label: 'Cameras' },
  { value: 'lights', label: 'Lights' },
  { value: 'sprites', label: 'Sprites' },
  { value: 'primitives', label: 'Primitives' },
  { value: 'environment', label: 'Environ.' },
  // UI categories. Shown only in `ui` mode (see AddNew) — a HUD element dropped into a scene-mode
  // session would be authored with no way to see what it looks like.
  { value: 'uiLayout', label: 'Layout' },
  { value: 'uiCore', label: 'Elements' },
  { value: 'uiWidgets', label: 'Widgets' },
];

/** The three UI-only categories, hidden outside `ui` mode. */
export const UI_CATEGORIES: readonly AddCategory[] = ['uiLayout', 'uiCore', 'uiWidgets'];

export interface AddContext {
  editorScene: Scene;
  eventEmitter: EventEmitter;
  triggers: Map<string, { shapes: ShapeDescription[] }>;
}

export interface AddItem {
  id: string;
  label: string;
  /** A PNG import, or an inline SVG component — the house style for new chrome (see ModeSelector). */
  icon: string | React.ComponentType;
  category: AddCategory;
  /** False for nodes a world position is meaningless for (sky, clouds) — a viewport drop won't place them. */
  placeable?: boolean;
  /** Builds the node but does NOT parent it: the caller decides where it lands. */
  create(ctx: AddContext): Promise<Node>;
}

// Only one sky at a time: adding a Skybox removes any existing Sky Atmosphere, and vice-versa.
// Use the synchronous removeNode (not the deferred Node.remove) per the EngineContext caveat.
function removeExistingSky(ctx: AddContext, kind: 'skybox' | 'skyAtmosphere') {
  const other = kind === 'skybox' ? ctx.editorScene.skyAtmosphere : ctx.editorScene.skybox;
  if (other) {
    ctx.editorScene.removeNode(other);
    ctx.eventEmitter.emit('SCENE_CHANGED');
  }
}

export const ADD_ITEMS: AddItem[] = [
  {
    id: 'empty', label: 'Empty', icon: EmptyIcon, category: 'common',
    create: async () => new Node('node'),
  },
  {
    id: 'trigger', label: 'Trigger', icon: TriggerIcon, category: 'common',
    // Just an empty node with a trigger; the editor-helper reconciler draws its debug wireframe.
    create: async (ctx) => {
      const triggerNode = new Node('trigger');
      ctx.triggers.set(triggerNode.id, { shapes: [{ type: 'sphere', radius: 1, offset: [0, 0, 0], rotation: [0, 0, 0] }] });
      ctx.eventEmitter.emit('PHYSICS_CHANGED');
      return triggerNode;
    },
  },

  // The reconciler adds the frustum gizmo (__debug__CameraModel) from the CameraNode itself.
  {
    id: 'perspectiveCamera', label: 'Perspective', icon: CameraIcon, category: 'cameras',
    create: async () => {
      const cameraNode = new CameraNode('camera', new Camera({ type: 'perspective' }));
      cameraNode.active = true;
      return cameraNode;
    },
  },
  {
    id: 'orthographicCamera', label: 'Orthographic', icon: CameraIcon, category: 'cameras',
    create: async () => {
      const cameraNode = new CameraNode('camera', new Camera({ type: 'orthographic' }));
      cameraNode.active = true;
      return cameraNode;
    },
  },
  // Shipped with its camera child already attached: a rig with no camera does nothing, and making
  // the user assemble the pair by hand is the first thing they would get wrong.
  {
    id: 'cameraRig', label: 'Camera Rig', icon: CameraRigIcon, category: 'cameras',
    create: async () => {
      const rig = new CameraRigNode('camera rig');
      const cameraNode = new CameraNode('camera', new Camera({ type: 'perspective' }));
      cameraNode.active = true;
      rig.addChild(cameraNode);
      return rig;
    },
  },

  // Lights/probes get their editor icon (__editor__LightSprite / __editor__ProbeHelper) added
  // automatically by the reconciler, keyed off the node type.
  {
    id: 'directionalLight', label: 'Directional', icon: DirectionalLightIcon, category: 'lights',
    create: async () => new LightNode('directional light', new DirectionalLight({}), true),
  },
  {
    id: 'pointLight', label: 'Point', icon: PointLightIcon, category: 'lights',
    create: async () => new LightNode('point light', new PointLight({})),
  },
  {
    id: 'spotlight', label: 'Spotlight', icon: SpotlightIcon, category: 'lights',
    create: async () => new LightNode('spot light', new Spotlight({})),
  },

  {
    id: 'sprite', label: 'Static', icon: SpriteIcon, category: 'sprites',
    // No tileset yet: a fresh sprite draws nothing until one is assigned in the inspector, the same
    // way a tilemap layer with no tileset does.
    create: async () => new SpriteNode('sprite', new Sprite(), 'spherical'),
  },
  {
    id: 'animatedSprite', label: 'Animated', icon: AnimatedSpriteIcon, category: 'sprites',
    create: async () => new AnimatedSpriteNode('animated sprite', new Sprite(),
      { frames: [], fps: 12, loop: true, constraints: 'spherical' }),
  },

  {
    id: 'cube', label: 'Cube', icon: CubeIcon, category: 'primitives',
    create: async () => new ModelNode('cube', new Model(Geometry.Cube(), Material.Default({}))),
  },
  {
    id: 'sphere', label: 'Sphere', icon: SphereIcon, category: 'primitives',
    create: async () => {
      const sphereNode = new ModelNode('sphere', new Model(Geometry.Sphere(), Material.Default({})));
      sphereNode.setUniformScale(0.5);
      return sphereNode;
    },
  },
  {
    id: 'cylinder', label: 'Cylinder', icon: CylinderIcon, category: 'primitives',
    create: async () => {
      const cylinderNode = new ModelNode('cylinder', new Model(Geometry.Cylinder(16), Material.Default({})));
      cylinderNode.setScale([0.5, 1, 0.5]);
      return cylinderNode;
    },
  },
  {
    id: 'plane', label: 'Plane', icon: PlaneIcon, category: 'primitives',
    create: async () => new ModelNode('plane', new Model(Geometry.Quad(), Material.Default({}, { side: 'double' }))),
  },

  {
    id: 'skybox', label: 'Skybox', icon: SkyboxIcon, category: 'environment', placeable: false,
    create: async (ctx) => {
      removeExistingSky(ctx, 'skybox');
      const imgSrc = await import('../../images/null.png');
      const img = new Image();
      img.src = imgSrc.default;
      await new Promise<void>(resolve => { img.onload = () => resolve(); });
      return new SkyboxNode('skybox', new Skybox({
        posX: img, negX: img, posY: img, negY: img, posZ: img, negZ: img,
      }));
    },
  },
  {
    id: 'skyAtmosphere', label: 'Sky Atmosphere', icon: SkyAtmosphereIcon, category: 'environment', placeable: false,
    create: async (ctx) => {
      removeExistingSky(ctx, 'skyAtmosphere');
      return new SkyAtmosphereNode('sky atmosphere');
    },
  },
  {
    id: 'lightProbe', label: 'Light Probe', icon: SphereIcon, category: 'environment',
    // New probes get a bounded influence volume out of the box; probes from legacy scenes
    // deserialize size [0,0,0] = unbounded (whole scene).
    create: async () => new LightProbeNode('light probe', { size: [10, 10, 10] }),
  },
  {
    id: 'volumetricClouds', label: 'Clouds', icon: CloudsIcon, category: 'environment', placeable: false,
    create: async () => new VolumetricCloudsNode('volumetric clouds'),
  },
  {
    id: 'landscape', label: 'Landscape', icon: LandscapeIcon, category: 'environment', placeable: false,
    // Not placeable, like the clouds and the sky: a terrain spans +/-size/2 around its own origin, so
    // dropping one at an arbitrary raycast point (possibly mid-air) is worse than putting it at 0.
    // These defaults are the ones the old "Create Terrain" button used.
    create: async () => new LandscapeNode('landscape', new Terrain({ size: 200, resolution: 129, chunkQuads: 32 })),
  },
  {
    id: 'tilemap', label: 'Tilemap', icon: TilemapIcon, category: 'sprites',
    // One default layer, because a map with no layer has nothing to paint on and the layers panel would
    // open empty. Unit cells: they line up with the 2D camera's default extents, and a tileset's pixel
    // size is decoupled from world size anyway.
    create: async () => {
      const tilemap = new Tilemap({ kind: 'orthogonal', cellWidth: 1, cellHeight: 1 });
      tilemap.addLayer({ name: 'Ground' });
      return new TilemapNode('tilemap', tilemap);
    },
  },

  // --- UI ---------------------------------------------------------------------------------------
  // Every screen-space type is `placeable: false`: a viewport drop resolves a WORLD position, which is
  // meaningless for something anchored to the screen. World UI is the deliberate exception — dropping one
  // at the raycast point is exactly what you want.
  {
    id: 'uiCanvas', label: 'Canvas', icon: CanvasIcon, category: 'uiLayout', placeable: false,
    create: async () => new UIRootNode('UI', 'screen'),
  },
  {
    id: 'uiWorldRoot', label: 'World UI', icon: WorldUIIcon, category: 'uiLayout', placeable: true,
    // Pivot at the bottom centre so the element hangs ABOVE its anchor point, which is what a nameplate
    // or a health bar over a character wants out of the box.
    create: async () => {
      const root = new UIRootNode('world ui', 'world');
      root.pivot = [0.5, 1];
      return root;
    },
  },
  {
    id: 'uiStackColumn', label: 'Column', icon: StackIcon, category: 'uiLayout', placeable: false,
    create: async () => new UIStackNode('column', 'column'),
  },
  {
    id: 'uiStackRow', label: 'Row', icon: StackIcon, category: 'uiLayout', placeable: false,
    create: async () => new UIStackNode('row', 'row'),
  },
  {
    id: 'uiSpacer', label: 'Spacer', icon: SpacerIcon, category: 'uiLayout', placeable: false,
    create: async () => new UISpacerNode('spacer'),
  },

  {
    id: 'uiPanel', label: 'Panel', icon: PanelIcon, category: 'uiCore', placeable: false,
    create: async () => new UIPanelNode('panel'),
  },
  {
    id: 'uiText', label: 'Text', icon: TextIcon, category: 'uiCore', placeable: false,
    create: async () => new UITextNode('text'),
  },
  {
    id: 'uiImage', label: 'Image', icon: ImageIcon, category: 'uiCore', placeable: false,
    // No texture yet: a fresh image draws nothing until one is assigned in the inspector, the same way a
    // fresh sprite with no tileset does.
    create: async () => new UIImageNode('image'),
  },
  {
    id: 'uiButton', label: 'Button', icon: ButtonIcon, category: 'uiCore', placeable: false,
    create: async () => new UIButtonNode('button'),
  },

  {
    id: 'uiProgressBar', label: 'Progress', icon: ProgressIcon, category: 'uiWidgets', placeable: false,
    create: async () => new UIProgressBarNode('progress bar'),
  },
  {
    id: 'uiSlider', label: 'Slider', icon: SliderIcon, category: 'uiWidgets', placeable: false,
    create: async () => new UISliderNode('slider'),
  },
  {
    id: 'uiToggle', label: 'Toggle', icon: ToggleIcon, category: 'uiWidgets', placeable: false,
    create: async () => new UIToggleNode('toggle'),
  },
  {
    id: 'uiTextInput', label: 'Text Input', icon: TextInputIcon, category: 'uiWidgets', placeable: false,
    create: async () => new UITextInputNode('text input'),
  },
];

export function findAddItem(id: string): AddItem | undefined {
  return ADD_ITEMS.find(item => item.id === id);
}

/**
 * Where a UI element should actually be parented.
 *
 * A UI element under a `ModelNode` is not an error the user will see — it is a node that silently never
 * renders, because only a {@link UIRootNode} subtree is resolved by the layout pass. So a UI item dropped
 * anywhere outside a UI subtree is retargeted to the scene's first root, creating one if the scene has
 * none. Applied inside `addItemTo` so the Add-grid click and BOTH drop paths (scene tree, viewport)
 * inherit it rather than each growing their own copy.
 *
 * A root itself is exempt: nesting a Canvas under another Canvas is meaningful (a world-space nameplate
 * authored inside a HUD), and a root's rect comes from the viewport or its projection either way.
 */
function resolveUIParent(item: AddItem, parent: Node, ctx: AddContext, created: Node): Node {
  if (!(created instanceof UINode)) return parent;
  if (created instanceof UIRootNode) return parent;
  if (parent instanceof UINode) return parent;

  const existing = ctx.editorScene.uiRoots.values().next().value;
  if (existing) return existing;

  const root = new UIRootNode('UI', 'screen');
  ctx.editorScene.root.addChild(root);
  return root;
}

/** Create the item, parent it under `parent` and select it. Returns the new node. */
export async function addItemTo(item: AddItem, parent: Node, ctx: AddContext): Promise<Node> {
  const node = await item.create(ctx);
  resolveUIParent(item, parent, ctx, node).addChild(node); // Node.addChild emits SCENE_CHANGED itself
  ctx.eventEmitter.emit('SELECT_NODE', node.id);
  return node;
}
