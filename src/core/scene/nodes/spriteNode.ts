import { Sprite, remapLegacyFrame } from "../../../graphics/sprite";
import { ShaderManager } from "../../../graphics/systems/shaderManager";
import { Tileset } from "../../../graphics/tilemap/tileset";
import { FollowedLight } from "./lightNode";
import { Logger } from "../../logger";
import { mat4, vec3 } from "gl-matrix";
import { billboardMatrix } from "../../../graphics/render/billboard";
import type { Camera } from "../../camera";
import { spriteQuadInto } from "../../math";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";

/**
 * Billboarded textured quad drawn from a tileset.
 */

export class SpriteNode extends Node {
    protected _sprite: Sprite;
    protected _initialized: boolean;
    protected _constraints: 'free' | 'spherical' | 'cylindrical';
    /**
     * The tallest the quad may draw, in CSS pixels; 0 (the default) is no limit. Past it the quad
     * shrinks, so a small raster is never blown up as the camera closes in: the editor's viewport icons
     * set it. Not serialized.
     */
    public maxScreenSize: number = 0;

    private readonly _followed = new FollowedLight();

    /** This frame's multiplier from the light the sprite follows (Sprite.followLight); 1 when none. */
    public get lightFollowScale(): number {
        return this._followed.factor(this, this._sprite.followLight, this._sprite.followAmount);
    }

    constructor(
        name: string,
        sprite: Sprite,
        constraints: 'free' | 'spherical' | 'cylindrical' = 'spherical',
        id: string = uuidv4(),
        nodeType: 'sprite' | 'animatedSprite' | 'parallaxLayer' = 'sprite'
    ) {
        super(name, nodeType, id);
        this._sprite = sprite;
        this._initialized = false;
        this._constraints = constraints;
    }

    public initializeSprite(): void {
        const shader = ShaderManager.Instance.getShader(this._sprite.material.type);

        const attributes = [];
        for (const attr of shader.attributes) {
            switch (attr.name) {
                case 'position':
                case 'a_position':
                    attributes.push('position');
                    break;
                case 'normal':
                case 'a_normal':
                    attributes.push('normal');
                    break;
                case 'uv':
                case 'a_uv':
                case 'texCoord':
                case 'a_texCoord':
                    attributes.push('uv');
                    break;
                case 'tangent':
                case 'a_tangent':
                    attributes.push('tangent');
                    break;
                case 'bitangent':
                case 'a_bitangent':
                    attributes.push('bitangent');
                    break;
                default:
                    const errMsg = `Attribute ${attr.name} not supported`;
                    Logger.error(errMsg)
                    throw new Error(errMsg);
            }
        }

        this._sprite.mesh.create(this._sprite.geometry.getData(attributes), this._sprite.geometry.vertexCount, this._sprite.geometry.indices);
        this._initialized = true;
    }

    protected _serializePayload(): any {
        return {
            sprite: { constraints: this._constraints, ...this._sprite.serialize() },
        };
    }

    public static parse(parent: Node, json: any) {
        const sprite = new SpriteNode(json.name, Sprite.parse(spritePayload(json)), json.sprite?.constraints, json.id);
        Node.finishParse(sprite, parent, json);
    }

    public get sprite(): Sprite { return this._sprite; }
    public get initialized(): boolean { return this._initialized; }
    public get constraints(): 'free' | 'spherical' | 'cylindrical' { return this._constraints; }
    public set constraints(value: 'free' | 'spherical' | 'cylindrical') { this._constraints = value; }

    /** The tileset this sprite draws from. Assigning replaces the embedded copy. */
    public get tileset(): Tileset | null { return this._sprite.tileset; }
    public set tileset(tileset: Tileset | null) { this._sprite.tileset = tileset; }
    public get tileIndex(): number { return this._sprite.tileIndex; }
    public set tileIndex(index: number) { this._sprite.tileIndex = index; }
    public get tint(): [number, number, number] { return this._sprite.tint; }
    public set tint(tint: [number, number, number]) { this._sprite.tint = tint; }
    public get opacity(): number { return this._sprite.opacity; }
    public set opacity(opacity: number) { this._sprite.opacity = opacity; }
    /** Draw order among sprites, higher on top: {@link Sprite.sortingOrder}. */
    public get sortingOrder(): number { return this._sprite.sortingOrder; }
    public set sortingOrder(value: number) { this._sprite.sortingOrder = value; }
    /** The point of the image at the node's origin: {@link Sprite.pivot}. */
    public get pivot(): [number, number] { return this._sprite.pivot; }
    public set pivot(value: [number, number]) { this._sprite.pivot = value; }
    /** Mirror the image left to right: {@link Sprite.flipX}. A character's facing. */
    public get flipX(): boolean { return this._sprite.flipX; }
    public set flipX(value: boolean) { this._sprite.flipX = value; }
    /** Mirror the image top to bottom: {@link Sprite.flipY}. */
    public get flipY(): boolean { return this._sprite.flipY; }
    public set flipY(value: boolean) { this._sprite.flipY = value; }

