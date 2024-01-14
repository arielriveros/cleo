import { Camera } from "./core/camera";
import { Engine } from "./core/engine";
import { Geometry } from "./core/geometry";
import { Material } from "./core/material";
import { Model } from "./graphics/model";
import { Texture } from "./graphics/texture";
import { Cubemap } from "./graphics/cubemap";
import { Node, LightNode, ModelNode } from "./core/scene/node";
import { Scene } from "./core/scene/scene";
import { DirectionalLight, PointLight } from "./core/lighting";
import { Shape } from "./physics/shape";
import { vec3 } from "gl-matrix";

let app: Engine = new Engine({
    graphics: {
        clearColor: [0.25, 0.05, 0.8, 1.0],
        shadowMapSize: 4096,
        bloom: true
    },
    physics: {gravity: [0, -9.8, 0]}
});

app.onPreInitialize = async () => { 
    app.camera = new Camera({position: [0, 1, 5], rotation: [0, Math.PI, 0], far: 1000});
    app.scene = new Scene();

    const skybox = new Cubemap();
    skybox.createFromFiles([
        'assets/cubemaps/skybox/right.jpg',
        'assets/cubemaps/skybox/left.jpg',
        'assets/cubemaps/skybox/top.jpg',
        'assets/cubemaps/skybox/bottom.jpg',
        'assets/cubemaps/skybox/front.jpg',
        'assets/cubemaps/skybox/back.jpg'
    ]);

    const envmap = new Cubemap();
    envmap.createFromFiles([
        'assets/cubemaps/envmap/right.jpg',
        'assets/cubemaps/envmap/left.jpg',
        'assets/cubemaps/envmap/top.jpg',
        'assets/cubemaps/envmap/bottom.jpg',
        'assets/cubemaps/envmap/front.jpg',
        'assets/cubemaps/envmap/back.jpg'
    ]);

    const crate = new ModelNode('crate', new Model(
        Geometry.Cube(),
        Material.Default({
            reflectivity: 1.0,
            textures: {
                base: new Texture().createFromFile('assets/crateTextures/diff.png'),
                specular: new Texture().createFromFile('assets/crateTextures/spec.png'),
                emissive: new Texture().createFromFile('assets/crateTextures/emis.png'),
                reflectivity: new Texture().createFromFile('assets/crateTextures/refl.png')}
            },
            { castShadow: true }
        )
    ));
    crate.setPosition([-2, 1, 0]);

    const sun = new LightNode('sun', new DirectionalLight({}), true)
    sun.setRotation([90, 0, 0]);
    

    const pl1 = new LightNode('pointLight', new PointLight({
        diffuse: [0.0, 0.0, 1.0],
        specular: [0.0, 0.0, 1.0],
        constant: 1.0
    }));
    pl1.setPosition([2, 2, 2]);

    const pl2 = new LightNode('pointLight2', new PointLight({
        diffuse: [0.0, 1.0, 0.0],
        specular: [0.0, 1.0, 0.0],
        constant: 2.0
    }));

    const terrain = new ModelNode('terrain', new Model(
        await Geometry.Terrain('assets/terrain_hm.jpg'),
        Material.Default({
            textures: {
                base: new Texture({ flipY: true }).createFromFile('assets/terrain_tex.jpg'),
            },
            specular: [0.4, 0.4, 0.4],
            shininess: 64.0
        })
    ));
    terrain.setY(-4);
    
    const room = new Node('room');
    const roomModel = await Model.FromFile({filePaths: ['assets/viking_room/viking_room.obj', 'assets/viking_room/viking_room.mtl']});
    roomModel[0].model.material.config.castShadow = true;
    room.addChild(new ModelNode(roomModel[0].name, roomModel[0].model));
    room.setPosition([1, 1, 0]).setRotation([0, 180, 0]).setBody(0).attachShape(Shape.TriMesh(roomModel[0].model.geometry, [1, 1, 1]))

    const floor = new Node('floor');
    floor.rotateX(-90).setBody(0).attachShape(Shape.Plane())

    const sponza = new Node('sponza')
    sponza.setBody(0);
    const sponzaModels = await Model.FromFile({filePaths: ['assets/sponza/sponza.obj', 'assets/sponza/sponza.mtl']});
    for (const result of sponzaModels) {
        result.model.material.config.castShadow = true;
        const node = new ModelNode(result.name, result.model);
        sponza.addChild(node);
        const geometry = new Geometry();
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
            
            sponza.body?.attachShape(Shape.TriMesh(geometry, [1, 1, 1]))
    }

    const backpack = new Node('backpack')
    /* backpack.setPosition([-1, 2, 0]).setUniformScale(0.5).setBody(10).attachShape(Shape.Box(1, 2, 1));
    const backpackModels = await Model.FromFile({filePaths: ['assets/backpack/backpack.obj', 'assets/backpack/backpack.mtl']});
    for (const result of backpackModels) {
        result.model.material.config.castShadow = true;
        const node = new ModelNode(result.name, result.model);
        backpack.addChild(node);
    } */

    const helmet = new Node('helmet')
    helmet.setPosition([1, 2, 0]).setUniformScale(0.5).setBody(20, 0.5, 0.5).attachShape(Shape.Sphere(0.5));
 
    const damagedHelmetModels = await Model.FromFile({filePaths: ['assets/damagedHelmet/damaged_helmet.obj', 'assets/damagedHelmet/damaged_helmet.mtl']});
    for (const result of damagedHelmetModels) {
        result.model.material.config.castShadow = true;
        const node = new ModelNode(result.name, result.model);
        helmet.addChild(node);
    }

    app.scene.skybox = skybox;
    app.scene.environmentMap = envmap;

    app.scene.addNode(floor);
    app.scene.addNode(sun);
    app.scene.addNode(pl1);
    app.scene.addNode(room);
    app.scene.addNode(crate);
    app.scene.addNode(terrain)
    app.scene.attachNode(pl2, 'crate');
    app.scene.addNode(helmet);
    app.scene.addNode(backpack);
    app.scene.addNode(sponza);
};

