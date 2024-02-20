import * as CLEO from 'cleo';

let app = new CLEO.CleoEngine({
    graphics: {
        clearColor: [0.25, 0.05, 0.8, 1.0],
        shadowMapSize: 4096,
        bloom: true
    },
    physics: {gravity: [0, -9.8, 0]}
});

let element = document.getElementById('game-viewport');
if (!element) {
    element = document.createElement('div');
    element.id = 'game-viewport';
}
app.setViewport(element);

const scene1: CLEO.Scene = new CLEO.Scene();
const scene2 = new CLEO.Scene();

async function loadAssets(): Promise<void> {
    app.isPaused = true;
    CLEO.TextureManager.Instance.addTextureFromPath('assets/crateTextures/diff.png', {}, 'crateDiff');
    CLEO.TextureManager.Instance.addTextureFromPath('assets/crateTextures/spec.png', {}, 'crateSpec');
    CLEO.TextureManager.Instance.addTextureFromPath('assets/crateTextures/emis.png', {}, 'crateEmis');
    CLEO.TextureManager.Instance.addTextureFromPath('assets/crateTextures/refl.png', {}, 'crateRefl');
    CLEO.TextureManager.Instance.addTextureFromPath('assets/world.png', {}, 'world');
    CLEO.TextureManager.Instance.addTextureFromPath('assets/terrain_tex.jpg', {}, 'terrain');

    const dirLight = new CLEO.LightNode('dirLight', new CLEO.DirectionalLight({}), true)
    dirLight.setRotation([90, 0, 0]);
    scene1.addNode(dirLight);

    const envmap = new CLEO.Texture({target: 'cubemap', flipY: true});
    Promise.all([
        'assets/cubemaps/envmap/right.jpg',
        'assets/cubemaps/envmap/left.jpg',
        'assets/cubemaps/envmap/top.jpg',
        'assets/cubemaps/envmap/bottom.jpg',
        'assets/cubemaps/envmap/front.jpg',
        'assets/cubemaps/envmap/back.jpg']
    .map(path => CLEO.Loader.loadImage(path)))
    .then(images => {
        envmap.create({
            posX: images[0],
            negX: images[1],
            posY: images[2],
            negY: images[3],
            posZ: images[4],
            negZ: images[5]
        }, images[0].width, images[0].height);
    });

    scene2.environmentMap = envmap;

    const skybox = await CLEO.Skybox.fromFiles({
        posX: 'assets/cubemaps/skybox/right.jpg',
        negX: 'assets/cubemaps/skybox/left.jpg',
        posY: 'assets/cubemaps/skybox/top.jpg',
        negY: 'assets/cubemaps/skybox/bottom.jpg',
        posZ: 'assets/cubemaps/skybox/front.jpg',
        negZ: 'assets/cubemaps/skybox/back.jpg'
    })

    scene1.addNode(new CLEO.SkyboxNode('skybox', skybox));
    scene2.addNode(new CLEO.SkyboxNode('skybox', skybox));
    
    const sun = new CLEO.LightNode('sun', new CLEO.DirectionalLight({}), true)
    sun.setRotation([90, 0, 0]);
    
    const pl1 = new CLEO.LightNode('pointLight', new CLEO.PointLight({
        diffuse: [0.0, 0.0, 1.0],
        specular: [0.0, 0.0, 1.0],
        constant: 1.0
    }));
    pl1.setPosition([2, 2, 2]).onUpdate = (node, delta, time) => {
        node.setPosition([Math.sin(time*0.005) * 2, 0, Math.cos(time*0.005) * 2]);
    }
    
    const pl2 = new CLEO.LightNode('pointLight2', new CLEO.PointLight({
        diffuse: [0.0, 1.0, 0.0],
        specular: [0.0, 1.0, 0.0],
        constant: 2.0
    }));
    
    const terrainGeometry = await CLEO.Geometry.Terrain('assets/terrain_hm.jpg')
    const terrain = new CLEO.ModelNode('terrain', new CLEO.Model(
        terrainGeometry,
        CLEO.Material.Default({
            textures: { base: 'terrain' },
            specular: [0.4, 0.4, 0.4],
            shininess: 64.0
        })
    ));
    terrain.setY(-4);
    scene2.addNode(terrain);
    
    let crate = new CLEO.ModelNode('crate', new CLEO.Model(
        CLEO.Geometry.Cube(),
        CLEO.Material.Default({
            reflectivity: 1.0,
            textures: {
                base: 'crateDiff',
                specular: 'crateSpec',
                emissive: 'crateEmis',
                reflectivity: 'crateRefl' }
            }, { castShadow: true } )
    ));
    crate.setPosition([-2, 1, 0]).setBody(0).attachShape(CLEO.Shape.Box(1, 1, 1));
    crate.onUpdate = (node, delta, time) => {
        node.setY(Math.sin(time * 0.001) + 1).rotateX(1).rotateY(1);
        let change = Math.sin(time * 0.005)/2 + 0.5;
        (node as CLEO.ModelNode).model.material.properties.set('emissive', [1, change * 2, 0]);
        (node.getChildByName('pointLight2')[0] as CLEO.LightNode).light.diffuse[1] = change;
    }
    crate.addChild(pl2);
    
    // Load model from obj file
    const roomModel = await CLEO.Model.fromFile({filePaths: ['assets/viking_room/viking_room.obj', 'assets/viking_room/viking_room.mtl']})
    const room = new CLEO.Node('room');
    roomModel[0].model.material.config.castShadow = true;
    const roomNode = new CLEO.ModelNode(roomModel[0].name, roomModel[0].model);
    roomNode.setPosition([1, 1, 1])
        .setBody(10)
        .attachShape(CLEO.Shape.Box(1.25, 0.2, 1.5), [0.1, 0, 0])
        .attachShape(CLEO.Shape.Box(1.25, 1, 0.2), [0.1, 0.5, 0.6])
        .attachShape(CLEO.Shape.Box(0.2, 1, 1.25), [-0.4, 0.5, -0.1])
        roomNode.onUpdate = (node, delta, time) => {
        node.setXScale(Math.sin(time * 0.001) + 1)
        .setYScale(Math.sin(time * 0.001) + 1);
    }
    room.addChild(roomNode);
    scene1.addNode(room);
    
    const floor = new CLEO.Node('floor');
    floor.rotateX(-90).setBody(0).attachShape(CLEO.Shape.Plane())
    
    const backpackModel = await CLEO.Model.fromFile({filePaths: ['assets/backpack/backpack.obj', 'assets/backpack/backpack.mtl']});
    const backpack = new CLEO.ModelNode('backpack2', backpackModel[0].model);
    backpack.setPosition([2, 1, -2]).setUniformScale(0.5).setBody(10).attachShape(CLEO.Shape.Box(1, 2, 1));
    scene2.addNode(backpack);
    
    const helmetModel = await CLEO.Model.fromFile({filePaths: ['assets/damagedHelmet/damaged_helmet.obj', 'assets/damagedHelmet/damaged_helmet.mtl']});
    const helmet = new CLEO.ModelNode('helmet2', helmetModel[0].model);
    helmetModel[0].model.material.config.castShadow = true;
    helmet.setPosition([1, 2, 2]).setUniformScale(0.5).setBody(20, 0.5, 0.5).attachShape(CLEO.Shape.Sphere(0.5));   
    scene2.addNode(helmet);
    
    // Load node from File
    /* const sponza = new CLEO.Node('sponza');
    CLEO.Model.fromFile({filePaths: ['assets/sponza/sponza.obj', 'assets/sponza/sponza.mtl']}).then(sponzaModel => {
        sponzaModel.forEach(model => {
            const modelNode = new CLEO.ModelNode(model.name, model.model);
            modelNode.model.material.config.castShadow = true;
            sponza.addChild(modelNode);
        });
        scene2.addNode(sponza);
    }); */
    
    scene2.addNodes(floor, sun, pl1, crate);

    const cameraNode1 = new CLEO.CameraNode('camera', new CLEO.Camera({far: 1000}));
    cameraNode1.setPosition([0, 1, 5]);
    cameraNode1.setRotation([0, 45, 0]);
    cameraNode1.active = true;

    const cameraNode2 = new CLEO.CameraNode('camera2', new CLEO.Camera({far: 1000}));
    cameraNode2.setPosition([0, 1, 5]);
    cameraNode2.setRotation([0, 45, 0]);
    cameraNode2.active = true;
    cameraNode2.onUpdate = (node, delta, time) => {
        let mouse = app.input.mouse;
        let movement = delta * 2;
        if (mouse.buttons.Left) {
            node.rotateX( mouse.velocity[1] * movement * 5).rotateY(-mouse.velocity[0] * movement * 5);
        }
    
        app.input.isKeyPressed('KeyW') && node.addForward(movement);
        app.input.isKeyPressed('KeyS') && node.addForward(-movement);
        app.input.isKeyPressed('KeyA') && node.addRight(-movement);
        app.input.isKeyPressed('KeyD') && node.addRight(movement);
        app.input.isKeyPressed('KeyE') && node.addY(movement);
        app.input.isKeyPressed('KeyQ') && node.addY(-movement);
    }
    
    scene1.addNode(cameraNode1);
    scene2.addNode(cameraNode2);

}

