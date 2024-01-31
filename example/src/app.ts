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

function loadAssets(): void {
    app.isPaused = true;
    CLEO.TextureManager.Instance.addTextureFromPath('assets/crateTextures/diff.png', {}, 'crateDiff');
    CLEO.TextureManager.Instance.addTextureFromPath('assets/crateTextures/spec.png', {}, 'crateSpec');
    CLEO.TextureManager.Instance.addTextureFromPath('assets/crateTextures/emis.png', {}, 'crateEmis');
    CLEO.TextureManager.Instance.addTextureFromPath('assets/crateTextures/refl.png', {}, 'crateRefl');
    CLEO.TextureManager.Instance.addTextureFromPath('assets/world.png', {}, 'world');
    CLEO.TextureManager.Instance.addTextureFromPath('assets/terrain_tex.jpg', {}, 'terrain');
}

loadAssets();

app.setCamera(new CLEO.Camera({position: [0, 1, 5], rotation: [0, Math.PI, 0], far: 1000}));
const scene1: CLEO.Scene = new CLEO.Scene();
const dirLight = new CLEO.LightNode('dirLight', new CLEO.DirectionalLight({}), true)
dirLight.setRotation([90, 0, 0]);
scene1.addNode(dirLight);

const scene2 = new CLEO.Scene();
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

CLEO.Skybox.fromFiles({
    posX: 'assets/cubemaps/skybox/right.jpg',
    negX: 'assets/cubemaps/skybox/left.jpg',
    posY: 'assets/cubemaps/skybox/top.jpg',
    negY: 'assets/cubemaps/skybox/bottom.jpg',
    posZ: 'assets/cubemaps/skybox/front.jpg',
    negZ: 'assets/cubemaps/skybox/back.jpg'
}).then(skybox => {
    scene1.addNode(new CLEO.SkyboxNode('skybox', skybox));
    scene2.addNode(new CLEO.SkyboxNode('skybox', skybox));
});

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

CLEO.Geometry.Terrain('assets/terrain_hm.jpg').then(terrainGeometry => {
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
});

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
CLEO.Model.fromFile({filePaths: ['assets/viking_room/viking_room.obj', 'assets/viking_room/viking_room.mtl']}).then(roomModel => {
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
});

const floor = new CLEO.Node('floor');
floor.rotateX(-90).setBody(0).attachShape(CLEO.Shape.Plane())

// Load models from json file
CLEO.Model.fromJSONFile('assets/backpack/model.json').then(backpackModel => {
    const backpack = new CLEO.ModelNode('backpack2', backpackModel as CLEO.Model);
    backpack.setPosition([2, 1, -2]).setUniformScale(0.5).setBody(10).attachShape(CLEO.Shape.Box(1, 2, 1));
    scene2.addNode(backpack);
});

CLEO.Model.fromJSONFile('assets/damagedHelmet/model.json').then(helmetModel => {
    const helmet = new CLEO.ModelNode('helmet2', helmetModel as CLEO.Model);
    helmetModel.material.config.castShadow = true;
    helmet.setPosition([1, 2, 2]).setUniformScale(0.5).setBody(20, 0.5, 0.5).attachShape(CLEO.Shape.Sphere(0.5));   
    scene2.addNode(helmet);
});

// Load node from File
/* const sponza = new CLEO.Node('sponza');
CLEO.Model.fromFile({filePaths: ['assets/sponza/sponza.obj', 'assets/sponza/sponza.mtl']}).then(sponzaModel => {
    sponzaModel.forEach(model => {
        const modelNode = new CLEO.ModelNode(model.name, model.model);
        modelNode.model.material.config.castShadow = true;
        sponza.addChild(modelNode);
    });
    scene1.addNode(sponza);
}); */

scene2.addNodes(floor, sun, pl1, crate);

app.setScene(scene2);

app.onPostInitialize = () => {
    const shootSphere = () => {
        const sphere = new CLEO.ModelNode(`sphere${Math.random() * 1000}`, new CLEO.Model(
            CLEO.Geometry.Sphere(32),
            CLEO.Material.Default({ reflectivity: 0.5, textures: { base: 'world'} }, { castShadow: true })
        ));
        sphere.setPosition(app.camera.position)
                .setUniformScale(0.25)
                .setBody(5).attachShape(CLEO.Shape.Sphere(0.25)).onCollision = node => { if (node.name === 'box') { node.remove(); }};
        sphere.onSpawn = node => {
            const impulseVector = CLEO.Vec.vec3.create();
            CLEO.Vec.vec3.scale(impulseVector, app.camera.forward, 100);
            node.body?.impulse(impulseVector)
        }
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
    app.input.registerKeyPress('KeyO', () => {
        app.scene.root.serialize().then(output => {
            // download scene to asset folder
            const a = document.createElement('a');
            const file = new Blob([JSON.stringify(output)], {type: 'text/plain'});
            a.href = URL.createObjectURL(file);
            a.download = 'scene.json';
            a.click();
        });
    })
};  

app.onUpdate = (delta, time) => {
    let mouse = app.input.mouse;
    let movement = delta * 2;
    if (mouse.buttons.Left) {
        app.camera.rotation[0] -= mouse.velocity[1] * movement / 10;
        app.camera.rotation[1] -= mouse.velocity[0] * movement / 10;
    }

    app.input.isKeyPressed('KeyW') && app.camera.moveForward(movement);
    app.input.isKeyPressed('KeyS') && app.camera.moveForward(-movement);
    app.input.isKeyPressed('KeyA') && app.camera.moveRight(-movement);
    app.input.isKeyPressed('KeyD') && app.camera.moveRight(movement);
    app.input.isKeyPressed('KeyE') && app.camera.moveUp(movement);
    app.input.isKeyPressed('KeyQ') && app.camera.moveUp(-movement);

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

    let crate = app.scene.getNodesByName('crate')[0];
    if (crate) {
        crate.setY(Math.sin(time * 0.001) + 1).rotateX(1).rotateY(1);
        let change = Math.sin(time * 0.005)/2 + 0.5;
        (crate as CLEO.ModelNode).model.material.properties.set('emissive', [1, change * 2, 0]);
        (crate.getChildByName('pointLight2')[0] as CLEO.LightNode).light.diffuse[1] = change;
    }
}

app.run();