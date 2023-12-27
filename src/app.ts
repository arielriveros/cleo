import { Camera } from "./core/camera";
import { Engine } from "./core/engine";
import { Geometry } from "./core/geometry";
import { Material } from "./core/material";
import { Model } from "./graphics/model";
import { Texture } from "./graphics/texture";
import { LightNode, ModelNode } from "./core/scene/node";
import { Scene } from "./core/scene/scene";
import { DirectionalLight, PointLight } from "./core/lighting";
import { Shape } from "./physics/shape";
import { vec3 } from "gl-matrix";

let app: Engine = new Engine({clearColor: [0.2, 0.2, 0.2, 1.0]});

app.onPreInitialize = async () => {
    app.camera = new Camera({position: [0, 1, -10], far: 1000});
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
    backpack.setUniformScale(0.5);
    backpack.setPosition([2, 0, 2]);
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
    crate.setPosition([-2, 1, 0]);
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
    room.setPosition([2, -1, 2]);
    room.setRotation([-90, 90, 0]);
    room.setUniformScale(3);
    app.scene.addNode(room);

    const sun = new LightNode('sun', new DirectionalLight({}))
    sun.setRotation([90, 0, 0]);
    app.scene.addNode(sun);

    const pl1 = new LightNode('pointLight', new PointLight({
        diffuse: [0.0, 0.0, 1.0],
        specular: [0.0, 0.0, 1.0],
        constant: 1.0
    }));
    pl1.setPosition([2, 2, 2]);

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

    terrain.setY(-4);
    terrain.setUniformScale(0.25);
    app.scene.addNode(terrain)

    const floor = new ModelNode('floor', new Model(
        Geometry.Quad(),
        Material.Default({
            specular: [0.25, 0.25, 0.25],
            shininess: 128,
            textures: {
                base: new Texture().createFromFile('assets/grass_diff.jpg'),
                specular: new Texture().createFromFile('assets/grass_spec.jpg')
            },
        })
    ));

    floor.setUniformScale(10);
    floor.setY(-2);
    floor.setRotation([-90, 0, 0]);
    floor.setBody(Shape.Box(5, 5, 0.001), 0);
    app.scene.addNode(floor);

};

app.onPostInitialize = () => {

    let worldTexture = new Texture().createFromFile('assets/world.png', {flipY: true})
    const shootSphere = () => {
        const sphere = new ModelNode(`sphere${Math.random() * 1000}`, new Model(
            Geometry.Sphere(),
            Material.Default({ textures: { base: worldTexture} })
        ));
        sphere.setUniformScale(0.5)
        sphere.setPosition(app.camera.position);
        sphere.setBody(Shape.Sphere(0.5), 5);
        const impulseVector = vec3.create();
        vec3.scale(impulseVector, app.camera.forward, 100);
        sphere.body?.impulse(impulseVector)
        app.scene.addNode(sphere);
    }

    let boxBaseTexture = new Texture().createFromFile('assets/cube_diff.png');
    let boxSpecularTexture = new Texture().createFromFile('assets/cube_spec.png');

    const spawnBox = () => {
        const box = new ModelNode(`box${Math.random() * 1000}`, new Model(
            Geometry.Cube(),
            Material.Default({
                textures: {
                    base: boxBaseTexture,
                    specular: boxSpecularTexture
                }
            })
        ));
        box.setPosition([Math.random(), 5, Math.random()]);
        box.setBody(Shape.Box(0.5, 0.5, 0.5), Math.random() * 10);
        app.scene.addNode(box);
    }

    
    app.input.registerKeyPress('KeyZ', () => { shootSphere(); });
    app.input.registerKeyPress('KeyX', () => { spawnBox(); });
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
        app.input.isKeyPressed('ArrowLeft') && (sun.rotateY(-0.01));
        app.input.isKeyPressed('ArrowRight') && (sun.rotateY(0.01));
        app.input.isKeyPressed('ArrowUp') && (sun.rotateX(0.01));
        app.input.isKeyPressed('ArrowDown') && (sun.rotateX(-0.01));
    }

    let backpack = app.scene.getNode('backpack')
    if (backpack)
        backpack.rotateY(0.01);

    let crate = app.scene.getNode('crate')
    if (crate) {
        crate.setY(Math.sin(time*0.001) + 1);
        crate.rotateX(0.01);
        crate.rotateY(0.01);
        let change = Math.sin(time * 0.005)/2 + 1;
        (crate as ModelNode).model.material.properties.set('emissive', [0, change, 0]);
        let light = app.scene.getNode('pointLight2') as LightNode;
        if (light)
            light.light.diffuse[1] = change;
    }

    let blueLight = app.scene.getNode('pointLight')
    if (blueLight)
        blueLight.setPosition([Math.sin(time*0.005) * 2, 0, Math.cos(time*0.005) * 2]);
}

app.run();