import { clamp } from "../../../math";
import { UIRect, UIScaleMode, UISpace, copyRect, edgeClamp, projectToScreen, quadHomography, rectsEqual, rootScale, setRect, worldUIScale } from "../../../uiLayout";
import { mat4, vec3 } from "gl-matrix";
import { Node } from "../node";
import { UINode, emptyRect, numTuple } from "./uiNode";

/**
 * The UI root: the bridge between the scene and a screen (or world) rectangle.
 */

export class UIRootNode extends UINode {
    private _space: UISpace = 'screen';
    private _referenceResolution: [number, number] = [1920, 1080];
    private _scaleMode: UIScaleMode = 'scaleWithScreen';
    private _matchWidthOrHeight: number = 0.5;
    private _referenceDpr: number = 1;

    // --- World-space only ---
    private _uiTargetId: string | null = null;
    private _referenceDistance: number = 10;
    private _minScale: number = 0.1;
    private _maxScale: number = 4;
    private _billboard: boolean = true;
    private _clampToScreen: boolean = false;
    private _hideBehindCamera: boolean = true;

    /** Root scale applied by the DOM as a single `transform: scale()`. */
    private _scaleFactor: number = 1;
    private _offscreen: boolean = false;
    private _edgeAngleDeg: number = 0;
    private _planeMatrix: number[] | null = null;
    private readonly _origin: { x: number, y: number } = { x: 0, y: 0 };
    /** Previous resolved geometry, so a root's layoutVersion bumps only on a real change. */
    private readonly _prevRootRect: UIRect = emptyRect();
    private _prevOriginX: number = NaN;
    private _prevOriginY: number = NaN;
    private _prevScaleFactor: number = NaN;

    constructor(name: string = 'UI', space: UISpace = 'screen', id?: string) {
        super(name, 'uiRoot', id);
        this._space = space;
        if (space === 'world') {
            // A world label is anchored at its own point, so it wants a centred pivot and a modest
            // default size rather than the screen root's full-viewport rect.
            this._referenceResolution = [200, 60];
            this._pivot = [0.5, 0.5];
            this._scaleMode = 'constantPixel';
        }
    }

    public get space(): UISpace { return this._space; }
    public set space(v: UISpace) { const p = this._space; this._space = v; this._touch(); this._notifyChange('component', 'space', p, v); }
    public get referenceResolution(): [number, number] { return this._referenceResolution; }
    public set referenceResolution(v: [number, number]) { const p = this._referenceResolution; this._referenceResolution = numTuple(v, [1920, 1080]); this._touch(); this._notifyChange('component', 'referenceResolution', p, this._referenceResolution); }
    public get scaleMode(): UIScaleMode { return this._scaleMode; }
    public set scaleMode(v: UIScaleMode) { const p = this._scaleMode; this._scaleMode = v; this._touch(); this._notifyChange('component', 'scaleMode', p, v); }
    public get matchWidthOrHeight(): number { return this._matchWidthOrHeight; }
    public set matchWidthOrHeight(v: number) { const p = this._matchWidthOrHeight; this._matchWidthOrHeight = clamp(v, 0, 1); this._touch(); this._notifyChange('component', 'matchWidthOrHeight', p, this._matchWidthOrHeight); }
    public get referenceDpr(): number { return this._referenceDpr; }
    public set referenceDpr(v: number) { const p = this._referenceDpr; this._referenceDpr = Math.max(0.01, v); this._touch(); this._notifyChange('component', 'referenceDpr', p, this._referenceDpr); }

    /** Node whose world position this root follows, instead of its own. */
    public get uiTargetId(): string | null { return this._uiTargetId; }
    public set uiTargetId(v: string | null) { const p = this._uiTargetId; this._uiTargetId = v || null; this._touch(); this._notifyChange('component', 'uiTargetId', p, this._uiTargetId); }
    public get referenceDistance(): number { return this._referenceDistance; }
    public set referenceDistance(v: number) { const p = this._referenceDistance; this._referenceDistance = Math.max(0.001, v); this._touch(); this._notifyChange('component', 'referenceDistance', p, this._referenceDistance); }
    public get minScale(): number { return this._minScale; }
    public set minScale(v: number) { const p = this._minScale; this._minScale = Math.max(0, v); this._touch(); this._notifyChange('component', 'minScale', p, this._minScale); }
    public get maxScale(): number { return this._maxScale; }
    public set maxScale(v: number) { const p = this._maxScale; this._maxScale = Math.max(0, v); this._touch(); this._notifyChange('component', 'maxScale', p, this._maxScale); }
    public get billboard(): boolean { return this._billboard; }
    public set billboard(v: boolean) { const p = this._billboard; this._billboard = v; this._touch(); this._notifyChange('component', 'billboard', p, v); }
    public get clampToScreen(): boolean { return this._clampToScreen; }
    public set clampToScreen(v: boolean) { const p = this._clampToScreen; this._clampToScreen = v; this._touch(); this._notifyChange('component', 'clampToScreen', p, v); }
    public get hideBehindCamera(): boolean { return this._hideBehindCamera; }
    public set hideBehindCamera(v: boolean) { const p = this._hideBehindCamera; this._hideBehindCamera = v; this._touch(); this._notifyChange('component', 'hideBehindCamera', p, v); }

