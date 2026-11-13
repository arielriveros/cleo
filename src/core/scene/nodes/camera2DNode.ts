import { vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Camera } from "../../camera";
import { camera2DLayout, confineAxis, deadzoneAxis, smoothDamp } from "../../math";
import type { Camera2DLayout, SmoothDampState } from "../../math";
import { CameraNode } from "./cameraNode";
import { Node } from "./node";
import type { Room2DNode } from "./room2DNode";

/** What a Camera2D's late update needs from the scene, which it may not import (see node-split rules). */
export interface Camera2DSceneView {
    findNode(name: string): Node | undefined;
    readonly rooms2D: ReadonlySet<Room2DNode>;
}

/**
 * The 2D game camera: orthographic, sized in art pixels, following a node with a dead zone, look-ahead
 * and damping, confined to the room (Room2DNode) the node stands in, sliding into the next one when it
 * crosses over, and shaking on demand.
 *
 * SIZE. `pixelsPerUnit` art pixels make a world unit (match the tilesets'), and the view shows at least
 * `referenceResolution` art pixels at `zoom` 1. With `pixelPerfect`, every art pixel is a whole number of
 * screen pixels: the renderer draws the 2D frame at that low resolution and scales it up with no
 * filtering, keeping a sub-pixel offset so a slow pan still moves smoothly. The renderer fits the
 * projection to the screen every frame (`fitView`); the node's own camera extents are not authored.
 *
 * MOTION runs in the scene's late pass, after every script has moved what it moves, and only while the
 * game plays: in the editor the camera stays where it is placed, drawn as its reference frame.
 */
export class Camera2DNode extends CameraNode {
    /** Art pixels per world unit. A 16 px tile at 16 is one unit. */
    public pixelsPerUnit: number = 16;
    /** The view in art pixels, at least, at zoom 1. */
    public referenceResolution: [number, number] = [480, 270];
    /** Multiplies the pixel scale: 2 shows half as much, twice as big. Rounded to a whole scale when pixel-perfect. */
    public zoom: number = 1;
    /** Whole screen pixels per art pixel, drawn at that low resolution and scaled up unfiltered. */
    public pixelPerfect: boolean = true;
    /** The name of the node to follow. Empty: the camera stays where it is. */
    public followTarget: string = '';
    /** Added to the target's position: what the camera centres on (a little above the feet, usually). */
    public followOffset: [number, number] = [0, 1];
    /** The box round the camera centre the target moves in freely before the camera moves, world units. */
    public deadzone: [number, number] = [2, 1.5];
    /** About how long the camera takes to catch up, seconds. 0 locks it on. */
    public damping: number = 0.12;
    /** How far ahead of the target the camera looks along its horizontal motion, world units. */
    public lookAhead: number = 0;
    /** Keep the view inside the room the target stands in (Room2DNode). */
    public confineToRooms: boolean = true;
    /** How long the slide into the next room takes, seconds. 0 cuts. */
    public roomTransitionSeconds: number = 0.45;

    /** The fitted layout of the last frame drawn: scale and the view in art pixels. See {@link fitView}. */
    public readonly layout: Camera2DLayout = { scale: 1, virtualWidth: 480, virtualHeight: 270 };
    /** The world-space view centre before shake: what the follow works from. */
    private readonly _center: [number, number] = [0, 0];
    private _centered = false;
    private readonly _damp: [SmoothDampState, SmoothDampState] = [{ velocity: 0 }, { velocity: 0 }];
    private readonly _look: SmoothDampState = { velocity: 0 };
    private _lookOffset = 0;
    private _lastTargetX = NaN;
    private _target: Node | null = null;
    private _targetName = '';
    private _room: Room2DNode | null = null;
    private _transition: { fromX: number; fromY: number; t: number } | null = null;
    private _shake: { amplitude: number; seconds: number; left: number; frequency: number; seed: number } | null = null;

    constructor(name: string, camera?: Camera, id: string = uuidv4()) {
        super(name, camera ?? new Camera({ type: 'orthographic', near: 0.1, far: 200, left: -8, right: 8, bottom: -8, top: 8 }), id, 'camera2D');
        this.camera.type = 'orthographic';
        // Looking at the XY plane from +Z, as the editor's 2D view does.
        this.setPosition([0, 0, 10]);
        this.setRotation([0, 180, 0]);
    }

    /** The room the followed node stands in, or null. */
    public get room(): Room2DNode | null { return this._room; }
    /** Whether the camera is sliding from one room into the next. */
    public get inRoomTransition(): boolean { return this._transition !== null; }