    /**
     * The matrix the sprite's quad draws with, into `out`: its world transform turned to the camera by its
     * constraint (render/billboard.ts), then sized to its tile (Sprite.quadSize: pixels over the tileset's
     * pixels per unit) and moved so its pivot -- mirrored with the image -- sits at the node's origin. What
     * the draw, the selection outline and the selection bounds all go through. A parallax layer overrides it.
     */
    public quadMatrixInto(out: mat4, camera: Camera): mat4 {
        billboardMatrix(out, this.worldTransform, this.worldScale, this._constraints, camera.viewMatrix, camera.position,
                        camera.type !== 'orthographic');
        return this._sizeQuad(out);
    }

    /** {@link quadMatrixInto}'s size and pivot step, on a matrix already turned to the camera. */
    protected _sizeQuad(out: mat4): mat4 {
        const sprite = this._sprite;
        const size = sprite.quadSize(this.currentTile, _quadSize);
        const px = sprite.flipX ? 1 - sprite.pivot[0] : sprite.pivot[0];
        const py = sprite.flipY ? 1 - sprite.pivot[1] : sprite.pivot[1];
        if (size[0] !== 1 || size[1] !== 1 || px !== 0.5 || py !== 0.5) spriteQuadInto(out, size[0], size[1], px, py);
        return out;
    }

    /** The tile index on screen this instant. AnimatedSpriteNode overrides it to follow the playing frame. */
    public get currentTile(): number { return this.tileIndex; }

    /**
     * The linear colour multiplier this sprite draws with: its current tile's overdrive in the tileset
     * (Tileset.overdriveOf). Above 1 the sprite is brighter than white, which is what lets it bloom.
     */
    public get overdrive(): number { return this._sprite.tileset?.overdriveOf(this.currentTile) ?? 1; }

    /**
     * Texture-space rect [u0, v0, u1, v1] the renderer turns into `u_uvOffset`/`u_uvScale`.
     * Overridden by AnimatedSpriteNode to follow the playing frame.
     */
    public uvRect(): [number, number, number, number] { return this._sprite.uvRect(); }

    /**
     * {@link uvRect} into `out`, without allocating: the tile on screen this instant ({@link currentTile}, which
     * AnimatedSpriteNode overrides), as the batched 2D pass reads it every frame.
     */
    public uvRectInto(out: Float32Array): Float32Array { return this._sprite.uvRectInto(this.currentTile, out); }

    /**
     * Selection bounds. A sprite sized by its tileset (pixels per unit) or pivoted off its centre: the box
     * round its quad as placed (its own transform; a camera-facing sprite turns, but in 2D it faces the
     * view anyway). Otherwise a small box around its origin, as it always was.
     */
    public getBoundingBox(): { min: vec3, max: vec3 } {
        const sprite = this._sprite;
        if ((sprite.tileset?.pixelsPerUnit ?? 0) > 0 || sprite.pivot[0] !== 0.5 || sprite.pivot[1] !== 0.5) {
            const m = this._sizeQuad(mat4.copy(_boundsMatrix, this.worldTransform));
            const min = vec3.fromValues(Infinity, Infinity, Infinity), max = vec3.fromValues(-Infinity, -Infinity, -Infinity);
            for (let k = 0; k < 4; k++) {
                const x = (k & 1) ? 0.5 : -0.5, y = (k & 2) ? 0.5 : -0.5;
                for (let a = 0; a < 3; a++) {
                    const v = m[a] * x + m[4 + a] * y + m[12 + a];
                    if (v < min[a]) min[a] = v;
                    if (v > max[a]) max[a] = v;
                }
            }
            // A flat quad: some depth, so a ray along the view still meets the box.
            min[2] -= 0.05; max[2] += 0.05;
            return { min, max };
        }
        const position = this.worldPosition;
        const scale = this.worldScale;
        
        const radius = Math.max(scale[0], scale[1], scale[2]) * 0.3;
        
        const min = vec3.fromValues(
            position[0] - radius,
            position[1] - radius,
            position[2] - radius
        );
        const max = vec3.fromValues(
            position[0] + radius,
            position[1] + radius,
            position[2] + radius
        );
        
        return { min, max };
    }
}

/** Scratch for {@link SpriteNode.quadMatrixInto} and the bounds. */
const _quadSize: [number, number] = [1, 1];
const _boundsMatrix = mat4.create();

/** The sprite payload to hand `Sprite.parse`. Legacy saves nest the material one level deeper. */
export function spritePayload(json: any): any {
    const sprite = json?.sprite ?? {};
    return 'tileset' in sprite ? sprite : (sprite.material ?? {});
}
