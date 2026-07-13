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
  Camera,
  Spotlight,
  SpriteNode,
  Sprite,
  AnimatedSpriteNode,
  VolumetricCloudsNode,
  SkyAtmosphereNode,
  Scene,
} from 'cleo'
import type EventEmitter from 'events'
import type { ShapeDescription } from '../EngineContext'
import CameraIcon from '../../icons/camera.png'
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

// The catalog of addable node types. It is data rather than a set of closures inside AddNew because the
// same item can now be created from three places: the Add grid's click, a drop on the scene tree, and a
// drop into the viewport — the latter two only receive the item's `id` through a DataTransfer.
export const NEW_NODE_MIME = 'text/cleo-new-node';

export type AddCategory = 'common' | 'cameras' | 'lights' | 'sprites' | 'meshes' | 'environment';

export const ADD_CATEGORIES: { value: AddCategory, label: string }[] = [
  { value: 'common', label: 'Common' },
  { value: 'cameras', label: 'Cameras' },
  { value: 'lights', label: 'Lights' },
  { value: 'sprites', label: 'Sprites' },
  { value: 'meshes', label: 'Meshes' },
  { value: 'environment', label: 'Environ.' },
];

export interface AddContext {
  editorScene: Scene;
  eventEmitter: EventEmitter;
  triggers: Map<string, { shapes: ShapeDescription[] }>;
}

export interface AddItem {
  id: string;
  label: string;
  icon: string;
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
    create: async () => new SpriteNode('sprite', new Sprite(Material.Basic({})), 'spherical'),
  },
  {
    id: 'animatedSprite', label: 'Animated', icon: AnimatedSpriteIcon, category: 'sprites',
    create: async () => new AnimatedSpriteNode('animated sprite', new Sprite(Material.Basic({})),
      { columns: 4, rows: 4, fps: 12, loop: true, constraints: 'spherical' }),
  },

  {
    id: 'cube', label: 'Cube', icon: CubeIcon, category: 'meshes',
    create: async () => new ModelNode('cube', new Model(Geometry.Cube(), Material.Default({}))),
  },
  {
    id: 'sphere', label: 'Sphere', icon: SphereIcon, category: 'meshes',
    create: async () => {
      const sphereNode = new ModelNode('sphere', new Model(Geometry.Sphere(), Material.Default({})));
      sphereNode.setUniformScale(0.5);
      return sphereNode;
    },
  },
  {
    id: 'cylinder', label: 'Cylinder', icon: CylinderIcon, category: 'meshes',
    create: async () => {
      const cylinderNode = new ModelNode('cylinder', new Model(Geometry.Cylinder(16), Material.Default({})));
      cylinderNode.setScale([0.5, 1, 0.5]);
      return cylinderNode;
    },
  },
  {
    id: 'plane', label: 'Plane', icon: PlaneIcon, category: 'meshes',
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
    create: async () => new LightProbeNode('light probe'),
  },
  {
    id: 'volumetricClouds', label: 'Clouds', icon: CloudsIcon, category: 'environment', placeable: false,
    create: async () => new VolumetricCloudsNode('volumetric clouds'),
  },
];

export function findAddItem(id: string): AddItem | undefined {
  return ADD_ITEMS.find(item => item.id === id);
}

/** Create the item, parent it under `parent` and select it. Returns the new node. */
export async function addItemTo(item: AddItem, parent: Node, ctx: AddContext): Promise<Node> {
  const node = await item.create(ctx);
  parent.addChild(node); // Node.addChild emits SCENE_CHANGED itself
  ctx.eventEmitter.emit('SELECT_NODE', node.id);
  return node;
}