    /**
     * Shake the view: `amplitude` world units at the start, easing out over `seconds`, `frequency` times a
     * second. A new shake stronger than what is left of the current one replaces it.
     */
    public shake(amplitude: number, seconds: number = 0.3, frequency: number = 25): void {
        const a = Math.max(0, +amplitude || 0), s = Math.max(0.01, +seconds || 0);
        const left = this._shake ? this._shake.amplitude * (this._shake.left / this._shake.seconds) : 0;
        if (a < left) return;
        this._shake = { amplitude: a, seconds: s, left: s, frequency: Math.max(1, +frequency || 25), seed: Math.random() * 1000 };
    }

    /** Jump straight to the target, with no damping or room slide: after a teleport or a respawn. */
    public snapToTarget(): void {
        this._centered = false;
        this._transition = null;
    }

    /**
     * Fit the projection to a `width` x `height` screen (render pixels): the pixel scale, the view in art
     * pixels and the orthographic extents. Called by the renderer every frame before it draws.
     */
    public fitView(width: number, height: number): Camera2DLayout {
        camera2DLayout(width, height, this.referenceResolution[0], this.referenceResolution[1],
                       this.zoom, this.pixelPerfect, this.layout);
        const half = this.layout.virtualHeight / (2 * Math.max(1e-6, this.pixelsPerUnit));
        const cam = this.camera;
        cam.type = 'orthographic';
        // Camera's ortho extents are scaled by its aspect horizontally, so all four are the half height.
        cam.left = -half; cam.right = half; cam.bottom = -half; cam.top = half;
        return this.layout;
    }

    /** Half the view, world units, from the last fitted layout. */
    private _halfView(): [number, number] {
        const ppu = Math.max(1e-6, this.pixelsPerUnit);
        return [this.layout.virtualWidth / (2 * ppu), this.layout.virtualHeight / (2 * ppu)];
    }

    /**
     * The scene's late pass: follow, confine, slide, shake. `playing` false (authoring, paused) leaves the
     * camera where it is. `delta` is game time; the slide and the shake run on `unscaledDelta`, so a
     * hit-stop does not stop the camera.
     */
    public lateUpdate(delta: number, unscaledDelta: number, playing: boolean, scene: Camera2DSceneView): void {
        if (!playing) return;
        const target = this._resolveTarget(scene);
        const p = this.position;
        if (!this._centered) { this._center[0] = p[0]; this._center[1] = p[1]; }
        const [hw, hh] = this._halfView();

        let tx = this._center[0], ty = this._center[1];
        if (target) {
            const wp = target.worldPosition;
            tx = wp[0] + this.followOffset[0];
            ty = wp[1] + this.followOffset[1];
            // Look ahead along the target's horizontal motion, eased so a turn does not whip the view.
            const dt = Math.max(1e-6, delta);
            const vx = Number.isNaN(this._lastTargetX) ? 0 : (wp[0] - this._lastTargetX) / dt;
            this._lastTargetX = wp[0];
            const want = this.lookAhead > 0 && Math.abs(vx) > 0.5 ? Math.sign(vx) * this.lookAhead : this._lookOffset;
            this._lookOffset = smoothDamp(this._lookOffset, want, this._look, 0.5, delta);
            tx += this._lookOffset;
        }

        // The room the target stands in: kept while it is still inside, else the first that holds it.
        const room = this.confineToRooms && target ? this._roomAt(scene, tx - this._lookOffset, ty - this.followOffset[1] + 0.001) : null;
        if (room !== this._room) {
            const from = this._room;
            this._room = room;
            if (from && room && this._centered && this.roomTransitionSeconds > 0)
                this._transition = { fromX: this._center[0], fromY: this._center[1], t: 0 };
            if (target) {
                if (from) { target.onRoomExit(from); from.onRoomExit(target); }
                if (room) { target.onRoomEnter(room); room.onRoomEnter(target); }
            }
        }

        let cx: number, cy: number;
        if (!this._centered) {
            cx = tx; cy = ty;
            this._damp[0].velocity = 0; this._damp[1].velocity = 0;
        } else {
            const dx = deadzoneAxis(this._center[0], tx, this.deadzone[0] * 0.5);
            const dy = deadzoneAxis(this._center[1], ty, this.deadzone[1] * 0.5);
            cx = smoothDamp(this._center[0], dx, this._damp[0], this.damping, delta);
            cy = smoothDamp(this._center[1], dy, this._damp[1], this.damping, delta);
        }
        if (room) {
            const b = room.bounds();
            cx = confineAxis(cx, hw, b[0], b[2]);
            cy = confineAxis(cy, hh, b[1], b[3]);
        }
        this._center[0] = cx; this._center[1] = cy;
        this._centered = true;

        // The slide: from where the view was when the target crossed over, eased into where it now wants
        // to be, which is itself following the target in the new room.
        let vx = cx, vy = cy;
        const tr = this._transition;
        if (tr) {
            tr.t += Math.max(0, unscaledDelta) / Math.max(1e-6, this.roomTransitionSeconds);
            if (tr.t >= 1) this._transition = null;
            else {
                const k = tr.t * tr.t * (3 - 2 * tr.t);
                vx = tr.fromX + (cx - tr.fromX) * k;
                vy = tr.fromY + (cy - tr.fromY) * k;
            }
        }

        // The shake, on top of everything and never fed back into the follow.
        const sh = this._shake;
        if (sh) {
            sh.left -= Math.max(0, unscaledDelta);
            if (sh.left <= 0) this._shake = null;
            else {
                const a = sh.amplitude * (sh.left / sh.seconds) ** 2;
                const t = (sh.seconds - sh.left) * sh.frequency + sh.seed;
                vx += a * (Math.sin(t * 6.283) * 0.6 + Math.sin(t * 2.71 * 6.283) * 0.4);
                vy += a * (Math.cos(t * 1.37 * 6.283) * 0.6 + Math.sin(t * 3.1 * 6.283) * 0.4);
            }
        }

        this.setPosition([vx, vy, p[2]]);
        this.updateTransforms(this.parent ? this.parent.worldTransform : null);
        this.camera.position = this.worldPosition;
        this.camera.eye = vec3.add(vec3.create(), this.worldPosition, this.worldForward);
    }

