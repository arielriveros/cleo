import { mat4, vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";

/**
 * What an occlusion volume hides while its box is out of sight. Each kind of content is a switch of its
 * own; `shadows` is separate from `models` — with it on, the volume's models also stop casting shadows,
 * with it off they keep casting (a shadow can fall out of the box into view) while still not being drawn.
 */
export interface OcclusionVolumeCull {
    /** Models: static, skinned and cloth. */
    models: boolean;
    /** Sprites and animated sprites. */
    sprites: boolean;
    /** Particle systems, 3D and 2D: not drawn, and a looping one pauses its simulation. */
    particles: boolean;
    /** Point and spot lights: they light nothing and render no shadow map. */
    lights: boolean;
    /** Decals. */
    decals: boolean;
    /** Fluid volumes. */
    fluids: boolean;
    /** The volume's models' shadows. */
    shadows: boolean;
}

/** The kinds of content, in the order the inspector lists them. */
export const OCCLUSION_VOLUME_CULL_KEYS: readonly (keyof OcclusionVolumeCull)[] = [
    'models', 'sprites', 'particles', 'lights', 'decals', 'fluids', 'shadows',
];

/** Everything on: what a new volume, and a saved one without the field, hides. */
export function defaultOcclusionVolumeCull(): OcclusionVolumeCull {
    return { models: true, sprites: true, particles: true, lights: true, decals: true, fluids: true, shadows: true };
}

/**
 * An occlusion volume: a box whose CONTENTS are not rendered while the box itself cannot be seen by the
 * active camera. Draws nothing and collides with nothing.
 *
 * ## What is inside
 *
 * Anything whose world bounds lie entirely inside the box (a light: its position), found automatically —
 * no parenting needed. Something poking out of the box is not inside, so nothing you can see part of ever
 * vanishes. Which kinds of content it hides is {@link cull}.
 *
 * ## When the box cannot be seen
 *
 * When it is outside the camera's frustum, or behind the landscape, or — a GPU occlusion query against
 * the frame's depth — behind whatever was drawn: walls, rocks, buildings. Nothing inside a box that cannot
 * be seen can be seen either, which is what makes this exact rather than a guess. With the camera inside
 * the box it is always seen.
 *
 * So a box fitted to a room — its faces halfway into the walls, floor and ceiling, so that what stands on
 * the floor or against a wall is wholly inside, while the walls' outer faces still hide the box — shows
 * the room's furniture, lights and fires only while you can see into the room (through a door, a window,
 * or from inside) and skips all of it, shadows included, the rest of the time. A query's answer comes
 * back a frame or two late, so a room coming into view past a door frame can show its contents a frame
 * late. Only what the geometry pass draws hides the box from a query: forward-shaded and transparent
 * surfaces (glass, a Blinn-Phong wall) are seen through.
 *
 * The box is `size` (full extents, local units) centred on the node, under the node's full transform.
 * The renderer's `occlusionCulling` must be `'all'` for volumes to act (graphics/render/visibility.ts).
 */
export class OcclusionVolumeNode extends Node {
    private _size: [number, number, number];
    /** Off leaves it in the scene without it hiding anything. */
    public enabled: boolean = true;
    private _cull: OcclusionVolumeCull = defaultOcclusionVolumeCull();
    /** Bumped on every change to the box or what it hides, so the renderer knows to look again. */
    private _version = 0;

    constructor(name: string, size: [number, number, number] = [4, 3, 4], id: string = uuidv4()) {
        super(name, 'occlusionVolume', id);
        this._size = [Math.max(0, +size[0] || 0), Math.max(0, +size[1] || 0), Math.max(0, +size[2] || 0)];
    }

    public get size(): [number, number, number] { return this._size; }
    public set size(v: [number, number, number]) {
        this._size = [Math.max(0, +v[0] || 0), Math.max(0, +v[1] || 0), Math.max(0, +v[2] || 0)];
        this._version++;
    }

    /** What the volume hides. A copy: write through `cull =` or {@link setCull}. */
    public get cull(): OcclusionVolumeCull { return { ...this._cull }; }
    public set cull(v: Partial<OcclusionVolumeCull>) {
        const next = defaultOcclusionVolumeCull();
        for (const k of OCCLUSION_VOLUME_CULL_KEYS) next[k] = v?.[k] !== false;
        this._cull = next;
        this._version++;
    }
    public setCull(key: keyof OcclusionVolumeCull, on: boolean): void {
        if (this._cull[key] === on) return;
        this._cull[key] = on;
        this._version++;
    }
    /** {@link cull}'s field, without the copy. */
    public culls(key: keyof OcclusionVolumeCull): boolean { return this._cull[key]; }

    /** Changes with the size or the cull switches (the transform has `transformVersion`). */
    public get version(): number { return this._version; }

    /** The box's local corners, under `worldTransform`. */
    public localBox(min: number[], max: number[]): void {
        for (let a = 0; a < 3; a++) { min[a] = -this._size[a] / 2; max[a] = this._size[a] / 2; }
    }

    public getBoundingBox(): { min: vec3, max: vec3 } {
        const min = vec3.fromValues(Infinity, Infinity, Infinity), max = vec3.fromValues(-Infinity, -Infinity, -Infinity);
        const m = this.worldTransform as mat4, c = vec3.create();
        for (let i = 0; i < 8; i++) {
            vec3.set(c, (i & 1 ? 0.5 : -0.5) * this._size[0], (i & 2 ? 0.5 : -0.5) * this._size[1], (i & 4 ? 0.5 : -0.5) * this._size[2]);
            vec3.transformMat4(c, c, m);
            vec3.min(min, min, c);
            vec3.max(max, max, c);
        }
        return { min, max };
    }

    /**
     * What a click in the viewport picks: a small box at the node, where the editor draws its icon. The
     * volume encloses a room's worth of content, so picking its whole box (as `Raycaster` does other
     * nodes' bounds) would select it on every click aimed at what is inside. `Raycaster` asks for this
     * hook by name.
     */
    public pickBox(): { min: vec3, max: vec3 } {
        const p = this.worldPosition;
        const h = OcclusionVolumeNode.PICK_HALF_EXTENT;
        return { min: vec3.fromValues(p[0] - h, p[1] - h, p[2] - h), max: vec3.fromValues(p[0] + h, p[1] + h, p[2] + h) };
    }
    /** Half the pick box's edge, in world units: about the size of the editor icon. */
    public static readonly PICK_HALF_EXTENT = 0.4;

    protected _serializePayload(): any {
        return { occlusionVolume: { size: [...this._size], enabled: this.enabled, cull: { ...this._cull } } };
    }

    public static parse(parent: Node, json: any) {
        const o = json.occlusionVolume ?? {};
        const node = new OcclusionVolumeNode(json.name, readSize(o.size), json.id);
        node.enabled = o.enabled !== false;
        node.cull = o.cull ?? {};
        Node.finishParse(node, parent, json);
    }

    /**
     * A scene saved when this node type was `'occluder'` — a box that hid what was BEHIND it. That
     * meaning is gone; such a box comes back as a volume of the same size, hiding everything (if
     * anything) inside it while it cannot be seen.
     */
    public static parseLegacyOccluder(parent: Node, json: any) {
        const o = json.occluder ?? {};
        const node = new OcclusionVolumeNode(json.name, readSize(o.size), json.id);
        node.enabled = o.enabled !== false;
        Node.finishParse(node, parent, json);
    }
}

function readSize(v: any): [number, number, number] {
    return Array.isArray(v) && v.length >= 3 ? [+v[0], +v[1], +v[2]] : [4, 3, 4];
}
