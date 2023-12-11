import { Camera } from "./core/camera";
import { Engine } from "./core/engine";
import { Geometry } from "./core/geometry";
import { Material } from "./core/material";
import { Model } from "./graphics/model";
import { Texture } from "./graphics/texture";

let app: Engine;
let camera: Camera;
let scene: Model[];

window.onload = () => {
    app = new Engine({
        clearColor: [0.2, 0.2, 0.2, 1.0]
    });

    camera = new Camera({
        position: [0, 0, -2],
    });

    const model1 = new Model(Geometry.Triangle(), Material.Basic({color: [1.0, 0.0, 0.0]}));
    model1.position[0] = -0.5;
    model1.scale[0] = 0.5;
    model1.scale[1] = 0.5;

    const texture = new Texture().createFromFile('assets/roma.png');
    
    const model2 = new Model(
        Geometry.Quad(),
        Material.Basic({
            texture: texture,
            color: [1.0, 0.0, 1.0]},
            { side: 'double'}
        )
    );
    model2.position[0] = 0.5;
    model2.scale[2] = 0.5;

    const model3 = new Model(Geometry.Circle(), Material.Default({diffuse: [1.0, 0.0, 1.0], specular: [0.0, 1.0, 0.0]}, { side: 'front'}));
    model3.position[1] = 0.5;

    const crateSpec = new Texture().createFromFile('assets/cube_spec.png');
    const crateTex = new Texture().createFromFile('assets/cube_diff.png');
    const crate = new Model(
        Geometry.Cube(),
        Material.Default({
            textures: {
                base: crateTex,
                specular: crateSpec
            },
            shininess: 32.0},
            { side: 'front'}
        )
    );
    crate.position[1] = -0.5;
    crate.scale[0] = 0.5;
    crate.scale[1] = 0.5;
    crate.scale[2] = 0.5;

    const model5 = new Model(
        Geometry.Cube(),
        Material.Custom(
            'custom',
            { vertexShader: 'shaders/basic.vert', fragmentShader: 'assets/custom.frag'},
            new Map<string, any>()
        )
    )
    model5.position[1] = -1.0;
    model5.scale[0] = 0.5;
    model5.scale[1] = 0.5;
    model5.scale[2] = 0.5;

    const wallTex = new Texture().createFromFile('assets/bricks_diff.jpg');
    const wallSpec = new Texture().createFromFile('assets/bricks_spec.jpg');

    const wall = new Model(
        Geometry.Quad(),
        Material.Default({
            textures: {
                base: wallTex,
                specular: wallSpec
            },
            shininess: 512.0},
            { side: 'front'}
        )
    )
    wall.position[2] = 0.5;
    wall.rotation[0] = Math.PI;

    wall.scale[0] = 2;
    wall.scale[1] = 2;

    const grassTex = new Texture().createFromFile('assets/grass_diff.jpg');
    const grassSpec = new Texture().createFromFile('assets/grass_spec.jpg');
    const grass = new Model(
        Geometry.Quad(),
        Material.Default({
            textures: {
                base: grassTex,
                specular: grassSpec
            },
            shininess: 512.0},
            { side: 'front'}
        )
    )
    grass.position[1] = -1;
    grass.position[2] = -0.5;
    
    grass.rotation[0] = -Math.PI / 2;
    grass.scale[0] = 2;
    grass.scale[1] = 2;

    scene = [model1, model2, model3, crate, model5, wall, grass];

    app.camera = camera;
    app.scene = scene;

    app.initialize();
    app.run();

    app.onUpdate = (delta: number, time: number) => {
        scene[0].rotation[1] += 0.01;
        scene[1].rotation[0] -= 0.01;
        scene[2].rotation[0] += 0.01;
        scene[3].rotation[0] -= 0.01;
        scene[4].material.properties.set('time', time / 1000);
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