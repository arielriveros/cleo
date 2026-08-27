import { Geometry } from '../core/geometry';
import { Mesh } from './mesh';
import { Material } from './material';
import { Tileset } from '../graphics/tilemap/tileset';

// A sprite is a unit quad textured from ONE TILE of a Tileset, via `Tileset.uvOf`.
//
// Two invariants: the Material is a private implementation detail, never serialized and never linked to
// a material asset; and the tileset is EMBEDDED on serialize, so `parse` needs no asset library in scope.

export type SpriteSide = 'front' | 'back' | 'double';

export interface SpriteOptions {
    tileset?: Tileset | null;
    tileIndex?: number;
    tint?: [number, number, number];
    opacity?: number;
    transparent?: boolean;
    side?: SpriteSide;
    wireframe?: boolean;
}

/** Full-quad UVs, for a sprite with no tileset. Matches what `Tileset.uvOf` returns for a 1x1 set. */
const FULL_RECT: [number, number, number, number] = [0, 0, 1, 1];

/**
 * Marks a tileset that was synthesized rather than authored. These draw normally but have no asset in
 * the editor's library, so anything reconciling a scene against that library must skip them.
 */
export const INLINE_TILESET_PREFIX = '@';
export function isInlineTilesetId(id: string | null | undefined): boolean {
    return !!id && id.startsWith(INLINE_TILESET_PREFIX);
}

export class Sprite {
  // Lazy: a sprite must be constructible with no GL context, for templates, scene parse and tests.
  private _geometry: Geometry | null = null;
  private _mesh: Mesh | null = null;
  /** Private: sprites have no material asset. Kept in sync so the renderer needs no special case. */
  private readonly _material: Material;
  private _tileset: Tileset | null;
  private _tileIndex: number;
  private _tint: [number, number, number];
  private _opacity: number;

  constructor(options?: SpriteOptions) {
      this._tileset = options?.tileset ?? null;
      this._tileIndex = Math.max(0, Math.floor(options?.tileIndex ?? 0));
      this._tint = options?.tint ?? [1, 1, 1];
      this._opacity = options?.opacity ?? 1;
      this._material = Material.Basic(
          { color: this._tint, opacity: this._opacity, texture: this._tileset?.textureId },
          {
              // Sprites draw blended regardless, but this also drives `u_isTransparent`.
              transparent: options?.transparent ?? true,
              side: options?.side ?? 'double',
              wireframe: options?.wireframe ?? false,
              castShadow: false,
              probeable: false,
          },
      );
      this._clampTileIndex();
  }

  /**
   * A sprite that samples a whole texture, via a synthetic 1x1 tileset. Needs no decoded image, so it
   * works from a texture id alone; the tileset id is derived from the texture, so sprites share one.
   */
  public static fromTexture(textureId: string, options?: Omit<SpriteOptions, 'tileset' | 'tileIndex'>): Sprite {
      return new Sprite({ ...options, tileset: Sprite.textureTileset(textureId), tileIndex: 0 });
  }

  /** The synthetic 1x1 tileset `fromTexture` wraps a bare texture in. */
  public static textureTileset(textureId: string): Tileset {
      return new Tileset({
          id: `${INLINE_TILESET_PREFIX}tex:${textureId}`,
          textureId,
          imageWidth: 1, imageHeight: 1,
          tileWidth: 1, tileHeight: 1,
          margin: 0, spacing: 0,
          columns: 1, rows: 1,
      });
  }

  public get mesh(): Mesh { return this._mesh ??= new Mesh(); }
  public get geometry(): Geometry { return this._geometry ??= Geometry.Quad(); }
  /** Internal only — the renderer reads this to bind textures and upload `u_material.*`. */
  public get material(): Material { return this._material; }

  public get tileset(): Tileset | null { return this._tileset; }
  public set tileset(tileset: Tileset | null) {
      this._tileset = tileset;
      if (tileset) {
          this._material.textures.set('texture', tileset.textureId);
          this._material.properties.set('hasTexture', true);
      } else {
          this._material.textures.delete('texture');
          this._material.properties.set('hasTexture', false);
      }
      this._clampTileIndex();
  }

  public get tileIndex(): number { return this._tileIndex; }
  public set tileIndex(index: number) {
      this._tileIndex = Math.max(0, Math.floor(index));
      this._clampTileIndex();
  }

  public get tint(): [number, number, number] { return this._tint; }
  public set tint(tint: [number, number, number]) {
      this._tint = tint;
      this._material.properties.set('color', tint);
  }

  public get opacity(): number { return this._opacity; }
  public set opacity(opacity: number) {
      this._opacity = opacity;
      this._material.properties.set('opacity', opacity);
  }

  public get transparent(): boolean { return this._material.config.transparent === true; }
  public set transparent(value: boolean) { this._material.config.transparent = value; }
  public get side(): SpriteSide { return (this._material.config.side ?? 'double') as SpriteSide; }
  public set side(value: SpriteSide) { this._material.config.side = value; }
  public get wireframe(): boolean { return this._material.config.wireframe === true; }
  public set wireframe(value: boolean) { this._material.config.wireframe = value; }

