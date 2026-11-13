import { Geometry } from '../core/geometry';
import { Mesh } from './mesh';
import { Material } from './material';
import { Tileset } from '../graphics/tilemap/tileset';
import { finiteOr } from '../core/math';

// A sprite is a unit quad textured from ONE TILE of a Tileset, via `Tileset.uvOf`.
//
// Two invariants: the Material is a private implementation detail, never serialized and never linked to
// a material asset; and the tileset is EMBEDDED on serialize, so `parse` needs no asset library in scope.

export type SpriteSide = 'front' | 'back' | 'double';
/** How a sprite composites: `alpha` draws over what is behind it, `additive` adds light to it (fire, glows). */
export type SpriteBlend = 'alpha' | 'additive';

export interface SpriteOptions {
    tileset?: Tileset | null;
    tileIndex?: number;
    tint?: [number, number, number];
    opacity?: number;
    transparent?: boolean;
    side?: SpriteSide;
    wireframe?: boolean;
    blend?: SpriteBlend;
    exposureWeight?: number;
    softness?: number;
    lit?: boolean;
    /** Burn with a light: the NAME of a point or spot light near the sprite (see `followLight`). */
    followLight?: string | null;
    /** How much of the followed light's flicker the sprite takes, 0..1 (default 1). */
    followAmount?: number;
    /** Draw order among sprites: higher draws later, on top (see `sortingOrder`). Default 0. */
    sortingOrder?: number;
    /** The point of the image at the node's origin, (0, 0) bottom-left to (1, 1) top-right (see `pivot`). */
    pivot?: [number, number];
    /** Mirror the image left to right (see `flipX`). */
    flipX?: boolean;
    /** Mirror the image top to bottom (see `flipY`). */
    flipY?: boolean;
}

