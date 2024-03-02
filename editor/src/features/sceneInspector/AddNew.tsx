import {
  Geometry,
  Material,
  Model,
  Node,
  ModelNode,
  LightNode,
  DirectionalLight,
  PointLight,
  SkyboxNode,
  Skybox,
  CameraNode,
  Camera,
  Vec,
  Spotlight,
  SpriteNode,
  Sprite
} from 'cleo'
import Collapsable from '../../components/Collapsable';
import { useCleoEngine } from '../EngineContext';
import { useEffect, useState } from 'react';
import { CameraGeometry } from '../../utils/EditorModels';
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
import './Styles.css'

interface AddButtonProps {
  onClick: () => void;
  label: string;
  icon: string;
}
function AddButton(props: AddButtonProps) {
  return(
    <div className='add-container'>
      <button className='add-node-button' onClick={() => props.onClick()}>
        <img className='add-node-icon' src={props.icon} alt={props.label} />
      </button>
      {props.label}
    </div>
  )
}

export default function AddNew() {
  const [node, setNode] = useState<Node | null>(null)
  const { editorScene, selectedNode, eventEmmiter, triggers } = useCleoEngine();

  useEffect(() => {
    if (editorScene && selectedNode) {
        const node = editorScene.getNodeById(selectedNode)
        if (node) setNode(node)
    }
  }, [selectedNode])

  const addNode = (newNode: Node) => {
    node?.addChild(newNode);
    eventEmmiter.emit('SELECT_NODE', newNode.id);
  }

  const addTrigger = () => {
    // Just an empty node with a trigger
    const triggerNode = new Node('trigger');
    triggers.set(triggerNode.id, { shapes: [] });
    
    triggers.set(triggerNode.id, { shapes: [ { type: 'sphere', radius: 1, offset: [0, 0, 0], rotation: [0, 0, 0] } ] });
    // add debug shape for the trigger
    const debugTriggerNode = new Node(`__debug__trigger_${triggerNode.id}`);
    debugTriggerNode.onUpdate = (node) => {
      node.setPosition(triggerNode.worldPosition);
      node.setQuaternion(triggerNode.worldQuaternion);
    };

    const debugTriggerModel = new Model(Geometry.Sphere(8), Material.Basic({color: [0, 1, 0]}, {wireframe: true}));
    const triggerModelNode = new ModelNode(`__debug__shape_0`, debugTriggerModel);
    debugTriggerNode?.addChild(triggerModelNode);
    editorScene.addNode(debugTriggerNode);

    addNode(triggerNode);
  }

  const addCamera = (type: 'perspective' | 'orthographic') => { 
    const cameraNode = new CameraNode('camera', new Camera({type}));
    cameraNode.active = true;
    const cameraModel = new Model(
      new Geometry( CameraGeometry.positions, undefined, CameraGeometry.texCoords, undefined, undefined, CameraGeometry.indices, false),
      Material.Basic({color: [0.2, 0.2, 0.75]}, { castShadow: false })
    );
    const debugCameraModel = new ModelNode('__debug__CameraModel', cameraModel);
    debugCameraModel.onUpdate = (node) => {
      // Get the scale from the world matrix of the parent node
      if (!node.parent) return;
      const compensationScale = Vec.mat4.getScaling(Vec.vec3.create(), node.parent.worldTransform);

      // Inverse scale to get the compensation scale
      Vec.vec3.inverse(compensationScale, compensationScale);
  
      // Set the scale of the camera model with the compensation
      node.setScale(compensationScale);
    };
    cameraNode.addChild(debugCameraModel);
    
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

  const addDirectionalLight = () => {
    const directionalLightNode = new LightNode('directional light', new DirectionalLight({}), true);
    const debugLightIcon = new SpriteNode('__editor__LightSprite', new Sprite(Material.Basic({color: [1, 1, 1], texture: '__editor__light_icon'})));
    debugLightIcon.setUniformScale(0.5);
    /* TODO: Add arrow model for direction debugging */
    directionalLightNode.addChild(debugLightIcon);
  }

  const addPointLight = () => {
    const pointLightNode = new LightNode('point light', new PointLight({}));
    const debugLightIcon = new SpriteNode('__editor__LightSprite', new Sprite(Material.Basic({color: [1, 1, 1], texture: '__editor__light_icon'})));
    debugLightIcon.setUniformScale(0.5);
    pointLightNode.addChild(debugLightIcon);
    addNode(pointLightNode);
  }

  const addSpotlight = () => {
    const spotlightNode = new LightNode('spot light', new Spotlight({}));
    const debugLightIcon = new SpriteNode('__editor__LightSprite', new Sprite(Material.Basic({color: [1, 1, 1], texture: '__editor__light_icon'})));
    debugLightIcon.setUniformScale(0.5);
    spotlightNode.addChild(debugLightIcon);
    addNode(spotlightNode);
  }

  const addSprite = () => {
    const sprite = new Sprite(Material.Basic({}));
    const spriteNode = new SpriteNode('sprite', sprite, 'spherical');
    addNode(spriteNode);
  }


  return (
    <Collapsable title='Add'>
      <div className='add-new-container'>
        <div className='node-category'>
          Common
          <div className='node-button-container'>
            <AddButton onClick={() => addNode(new Node('node')) } label='Empty' icon={EmptyIcon} />
            <AddButton onClick={() => addTrigger()} label='Trigger' icon={TriggerIcon} />
          </div>
        </div>
        <div className='node-category'>
          Cameras
          <div className='node-button-container'>
            <AddButton onClick={() => addCamera('perspective')} label='Perspective' icon={CameraIcon} />
            <AddButton onClick={() => addCamera('orthographic')} label='Orthographic' icon={CameraIcon} />
          </div>
        </div>
        <div className='node-category'>
          Lights
          <div className='node-button-container'>
            <AddButton onClick={() => addDirectionalLight() } label='Directional' icon={DirectionalLightIcon} />
            <AddButton onClick={() => addPointLight()} label='Point' icon={PointLightIcon} />
            <AddButton onClick={() => addSpotlight()} label='Spotlight' icon={SpotlightIcon} />
          </div>
        </div>
        <div className='node-category'>
          Sprites
          <div className='node-button-container'>
            <AddButton onClick={() => addSprite()} label='Static' icon={SpriteIcon} />
          </div>
        </div>
        <div className='node-category'>
          Meshes
          <div className='node-button-container'>
            <AddButton onClick={() => addCube()} label='Cube' icon={CubeIcon} />
            <AddButton onClick={() => addSphere()} label='Sphere' icon={SphereIcon} />
            <AddButton onClick={() => addCylinder()} label='Cylinder' icon={CylinderIcon} />
            <AddButton onClick={() => addPlane()} label='Plane' icon={PlaneIcon} />
            <div className='add-container'>
              <label className='add-node-button' htmlFor="file">
                <img className='add-node-icon' src={ImportIcon} alt='Import' />
              </label>
              <input type="file" id="file" name="file" multiple accept='.obj, .mtl, .glb' onChange={(e) => {
                const files = e.target.files;
                if (files) {
                  const filesArray = Array.from(files);
                  Model.fromFile({ files: filesArray }).then((models) => {
                    const node = new Node('model');
                    for (const model of models) {
                      const modelNode = new ModelNode(model.name, model.model);
                      node.addChild(modelNode);
                    }
                    addNode(node);
                  })
                  .catch( err => console.error(err) );
                }
              }} />
              Import
            </div>
          </div>
        </div>
        <div className='node-category'>
          Environment
          <div className='node-button-container'>
            <AddButton onClick={() => addSkybox()} label='Skybox' icon={SkyboxIcon} />
          </div>
        </div>
      </div>
    </Collapsable>
  )
}
