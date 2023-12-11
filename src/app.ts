import { Camera } from "./core/camera";
import { Engine } from "./core/engine";
import { Geometry } from "./core/geometry";
import { Material } from "./core/material";
import { Model } from "./graphics/model";
import { Texture } from "./graphics/texture";

let app: Engine;
let camera: Camera;
let scene: Model[] = [];

window.onload = () => {
    app = new Engine({
        clearColor: [0.2, 0.2, 0.2, 1.0]
    });

    camera = new Camera({
        position: [0, 0, -2],
    });

    const crateSpec = new Texture().createFromFile('assets/cube_spec.png');
    const crateTex = new Texture().createFromFile('assets/cube_diff.png');
    const crate = new Model(
        Geometry.Cube(),
        Material.Default({
            textures: {
                base: crateTex,
                specular: crateSpec
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

    scene.push(crate);

    app.camera = camera;
    app.scene = scene;

    Model.FromFile('assets/viking_room.obj', Material.Default({textures: {
            base: new Texture().createFromFile('assets/viking_room.png')},
            specular: [0.25, 0.25, 0.25],
        })).then((model) => {
        model.position[1] = -1;
        model.rotation[0] = -Math.PI / 2;
        model.rotation[2] = Math.PI / 2;
        model.scale[0] = 3;
        model.scale[1] = 3;
        model.scale[2] = 3;
        scene.push(model);

        Model.FromFile('assets/backpack.obj', Material.Default({textures: {
                base: new Texture().createFromFile('assets/backpack_diff.jpg', {flipY: true}),
                specular: new Texture().createFromFile('assets/backpack_spec.jpg', {flipY: true})},
                shininess: 64}
            )).then((backpack) => {
            backpack.rotation[2] = -Math.PI / 4;
            backpack.rotation[1] = -Math.PI / 2;
            
            backpack.scale[0] = 0.5;
            backpack.scale[1] = 0.5;
            backpack.scale[2] = 0.5;
            scene.push(backpack);

            app.initialize();
            app.run();
        });
    });

    
    

    app.onUpdate = (delta: number, time: number) => {
    }
}

window.onmousemove = (event: MouseEvent) => {
    if (event.buttons === 1) {
        camera.rotation[0] = -(event.clientY / window.innerHeight - 0.5) * Math.PI;
        camera.rotation[1] = -(event.clientX / window.innerWidth - 0.5) * Math.PI * 2;
    }
}

window.onkeydown = (event: KeyboardEvent) => {
    if (event.key === "w") {
        camera.moveForward(0.1);
    } else if (event.key === "s") {
        camera.moveForward(-0.1);
    } else if (event.key === "a") {
        camera.moveRight(-0.1);
    } else if (event.key === "d") {
        camera.moveRight(0.1);
    }
}


window.onresize = () => {
    app.onResize();
}