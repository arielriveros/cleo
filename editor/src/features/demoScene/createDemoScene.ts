import { Scene, Camera, LightNode, DirectionalLight, CameraNode, InputManager, Model, AnimatedModel, Geometry, Material, Node, ModelNode, Vec, SpriteNode, Sprite, Texture, Loader, Skybox, SkyboxNode } from 'cleo';
import { CameraGeometry, GridGeometry } from '../../utils/EditorModels';
import type { BodyDescription, ShapeDescription } from '../EngineContext';

export async function createDemoScene(params: {
  scene: Scene,
  scripts: Map<string, string>,
  bodies: Map<string, BodyDescription>,
  triggers: Map<string, { shapes: ShapeDescription[] }>,
}): Promise<void> {
  const { scene, scripts, bodies, triggers } = params;

  // Editor Camera
  const editorCameraNode = new CameraNode('__editor__Camera', new Camera({ far: 10000 }));
  editorCameraNode.active = true;
  editorCameraNode.setPosition([4, 4, 4]).setRotation([30, -135, 0]);

  // Grid + Axes
  const grid = GridGeometry(200);
  const editorGridNode = new ModelNode('__editor__Grid', new Model(
    new Geometry(grid.positions, undefined, grid.texCoords, undefined, undefined, grid.indices, false),
    Material.Basic({ color: [0.75, 0.75, 0.75] }, { wireframe: true })
  ));

  const xAxis = new ModelNode('__editor__Xaxis', new Model(
    new Geometry([[-200, 0, 0], [200, 0, 0]], undefined, undefined, undefined, undefined, [0, 1], false),
    Material.Basic({ color: [1, 0, 0] }, { wireframe: true })
  ));
  xAxis.setPosition([100, 0.001, 0]);

  const yAxis = new ModelNode('__editor__Yaxis', new Model(
    new Geometry([[0, -200, 0], [0, 200, 0]], undefined, undefined, undefined, undefined, [0, 1], false),
    Material.Basic({ color: [0, 1, 0] }, { wireframe: true })
  ));
  yAxis.setPosition([0, 100, 0.001]);

  const zAxis = new ModelNode('__editor__Zaxis', new Model(
    new Geometry([[0, 0, -200], [0, 0, 200]], undefined, undefined, undefined, undefined, [0, 1], false),
    Material.Basic({ color: [0, 0, 1] }, { wireframe: true })
  ));
  zAxis.setPosition([0, 0.001, 100]);

  scene.addNodes(editorCameraNode, editorGridNode, xAxis, yAxis, zAxis);

  // Environment map (cubemap) just like in the example app
  try {
    const envmap = new Texture({ target: 'cubemap', flipY: true });
    const images = await Promise.all([
      '/assets/cubemaps/envmap/right.jpg',
      '/assets/cubemaps/envmap/left.jpg',
      '/assets/cubemaps/envmap/top.jpg',
      '/assets/cubemaps/envmap/bottom.jpg',
      '/assets/cubemaps/envmap/front.jpg',
      '/assets/cubemaps/envmap/back.jpg'
    ].map(path => Loader.loadImage(path)));

    envmap.create({
      posX: images[0],
      negX: images[1],
      posY: images[2],
      negY: images[3],
      posZ: images[4],
      negZ: images[5]
    }, images[0].width, images[0].height);

    scene.environmentMap = envmap;
  } catch (e) {
    console.error('Failed to load environment map:', e);
  }

  // Skybox just like in the example app
  try {
    const skybox = await Skybox.fromFiles({
      posX: '/assets/cubemaps/skybox/right.jpg',
      negX: '/assets/cubemaps/skybox/left.jpg',
      posY: '/assets/cubemaps/skybox/top.jpg',
      negY: '/assets/cubemaps/skybox/bottom.jpg',
      posZ: '/assets/cubemaps/skybox/front.jpg',
      negZ: '/assets/cubemaps/skybox/back.jpg'
    });
    scene.addNode(new SkyboxNode('skybox', skybox));
  } catch (e) {
    console.error('Failed to load skybox:', e);
  }

  // Load Damaged Helmet
  try {
    const helmetModels = await Model.fromPath({
      filePaths: [
        '/assets/damagedHelmet/damaged_helmet.obj',
        '/assets/damagedHelmet/damaged_helmet.mtl'
      ]
    });

    if (helmetModels.length > 0) {
      const helmetModel = helmetModels[0];
      const helmetNode = new ModelNode('damagedHelmet', helmetModel.model);
      helmetNode.setPosition([-1, 3, 0]);
      helmetNode.setRotation([0, 180, 0]);
      helmetNode.setScale([1, 1, 1]);
      scene.addNodes(helmetNode);

      // Body for helmet
      bodies.set(helmetNode.id, {
        mass: 1,
        linearDamping: 0.01,
        angularDamping: 0.8,
        linearConstraints: [1, 1, 1],
        angularConstraints: [1, 1, 1],
        shapes: [{ type: 'sphere', radius: 0.5, offset: [0, 0, 0], rotation: [0, 0, 0] }]
      });

      // Debug body visualization
      const debugHelmetNode = new Node(`__debug__body_${helmetNode.id}`);
      debugHelmetNode.onUpdate = (node) => {
        node.setPosition(helmetNode.position);
        node.setRotation(helmetNode.rotation);
      };
      const debugHelmetModel = new Model(Geometry.Sphere(8), Material.Basic({ color: [1, 0, 0] }, { wireframe: true }));
      const helmetModelNode = new ModelNode(`__debug__shape_0`, debugHelmetModel);
      debugHelmetNode?.addChild(helmetModelNode);
      scene.addNode(debugHelmetNode);

      console.log('Damaged helmet model loaded successfully with physics');
    }
  } catch (error) {
    console.error('Failed to load damaged helmet model:', error);
  }

  // Load Running GLTF Model with Animation
  try {
    const runningModels = await Loader.loadAnimatedModelsFromPath('/assets/running.gltf');

    if (runningModels.length > 0) {
      const runningNode = new Node('runningModel');
      runningNode.setPosition([2, 0, 2]);
      runningNode.setRotation([0, 0, 0]);
      runningNode.setScale([1, 1, 1]);
      
      for (const modelData of runningModels) {
        const modelNode = new ModelNode(modelData.name, modelData.model as any);
        runningNode.addChild(modelNode);
      }
      
      scene.addNode(runningNode);
      
      // Log animation and skinning info
      const firstModel = runningModels[0].model;
      if (firstModel.hasSkin) {
        console.log('Running GLTF model loaded with skinning data:');
        console.log('- Joints:', firstModel.skin?.joints.length);
      }
      if (firstModel.hasAnimations) {
        console.log('Running GLTF model loaded with animations:');
        firstModel.animations.forEach((anim: any, i: number) => {
          console.log(`- Animation ${i}: ${anim.name}, Channels: ${anim.channels.length}, Samplers: ${anim.samplers.length}`);
        });
      }
      console.log('Running GLTF model loaded successfully as AnimatedModel');
    }
  } catch (error) {
    console.error('Failed to load running GLTF model:', error);
  }

  // Directional light with icon sprite (texture is added later by EngineContext)
  const lightNode = new LightNode('light', new DirectionalLight({}));
  const debugLightIcon = new SpriteNode('__editor__LightSprite', new Sprite(Material.Basic({ color: [1, 1, 1], texture: '__editor__light_icon' })));
  debugLightIcon.setUniformScale(0.5);
  lightNode.addChild(debugLightIcon);
  lightNode.setPosition([0, 1, 0]).setRotation([100, 25, 0]);
  lightNode.castShadows = true;

  // A controllable camera node with debug mesh
  const cameraNode = new CameraNode('camera', new Camera({}));
  cameraNode.active = true;
  const cameraModel = new Model(new Geometry(
    CameraGeometry.positions, undefined, CameraGeometry.texCoords,
    undefined, undefined, CameraGeometry.indices, false
  ), Material.Basic({ color: [0.2, 0.2, 0.75] }, { castShadow: false }));
  const debugCameraModel = new ModelNode('__debug__CameraModel', cameraModel);
  debugCameraModel.onUpdate = (node) => {
    // Ignore scaling
    Vec.mat4.scale(node.worldTransform, node.worldTransform, Vec.vec3.inverse(Vec.vec3.create(), Vec.mat4.getScaling(Vec.vec3.create(), node.worldTransform)));
  };
  cameraNode.addChild(debugCameraModel);
  cameraNode.setPosition([0, 2, -5]).setRotation([30, 0, 0]);

  // Example scene nodes
  const physicalBox = new ModelNode('physical box', new Model(Geometry.Cube(), Material.Default({ diffuse: [1, 0, 1] })));
  physicalBox.setPosition([1, 3, 0]).setRotation([45, 0, 45]);

  const playable = new Node('playable');
  playable.setPosition([1, 0, 0]);

  const spriteNode = new SpriteNode('sprite', new Sprite(Material.Basic({
    texture: 'dinosaur.png'
  })));
  playable.addChild(spriteNode);
  playable.addChild(cameraNode);

  const plane = new Node('plane');
  plane.setPosition([0, -1, 0]).setRotation([-90, 0, 0]).setScale([10, 10, 1]);


  scene.addNodes(lightNode, physicalBox, playable, plane);

  try {
    const sponzaModels = await Model.fromPath({ filePaths: [
      '/assets/sponza/sponza.obj',
      '/assets/sponza/sponza.mtl'
    ]});
    const sponza = new Node('sponza');
    sponza.setScale([2, 2, 2]);
    sponza.setY( -1 );
    sponzaModels.forEach(model => {
      const modelNode = new ModelNode(model.name, model.model);
      modelNode.model.material.config.castShadow = true;
      sponza.addChild(modelNode);
    });
    scene.addNode(sponza);
  } catch (e) {
    console.error('Failed to load sponza model:', e);
  }

  // --- Simple Game: Collectibles (green cubes) and Hazards (red spheres) ---
  const collectiblePositions: Array<[number, number, number]> = [
    [-4, 0, -2], [-2, 0, 3], [0, 0, 4], [2, 0, -3], [4, 0, 1],
    [-3, 0, 2], [3, 0, -1], [0, 0, -4]
  ];
  const collectibles: ModelNode[] = [];
  for (let i = 0; i < collectiblePositions.length; i++) {
    const pos = collectiblePositions[i];
    const cube = new ModelNode(`collectible_${i}`, new Model(Geometry.Cube(), Material.Default({ diffuse: [0, 1, 0], emissive: [0, 1, 0] })));
    cube.setPosition(pos).setUniformScale(0.5);
    scene.addNode(cube);
    collectibles.push(cube);
  }

  const hazardPositions: Array<[number, number, number]> = [
    [-3, -0.5, -3], [3, -0.5, 3], [0, -0.5, 0], [-2, -0.5, 4], [4, -0.5, -2]
  ];
  const hazards: ModelNode[] = [];
  for (let i = 0; i < hazardPositions.length; i++) {
    const pos = hazardPositions[i];
    const ball = new ModelNode(`hazard_${i}`, new Model(Geometry.Sphere(), Material.Default({ diffuse: [1, 0, 0] })));
    ball.setPosition(pos).setUniformScale(0.5);
    scene.addNode(ball);
    hazards.push(ball);
  }

  // Bodies
  bodies.set(physicalBox.id, {
    mass: 1,
    linearDamping: 0.01,
    angularDamping: 0.01,
    linearConstraints: [1, 1, 1],
    angularConstraints: [1, 1, 1],
    shapes: [{ type: 'box', width: 1, height: 1, depth: 1, offset: [0, 0, 0], rotation: [0, 0, 0] }]
  });

  const debugNode = new Node(`__debug__body_${physicalBox.id}`);
  debugNode.onUpdate = (node) => {
    node.setPosition(physicalBox.position);
    node.setRotation(physicalBox.rotation);
  };
  const debugModel = new Model(Geometry.Cube(1, 1, 1, true), Material.Basic({ color: [1, 0, 0] }, { wireframe: true }));
  const modelNode = new ModelNode(`__debug__shape_0`, debugModel);
  debugNode?.addChild(modelNode);
  scene.addNode(debugNode);

  bodies.set(plane.id, {
    mass: 0,
    linearDamping: 0, angularDamping: 0,
    linearConstraints: [1, 1, 1], angularConstraints: [1, 1, 1],
    shapes: [{ type: 'plane', offset: [0, 0, 0], rotation: [0, 0, 0] }]
  });

  const debugPlayableNode = new Node(`__debug__playable_${playable.id}`);
  debugPlayableNode.onUpdate = (node) => {
    node.setPosition(playable.position);
    node.setRotation(playable.rotation);
  };
  const debugPlayableModel = new Model(Geometry.Cube(1, 1, 1, true), Material.Basic({ color: [1, 0, 0] }, { wireframe: true }));
  const playableModelNode = new ModelNode(`__debug__shape_0`, debugPlayableModel);
  debugPlayableNode?.addChild(playableModelNode);
  scene.addNode(debugPlayableNode);

  bodies.set(playable.id, {
    mass: 1,
    linearDamping: 0.01,
    angularDamping: 0.01,
    linearConstraints: [1, 1, 0],
    angularConstraints: [0, 0, 0],
    shapes: [{ type: 'box', width: 1, height: 1, depth: 1, offset: [0, 0, 0], rotation: [0, 0, 0] }]
  });

  // Triggers for collectibles (boxes) and hazards (spheres)
  for (const cube of collectibles) {
    triggers.set(cube.id, { shapes: [{ type: 'box', width: 0.5, height: 0.5, depth: 0.5, offset: [0, 0, 0], rotation: [0, 0, 0] }] });
  }
  for (const ball of hazards) {
    triggers.set(ball.id, { shapes: [{ type: 'sphere', radius: 0.5, offset: [0, 0, 0], rotation: [0, 0, 0] }] });
  }

  // Scripts using module-style exports
  // Playable controller and game state
  scripts.set(playable.id, "module.exports = {\n  onStart(node, global) {\n    // Game state stored on the node instance\n    node.__game = { score: 0, hits: 0, alive: true, quit: false, invulnerableUntil: 0 };\n    const jump = () => { if (!node.__game.alive || node.__game.quit) return; if (node.body) node.body.impulse([0, 10, 0]); global.logger('Jump!'); };\n    global.input.registerKeyPress('Space', jump);\n    global.input.registerKeyPress('Escape', () => {\n      node.__game.quit = true;\n      // trigger cleanup and final score logging via onDespawn\n      node.remove();\n    });\n  },\n  onUpdate(node, delta, time, global) {\n    const g = node.__game || (node.__game = { score: 0, hits: 0, alive: true, quit: false, invulnerableUntil: 0 });\n    if (!g.alive || g.quit) return;\n    const speed = 3;\n    if (global.input.isKeyPressed('KeyD')) node.addX(-delta * speed);\n    if (global.input.isKeyPressed('KeyA')) node.addX(delta * speed);\n    if (global.input.isKeyPressed('KeyW')) node.addZ(delta * speed);\n    if (global.input.isKeyPressed('KeyS')) node.addZ(-delta * speed);\n  },\n  onCollision(node, other, global) { /* not used; hazards are triggers */ },\n  onDespawn(node, global) {\n    const g = node.__game || { score: 0 };\n    global.logger('Final score: ' + g.score);\n  }\n};");

  // Camera rotate with mouse (keep existing behavior)
  scripts.set(cameraNode.id, "module.exports = {\n  onUpdate(node, delta, time, global) {\n    const mouseMovement = global.input.mouse.velocity;\n    const deltaFix = -delta * 10;\n    node.rotateY(mouseMovement[0] * deltaFix);\n  }\n};");

  // Log collisions for the physical box (debug)
  scripts.set(physicalBox.id, "module.exports = {\n  onCollision(node, other, global) {\n    global.logger(`${node.name} collided with ${other.name}`);\n  }\n};");

  // Scripts for collectibles: hide on pickup and increase score
  for (const cube of collectibles) {
    scripts.set(cube.id, "module.exports = {\n  onTrigger(node, other, global) {\n    if (other && other.name === 'playable' && node.visible) {\n      // Initialize game state on player if missing\n      other.__game = other.__game || { score: 0, hits: 0, alive: true, quit: false, invulnerableUntil: 0 };\n      other.__game.score += 1;\n      node.visible = false;\n      global.logger('Score: ' + other.__game.score);\n    }\n  }\n};");
  }

  // Scripts for hazards: move and damage player on contact; player dies after 3 hits
  hazards.forEach((ball, i) => {
    scripts.set(ball.id, "module.exports = {\n  onStart(node) {\n    node.__origin = [node.position[0], node.position[1], node.position[2]];\n    node.__phase = " + i + ";\n  },\n  onUpdate(node, delta, time) {\n    const o = node.__origin || [0,0,0];\n    const t = time / 700 + (node.__phase || 0);\n    node.setX(o[0] + Math.sin(t) * 2.5);\n    node.setZ(o[2] + Math.cos(t * 0.8) * 2.5);\n  },\n  onTrigger(node, other, global) {\n    if (!other || other.name !== 'playable') return;\n    const now = Date.now();\n    const g = other.__game = other.__game || { score: 0, hits: 0, alive: true, quit: false, invulnerableUntil: 0 };\n    if (!g.alive || g.quit) return;\n    if (now < (g.invulnerableUntil || 0)) return; // brief i-frames\n    g.hits = Math.min(3, (g.hits || 0) + 1);\n    g.invulnerableUntil = now + 1000;\n    const livesLeft = 3 - g.hits;\n    if (g.hits >= 3) {\n      g.alive = false;\n      g.quit = true;\n      // despawn player to end game and trigger onDespawn logging\n      other.remove();\n    } else {\n      global.logger('Ouch! Lives left: ' + livesLeft);\n    }\n  }\n};");
  });
}