    /** The scale the DOM layer applies to this root's element. */
    public get scaleFactor(): number { return this._scaleFactor; }
    /** Where this root's rect starts in viewport CSS pixels. */
    public get origin(): { x: number, y: number } { return this._origin; }

    /**
     * True when a world-space anchor is outside the viewport (or behind the camera) and `clampToScreen`
     * pinned it to an edge. Meaningless for a screen-space root, which is always on screen.
     */
    public get offscreen(): boolean { return this._offscreen; }

    /**
     * Direction from the viewport centre toward a clamped world anchor: degrees, 0 = right, growing
     * CLOCKWISE, so it can be fed straight to a CSS `rotate()` on a marker glyph.
     */
    public get edgeAngleDeg(): number { return this._edgeAngleDeg; }

    /**
     * The `matrix3d` that lays this root flat in the world, or null when it is billboarded (the usual
     * case) or cannot be projected. Set only when `billboard` is false — see {@link quadHomography}.
     */
    public get planeMatrix(): number[] | null { return this._planeMatrix; }

    /**
     * Resolve this root and its whole subtree. Called by the scene's UI pass, not by {@link solveUI}: a
     * root's rect comes from the viewport or a projection, never from a parent rect.
     *
     * @param viewProj `projection * view` for the active camera, or null when there is no camera — world
     *                 roots then do not resolve.
     */
    public solveRoot(
        viewportWidth: number,
        viewportHeight: number,
        dpr: number,
        viewProj: mat4 | null,
        cameraOrthographic: boolean,
        orthoVerticalExtent: number,
    ): void {
        copyRect(this._prevRootRect, this._rect);

        if (this._space === 'world')
            this._solveWorldRoot(viewportWidth, viewportHeight, viewProj, cameraOrthographic, orthoVerticalExtent);
        else
            this._solveScreenRoot(viewportWidth, viewportHeight, dpr);

        copyRect(this._localRect, this._rect);
        setRect(this._screenRect,
            this._origin.x, this._origin.y,
            this._rect.width * this._scaleFactor, this._rect.height * this._scaleFactor);
        copyRect(this._clipRect, this._rect);

        this._resolvedOpacity = this._opacity;
        this._resolvedVisible = this._visible;

        // Origin and scale, not just the rect: a WORLD-space root's rect is constant (it is always its
        // reference resolution) and only the origin and scale move as the camera does.
        if (!rectsEqual(this._prevRootRect, this._rect)
            || this._origin.x !== this._prevOriginX
            || this._origin.y !== this._prevOriginY
            || this._scaleFactor !== this._prevScaleFactor) {
            this._layoutVersion++;
        }
        this._prevOriginX = this._origin.x;
        this._prevOriginY = this._origin.y;
        this._prevScaleFactor = this._scaleFactor;

        this._solveChildren(this._origin, this._scaleFactor);
    }

    private _solveScreenRoot(viewportWidth: number, viewportHeight: number, dpr: number): void {
        this._scaleFactor = rootScale(
            this._scaleMode, viewportWidth, viewportHeight,
            this._referenceResolution[0], this._referenceResolution[1],
            this._matchWidthOrHeight, dpr, this._referenceDpr);

        // The root's rect is the viewport expressed in reference units, so every descendant lays out in
        // those units and the DOM applies one scale at the top.
        const s = this._scaleFactor > 0 ? this._scaleFactor : 1;
        setRect(this._rect, 0, 0, viewportWidth / s, viewportHeight / s);
        this._origin.x = 0;
        this._origin.y = 0;
        this._onScreen = true;
    }

    private _solveWorldRoot(
        viewportWidth: number,
        viewportHeight: number,
        viewProj: mat4 | null,
        orthographic: boolean,
        orthoVerticalExtent: number,
    ): void {
        setRect(this._rect, 0, 0, this._referenceResolution[0], this._referenceResolution[1]);

        this._planeMatrix = null;
        this._offscreen = false;

        if (!viewProj) {
            // No active camera: resolve to a hidden zero-scale rect rather than leaving last frame's
            // values, which would freeze the label mid-air.
            this._scaleFactor = 0;
            this._origin.x = this._origin.y = 0;
            this._onScreen = false;
            return;
        }

        const anchorNode = this._uiTargetId ? this._scene?.getNodeById(this._uiTargetId) ?? null : null;
        const world = anchorNode ? anchorNode.worldPosition : this.worldPosition;
        const p = projectToScreen(viewProj, world, viewportWidth, viewportHeight);

        this._scaleFactor = worldUIScale(orthographic, p.distance, this._referenceDistance,
            this._minScale, this._maxScale, viewportHeight, orthoVerticalExtent);

        // The pivot is what actually anchors the element to the projected point: a (0.5, 1) pivot hangs
        // the rect ABOVE the point, which is what a nameplate wants.
        const w = this._rect.width * this._scaleFactor;
        const h = this._rect.height * this._scaleFactor;
        let ox = p.x - this._pivot[0] * w;
        let oy = p.y - this._pivot[1] * h;

        if (this._clampToScreen) {
            // edgeClamp mirrors a behind-camera projection through the centre: such a projection lands on
            // the opposite side of the screen from the object.
            const pinned = edgeClamp(ox, oy, w, h, viewportWidth, viewportHeight, 0, !p.inFront);
            ox = pinned.x;
            oy = pinned.y;
            this._offscreen = pinned.offscreen;
            this._edgeAngleDeg = pinned.angleDeg;
        }

        this._origin.x = ox;
        this._origin.y = oy;
        // A clamped label stays ON screen even when the anchor is behind the camera, so hideBehindCamera
        // does not apply to one.
        this._onScreen = p.inFront || this._clampToScreen || !this._hideBehindCamera;

        if (!this._billboard) this._solvePlaneMatrix(viewProj, viewportWidth, viewportHeight);
    }

