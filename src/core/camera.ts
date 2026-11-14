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
    private _up: vec3 = vec3.clone(UP);
    private _fov: number;
    private _near: number;
    private _far: number;
    private _ratio: number;
    private _left: number;
    private _right: number;
    private _bottom: number;
    private _top: number;

    private _view: mat4 = mat4.create();
    private _projection: mat4 = mat4.create();
    private _viewDirty: boolean = true;
    private _projDirty: boolean = true;

  /** The field of view viewmodel nodes are drawn at, degrees (0: the camera's own). See Node.viewmodel. */
  public viewmodelFov: number = 0;
  /**
   * For an orthographic camera, how far ahead of it the renderer measures detail from: LOD levels, draw
   * distances, which foliage is admitted and how it dissolves (runtime, not serialized). An orthographic
   * view has no depth on screen, so a camera standing well back from what it frames -- the editor's Top or
   * Front pane -- would otherwise see everything at its coarsest, or culled. 0: from the camera itself.
   * Ignored for a perspective camera.
   */
  public detailDistance: number = 0;
  /**
   * The share of its true distance a viewmodel node is drawn at along each view ray, 0.05..1 (runtime, not
   * serialized). A script lowers it while a wall is close in front, so the weapon stays clear of the wall at
   * the same size on the screen.
   */
  public viewmodelDepth: number = 1;
  private readonly _viewmodelMatrix: mat4 = mat4.create();

  /**
   * The matrix applied to a viewmodel's VIEW-space position before the projection, or null when
   * viewmodels are drawn as the world is. x and y are scaled by the lens ratio (a narrower lens magnifies
   * about the axis), and all three by the depth share. NDC x/y depend only on the lens ratio (the share
   * cancels in the divide by w); NDC depth is that of the nearer point.
   */
  public get viewmodelMatrix(): mat4 | null {
    if (this._type !== 'perspective') return null;
    const k = Math.min(1, Math.max(0.05, this.viewmodelDepth));
    const f = this.viewmodelFov > 0 ? Math.tan(this._fov * Math.PI / 360) / Math.tan(this.viewmodelFov * Math.PI / 360) : 1;
    if (f === 1 && k === 1) return null;
    const m = this._viewmodelMatrix;
    mat4.identity(m);
    m[0] = f * k; m[5] = f * k; m[10] = k;
    return m;
  }

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
    // Setters copy into the internal vectors; the camera never aliases a caller's vector.
    public get position(): vec3 { return this._position; }
    public set position(value: vec3) { vec3.copy(this._position, value); this._viewDirty = true; }
    public get eye(): vec3 { return this._eye; }
    public set eye(value: vec3) { vec3.copy(this._eye, value); this._viewDirty = true; }
    // Defaults to world up; cube-map capture must set it explicitly for the +Y / -Y faces.
    public get up(): vec3 { return this._up; }
    public set up(value: vec3) { vec3.copy(this._up, value); this._viewDirty = true; }
    public get fov(): number { return this._fov; }
    public set fov(value: number) { if (value !== this._fov) { this._fov = value; this._projDirty = true; } }
    public get near(): number { return this._near; }
    public set near(value: number) { if (value !== this._near) { this._near = value; this._projDirty = true; } }
    public get far(): number { return this._far; }
    public set far(value: number) { if (value !== this._far) { this._far = value; this._projDirty = true; } }
    /**
     * Viewport aspect (width / height), set by {@link resize}. Anything that UNPROJECTS must apply the
     * same scaling `projectionMatrix` does: an orthographic camera scales `left`/`right` by this and
     * leaves `top`/`bottom` alone (see {@link Raycaster.screenToRay}).
     */
    public get ratio(): number { return this._ratio; }
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
            mat4.lookAt(this._view, this._position, this._eye, this._up);
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