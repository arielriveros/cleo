import { Scene, Camera, LightNode, DirectionalLight, CameraNode, Model, Geometry, Material, Node, ModelNode, Vec, SpriteNode, Sprite, Texture, Loader, Skybox, SkyboxNode, AnimatedModel, TextureManager, PointLight, AnimatedSpriteNode } from 'cleo';
import { CameraGeometry } from '../../utils/EditorModels';
import type { BodyDescription, ShapeDescription } from '../EngineContext';

export async function createDemoScene(params: {
  scene: Scene,
  scripts: Map<string, string>,
  bodies: Map<string, BodyDescription>,
  triggers: Map<string, { shapes: ShapeDescription[] }>,
  onProgress?: (loaded: number, total: number, label: string) => void,
}): Promise<void> {
  const { scene, scripts, bodies, triggers, onProgress } = params;

  // Report startup asset-loading progress. Each awaited asset group below is one
  // step; `step` is called immediately before a group starts loading, so the bar
  // reflects completed groups and the label names the group currently loading.
  // Calls are unconditional (placed before each try), so a failed asset still
  // advances the bar instead of stalling it.
  const LOAD_STEPS = 6;
  let loadedSteps = 0;
  const step = (label: string) => onProgress?.(loadedSteps++, LOAD_STEPS, label);

  // Editor Camera
  const editorCameraNode = new CameraNode('__editor__Camera', new Camera({ far: 10000 }));
  editorCameraNode.active = true;
  editorCameraNode.setPosition([4, 4, 4]).setRotation([30, -135, 0]);

  const yAxis = new ModelNode('__editor__Yaxis', new Model(
    new Geometry([[0, -200, 0], [0, 200, 0]], undefined, undefined, undefined, undefined, [0, 1], false),
    Material.Basic({ color: [0, 1, 0] }, { wireframe: true })
  ));
  yAxis.setPosition([0, 100, 0.001]);

  scene.addNodes(editorCameraNode, yAxis);

  // Environment map (cubemap) just like in the example app
  step('Loading environment map…');
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
  step('Loading skybox…');
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
  step('Loading damaged helmet…');
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
      debugHelmetNode.onUpdate = () => {
        debugHelmetNode.setPosition(helmetNode.position);
        debugHelmetNode.setRotation(helmetNode.rotation);
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

  // Example scene nodes
  const physicalBox = new ModelNode('physical box', new Model(Geometry.Cube(), Material.Default({ diffuse: [1, 0, 1] })));
  physicalBox.setPosition([1, 3, 0]).setRotation([45, 0, 45]);

  // A controllable camera node with debug mesh
  const cameraNode = new CameraNode('camera', new Camera({}));
  cameraNode.active = true;
  const cameraModel = new Model(new Geometry(
    CameraGeometry.positions, undefined, CameraGeometry.texCoords,
    undefined, undefined, CameraGeometry.indices, false
  ), Material.Basic({ color: [0.2, 0.2, 0.75] }, { castShadow: false }));
  const debugCameraModel = new ModelNode('__debug__CameraModel', cameraModel);
  debugCameraModel.onUpdate = () => {
    // Ignore scaling
    Vec.mat4.scale(debugCameraModel.worldTransform, debugCameraModel.worldTransform, Vec.vec3.inverse(Vec.vec3.create(), Vec.mat4.getScaling(Vec.vec3.create(), debugCameraModel.worldTransform)));
  };
  cameraNode.addChild(debugCameraModel);
  // Camera local offset; rotation will be inherited from pivot
  cameraNode.setPosition([0, 0, -5]).setRotation([0, 0, 0]);

  // Create a camera pivot that will handle rotation based on mouse input
  const cameraPivot = new Node('cameraPivot');
  cameraPivot.setPosition([0, 1.2, 0]); // slight height above playable origin

  const playable = new Node('playable');
  playable.setPosition([1, 0, 0]);
  // Custom variables. Scripts reach these straight off the node — `this.HealthPoints` on the player's own
  // script, `other.HealthPoints` from the hazards' — and the HUD reads HealthPoints to draw the hearts.
  playable.setVariable('HealthPoints', 3, 'number');
  playable.setVariable('Score', 0, 'number');
  playable.setVariable('InvulnerableUntil', 0, 'number');
  // Parent camera under pivot, and pivot under playable
  cameraPivot.addChild(cameraNode);
  playable.addChild(cameraPivot);

  // Load Running GLTF Model with Animation
  step('Loading character model…');
  try {
    const runningModels = await Loader.loadAnimatedModelsFromPath('/assets/mannequin.gltf');

    if (runningModels.length > 0) {

      for (const modelData of runningModels) {
        const modelNode = new ModelNode(modelData.name, modelData.model as AnimatedModel);

        if (modelNode.animator && modelNode.model) {
          const animModel = modelNode.model as AnimatedModel;
          console.log('Available animations:', animModel.animations.map((a: any) => a.name));
          
          // Set blend time for smooth transitions
          modelNode.animator.blendTime = 0.25; // 250ms blend time

          modelNode.animator.setAnimationMappings([
            {
              animationName: 'Run', // Running animation (first = higher priority)
              trigger: 'forward',
              triggerType: 'direction',
              direction: [0, 0, 1], // Forward in local space
              directionThreshold: 0.7
            },
            {
              animationName: 'Idle', // Idle animation (second = lower priority)
              trigger: 'idle',
              triggerType: 'direction',
              direction: [0, 0, 0], // Forward in local space
              directionThreshold: 0.7
            }
          ]);
        }
        
        playable.addChild(modelNode);
      }
      scene.addNode(playable);
    }
  }
  catch (error) {
    console.error('Failed to load running GLTF model:', error);
  }

  // Directional light with icon sprite (texture is added later by EngineContext)
  const lightNode = new LightNode('light', new DirectionalLight({}));
  const debugLightIcon = new SpriteNode('__editor__LightSprite', Sprite.fromTexture('__editor__light_icon'));
  debugLightIcon.setUniformScale(0.5);
  lightNode.addChild(debugLightIcon);
  lightNode.setPosition([0, 1, 0]).setRotation([100, 25, 0]);
  lightNode.castShadows = true;

  const spriteNode = new SpriteNode('sprite', Sprite.fromTexture('dinosaur.png'));

  const plane = new Node('plane');
  plane.setPosition([0, -1, 0]).setRotation([-90, 0, 0]).setScale([10, 10, 1]);


  scene.addNodes(lightNode, physicalBox, spriteNode, plane);

  // --- Fire posts with point lights and animated sprites ---
  step('Loading fire effects…');
  try {
    // Lazy-load fire.png texture if not already present
    const { TextureManager, PointLight, AnimatedSpriteNode, Sprite, gridTileset } = await import('cleo');
    if (!TextureManager.Instance.getTexture('fire.png')) {
      TextureManager.Instance.addTextureFromPath('/assets/fire.png', { mipMap: true }, 'fire.png');
    }

    const fireTileset = gridTileset('@demo:fire', 'fire.png', 8, 4);

    const firePositions: Array<[number, number, number]> = [
      [-4.3, 1.67, -9.76],
      [2.71, 1.67, -9.76],
      [2.71, 1.67, 12.37],
      [-4.43, 1.67, 12.37]
    ];

    for (let i = 0; i < firePositions.length; i++) {
      const pos = firePositions[i];
      const group = new Node(`fire_post_${i+1}`);
      group.setPosition(pos);

      // Yellow point light
      const light = new LightNode(`fire_light_${i+1}`, new PointLight({
        diffuse: [1.0, 0.9, 0.3],
        specular: [1.0, 0.9, 0.3],
        ambient: [0.0, 0.0, 0.0],
        constant: 0.13,
        linear: 0.51,
        quadratic: 0.17
      }));
      group.addChild(light);

      // Animated fire sprite: the 8x4 sheet as a tileset, played top-left to bottom-right.
      const fireSprite = new AnimatedSpriteNode(`fire_sprite_${i+1}`,
        new Sprite({ tileset: fireTileset, transparent: true, side: 'double' }), {
        frames: Array.from({ length: 32 }, (_, f) => f),
        fps: 60,
        loop: true,
        constraints: 'cylindrical'
      });
      // Slight scale up for visibility
      fireSprite.setScale([1.4, 1.65, 1]).setPosition([0, 0.65, 0]);
      group.addChild(fireSprite);

      scene.addNode(group);
    }
  } catch (e) {
    console.warn('Failed to set up fire posts:', e);
  }

  step('Loading Sponza scene…');
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
  debugNode.onUpdate = () => {
    debugNode.setPosition(physicalBox.position);
    debugNode.setRotation(physicalBox.rotation);
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
  debugPlayableNode.onUpdate = () => {
    debugPlayableNode.setPosition(playable.position);
    debugPlayableNode.setRotation(playable.rotation);
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

  // Scripts. These are the reference examples for the scripting API: a script imports what it needs from
  // 'cleo', and assigns its handlers to `this` — which IS the node, with the inspector's custom Variables
  // as ordinary properties. Nothing is injected.

  // Playable controller and game state
  scripts.set(playable.id, `import { InputManager, Logger } from 'cleo';

const SPEED = 3;
const ROTATION_SPEED = 360; // degrees per second

// Top-level state is per-node: this body runs once for each node the script is attached to. Only the
// values other scripts (or the HUD) need to see are Variables — the rest just lives here.
let alive = true;
let quit = false;
let pivot = null;

this.onStart = (node) => {
  const input = InputManager.instance;

  // Movement is relative to the camera heading, so keep the pivot handy.
  pivot = this.children.find(child => child.name === 'cameraPivot');

  input.registerKeyPress('Space', () => {
    if (!alive || quit) return;
    if (this.body) this.body.impulse([0, 10, 0]);
    Logger.log('Jump!', 'Script');
  });

  input.registerKeyPress('Escape', () => {
    quit = true;
    this.remove(); // onDespawn logs the final score
  });
};

this.onUpdate = (node, delta, time) => {
  // Death -> ragdoll (one-shot): hand the mannequin's skeleton over to physics.
  if (alive && this.HealthPoints <= 0) {
    alive = false;
    const skinned = this.children.filter(child => child.nodeType === 'model' && child.name !== 'camera' && child.animator);
    const physics = this.scene && this.scene.physics;
    if (skinned.length && physics) {
      if (this.body) {
        this.body.velocity.set(0, 0, 0);
        this.body.angularVelocity.set(0, 0, 0);
        this.body.linearFactor.set(0, 0, 0);
        this.body.angularFactor.set(0, 0, 0);
        this.body.collisionResponse = false;
      }
      const ragdoll = physics.startRagdoll(skinned[0]);
      for (let i = 1; i < skinned.length; i++) skinned[i].animator.enableRagdoll(ragdoll.bodies);
      Logger.log('You died!', 'Script');
    }
    return;
  }
  if (!alive || quit) return;

  const input = InputManager.instance;

  // Forward/right on the XZ plane, derived from the camera's yaw.
  const yaw = ((pivot && pivot.rotation[1]) || 0) * Math.PI / 180;
  const forward = [Math.sin(yaw), 0, Math.cos(yaw)];
  const right = [Math.cos(yaw), 0, -Math.sin(yaw)];

  let axisForward = 0, axisRight = 0;
  if (input.isKeyPressed('KeyW')) axisForward += 1;
  if (input.isKeyPressed('KeyS')) axisForward -= 1;
  if (input.isKeyPressed('KeyD')) axisRight -= 1;
  if (input.isKeyPressed('KeyA')) axisRight += 1;

  let move = [
    forward[0] * axisForward + right[0] * axisRight,
    0,
    forward[2] * axisForward + right[2] * axisRight
  ];
  const length = Math.hypot(move[0], move[2]);

  const models = this.children.filter(child => child.nodeType === 'model' && child.name !== 'camera');

  if (length === 0) {
    for (const model of models) model.movementDirection = [0, 0, 0]; // idle
    return;
  }

  move = [move[0] / length, 0, move[2] / length];
  this.setPosition([
    this.position[0] + move[0] * SPEED * delta,
    this.position[1],
    this.position[2] + move[2] * SPEED * delta
  ]);

  // Turn the animated model towards the direction of travel.
  const target = Math.atan2(move[0], move[2]) * 180 / Math.PI;
  for (const model of models) {
    let angle = model.rotation[1];
    let difference = target - angle;
    while (difference > 180) difference -= 360;
    while (difference < -180) difference += 360;

    const maxStep = ROTATION_SPEED * delta;
    angle += Math.abs(difference) > maxStep ? Math.sign(difference) * maxStep : difference;

    model.setRotation([0, angle, 0]);
    model.movementDirection = [move[0], 0, move[2]];
  }
};

this.onDespawn = (node) => {
  Logger.log('Final score: ' + this.Score, 'Script');
};
`);

  // Third-person orbit using a pivot node (camera child inherits rotation)
  scripts.set(cameraPivot.id, `import { InputManager } from 'cleo';

const LOOK_SPEED = 0.15;
const MIN_PITCH = -80, MAX_PITCH = 85;
const MIN_DISTANCE = 2, MAX_DISTANCE = 12;

let distance = 5;
let yaw = 0;
let pitch = 20;

this.onStart = (node) => {
  // The camera is the first child: start it at the resting offset.
  if (this.children.length) this.children[0].setPosition([0, 0, -distance]).setRotation([0, 0, 0]);
};

this.onUpdate = (node, delta, time) => {
  const mouse = InputManager.instance.mouse;

  yaw -= mouse.velocity[0] * LOOK_SPEED;
  pitch += mouse.velocity[1] * LOOK_SPEED;
  pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, pitch));

  if (mouse.wheel.deltaY !== 0) {
    distance += mouse.wheel.deltaY * 0.01;
    distance = Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, distance));
  }

  // Rotate the pivot; the camera child inherits it.
  this.setRotation([pitch, yaw, 0]);
  if (this.children.length) this.children[0].setPosition([0, 0, -distance]);
};
`);

  // Log collisions for the physical box (debug)
  scripts.set(physicalBox.id, `import { Logger } from 'cleo';

this.onCollision = (node, other) => {
  Logger.log(this.name + ' collided with ' + other.name, 'Script');
};
`);

  // Scripts for collectibles: hide on pickup and increase score
  for (const cube of collectibles) {
    scripts.set(cube.id, `import { Logger } from 'cleo';

this.onTrigger = (node, other) => {
  if (!this.visible || !other || other.name !== 'playable') return;

  // 'other' is the player's node: its Variables are properties here too, access-checked against
  // this node. Score is public, so the collectible may increment it.
  other.Score += 1;
  this.visible = false;

  Logger.log('Score: ' + other.Score, 'Script');
};
`);
  }

  // Scripts for hazards: move and damage the player on contact; the player dies after 3 hits
  hazards.forEach((ball, i) => {
    scripts.set(ball.id, `import { Logger } from 'cleo';

const PHASE = ${i};       // offsets this hazard's orbit from its siblings
const IFRAME_MS = 1000;   // grace period after a hit

let origin = [0, 0, 0];

this.onStart = (node) => {
  origin = [this.position[0], this.position[1], this.position[2]];
};

this.onUpdate = (node, delta, time) => {
  const t = time / 700 + PHASE;
  this.setX(origin[0] + Math.sin(t) * 2.5);
  this.setZ(origin[2] + Math.cos(t * 0.8) * 2.5);
};

this.onTrigger = (node, other) => {
  if (!other || other.name !== 'playable') return;

  const now = Date.now();
  if (now < other.InvulnerableUntil) return;
  other.InvulnerableUntil = now + IFRAME_MS;

  if (other.HealthPoints > 0) {
    other.HealthPoints -= 1;
    Logger.log('Ouch! Health: ' + other.HealthPoints, 'Script');
  }
};
`);
  });
}