/** A soft-fade distance: non-negative metres, capped where it stops meaning "near the surface". */
const softnessOf = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(10, Math.max(0, v)) : 0);
const unitOr1 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1);
/** A sorting order: a whole number, 0 for anything that is not a finite one (as a particle emitter's). */
const orderOf = (v: unknown): number => Math.floor(finiteOr(v, 0));
/** A pivot: two finite numbers, the centre for anything else. Not clamped: a pivot may sit outside the image. */
const pivotOf = (v: unknown): [number, number] =>
    Array.isArray(v) && v.length >= 2 ? [finiteOr(v[0], 0.5), finiteOr(v[1], 0.5)] : [0.5, 0.5];

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
  private _blend: SpriteBlend;
  private _exposureWeight: number;
  private _softness: number;
  private _lit: boolean;
  private _followLight: string | null;
  private _followAmount: number;
  private _sortingOrder: number;
  private _pivot: [number, number];
  private _flipX: boolean;
  private _flipY: boolean;
  /** A lit sprite's private material, made on first lit draw (see {@link drawMaterial}). */
  private _litMaterial: Material | null = null;

  constructor(options?: SpriteOptions) {
      this._tileset = options?.tileset ?? null;
      this._tileIndex = Math.max(0, Math.floor(options?.tileIndex ?? 0));
      this._tint = options?.tint ?? [1, 1, 1];
      this._opacity = options?.opacity ?? 1;
      this._blend = options?.blend === 'additive' ? 'additive' : 'alpha';
      this._exposureWeight = unitOr1(options?.exposureWeight);
      this._softness = softnessOf(options?.softness);
      this._lit = options?.lit === true;
      this._followLight = typeof options?.followLight === 'string' && options.followLight ? options.followLight : null;
      this._followAmount = unitOr1(options?.followAmount);
      this._sortingOrder = orderOf(options?.sortingOrder);
      this._pivot = pivotOf(options?.pivot);
      this._flipX = options?.flipX === true;
      this._flipY = options?.flipY === true;
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
  public get blend(): SpriteBlend { return this._blend; }
  public set blend(value: SpriteBlend) { this._blend = value === 'additive' ? 'additive' : 'alpha'; }
  /**
   * How much the camera's exposure brightens the sprite, 0..1. A sprite is unlit: at 1 (the default) its
   * colour reaches the screen multiplied by the exposure like everything lit, so a flame that reads right in
   * daylight is a white smear once the exposure opens for a night or a dungeon (a thousand times, for a
   * torch-lit room). At 0 it shows at the same brightness under any exposure. In between it still brightens
   * in the dark, by that fraction of the stops. The same idea as an emissive "exposure weight".
   */
  public get exposureWeight(): number { return this._exposureWeight; }
  public set exposureWeight(value: number) { this._exposureWeight = unitOr1(value); }

  /**
   * Soft fade, in metres. 0 (the default) is a plain depth test, so a flame set into its torch is cut along
   * a hard line where it goes into the torch head. Above 0 the sprite fades out over that distance as it
   * nears the opaque surface behind it (a soft particle), so the line melts away. It is still depth-tested
   * as it stands: whatever is in front of it -- the torch head seen from below, a wall -- hides it. A flame
   * wants a few centimetres to a little over a decimetre.
   */
  public get softness(): number { return this._softness; }
  public set softness(value: number) { this._softness = softnessOf(value); }

  /**
   * Burn with a light (graphics/lightFlicker.ts): the NAME of a point or spot light near the sprite — a
   * sibling, or under an ancestor a level or two up, as a torch's Flame and Light sit under the torch.
   * The sprite's brightness then follows that light's flicker, so the flame swells on the beat its light
   * does. A name rather than an id so a template's instances each follow their own light. Null: steady.
   */
  public get followLight(): string | null { return this._followLight; }
  public set followLight(value: string | null) { this._followLight = typeof value === 'string' && value ? value : null; }
  /** How much of the followed light's flicker the sprite takes: 0 none, 1 all of it. */
  public get followAmount(): number { return this._followAmount; }
  public set followAmount(value: number) { this._followAmount = unitOr1(value); }

  /**
   * Sorting order, the artist's word on draw order: higher draws later, on top, whatever the distances say.
   * In 3D, sprites draw by sorting order first and back to front within one; in a 2D scene it offsets the
   * sprite's band from the tilemap's entity layer, as a particle emitter's sorting order does, so 1 draws
   * over the next layer up. A whole number; 0 (the default) leaves the order to depth.
   */
  public get sortingOrder(): number { return this._sortingOrder; }
  public set sortingOrder(value: number) { this._sortingOrder = orderOf(value); }

  /**
   * The point of the image that sits at the node's origin: (0, 0) its bottom-left corner, (1, 1) its
   * top-right, (0.5, 0.5) -- the default -- its centre. A character standing on the ground pivots at its
   * feet, so its position is where it stands and flipping it turns it about its own body.
   */
  public get pivot(): [number, number] { return this._pivot; }
  public set pivot(value: [number, number]) { this._pivot = pivotOf(value); }
  /** Mirror the image left to right, about the pivot: a character facing the other way. */
  public get flipX(): boolean { return this._flipX; }
  public set flipX(value: boolean) { this._flipX = value === true; }
  /** Mirror the image top to bottom, about the pivot. */
  public get flipY(): boolean { return this._flipY; }
  public set flipY(value: boolean) { this._flipY = value === true; }

  /**
   * The quad `tileIndex` draws as, in the node's units before its scale, into `out`: its tile's pixel size
   * over the tileset's pixels per unit, or a unit quad when the tileset has none (the legacy rule: size by
   * scale).
   */
  public quadSize(tileIndex: number, out: [number, number]): [number, number] {
      const ts = this._tileset;
      const ppu = ts?.pixelsPerUnit ?? 0;
      if (!ts || ppu <= 0) { out[0] = 1; out[1] = 1; return out; }
      ts.sizeOf(tileIndex, out);
      out[0] /= ppu; out[1] /= ppu;
      return out;
  }

  /**
   * Lit: the sprite takes the scene's light instead of showing its texture as it is -- the sun (and the
   * shadows it casts on the sprite), the sky and ambient light, and the strongest light near it. How, its
   * tileset decides (Tileset.lighting): with six-way lightmaps, the effect relit from the light's direction
   * (smoke, steam); with a normal map, its surface shaded (a liquid's splash); with neither, flat, as a
   * lit particle. Off (the default), unlit, as it always was.
   */
  public get lit(): boolean { return this._lit; }
  public set lit(value: boolean) { this._lit = value === true; }

  /**
   * The material this sprite DRAWS with: the private Basic one, or for a lit sprite its private lit one,
   * kept in step with the tint, opacity, sides and tileset (its texture and lighting maps) on every call.
   * Renderer-internal, as {@link material} is.
   */
  public drawMaterial(): Material {
      if (!this._lit) return this._material;
      const lit = this._litMaterial ??= Material.SpriteLit({ color: this._tint, opacity: this._opacity }, {
          transparent: true, side: 'double', wireframe: false, castShadow: false, probeable: false,
      });
      const cfg = this._material.config;
      lit.config.transparent = cfg.transparent;
      lit.config.side = cfg.side;
      lit.config.wireframe = cfg.wireframe;
      lit.properties.set('color', this._tint);
      lit.properties.set('opacity', this._opacity);
      const ts = this._tileset;
      const set = (slot: string, id: string | null | undefined) => { if (id) lit.textures.set(slot, id); else lit.textures.delete(slot); };
      set('texture', ts?.textureId);
      lit.properties.set('hasTexture', !!ts?.textureId);
      const mode = ts ? ts.lighting : 'flat';
      set('mapA', mode === 'sixWay' ? ts!.sixWayPositiveTextureId : mode === 'surface' ? ts!.normalTextureId : null);
      set('mapB', mode === 'sixWay' ? ts!.sixWayNegativeTextureId : mode === 'surface' ? ts!.ormTextureId : null);
      lit.properties.set('mode', mode === 'sixWay' ? 1 : mode === 'surface' ? 2 : 0);
      lit.properties.set('hasOrm', mode === 'surface' && !!ts!.ormTextureId);
      return lit;
  }

  /** Texture-space rect [u0, v0, u1, v1] of the tile this sprite shows. */
  public uvRect(): [number, number, number, number] {
      return this.uvRectOf(this._tileIndex);
  }

  /**
   * {@link uvRectOf} into `out` without allocating: what the batched 2D pass reads per sprite per frame. The
   * same float32 values `uvRectOf` copies out of `Tileset.uvOf`.
   */
  public uvRectInto(tileIndex: number, out: Float32Array): Float32Array {
      if (!this._tileset) { out[0] = 0; out[1] = 0; out[2] = 1; out[3] = 1; return out; }
      return this._tileset.uvOf(tileIndex, out);
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
          // Only when set, so an alpha sprite serializes as it always did.
          ...(this._blend === 'additive' ? { blend: 'additive' } : {}),
          ...(this._exposureWeight < 1 ? { exposureWeight: this._exposureWeight } : {}),
          ...(this._softness > 0 ? { softness: this._softness } : {}),
          ...(this._lit ? { lit: true } : {}),
          ...(this._followLight ? { followLight: this._followLight, ...(this._followAmount < 1 ? { followAmount: this._followAmount } : {}) } : {}),
          ...(this._sortingOrder !== 0 ? { sortingOrder: this._sortingOrder } : {}),
          ...(this._pivot[0] !== 0.5 || this._pivot[1] !== 0.5 ? { pivot: [this._pivot[0], this._pivot[1]] } : {}),
          ...(this._flipX ? { flipX: true } : {}),
          ...(this._flipY ? { flipY: true } : {}),
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
          blend: data?.blend,
          exposureWeight: data?.exposureWeight,
          softness: data?.softness,
          lit: data?.lit === true,
          followLight: data?.followLight ?? null,
          followAmount: data?.followAmount,
          sortingOrder: data?.sortingOrder,
          pivot: data?.pivot,
          flipX: data?.flipX === true,
          flipY: data?.flipY === true,
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
