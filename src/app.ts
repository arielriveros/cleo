import { Camera } from "./core/camera";
import { Engine } from "./core/engine";
import { Geometry } from "./core/geometry";
import { Material } from "./core/material";
import { Model } from "./graphics/model";
import { Texture } from "./graphics/texture";
import { LightNode, ModelNode } from "./core/scene/node";
import { Scene } from "./core/scene/scene";
import { DirectionalLight, PointLight } from "./core/lighting";

let app: Engine = new Engine({clearColor: [0.2, 0.2, 0.2, 1.0]});

app.onPreInitialize = async () => {
    app.camera = new Camera({position: [0, 0, -2], far: 10000});
    app.scene = new Scene();    

    const backpackModel = await Model.FromFile(
        'assets/backpack.obj',
        Material.Default({
            textures: {
                base: new Texture().createFromFile('assets/backpack_diff.jpg', {flipY: true}),
                specular: new Texture().createFromFile('assets/backpack_spec.jpg', {flipY: true})},
            shininess: 64,
            opacity: 0.75,
        }, {
            transparent: true
        })
    );
    const backpack = new ModelNode('backpack', backpackModel)
    backpack.scale[0] = 0.5;
    backpack.scale[1] = 0.5;
    backpack.scale[2] = 0.5;
    app.scene.addNode(backpack);

    const crate = new ModelNode('crate', new Model(
        Geometry.Cube(),
        Material.Default({
            textures: {
                base: new Texture().createFromFile('assets/cube_diff.png'),
                specular: new Texture().createFromFile('assets/cube_spec.png'),
                emissive: new Texture().createFromFile('assets/cube_emis.png')}
            }
        )
    ));
    crate.position[0] = -2;
    crate.position[1] = 1;
    app.scene.attachNode(crate, 'backpack');

    const roomModel = await Model.FromFile(
        'assets/viking_room.obj', 
        Material.Default({
            textures: {
                base: new Texture().createFromFile('assets/viking_room.png')},
                specular: [0.25, 0.25, 0.25]
            }
        )
    );
    const room = new ModelNode('room', roomModel);
    room.position[1] = -1;
    room.rotation[0] = -Math.PI / 2;
    room.rotation[2] = Math.PI / 2;
    room.scale[0] = 3;
    room.scale[1] = 3;
    room.scale[2] = 3;
    app.scene.addNode(room);

    const sun = new LightNode('sun', new DirectionalLight({}))
    sun.rotation[0] = Math.PI / 4;
    app.scene.addNode(sun);

    const pl1 = new LightNode('pointLight', new PointLight({
        diffuse: [0.0, 0.0, 1.0],
        specular: [0.0, 0.0, 1.0],
        constant: 1.0
    }));
    pl1.position[0] = 2;
    pl1.position[1] = 2;
    pl1.position[2] = 2;

    app.scene.addNode(pl1);
    
    const pl2 = new LightNode('pointLight2', new PointLight({
        diffuse: [0.0, 1.0, 0.0],
        specular: [0.0, 1.0, 0.0],
        constant: 1.0
    }));
    app.scene.attachNode(pl2, 'crate');

    const terrain = new ModelNode('terrain', new Model(
        await Geometry.Terrain('assets/terrain_hm.jpg'),
        Material.Default({
            textures: {
                base: new Texture().createFromFile('assets/terrain_tex.jpg', {flipY: true}),
            },
            specular: [0.4, 0.4, 0.4],
            shininess: 64.0
        })
    ));

    terrain.position[1] = -4;
    terrain.scale[0] = 0.25;
    terrain.scale[1] = 0.25;
    terrain.scale[2] = 0.25;
    app.scene.addNode(terrain)
};

app.onPostInitialize = () => { 
    app.input.registerKeyPress('KeyR', () => {
        console.log('Resetting');
        app.camera.position[0] = 0;
        app.camera.position[1] = 0;
        app.camera.position[2] = 0;

        app.scene = new Scene();
    });
};  

app.onUpdate = (delta: number, time: number) => {
    let mouse = app.input.mouse;
    if (mouse.buttons.Left) {
        app.camera.rotation[0] -= mouse.velocity[1] * 0.01;
        app.camera.rotation[1] -= mouse.velocity[0] * 0.01;
    }

    app.input.isKeyPressed('KeyW') && app.camera.moveForward(0.1);
    app.input.isKeyPressed('KeyS') && app.camera.moveForward(-0.1);
    app.input.isKeyPressed('KeyA') && app.camera.moveRight(-0.1);
    app.input.isKeyPressed('KeyD') && app.camera.moveRight(0.1);
    app.input.isKeyPressed('KeyE') && app.camera.moveUp(0.1);
    app.input.isKeyPressed('KeyQ') && app.camera.moveUp(-0.1);

    let sun = app.scene.getNode('sun')
    if (sun) {
        app.input.isKeyPressed('ArrowLeft') && (sun.rotation[1] -= 0.01);
        app.input.isKeyPressed('ArrowRight') && (sun.rotation[1] += 0.01);
        app.input.isKeyPressed('ArrowUp') && (sun.rotation[0] -= 0.01);
        app.input.isKeyPressed('ArrowDown') && (sun.rotation[0] += 0.01);
    }

    let backpack = app.scene.getNode('backpack')
    if (backpack)
        backpack.rotation[1] += 0.01;

    let crate = app.scene.getNode('crate')
    if (crate) {
        crate.position[1] = Math.sin(time*0.001) + 1;
        crate.rotation[0] += 0.01;
        let change = Math.sin(time * 0.005)/2 + 1;
        (crate as ModelNode).model.material.properties.set('emissive', [0, change, 0]);
        let light = app.scene.getNode('pointLight2') as LightNode;
        if (light)
            light.light.diffuse[1] = change;
    }

    let blueLight = app.scene.getNode('pointLight')
    if (blueLight) {
        blueLight.position[0] = Math.sin(time*0.005) * 2;
        blueLight.position[2] = Math.cos(time*0.005) * 2;
    }
}

app.run();