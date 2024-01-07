import { Camera } from "./core/camera";
import { Engine } from "./core/engine";
import { Geometry } from "./core/geometry";
import { Material } from "./core/material";
import { Model } from "./graphics/model";
import { Texture } from "./graphics/texture";
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

    const crate = new ModelNode('crate', new Model(
        Geometry.Cube(),
        Material.Default({
            opacity: 0.5,
            textures: {
                base: new Texture().createFromFile('assets/cube_diff.png'),
                specular: new Texture().createFromFile('assets/cube_spec.png'),
                emissive: new Texture().createFromFile('assets/cube_emis.png')},
            },
            {
                transparent: true,
            }
        )
    ));
    crate.setPosition([-2, 1, 0]);

    const sun = new LightNode('sun', new DirectionalLight({
        diffuse: [1.2, 1.2, 1.2],
        specular: [1.2, 1.2, 1.2]
    }), true)
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
                base: new Texture().createFromFile('assets/terrain_tex.jpg', {flipY: true}),
            },
            specular: [0.4, 0.4, 0.4],
            shininess: 64.0
        })
    ));
    terrain.setY(-4);
    
    const roomModel = await Model.FromFile({filePaths: ['assets/viking_room/viking_room.obj', 'assets/viking_room/viking_room.mtl']});
    const room = new ModelNode('room', roomModel[0]);
    room.setY(1);
    room.setBody(25)
    .attachShape(Shape.TriMesh(roomModel[0].geometry, [1, 1, 1]))
    /* .attachShape(Shape.Box(1, 0.2, 1))
    .attachShape(Shape.Box(0.8, 0.8, 0.2), [0, 0.5, 1])
    .attachShape(Shape.Box(0.5, 0.8, 1), [-0.5, 0.5, 0]) */


    const floor = new Node('floor');
    floor.setY(-2);
    floor.rotateX(-Math.PI/2);
    floor.setBody(0)
    .attachShape(Shape.Plane())
    app.scene.addNode(floor);

    app.scene.addNode(sun);
    app.scene.addNode(pl1);
    app.scene.addNode(room);
    app.scene.addNode(crate);
    app.scene.addNode(terrain)
    app.scene.attachNode(pl2, 'crate');

    /* const sponza = new Node('sponza')
    sponza.setBody(0)
    .attachShape(Shape.Box(12, 0.01, 30)) // floor
    .attachShape(Shape.Box(10, 10, 0.01), [0, 5, -12.5]) // back wall
    .attachShape(Shape.Box(10, 10, 0.01), [0, 5, 14]) // front wall
    .attachShape(Shape.Box(0.01, 10, 30), [-6.5, 5, 0]) // left wall
    .attachShape(Shape.Box(0.01, 10, 30), [6, 5, 0]) // right wall
    .attachShape(Shape.Box(0.5, 0.5, 0.5), [-2.2, 0.5, 2.4])
    .attachShape(Shape.Box(0.5, 0.5, 0.5), [ 1.4, 0.5, 2.4])

    const sponzaModels = await Model.FromFile({filePaths: ['assets/sponza/sponza.obj', 'assets/sponza/sponza.mtl']});
    for (const model of sponzaModels) {
        const node = new ModelNode('sponza'+Math.random().toString(), model);
        sponza.addChild(node);
    }
    app.scene.addNode(sponza); */
};

app.onPostInitialize = () => {
    let worldTexture = new Texture().createFromFile('assets/world.png', {flipY: true})
    const shootSphere = () => {
        const sphere = new ModelNode(`sphere${Math.random() * 1000}`, new Model(
            Geometry.Sphere(),
            Material.Default({ textures: { base: worldTexture} })
        ));
        sphere.setUniformScale(0.25)
        sphere.setPosition(app.camera.position);
        sphere.setBody(5)
        .attachShape(Shape.Sphere(0.25))
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
        box.setBody(Math.random() * 10)
        .attachShape(Shape.Box(1, 1, 1))
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
        app.input.isKeyPressed('ArrowLeft') && (sun.rotateZ(-0.01));
        app.input.isKeyPressed('ArrowRight') && (sun.rotateZ(0.01));
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