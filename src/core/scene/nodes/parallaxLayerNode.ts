import { mat4, vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Sprite } from "../../../graphics/sprite";
import { parallaxSpan } from "../../math";
import type { ParallaxSpan } from "../../math";
import type { Camera } from "../../camera";
import { Node } from "./node";
import { SpriteNode, spritePayload } from "./spriteNode";

/**
 * A 2D backdrop: a sprite that moves with only part of the camera's travel, so a far range of mountains
 * drifts behind a near line of trees, and that can repeat sideways (and up) to fill the view however far
 * the camera goes.
 *
 * `parallax` is how much of the camera's travel the layer moves with, per axis: 1 moves with the world (no
 * parallax), 0 stays put on screen (a sky), 0.2 is a far range. The image sits at the node's position
 * when the camera is at the origin. Repeating needs a tileset whose one tile is the whole image (its
 * texture wraps), which is what a background imported as its own tileset is. `scroll` drifts the image by
 * itself, world units a second (clouds).
 *
 * It draws as an ordinary sprite in the 2D pass, ordered by its sorting order (negative to sit behind the
 * tilemap's layers), and it is never picked in the viewport: select it in the scene tree.
 */
export class ParallaxLayerNode extends SpriteNode {
    public parallax: [number, number] = [0.5, 1];
    public repeatX: boolean = true;
    public repeatY: boolean = false;
    public scroll: [number, number] = [0, 0];

    /** This frame's spans, from the matrix, for the UVs read right after it (see uvRectInto). */
    private readonly _spanX: ParallaxSpan = { min: 0, max: 1, from: 0, to: 1 };
    private readonly _spanY: ParallaxSpan = { min: 0, max: 1, from: 0, to: 1 };
    private readonly _scrolled: [number, number] = [0, 0];

    constructor(name: string, sprite: Sprite, id: string = uuidv4()) {
        super(name, sprite, 'free', id, 'parallaxLayer');
    }

    public update(delta: number, time: number): void {
        super.update(delta, time);
        // Wrapped to one image so a layer drifting for an hour keeps its precision.
        const size = this.sprite.quadSize(this.currentTile, _size);
        const s = this.worldScale;
        for (let a = 0; a < 2; a++) {
            const unit = Math.abs(size[a] * s[a]) || 1;
            this._scrolled[a] = (this._scrolled[a] + this.scroll[a] * delta) % unit;
        }
    }

    /** Whether the image can tile: one tile that is the whole texture, which then wraps. */
    private _tiles(): boolean {
        const ts = this.sprite.tileset;
        return !ts || (ts.tileCount === 1 && !ts.hasRegions && ts.margin === 0 && ts.spacing === 0);
    }

    /**
     * The layer's quad for `camera`'s view: world-aligned, as wide as the view on a repeating axis and as
     * the image elsewhere, where the camera's travel times its parallax has carried it.
     */
    public quadMatrixInto(out: mat4, camera: Camera): mat4 {
        const size = this.sprite.quadSize(this.currentTile, _size);
        const s = this.worldScale, p = this.worldPosition, eye = camera.position;
        let halfH: number;
        if (camera.type === 'orthographic') halfH = Math.abs(camera.top - camera.bottom) * 0.5;
        else halfH = Math.max(0.01, Math.abs(eye[2] - p[2])) * Math.tan(camera.fov * Math.PI / 360);
        const halfW = halfH * (camera.ratio || 1);
        const tiles = this._tiles();
        parallaxSpan(eye[0], halfW, p[0] + this._scrolled[0], size[0] * s[0], this.parallax[0], tiles && this.repeatX, this._spanX);
        parallaxSpan(eye[1], halfH, p[1] + this._scrolled[1], size[1] * s[1], this.parallax[1], tiles && this.repeatY, this._spanY);
        const x = this._spanX, y = this._spanY;
        mat4.identity(out);
        out[0] = x.max - x.min;
        out[5] = y.max - y.min;
        out[12] = (x.min + x.max) * 0.5;
        out[13] = (y.min + y.max) * 0.5;
        out[14] = p[2];
        return out;
    }

    /** The image over the quad: the tile's own rect, run on past its edges where the layer repeats. */
    public uvRectInto(out: Float32Array): Float32Array {
        super.uvRectInto(out);
        const u0 = out[0], v0 = out[1], du = out[2] - out[0], dv = out[3] - out[1];
        out[0] = u0 + du * this._spanX.from; out[2] = u0 + du * this._spanX.to;
        out[1] = v0 + dv * this._spanY.from; out[3] = v0 + dv * this._spanY.to;
        return out;
    }

    /** Never picked in the viewport: it covers the view. An empty box the raycaster always misses. */
    public pickBox(): { min: vec3, max: vec3 } {
        return { min: vec3.fromValues(Infinity, Infinity, Infinity), max: vec3.fromValues(-Infinity, -Infinity, -Infinity) };
    }

    protected _serializePayload(): any {
        return {
            ...super._serializePayload(),
            parallaxLayer: {
                parallax: [this.parallax[0], this.parallax[1]],
                repeatX: this.repeatX, repeatY: this.repeatY,
                ...(this.scroll[0] !== 0 || this.scroll[1] !== 0 ? { scroll: [this.scroll[0], this.scroll[1]] } : {}),
            },
        };
    }

    public static parse(parent: Node, json: any) {
        const node = new ParallaxLayerNode(json.name, Sprite.parse(spritePayload(json)), json.id);
        const d = json.parallaxLayer ?? {};
        const pair = (v: unknown, fallback: [number, number]): [number, number] =>
            Array.isArray(v) && v.length >= 2 && v.every(n => typeof n === 'number' && Number.isFinite(n))
                ? [v[0] as number, v[1] as number] : fallback;
        node.parallax = pair(d.parallax, [0.5, 1]);
        node.repeatX = d.repeatX !== false;
        node.repeatY = d.repeatY === true;
        node.scroll = pair(d.scroll, [0, 0]);
        Node.finishParse(node, parent, json);
    }
}

const _size: [number, number] = [1, 1];
