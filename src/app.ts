import { Camera } from "./core/camera";
import { Engine } from "./core/engine";

let app: Engine;
let camera: Camera;

window.onload = () => {
    app = new Engine({
        clearColor: [0.2, 0.2, 0.2, 1.0]
    });

    camera = new Camera({
        position: [0, 0, -2]
    });

    app.camera = camera;

    app.initialize();
    app.run();

    app.onUpdate = (delta: number, time: number) => {}
}

window.onmousemove = (event: MouseEvent) => {
    camera.rotation[0] = -(event.clientY / window.innerHeight - 0.5) * Math.PI;
    camera.rotation[1] = -(event.clientX / window.innerWidth - 0.5) * Math.PI * 2;

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