  /** Texture-space rect [u0, v0, u1, v1] of the tile this sprite shows. */
  public uvRect(): [number, number, number, number] {
      return this.uvRectOf(this._tileIndex);
  }

  /** `uvRect` for an arbitrary tile — what AnimatedSpriteNode resolves its current frame through. */
  public uvRectOf(tileIndex: number): [number, number, number, number] {
      if (!this._tileset) return [...FULL_RECT] as [number, number, number, number];
      const uv = this._tileset.uvOf(tileIndex);
      return [uv[0], uv[1], uv[2], uv[3]];
  }

  private _clampTileIndex(): void {
      if (!this._tileset) return;
      const last = Math.max(0, this._tileset.tileCount - 1);
      if (this._tileIndex > last) this._tileIndex = last;
  }

  public serialize(): any {
      return {
          tilesetId: this._tileset?.id ?? null,
          // Embedded in full: see the note at the top of this file.
          tileset: this._tileset ? this._tileset.serialize() : null,
          tileIndex: this._tileIndex,
          tint: [this._tint[0], this._tint[1], this._tint[2]],
          opacity: this._opacity,
          transparent: this._material.config.transparent,
          side: this._material.config.side,
          wireframe: this._material.config.wireframe,
      };
  }

  public static parse(data: any): Sprite {
      const migrated = migrateLegacySprite(data);
      return new Sprite({
          tileset: migrated.tileset,
          tileIndex: migrated.tileIndex,
          tint: data?.tint ?? migrated.tint,
          opacity: data?.opacity ?? migrated.opacity,
          transparent: data?.transparent ?? migrated.transparent,
          side: data?.side ?? migrated.side,
          wireframe: data?.wireframe ?? migrated.wireframe,
      });
  }
}

/**
 * Read a pre-tileset sprite payload (`{ material: { color, texture, opacity, config } }`). Must live in
 * the engine, not the editor: the player and `Scene.instantiate` have no migration pass in front of them.
 */
export function migrateLegacySprite(data: any): {
    tileset: Tileset | null;
    tileIndex: number;
    tint: [number, number, number];
    opacity: number;
    transparent: boolean;
    side: SpriteSide;
    wireframe: boolean;
} {
    // Current format: a `tileset` key (possibly null, for a sprite with none assigned yet).
    if (data && 'tileset' in data) {
        return {
            tileset: data.tileset ? Tileset.parse(data.tileset) : null,
            tileIndex: data.tileIndex ?? 0,
            tint: data.tint ?? [1, 1, 1],
            opacity: data.opacity ?? 1,
            transparent: data.transparent ?? true,
            side: data.side ?? 'double',
            wireframe: data.wireframe ?? false,
        };
    }

    const material = data?.material ?? {};
    const textureId: string | undefined = material.texture;
    return {
        tileset: textureId ? Sprite.textureTileset(textureId) : null,
        tileIndex: 0,
        tint: material.color ?? [1, 1, 1],
        opacity: material.opacity ?? 1,
        transparent: material.config?.transparent ?? true,
        side: material.config?.side ?? 'double',
        wireframe: material.config?.wireframe ?? false,
    };
}

/**
 * A tileset over an evenly divided sheet, described only by its grid — dimensions are in TILES, so
 * `uvOf` is exact with no decoded image. Only valid for sheets with no margin and no spacing.
 */
export function gridTileset(id: string, textureId: string, columns: number, rows: number): Tileset {
    const c = Math.max(1, Math.floor(columns));
    const r = Math.max(1, Math.floor(rows));
    return new Tileset({
        id, textureId,
        imageWidth: c, imageHeight: r,
        tileWidth: 1, tileHeight: 1,
        margin: 0, spacing: 0,
        columns: c, rows: r,
    });
}

/** The tileset a legacy animated sprite's columns x rows sheet becomes. Pair with {@link remapLegacyFrame}. */
export function legacySheetTileset(textureId: string, columns: number, rows: number): Tileset {
    const c = Math.max(1, Math.floor(columns));
    const r = Math.max(1, Math.floor(rows));
    return gridTileset(`${INLINE_TILESET_PREFIX}legacy:${textureId}:${c}x${r}`, textureId, c, r);
}

/**
 * Legacy frame index -> tileset tile index. Legacy frames counted rows from the BOTTOM; tile 0 of a
 * tileset is the top-left cell, so the row is mirrored.
 */
export function remapLegacyFrame(index: number, columns: number, rows: number): number {
    const c = Math.max(1, Math.floor(columns));
    const r = Math.max(1, Math.floor(rows));
    const i = Math.max(0, Math.min(Math.floor(index), c * r - 1));
    const col = i % c;
    const rowFromBottom = Math.floor(i / c);
    return (r - 1 - rowFromBottom) * c + col;
}
