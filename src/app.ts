import { Camera } from "./core/camera";
import { Engine } from "./core/engine";
import { Geometry } from "./core/geometry";
import { Material } from "./core/material";
import { Model } from "./graphics/model";
import { Texture } from "./graphics/texture";

let app: Engine = new Engine({clearColor: [0.2, 0.2, 0.2, 1.0]});

app.onPreInitialize = async () => {
    app.camera = new Camera({position: [0, 0, -2],});

    const crate = new Model(
        Geometry.Cube(),
        Material.Default({
            textures: {
                base: new Texture().createFromFile('assets/cube_diff.png'),
                specular: new Texture().createFromFile('assets/cube_spec.png')
            },
            shininess: 256.0},
            { side: 'front'}
        )
    );

    crate.position[0] = -0.5;
    crate.position[1] = 0.25;

    crate.scale[0] = 0.5;
    crate.scale[1] = 0.5;
    crate.scale[2] = 0.5;
    app.scene.push(crate);

    const model = await Model.FromFile(
        'assets/viking_room.obj', 
        Material.Default({
            textures: {
                base: new Texture().createFromFile('assets/viking_room.png')},
                specular: [0.25, 0.25, 0.25]
            }
        )
    );
    model.position[1] = -1;
    model.rotation[0] = -Math.PI / 2;
    model.rotation[2] = Math.PI / 2;
    model.scale[0] = 3;
    model.scale[1] = 3;
    model.scale[2] = 3;
    app.scene.push(model);

    const backpack = await Model.FromFile(
        'assets/backpack.obj',
        Material.Default({
            textures: {
                base: new Texture().createFromFile('assets/backpack_diff.jpg', {flipY: true}),
                specular: new Texture().createFromFile('assets/backpack_spec.jpg', {flipY: true})},
            shininess: 64
        })
    );
    backpack.rotation[2] = -Math.PI / 4;
    backpack.rotation[1] = -Math.PI / 2;
    
    backpack.scale[0] = 0.5;
    backpack.scale[1] = 0.5;
    backpack.scale[2] = 0.5;
    app.scene.push(backpack);
};

app.onPostInitialize = () => { 
    app.input.registerKeyPress('KeyR', () => {
        console.log('Resetting camera');
        app.camera.position[0] = 0;
        app.camera.position[1] = 0;
        app.camera.position[2] = 0;
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
}

app.run();