    private _resolveTarget(scene: Camera2DSceneView): Node | null {
        const name = this.followTarget;
        if (!name) { this._target = null; this._targetName = ''; return null; }
        // Re-looked-up when the name changes or the node left the scene (respawned under the same name).
        if (name !== this._targetName || !this._target || this._target.markForRemoval || !this._target.scene) {
            this._targetName = name;
            this._target = scene.findNode(name) ?? null;
            this._lastTargetX = NaN;
        }
        return this._target;
    }

    private _roomAt(scene: Camera2DSceneView, x: number, y: number): Room2DNode | null {
        const last = this._room;
        if (last && last.scene && last.contains(x, y)) return last;
        for (const room of scene.rooms2D) if (room.visible !== false && room.contains(x, y)) return room;
        // In no room -- falling down a pit, jumping past the top: the view stays in the last one, unless
        // the target went far from it (a teleport to a part of the world no room covers).
        if (last && last.scene && last.visible !== false) {
            const b = last.bounds();
            const [hw, hh] = this._halfView();
            const gx = Math.max(b[0] - x, 0, x - b[2]), gy = Math.max(b[1] - y, 0, y - b[3]);
            if (gx <= hw * 2 && gy <= hh * 2) return last;
        }
        return null;
    }

    protected _serializePayload(): any {
        return {
            ...super._serializePayload(),
            camera2D: {
                pixelsPerUnit: this.pixelsPerUnit,
                referenceResolution: [this.referenceResolution[0], this.referenceResolution[1]],
                zoom: this.zoom,
                pixelPerfect: this.pixelPerfect,
                followTarget: this.followTarget,
                followOffset: [this.followOffset[0], this.followOffset[1]],
                deadzone: [this.deadzone[0], this.deadzone[1]],
                damping: this.damping,
                lookAhead: this.lookAhead,
                confineToRooms: this.confineToRooms,
                roomTransitionSeconds: this.roomTransitionSeconds,
            },
        };
    }

    public static parse(parent: Node, json: any) {
        const c = json.camera ?? {};
        const node = new Camera2DNode(json.name, new Camera({
            type: 'orthographic', fov: c.fov, near: c.near, far: c.far,
            left: c.left, right: c.right, bottom: c.bottom, top: c.top,
        }), json.id);
        Node.finishParse(node, parent, json);
    }

    protected _afterParse(json: any): void {
        super._afterParse(json);
        const d = json.camera2D ?? {};
        const num = (v: unknown, fallback: number, min = -Infinity) =>
            typeof v === 'number' && Number.isFinite(v) ? Math.max(min, v) : fallback;
        const pair = (v: unknown, fallback: [number, number], min = -Infinity): [number, number] =>
            Array.isArray(v) && v.length >= 2 ? [num(v[0], fallback[0], min), num(v[1], fallback[1], min)] : [fallback[0], fallback[1]];
        this.pixelsPerUnit = num(d.pixelsPerUnit, 16, 1e-3);
        this.referenceResolution = pair(d.referenceResolution, [480, 270], 1);
        this.zoom = num(d.zoom, 1, 1e-3);
        this.pixelPerfect = d.pixelPerfect !== false;
        this.followTarget = typeof d.followTarget === 'string' ? d.followTarget : '';
        this.followOffset = pair(d.followOffset, [0, 1]);
        this.deadzone = pair(d.deadzone, [2, 1.5], 0);
        this.damping = num(d.damping, 0.12, 0);
        this.lookAhead = num(d.lookAhead, 0, 0);
        this.confineToRooms = d.confineToRooms !== false;
        this.roomTransitionSeconds = num(d.roomTransitionSeconds, 0.45, 0);
    }
}