app.onPostInitialize = () => {
    let worldTexture = new Texture({ flipY: true }).createFromFile('assets/world.png')
    const shootSphere = () => {
        const sphere = new ModelNode(`sphere${Math.random() * 1000}`, new Model(
            Geometry.Sphere(),
            Material.Default({ reflectivity: 0.5, textures: { base: worldTexture} }, { castShadow: true })
        ));
        sphere.setUniformScale(0.25).setPosition(app.camera.position).setBody(5).attachShape(Shape.Sphere(0.25))
        const impulseVector = vec3.create();
        vec3.scale(impulseVector, app.camera.forward, 100);
        sphere.body?.impulse(impulseVector)
        app.scene.addNode(sphere);
    }

    let boxBaseTexture = new Texture().createFromFile('assets/crateTextures/diff.png');
    let boxSpecularTexture = new Texture().createFromFile('assets/crateTextures/spec.png');
    let boxEmissiveTexture = new Texture().createFromFile('assets/crateTextures/emis.png');
    let boxReflectivityTexture = new Texture().createFromFile('assets/crateTextures/refl.png');

    const spawnBox = () => {
        const box = new ModelNode(`box${Math.random() * 1000}`, new Model(
            Geometry.Cube(),
            Material.Default({
                textures: {
                    base: boxBaseTexture,
                    specular: boxSpecularTexture,
                    emissive: boxEmissiveTexture,
                    reflectivity: boxReflectivityTexture
                }
            }, { castShadow: true })
        ));
        box.setPosition([Math.random(), 5, Math.random()]).setBody(Math.random() * 10).attachShape(Shape.Box(1, 1, 1))
        app.scene.addNode(box);
    }

    
    app.input.registerKeyPress('KeyZ', () => { shootSphere(); });
    app.input.registerKeyPress('KeyX', () => { spawnBox(); });
    app.input.registerKeyPress('KeyP', () => {app.isPaused = !app.isPaused})
};  

app.onUpdate = (delta: number, time: number) => {
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

    let crate = app.scene.getNode('crate')
    if (crate) {
        crate.setY(Math.sin(time*0.001) + 1).rotateX(1).rotateY(1);
        let change = Math.sin(time * 0.005)/2 + 0.5;
        (crate as ModelNode).model.material.properties.set('emissive', [0, change, 0]);
        (app.scene.getNode('pointLight2') as LightNode).light.diffuse[1] = change;
    }

    app.scene.getNode('pointLight')?.setPosition([Math.sin(time*0.005) * 2, 0, Math.cos(time*0.005) * 2]);
}

app.run();