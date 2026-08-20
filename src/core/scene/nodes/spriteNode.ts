import { Sprite, remapLegacyFrame } from "../../../graphics/sprite";
import { ShaderManager } from "../../../graphics/systems/shaderManager";
import { Texture } from "../../../graphics/texture";
import { Tileset } from "../../../graphics/tilemap/tileset";
import { Logger } from "../../logger";
import { vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { AnimatedSpriteNode } from "./animatedSpriteNode";
import { Node } from "./node";

/**
 * Billboarded textured quad drawn from a tileset.
 */

export class SpriteNode extends Node {
    protected _sprite: Sprite;
    protected _initialized: boolean;
    protected _constraints: 'free' | 'spherical' | 'cylindrical';

    constructor(
        name: string,
        sprite: Sprite,
        constraints: 'free' | 'spherical' | 'cylindrical' = 'spherical',
        id: string = uuidv4(),
        nodeType: 'sprite' | 'animatedSprite' = 'sprite'
    ) {
        super(name, nodeType, id);
        this._sprite = sprite;
        this._initialized = false;
        this._constraints = constraints;
    }

    public initializeSprite(): void {
        const shader = ShaderManager.Instance.getShader(this._sprite.material.type);
        this._sprite.mesh.initializeVAO(shader.attributes);

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

    /**
     * Texture-space rect [u0, v0, u1, v1] the renderer turns into `u_uvOffset`/`u_uvScale`.
     * Overridden by AnimatedSpriteNode to follow the playing frame.
     */
    public uvRect(): [number, number, number, number] { return this._sprite.uvRect(); }

    /**
     * Get bounding box for SpriteNode - returns a small sphere bounding box
     */
    public getBoundingBox(): { min: vec3, max: vec3 } {
        const position = this.worldPosition;
        const scale = this.worldScale;
        
        // Sprite has a small bounding box
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

/**
 * Where an animated sprite's frames come from.
 *
 * - `node`: the ordered `frames` list on the node — one tileset, many different animations.
 * - `tile`: the selected tile's own `TileMeta.animation`, resolved through `Tileset.frameOf`. Authored
 *   once in the tileset editor and reusable by every sprite that picks that tile.
 */

export function spritePayload(json: any): any {
    const sprite = json?.sprite ?? {};
    return 'tileset' in sprite ? sprite : (sprite.material ?? {});
}

/**
 * A legacy animated sprite's columns x rows grid, as an explicit frame list.
 *
 * The old model walked `startFrame..endFrame` (or an explicit `sequence`) over a bottom-up grid. Expanding
 * that range through `remapLegacyFrame` produces tile indices into the synthesized sheet tileset that
 * sample exactly the same cells in the same order — so a migrated animation is visually unchanged.
 *
 * Assigning the sheet tileset is done here too: `Sprite.parse` only sees the material payload and cannot
 * know the sheet was columns x rows rather than a single image.
 */
