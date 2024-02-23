import { mat4, vec3 } from "gl-matrix";

interface CameraProperties {
    type?: 'perspective' | 'orthographic';
    fov?: number;
    near?: number;
    far?: number;
    left?: number;
    right?: number;
    bottom?: number;
    top?: number;
}

export class Camera {
    private _type: 'perspective' | 'orthographic';
    private _position: vec3 = vec3.create();
    private _eye: vec3 = vec3.create();
    private _fov: number;
    private _near: number;
    private _far: number;
    private _ratio: number;
    private _left: number;
    private _right: number;
    private _bottom: number;
    private _top: number;

    constructor(properties: CameraProperties = {}) {
        this._type = properties.type || 'perspective';
        this._fov = properties.fov || 60;
        this._near = properties.near || 0.1;
        this._far = properties.far || 100;
        this._left = properties.left || -1;
        this._right = properties.right || 1;
        this._bottom = properties.bottom || -1;
        this._top = properties.top || 1;
        this._ratio = 1;
    }

    public resize(width: number, height: number) {
        this._ratio = width / height;
    }

    public get type(): 'perspective' | 'orthographic' { return this._type; }
    public set type(value: 'perspective' | 'orthographic') { this._type = value; }
    public get position(): vec3 { return this._position; }
    public set position(value: vec3) { this._position = value; }
    public get eye(): vec3 { return this._eye; }
    public set eye(value: vec3) { this._eye = value; }
    public get fov(): number { return this._fov; }
    public set fov(value: number) { this._fov = value; }
    public get near(): number { return this._near; }
    public set near(value: number) { this._near = value; }
    public get far(): number { return this._far; }
    public set far(value: number) { this._far = value; }
    public get left(): number { return this._left; }
    public set left(value: number) { this._left = value; }
    public get right(): number { return this._right; }
    public set right(value: number) { this._right = value; }
    public get bottom(): number { return this._bottom; }
    public set bottom(value: number) { this._bottom = value; }
    public get top(): number { return this._top; }
    public set top(value: number) { this._top = value; }

    public get viewMatrix(): mat4 {
        return mat4.lookAt(mat4.create(), this._position, this._eye, vec3.fromValues(0, 1, 0));
    }

    public get projectionMatrix(): mat4 {
        const out = mat4.create();

        if (this._type === 'perspective')
            mat4.perspective(out, this._fov * Math.PI / 180, this._ratio, this._near, this._far);
        else
            mat4.ortho(out, this._left * this._ratio, this._right * this._ratio, this._bottom, this._top, this._near, this._far);

        return out;
    }

}