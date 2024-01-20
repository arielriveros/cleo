import * as CLEO from 'cleo';

let app = new CLEO.CleoEngine({
    graphics: {
        clearColor: [0.25, 0.05, 0.8, 1.0],
        shadowMapSize: 4096,
        bloom: true
    },
    physics: {gravity: [0, -9.8, 0]}
});

function loadAssets(): void {
    app.isPaused = true;
    CLEO.TextureManager.Instance.addTextureFromPathWithId('crateDiff', 'assets/crateTextures/diff.png');
    CLEO.TextureManager.Instance.addTextureFromPathWithId('crateSpec', 'assets/crateTextures/spec.png');
    CLEO.TextureManager.Instance.addTextureFromPathWithId('crateEmis', 'assets/crateTextures/emis.png');
    CLEO.TextureManager.Instance.addTextureFromPathWithId('crateRefl', 'assets/crateTextures/refl.png');
    CLEO.TextureManager.Instance.addTextureFromPathWithId('world', 'assets/world.png');
    CLEO.TextureManager.Instance.addTextureFromPathWithId('terrain', 'assets/terrain_tex.jpg');
}

loadAssets();

const camera: CLEO.Camera = new CLEO.Camera({position: [0, 1, 5], rotation: [0, Math.PI, 0], far: 1000});
const scene: CLEO.Scene = new CLEO.Scene();

app.camera = camera;
app.scene = scene;

const skybox = new CLEO.Cubemap();
skybox.createFromFiles([
    'assets/cubemaps/skybox/right.jpg',
    'assets/cubemaps/skybox/left.jpg',
    'assets/cubemaps/skybox/top.jpg',
    'assets/cubemaps/skybox/bottom.jpg',
    'assets/cubemaps/skybox/front.jpg',
    'assets/cubemaps/skybox/back.jpg'
]);

const envmap = new CLEO.Cubemap();
envmap.createFromFiles([
    'assets/cubemaps/envmap/right.jpg',
    'assets/cubemaps/envmap/left.jpg',
    'assets/cubemaps/envmap/top.jpg',
    'assets/cubemaps/envmap/bottom.jpg',
    'assets/cubemaps/envmap/front.jpg',
    'assets/cubemaps/envmap/back.jpg'
]);

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
    app.scene.addNode(terrain);
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
    (node.getChild('pointLight2') as CLEO.LightNode).light.diffuse[1] = change;
}
crate.addChild(pl2);

CLEO.Model.FromFile({filePaths: ['assets/viking_room/viking_room.obj', 'assets/viking_room/viking_room.mtl']}).then(roomModel => {
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
    app.scene.addNode(room);
});


const floor = new CLEO.Node('floor');
floor.rotateX(-90).setBody(0).attachShape(CLEO.Shape.Plane())


/* CLEO.Model.FromFile({filePaths: ['assets/sponza/sponza.obj', 'assets/sponza/sponza.mtl']}).then(sponzaModels => {
    const sponza = new CLEO.Node('sponza')
    sponza.setBody(0);
    for (const result of sponzaModels) {
        result.model.material.config.castShadow = true;
        const node = new CLEO.ModelNode(result.name, result.model);
        sponza.addChild(node);
        const geometry = new CLEO.Geometry();
        if (result.name === 'sponza_sponza_arch' ||
            result.name === 'sponza_sponza_bricks' ||
            result.name === 'sponza_sponza_ceiling' ||
            result.name === 'sponza_sponza_column_a' ||
            result.name === 'sponza_sponza_column_b' ||
            result.name === 'sponza_sponza_column_c' ||
            result.name === 'sponza_sponza_flagpole' ||
            result.name === 'sponza_sponza_roof' ||
            result.name === 'sponza_sponza_vase' ||
            result.name === 'sponza_sponza_vase_round') { 
                geometry.positions.push(...result.model.geometry.positions);
                geometry.indices.push(...result.model.geometry.indices);
            }
            
            sponza.body?.attachShape(CLEO.Shape.TriMesh(geometry, [1, 1, 1]))
    }
    app.scene.addNode(sponza);
}); */

const backpack = new CLEO.Node('backpack')
/* backpack.setPosition([-1, 2, 0]).setUniformScale(0.5).setBody(10).attachShape(CLEO.Shape.Box(1, 2, 1));
const backpackModels = await CLEO.Model.FromFile({filePaths: ['assets/backpack/backpack.obj', 'assets/backpack/backpack.mtl']});
for (const result of backpackModels) {
    result.model.material.config.castShadow = true;
    const node = new CLEO.ModelNode(result.name, result.model);
    backpack.addChild(node);
} */

const helmet = new CLEO.Node('helmet')
helmet.setPosition([1, 2, -2]).setUniformScale(0.5).setBody(20, 0.5, 0.5).attachShape(CLEO.Shape.Sphere(0.5));

CLEO.Model.FromFile({filePaths: ['assets/damagedHelmet/damaged_helmet.obj', 'assets/damagedHelmet/damaged_helmet.mtl']}).then(damagedHelmetModels => {
    for (const result of damagedHelmetModels) {
        result.model.material.config.castShadow = true;
        const node = new CLEO.ModelNode(result.name, result.model);
        helmet.addChild(node);
    }

    app.scene.addNode(helmet);
});



app.scene.skybox = skybox;
app.scene.environmentMap = envmap;

app.scene.addNodes(floor, sun, pl1, crate);
app.scene.addNode(helmet);
app.scene.addNode(backpack);


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

    let sun = app.scene.getNode('sun')
    if (sun) {
        app.input.isKeyPressed('ArrowLeft') && (sun.rotateZ(-0.5));
        app.input.isKeyPressed('ArrowRight') && (sun.rotateZ(0.5));
        app.input.isKeyPressed('ArrowUp') && (sun.rotateX(0.5));
        app.input.isKeyPressed('ArrowDown') && (sun.rotateX(-0.5));
    }
}

app.run();