    /**
     * Project the reference rect's four world corners and solve the transform that lays this root flat in
     * the world — a poster on a wall rather than a label facing the camera.
     *
     * The rect is planar, so its image under a perspective camera is exactly a homography. The corners sit
     * on the node's own XY plane, scaled so the reference resolution spans one world unit per
     * {@link referenceDistance}, with the pivot deciding where the node's origin sits in the quad.
     */
    private _solvePlaneMatrix(viewProj: mat4, viewportWidth: number, viewportHeight: number): void {
        const world = this.worldTransform;
        const w = this._rect.width;
        const h = this._rect.height;
        // One reference unit maps to 1/referenceDistance world units, so referenceDistance reads as
        // "reference pixels per world unit" here — the same knob that scales a billboarded root.
        const s = this._referenceDistance > 0 ? 1 / this._referenceDistance : 1;

        const corners: ([number, number] | null)[] = [];
        for (const [cx, cy] of [[0, 0], [w, 0], [w, h], [0, h]]) {
            // UI space is Y-down; the world plane is Y-up, hence the negated Y.
            const lx = (cx - this._pivot[0] * w) * s;
            const ly = -(cy - this._pivot[1] * h) * s;
            const wp = vec3.transformMat4(vec3.create(), vec3.fromValues(lx, ly, 0), world);
            const p = projectToScreen(viewProj, wp, viewportWidth, viewportHeight);
            corners.push(p.inFront ? [p.x, p.y] : null);
        }

        this._planeMatrix = quadHomography(corners, w, h);
        // A quad with a corner behind the camera has no valid 2D image; treat it as offscreen.
        if (!this._planeMatrix) this._onScreen = false;
    }

    protected _serializeUIPayload(): any {
        return {
            space: this._space,
            referenceResolution: [...this._referenceResolution],
            scaleMode: this._scaleMode,
            matchWidthOrHeight: this._matchWidthOrHeight,
            referenceDpr: this._referenceDpr,
            uiTargetId: this._uiTargetId,
            referenceDistance: this._referenceDistance,
            minScale: this._minScale,
            maxScale: this._maxScale,
            billboard: this._billboard,
            clampToScreen: this._clampToScreen,
            hideBehindCamera: this._hideBehindCamera,
        };
    }

    protected _parsePayload(ui: any): void {
        if (ui.space === 'world' || ui.space === 'screen') this._space = ui.space;
        this._referenceResolution = numTuple(ui.referenceResolution, this._referenceResolution);
        if (ui.scaleMode === 'constantPixel' || ui.scaleMode === 'scaleWithScreen' || ui.scaleMode === 'constantPhysical')
            this._scaleMode = ui.scaleMode;
        if (typeof ui.matchWidthOrHeight === 'number') this._matchWidthOrHeight = clamp(ui.matchWidthOrHeight, 0, 1);
        if (typeof ui.referenceDpr === 'number') this._referenceDpr = Math.max(0.01, ui.referenceDpr);
        this._uiTargetId = typeof ui.uiTargetId === 'string' ? ui.uiTargetId : null;
        if (typeof ui.referenceDistance === 'number') this._referenceDistance = Math.max(0.001, ui.referenceDistance);
        if (typeof ui.minScale === 'number') this._minScale = Math.max(0, ui.minScale);
        if (typeof ui.maxScale === 'number') this._maxScale = Math.max(0, ui.maxScale);
        if (typeof ui.billboard === 'boolean') this._billboard = ui.billboard;
        if (typeof ui.clampToScreen === 'boolean') this._clampToScreen = ui.clampToScreen;
        if (typeof ui.hideBehindCamera === 'boolean') this._hideBehindCamera = ui.hideBehindCamera;
    }

    public static parse(parent: Node, json: any): void {
        UINode._parseUI(new UIRootNode(json.name, 'screen', json.id), parent, json);
    }
}
