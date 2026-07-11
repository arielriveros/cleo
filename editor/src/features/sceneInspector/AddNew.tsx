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
  AnimatedSpriteNode
} from 'cleo'
import Collapsable from '../../components/Collapsable';
import { useCleoEngine } from '../EngineContext';
import { useEffect, useState } from 'react';
import CameraIcon from '../../icons/camera.png'
import SkyboxIcon from '../../icons/skybox.png'
import CubeIcon from '../../icons/cube.png'
import PlaneIcon from '../../icons/plane.png'
import SphereIcon from '../../icons/sphere.png'
import CylinderIcon from '../../icons/cylinder.png'
import EmptyIcon from '../../icons/empty.png'
import TriggerIcon from '../../icons/trigger.png'
import ImportIcon from '../../icons/import.png'
import PointLightIcon from '../../icons/point-light.png'
import DirectionalLightIcon from '../../icons/directional-light.png'
import SpotlightIcon from '../../icons/spotlight.png'
import SpriteIcon from '../../icons/static-sprite.png'
import AnimatedSpriteIcon from '../../icons/animated-sprite.png'

interface AddButtonProps {
  onClick: () => void;
  label: string;
  icon: string;
}
function AddButton(props: AddButtonProps) {
  return(
    <div className='flex flex-col items-center font-thin text-sm px-[1px]'>
      <button className='flex items-center justify-center w-[40px] h-[40px] border border-[#3b3b3b] rounded-[2px] bg-[#3b3b3b] text-white cursor-pointer' onClick={() => props.onClick()}>
        <img className='flex items-center justify-center w-[35px] h-[35px]' src={props.icon} alt={props.label} />
      </button>
      {props.label}
    </div>
  )
}

