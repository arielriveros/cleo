import { mat4, vec3 } from "gl-matrix";

interface CaperaProperties {
    fov?: number;
    near?: number;
    far?: number;
}

export class Camera {
    private _position: vec3 = vec3.create();
    private _eye: vec3 = vec3.create();
    private _fov: number = 45;
    private _near: number = 0.1;
    private _far: number = 100;
    private _ratio: number = 1;


    constructor(properties: CaperaProperties = {}) {
        this._fov = properties.fov || 45;
        this._near = properties.near || 0.1;
        this._far = properties.far || 100;
        this._ratio = 1;
    }

    public resize(width: number, height: number) {
        this._ratio = width / height;
    }

    public get position(): vec3 { return this._position; }
    public set position(value: vec3) { this._position = value; }
    public get eye(): vec3 { return this._eye; }
    public set eye(value: vec3) { this._eye = value; }
    public get fov(): number { return this._fov; }
    public get near(): number { return this._near; }
    public get far(): number { return this._far; }

    public get viewMatrix(): mat4 {
        return mat4.lookAt(mat4.create(), this._position, this._eye, vec3.fromValues(0, 1, 0));
    }

    public get projectionMatrix(): mat4 {
        return mat4.perspective(mat4.create(), this._fov, this._ratio, this._near, this._far);
    }

}