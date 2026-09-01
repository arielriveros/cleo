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
  SkyLightNode,
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
import type EventEmitter from '../../utils/eventEmitter'
import type { ShapeDescription } from '../EngineContext'
import {
  CanvasIcon, WorldUIIcon, PanelIcon, StackIcon, SpacerIcon, TextIcon, ImageIcon,
  ButtonIcon, ProgressIcon, SliderIcon, ToggleIcon, TextInputIcon,
} from './uiIcons'
import {
  CubeIcon, SphereIcon, CylinderIcon, CapsuleIcon, ConeIcon, TorusIcon, PyramidIcon,
  QuadIcon, CircleIcon, TriangleIcon,
  RampIcon, CornerRampIcon, StairsIcon, SpiralStairsIcon, ArchIcon, TubeIcon, HollowBoxIcon,
} from './primitiveIcons'
import {
  EmptyIcon, TriggerIcon, CameraIcon, CameraRigIcon,
  DirectionalLightIcon, PointLightIcon, SpotlightIcon, LightProbeIcon,
  SpriteIcon, AnimatedSpriteIcon, TilemapIcon,
  SkyboxIcon, SkyAtmosphereIcon, SkyLightIcon, CloudsIcon, LandscapeIcon,
} from './nodeIcons'

// The catalog of addable node types, as data rather than closures inside AddNew: the same item is created
// from the Add grid's click, a drop on the scene tree and a drop into the viewport, and the last two
// receive only the item's `id` through a DataTransfer.
export const NEW_NODE_MIME = 'text/cleo-new-node';

export type AddCategory = 'common' | 'cameras' | 'lights' | 'sprites' | 'primitives' | 'complex'
  | 'environment' | 'uiLayout' | 'uiCore' | 'uiWidgets';

