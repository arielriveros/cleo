import { mat4, vec3 } from "gl-matrix";

interface CaperaProperties {
    position?: vec3;
    rotation?: vec3;
    fov?: number;
    near?: number;
    far?: number;
}

export class Camera {
    private _position: vec3;
    private _rotation: vec3;
    private _fov: number;
    private _near: number;
    private _far: number;
    private _ratio: number;
    private _forward: vec3;


    constructor(properties: CaperaProperties = {}) {
        this._position = properties.position || vec3.create();
        this._rotation = properties.rotation || vec3.create();
        this._fov = properties.fov || 45;
        this._near = properties.near || 0.1;
        this._far = properties.far || 100;
        this._ratio = 1;
        this._forward = vec3.fromValues(0, 0, -1);
    }

    public update() {
        if (this._rotation[0] > Math.PI / 2) this._rotation[0] = Math.PI / 2 - 0.0001;
        if (this._rotation[0] < -Math.PI / 2) this._rotation[0] = -Math.PI / 2 + 0.0001;

        this._forward[0] = Math.cos(this._rotation[0]) * Math.sin(this._rotation[1]);
        this._forward[1] = Math.sin(this._rotation[0]);
        this._forward[2] = Math.cos(this._rotation[0]) * Math.cos(this._rotation[1]);
    }

    public resize(width: number, height: number) {
        this._ratio = width / height;
    }

    public moveForward(distance: number) {
        vec3.add(this._position, this._position, vec3.scale(vec3.create(), this._forward, distance));
    }

    public moveRight(distance: number) {
        // normalize forward vector
        vec3.normalize(this._forward, this._forward);
        // normalize right vector
        let right = vec3.cross(vec3.create(), this._forward, vec3.fromValues(0, 1, 0));
        vec3.normalize(right, right);
        // move along right vector
        vec3.add(this._position, this._position, vec3.scale(vec3.create(), right, distance));
    }

    public moveUp(distance: number) {
        vec3.add(this._position, this._position, vec3.scale(vec3.create(), vec3.fromValues(0, 1, 0), distance));
    }

    public get position(): vec3 { return this._position; }
    public get rotation(): vec3 { return this._rotation; }
    public get fov(): number { return this._fov; }
    public get near(): number { return this._near; }
    public get far(): number { return this._far; }

    public get viewMatrix(): mat4 {
        return mat4.lookAt(mat4.create(), this._position, vec3.add(vec3.create(), this._position, this._forward), vec3.fromValues(0, 1, 0));
    }

    public get projectionMatrix(): mat4 {
        return mat4.perspective(mat4.create(), this._fov, this._ratio, this._near, this._far);
    }

    public get forward(): vec3 { return this._forward; }
}