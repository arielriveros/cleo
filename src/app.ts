import { Engine } from "./core/engine";

let app: Engine;

window.onload = () => {
    app = new Engine({
        clearColor: [0.2, 0.2, 0.2, 1.0]
    });
    app.initialize();
    app.run();
}

window.onresize = () => {
    app.onResize();
}