export const ADD_CATEGORIES: { value: AddCategory, label: string }[] = [
  { value: 'common', label: 'Common' },
  { value: 'cameras', label: 'Cameras' },
  { value: 'lights', label: 'Lights' },
  { value: 'sprites', label: 'Sprites' },
  // The values are internal; renaming one invalidates the stored cleo.addnew.category preference.
  { value: 'primitives', label: 'Primitive Geometries' },
  { value: 'complex', label: 'Complex Geometries' },
  { value: 'environment', label: 'Environment' },
  // UI categories. Shown only in `ui` mode (see AddNew).
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
  /** An inline SVG glyph. Components rather than image URLs so an icon tints with its cell's text colour. */
  icon: React.ComponentType;
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
  // Shipped with its camera child already attached: a rig with no camera does nothing.
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
    // No tileset yet: a fresh sprite draws nothing until one is assigned in the inspector.
    create: async () => new SpriteNode('sprite', new Sprite(), 'spherical'),
  },
  {
    id: 'animatedSprite', label: 'Animated', icon: AnimatedSpriteIcon, category: 'sprites',
    create: async () => new AnimatedSpriteNode('animated sprite', new Sprite(),
      { frames: [], fps: 12, loop: true, constraints: 'spherical' }),
  },

  // Primitives. Solids first, then the flat shapes, which are double-sided so they do not vanish when
  // orbited past. Cube/Sphere/Cylinder keep their original geometry arguments and node scales; the later
  // additions are authored at unit size with an identity transform.
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
    id: 'capsule', label: 'Capsule', icon: CapsuleIcon, category: 'primitives',
    // radius 0.25 + a 0.5 straight section = 1 unit tall overall (Capsule's height argument is the
    // straight section only, matching Shape.Capsule).
    create: async () => new ModelNode('capsule', new Model(Geometry.Capsule(24, 0.25, 0.5), Material.Default({}))),
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
    id: 'cone', label: 'Cone', icon: ConeIcon, category: 'primitives',
    create: async () => new ModelNode('cone', new Model(Geometry.Cone(24, 0.5, 1), Material.Default({}))),
  },
  {
    id: 'torus', label: 'Torus', icon: TorusIcon, category: 'primitives',
    create: async () => new ModelNode('torus', new Model(Geometry.Torus(32, 16, 0.35, 0.15), Material.Default({}))),
  },
  {
    id: 'pyramid', label: 'Pyramid', icon: PyramidIcon, category: 'primitives',
    create: async () => new ModelNode('pyramid', new Model(Geometry.Pyramid(1, 1), Material.Default({}))),
  },
  {
    id: 'quad', label: 'Quad', icon: QuadIcon, category: 'primitives',
    create: async () => new ModelNode('quad', new Model(Geometry.Quad(), Material.Default({}, { side: 'double' }))),
  },
  {
    // A Quad with interior vertices. `Geometry.Plane` has existed and been documented for exactly this
    // and had no caller at all, which meant the one primitive built to carry a height field was the one
    // nobody could place. 16x16 gives 512 triangles before any subdivision: enough that vertex
    // displacement shows relief immediately rather than moving four corners.
    id: 'plane', label: 'Plane', icon: QuadIcon, category: 'primitives',
    create: async () => new ModelNode('plane', new Model(Geometry.Plane(2, 2, 16, 16), Material.Default({}, { side: 'double' }))),
  },
  {
    id: 'circle', label: 'Circle', icon: CircleIcon, category: 'primitives',
    create: async () => new ModelNode('circle', new Model(Geometry.Circle(1, 32), Material.Default({}, { side: 'double' }))),
  },
  {
    id: 'triangle', label: 'Triangle', icon: TriangleIcon, category: 'primitives',
    create: async () => new ModelNode('triangle', new Model(Geometry.Triangle(), Material.Default({}, { side: 'double' }))),
  },

  // Complex geometries: parametric level-blockout pieces, authored at unit size with an identity transform
  // as solid single-sided shells, so scaling the node is how one is fitted to a space. Bare ModelNodes:
  // the Physics panel fits a collider on demand.
  {
    id: 'ramp', label: 'Ramp', icon: RampIcon, category: 'complex',
    create: async () => new ModelNode('ramp', new Model(Geometry.Ramp(1, 1, 1), Material.Default({}))),
  },
  {
    id: 'cornerRamp', label: 'Corner Ramp', icon: CornerRampIcon, category: 'complex',
    create: async () => new ModelNode('cornerRamp', new Model(Geometry.CornerRamp(1, 1, 1), Material.Default({}))),
  },
  {
    id: 'stairs', label: 'Stairs', icon: StairsIcon, category: 'complex',
    create: async () => new ModelNode('stairs', new Model(Geometry.Stairs(8, 1, 1, 1), Material.Default({}))),
  },
  {
    id: 'spiralStairs', label: 'Spiral Stairs', icon: SpiralStairsIcon, category: 'complex',
    create: async () => new ModelNode('spiralStairs', new Model(Geometry.SpiralStairs(12, 0.12, 0.5, 1), Material.Default({}))),
  },
  {
    id: 'arch', label: 'Arch', icon: ArchIcon, category: 'complex',
    create: async () => new ModelNode('arch', new Model(Geometry.Arch(24, 0.5, 0.15, 0.3), Material.Default({}))),
  },
  {
    id: 'tube', label: 'Tube', icon: TubeIcon, category: 'complex',
    create: async () => new ModelNode('tube', new Model(Geometry.Tube(32, 0.5, 0.35, 1), Material.Default({}))),
  },
  {
    id: 'hollowBox', label: 'Hollow Box', icon: HollowBoxIcon, category: 'complex',
    create: async () => new ModelNode('hollowBox', new Model(Geometry.HollowBox(1, 1, 1, 0.1), Material.Default({}))),
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
    id: 'lightProbe', label: 'Light Probe', icon: LightProbeIcon, category: 'environment',
    // New probes get a bounded influence volume out of the box; probes from legacy scenes
    // deserialize size [0,0,0] = unbounded (whole scene).
    create: async () => new LightProbeNode('light probe', { size: [10, 10, 10] }),
  },
  {
    // Scene-wide, so unplaceable — unlike a light probe, which has a volume.
    id: 'skyLight', label: 'Sky Light', icon: SkyLightIcon, category: 'environment', placeable: false,
    create: async () => new SkyLightNode('sky light'),
  },
  {
    id: 'volumetricClouds', label: 'Clouds', icon: CloudsIcon, category: 'environment', placeable: false,
    create: async () => new VolumetricCloudsNode('volumetric clouds'),
  },
  {
    id: 'landscape', label: 'Landscape', icon: LandscapeIcon, category: 'environment', placeable: false,
    // Not placeable: a terrain spans +/-size/2 around its own origin, so dropping one at an arbitrary
    // raycast point (possibly mid-air) is worse than putting it at 0.
    create: async () => new LandscapeNode('landscape', new Terrain({ size: 200, resolution: 129, chunkQuads: 32 })),
  },
  {
    id: 'tilemap', label: 'Tilemap', icon: TilemapIcon, category: 'sprites',
    // One default layer, or there is nothing to paint on and the layers panel opens empty. Unit cells:
    // they line up with the 2D camera's default extents, and a tileset's pixel size is world-independent.
    create: async () => {
      const tilemap = new Tilemap({ kind: 'orthogonal', cellWidth: 1, cellHeight: 1 });
      tilemap.addLayer({ name: 'Ground' });
      return new TilemapNode('tilemap', tilemap);
    },
  },

  // --- UI ---------------------------------------------------------------------------------------
  // Every screen-space type is `placeable: false`: a viewport drop resolves a WORLD position, meaningless
  // for something anchored to the screen. World UI is the exception.
  {
    id: 'uiCanvas', label: 'Canvas', icon: CanvasIcon, category: 'uiLayout', placeable: false,
    create: async () => new UIRootNode('UI', 'screen'),
  },
  {
    id: 'uiWorldRoot', label: 'World UI', icon: WorldUIIcon, category: 'uiLayout', placeable: true,
    // Pivot at the bottom centre so the element hangs ABOVE its anchor point.
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
    // No texture yet: a fresh image draws nothing until one is assigned in the inspector.
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
 * Only a {@link UIRootNode} subtree is resolved by the layout pass, so a UI item dropped outside one is
 * retargeted to the scene's first root, creating one if the scene has none. Applied inside `addItemTo` so
 * the Add-grid click and both drop paths inherit it.
 * A root itself is exempt: nesting a Canvas under another Canvas is meaningful.
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