app.setScene(scene2);
loadAssets().then(() => { app.isPaused = false; app.scene.start(); });

app.onPostInitialize = () => {
    const shootSphere = () => {
        const sphere = new CLEO.ModelNode(`sphere${Math.random() * 1000}`, new CLEO.Model(
            CLEO.Geometry.Sphere(32),
            CLEO.Material.Default({ reflectivity: 0.5, textures: { base: 'world'} }, { castShadow: true })
        ));
        sphere.setPosition(/* app.camera.position */[0, 0, 0])
                .setUniformScale(0.25)
                .setBody(5).attachShape(CLEO.Shape.Sphere(0.25)).onCollision = node => { if (node.name === 'box') { node.remove(); }};
        sphere.onStart = node => {
            const impulseVector = CLEO.Vec.vec3.create();
            CLEO.Vec.vec3.scale(impulseVector, /* app.camera.forward */[0, 1, 0], 100);
            node.body?.impulse(impulseVector)
        }
        sphere.onSpawn = () => { console.log('sphere spawned')}
        app.scene.addNode(sphere);
    }

    const spawnBox = () => {
        const box = new CLEO.ModelNode('box', new CLEO.Model(
            CLEO.Geometry.Cube(),
            CLEO.Material.Default({
                textures: {
                    base: 'crateDiff',
                    specular: 'crateSpec',
                    emissive: 'crateEmis',
                    reflectivity: 'crateRefl'
                }
            }, { castShadow: true })
        ));
        box.onUpdate = (node, delta, time) => {
            let change = Math.cos(time * 0.005)/2 + 0.5;
            (node as CLEO.ModelNode).model.material.properties.set('emissive', [1, change, 0]);
        }
        box.setPosition([Math.random(), 5, Math.random()]).setBody(Math.random() * 10).attachShape(CLEO.Shape.Box(1, 1, 1))
        app.scene.addNode(box);
    }

    
    app.input.registerKeyPress('KeyZ', () => { shootSphere(); });
    app.input.registerKeyPress('KeyX', () => { spawnBox(); });
    app.input.registerKeyPress('KeyP', () => {app.isPaused = !app.isPaused})
    app.input.registerKeyPress('KeyL', () => {app.setScene(app.scene === scene1 ? scene2 : scene1);})
    app.input.registerKeyPress('KeyI', () => {app.scene.start()});
    app.input.registerKeyPress('KeyO', () => {
        app.scene.serialize().then((json) => {
            if (json) {
              const blob = new Blob([JSON.stringify(json)], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = 'scene.json';
              a.click();
            }
          });
    })
};  

app.onUpdate = (delta, time) => {

    app.input.isKeyPressed('Digit1') && (app.renderer.exposure -= 0.005);
    app.input.isKeyPressed('Digit2') && (app.renderer.exposure += 0.005);
    app.input.isKeyPressed('Digit3') && (app.renderer.chromaticAberrationStrength -= 0.001);
    app.input.isKeyPressed('Digit4') && (app.renderer.chromaticAberrationStrength += 0.001);

    let sun = app.scene.getNodesByName('sun')[0]
    if (sun) {
        app.input.isKeyPressed('ArrowLeft') && (sun.rotateZ(-0.5));
        app.input.isKeyPressed('ArrowRight') && (sun.rotateZ(0.5));
        app.input.isKeyPressed('ArrowUp') && (sun.rotateX(0.5));
        app.input.isKeyPressed('ArrowDown') && (sun.rotateX(-0.5));
    }
}

app.run();