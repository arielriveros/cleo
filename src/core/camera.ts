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

const UP = vec3.fromValues(0, 1, 0);

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

    // Cached matrices, recomputed only when their inputs change (see _viewDirty / _projDirty).
    private _view: mat4 = mat4.create();
    private _projection: mat4 = mat4.create();
    private _viewDirty: boolean = true;
    private _projDirty: boolean = true;

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
        const ratio = width / height;
        if (ratio !== this._ratio) {
            this._ratio = ratio;
            this._projDirty = true;
        }
    }

    public get type(): 'perspective' | 'orthographic' { return this._type; }
    public set type(value: 'perspective' | 'orthographic') { if (value !== this._type) { this._type = value; this._projDirty = true; } }
    // Setters copy into the internal vectors so the camera never aliases (and gets desynced by)
    // externally-owned/cached vectors such as a node's world position.
    public get position(): vec3 { return this._position; }
    public set position(value: vec3) { vec3.copy(this._position, value); this._viewDirty = true; }
    public get eye(): vec3 { return this._eye; }
    public set eye(value: vec3) { vec3.copy(this._eye, value); this._viewDirty = true; }
    public get fov(): number { return this._fov; }
    public set fov(value: number) { if (value !== this._fov) { this._fov = value; this._projDirty = true; } }
    public get near(): number { return this._near; }
    public set near(value: number) { if (value !== this._near) { this._near = value; this._projDirty = true; } }
    public get far(): number { return this._far; }
    public set far(value: number) { if (value !== this._far) { this._far = value; this._projDirty = true; } }
    public get left(): number { return this._left; }
    public set left(value: number) { if (value !== this._left) { this._left = value; this._projDirty = true; } }
    public get right(): number { return this._right; }
    public set right(value: number) { if (value !== this._right) { this._right = value; this._projDirty = true; } }
    public get bottom(): number { return this._bottom; }
    public set bottom(value: number) { if (value !== this._bottom) { this._bottom = value; this._projDirty = true; } }
    public get top(): number { return this._top; }
    public set top(value: number) { if (value !== this._top) { this._top = value; this._projDirty = true; } }

    public get viewMatrix(): mat4 {
        if (this._viewDirty) {
            mat4.lookAt(this._view, this._position, this._eye, UP);
            this._viewDirty = false;
        }
        return this._view;
    }

    public get projectionMatrix(): mat4 {
        if (this._projDirty) {
            if (this._type === 'perspective')
                mat4.perspective(this._projection, this._fov * Math.PI / 180, this._ratio, this._near, this._far);
            else
                mat4.ortho(this._projection, this._left * this._ratio, this._right * this._ratio, this._bottom, this._top, this._near, this._far);
            this._projDirty = false;
        }
        return this._projection;
    }

}