export default function AddNew() {
  const [node, setNode] = useState<Node | null>(null)
  const { editorScene, selectedNode, eventEmitter: eventEmitter, triggers, importMeshFiles } = useCleoEngine();

  useEffect(() => {
    if (editorScene && selectedNode) {
        const node = editorScene.getNodeById(selectedNode)
        if (node) setNode(node)
    }
  }, [selectedNode])

  const addNode = (newNode: Node) => {
    node?.addChild(newNode);
    eventEmitter.emit('SELECT_NODE', newNode.id);
  }

  const addTrigger = () => {
    // Just an empty node with a trigger; the editor-helper reconciler draws its debug wireframe.
    const triggerNode = new Node('trigger');
    triggers.set(triggerNode.id, { shapes: [ { type: 'sphere', radius: 1, offset: [0, 0, 0], rotation: [0, 0, 0] } ] });
    eventEmitter.emit('PHYSICS_CHANGED');
    addNode(triggerNode);
  }

  const addCamera = (type: 'perspective' | 'orthographic') => {
    // The reconciler adds the frustum gizmo (__debug__CameraModel) from the CameraNode itself.
    const cameraNode = new CameraNode('camera', new Camera({type}));
    cameraNode.active = true;
    addNode(cameraNode);
  }

  const addCube = () => {
    const cubeNode = new ModelNode('cube', new Model(Geometry.Cube(), Material.Default({})));
    addNode(cubeNode);
  }

  const addSphere = () => {
    const sphereNode = new ModelNode('sphere', new Model(Geometry.Sphere(), Material.Default({})));
    sphereNode.setUniformScale(0.5);
    addNode(sphereNode);
  }

  const addCylinder = () => {
    const cylinderNode = new ModelNode('cylinder', new Model(Geometry.Cylinder(16), Material.Default({})));
    cylinderNode.setScale([0.5, 1, 0.5]);
    addNode(cylinderNode);
  }

  const addPlane = () => {
    const planeNode = new ModelNode('plane', new Model(Geometry.Quad(), Material.Default({}, {side: 'double'})));
    addNode(planeNode);
  }

  const addSkybox = () => {
    import ('../../images/null.png').then( (imgSrc) => {
      const img = new Image();
      img.src = imgSrc.default;
      img.onload = () => {
        const skyboxNode = new SkyboxNode('skybox', new Skybox({
          posX: img,
          negX: img,
          posY: img,
          negY: img,
          posZ: img,
          negZ: img,
        }));
        addNode(skyboxNode);
      }
    })
  }

  // Lights/probes get their editor icon (__editor__LightSprite / __editor__ProbeHelper) added
  // automatically by the reconciler, keyed off the node type.
  const addDirectionalLight = () => {
    addNode(new LightNode('directional light', new DirectionalLight({}), true));
  }

  const addPointLight = () => {
    addNode(new LightNode('point light', new PointLight({})));
  }

  const addSpotlight = () => {
    addNode(new LightNode('spot light', new Spotlight({})));
  }

  const addLightProbe = () => {
    addNode(new LightProbeNode('light probe'));
  }

  const addSprite = () => {
    const sprite = new Sprite(Material.Basic({}));
    const spriteNode = new SpriteNode('sprite', sprite, 'spherical');
    addNode(spriteNode);
  }

  const addAnimatedSprite = () => {
    const sprite = new Sprite(Material.Basic({}));
    const node = new AnimatedSpriteNode('animated sprite', sprite, { columns: 4, rows: 4, fps: 12, loop: true, constraints: 'spherical' });
    addNode(node);
  }

  // Shared import handler for both the single-file and whole-folder inputs. Imports now land in the
  // Meshes library (each model file becomes a reusable mesh asset with a thumbnail); drag a card from
  // the Meshes tab into the viewport to place it. A folder pick (webkitdirectory) lets a .gltf with an
  // external textures/ folder resolve (the browser hands us every file with its webkitRelativePath).
  const importModelFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    eventEmitter.emit('FOCUS_BOTTOM_TAB', 'Meshes'); // surface the library so the new cards are visible
    importMeshFiles(Array.from(files)).catch(err => console.error(err));
  }


  return (
    <Collapsable title='Add'>
      <div className='flex flex-row font-thin px-[2px] flex-wrap w-full'>
        <div className='flex flex-col items-center font-medium mr-[10px]'>
          Common
          <div className='flex flex-row w-full items-center justify-evenly'>
            <AddButton onClick={() => addNode(new Node('node')) } label='Empty' icon={EmptyIcon} />
            <AddButton onClick={() => addTrigger()} label='Trigger' icon={TriggerIcon} />
          </div>
        </div>
        <div className='flex flex-col items-center font-medium mr-[10px]'>
          Cameras
          <div className='flex flex-row w-full items-center justify-evenly'>
            <AddButton onClick={() => addCamera('perspective')} label='Perspective' icon={CameraIcon} />
            <AddButton onClick={() => addCamera('orthographic')} label='Orthographic' icon={CameraIcon} />
          </div>
        </div>
        <div className='flex flex-col items-center font-medium mr-[10px]'>
          Lights
          <div className='flex flex-row w-full items-center justify-evenly'>
            <AddButton onClick={() => addDirectionalLight() } label='Directional' icon={DirectionalLightIcon} />
            <AddButton onClick={() => addPointLight()} label='Point' icon={PointLightIcon} />
            <AddButton onClick={() => addSpotlight()} label='Spotlight' icon={SpotlightIcon} />
          </div>
        </div>
        <div className='flex flex-col items-center font-medium mr-[10px]'>
          Sprites
          <div className='flex flex-row w-full items-center justify-evenly'>
            <AddButton onClick={() => addSprite()} label='Static' icon={SpriteIcon} />
            <AddButton onClick={() => addAnimatedSprite()} label='Animated' icon={AnimatedSpriteIcon} />
          </div>
        </div>
        <div className='flex flex-col items-center font-medium mr-[10px]'>
          Meshes
          <div className='flex flex-row w-full items-center justify-evenly'>
            <AddButton onClick={() => addCube()} label='Cube' icon={CubeIcon} />
            <AddButton onClick={() => addSphere()} label='Sphere' icon={SphereIcon} />
            <AddButton onClick={() => addCylinder()} label='Cylinder' icon={CylinderIcon} />
            <AddButton onClick={() => addPlane()} label='Plane' icon={PlaneIcon} />
            <div className='flex flex-col items-center font-thin text-sm px-[1px]'>
              <label className='flex items-center justify-center w-[40px] h-[40px] border border-[#3b3b3b] rounded-[2px] bg-[#3b3b3b] text-white cursor-pointer' htmlFor="file">
                <img className='flex items-center justify-center w-[35px] h-[35px]' src={ImportIcon} alt='Import' />
              </label>
              <input className='hidden' type="file" id="file" name="file" multiple accept='.obj, .mtl, .gltf, .glb, .png, .jpg, .jpeg, .bmp, .tga, .tiff'
                onChange={(e) => { importModelFiles(e.target.files); e.target.value = ''; }} />
              Import
            </div>
            <div className='flex flex-col items-center font-thin text-sm px-[1px]'>
              <label className='flex items-center justify-center w-[40px] h-[40px] border border-[#3b3b3b] rounded-[2px] bg-[#3b3b3b] text-white cursor-pointer' htmlFor="folder">
                <img className='flex items-center justify-center w-[35px] h-[35px]' src={ImportIcon} alt='Import Folder' />
              </label>
              <input className='hidden' type="file" id="folder" name="folder" {...({ webkitdirectory: '', directory: '' } as any)}
                onChange={(e) => { importModelFiles(e.target.files); e.target.value = ''; }} />
              Folder
            </div>
          </div>
        </div>
        <div className='flex flex-col items-center font-medium mr-[10px]'>
          Environment
          <div className='flex flex-row w-full items-center justify-evenly'>
            <AddButton onClick={() => addSkybox()} label='Skybox' icon={SkyboxIcon} />
            <AddButton onClick={() => addLightProbe()} label='Light Probe' icon={SphereIcon} />
          </div>
        </div>
      </div>
    </Collapsable>
  )
}
