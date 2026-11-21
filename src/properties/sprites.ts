// The sprites', the tilemap's and the 2D bodies' declared properties (see declare.ts). Documented with the rest
// of 2D (docs/editor/tilemap-2d.md). What a sprite draws (its tileset, its tile, its frames, its clips) stays the
// cards' own: tile grids and the tileset library.

import { Color, Vec2, CollisionLayer, CollisionMask } from '../core/scripting/fieldTypes';
import { Choice } from '../core/properties/types';
import { SpriteNode } from '../core/scene/nodes/spriteNode';
import { AnimatedSpriteNode } from '../core/scene/nodes/animatedSpriteNode';
import { TilemapNode } from '../core/scene/nodes/tilemapNode';
import { CharacterBody2DNode } from '../core/scene/nodes/characterBody2DNode';
import { Body2DNode } from '../core/scene/nodes/body2DNode';
import { declareProperties, type PropertyDeclaration } from './declare';

const DOCS = 'editor/tilemap-2d';

declareProperties(SpriteNode, 'Sprite', [
    { title: '', props: [
        { key: 'constraints', type: Choice(['free', 'spherical', 'cylindrical'], ['Free', 'Spherical', 'Cylindrical']) },
    ] },
    // The Appearance card's rows, shared by every kind of sprite (a static one, an animated one, a parallax layer).
    { title: 'Appearance', props: [
        { key: 'sprite.tint', label: 'Tint', type: Color },
        { key: 'sprite.opacity', label: 'Opacity', type: Number, min: 0, max: 1, step: 0.01 },
        { key: 'sprite.blend', label: 'Blending', type: Choice(['alpha', 'additive'], ['Alpha', 'Additive']) },
        { key: 'sprite.sortingOrder', label: 'Sorting order', type: Number, step: 1 },
        { key: 'sprite.pivot', label: 'Pivot', type: Vec2, step: 0.05 },
        { key: 'sprite.flipX', label: 'Flip X', type: Boolean },
        { key: 'sprite.flipY', label: 'Flip Y', type: Boolean },
        { key: 'sprite.lit', label: 'Lit', type: Boolean },
        { key: 'sprite.exposureWeight', label: 'Exposure weight', type: Number, min: 0, max: 1, step: 0.05 },
        { key: 'sprite.softness', label: 'Soft fade', type: Number, min: 0, max: 1, step: 0.01 },
        { key: 'sprite.transparent', label: 'Transparent', type: Boolean },
        { key: 'sprite.side', label: 'Sides', type: Choice(['double', 'front', 'back'], ['Double', 'Front', 'Back']) },
        { key: 'sprite.wireframe', label: 'Wireframe', type: Boolean },
    ] },
], { docs: DOCS });

declareProperties(AnimatedSpriteNode, 'Animated Sprite', [
    { title: 'Playback', when: n => n.frameSource === 'node', props: [
        { key: 'fps', label: 'Frames per second', type: Number, min: 0.01, step: 1 },
        { key: 'loop', type: Boolean },
        { key: 'randomStart', label: 'Random start', type: Boolean },
    ] },
], { docs: DOCS });

/** A field of the tilemap's grid: the grid is set whole. */
const grid = (key: string, decl: Omit<PropertyDeclaration<TilemapNode>, 'key' | 'get' | 'set'>): PropertyDeclaration<TilemapNode> => ({
    key: `grid.${key}`, ...decl,
    get: n => (n.tilemap.grid as any)[key],
    set: (n, v) => n.tilemap.setGrid({ ...n.tilemap.grid, [key]: v } as any),
});
const hex = (n: TilemapNode) => n.tilemap.grid.kind === 'hexagonal';

declareProperties(TilemapNode, 'Tilemap', [
    { title: '', props: [
        grid('kind', { label: 'Grid', type: Choice(['orthogonal', 'isometric', 'hexagonal'], ['Orthogonal', 'Isometric', 'Hexagonal']) }),
        { key: 'grid.cellSize', label: 'Cell size', type: Vec2, min: 0.01, step: 0.1,
          get: n => [n.tilemap.grid.cellWidth, n.tilemap.grid.cellHeight],
          set: (n, v) => { const [w, h] = v as number[]; n.tilemap.setGrid({ ...n.tilemap.grid, cellWidth: w, cellHeight: h }); } },
        grid('hexOrientation', { label: 'Orientation', type: Choice(['pointy', 'flat'], ['Pointy top', 'Flat top']), when: hex }),
        grid('hexOffset', { label: 'Offset', type: Choice(['odd-r', 'even-r'], ['Odd rows', 'Even rows']), when: n => hex(n) && n.tilemap.grid.hexOrientation === 'pointy' }),
        // The same field, offered by columns on a flat-top grid (its own row key).
        { ...grid('hexOffset', { label: 'Offset', type: Choice(['odd-q', 'even-q'], ['Odd columns', 'Even columns']), when: n => hex(n) && n.tilemap.grid.hexOrientation === 'flat' }),
          key: 'grid.hexOffset.flat' },
        grid('hexSideLength', { label: 'Side length', type: Number, min: 0.01, step: 0.05, when: hex }),
        { key: 'tilemap.entitySort', label: 'Sprite order', type: Choice(['y', 'none'], ['By Y', 'Side view']) },
        { key: 'tilemap.colliders3D', label: '3D colliders', type: Boolean },
        { key: 'tilemap.collisionDepth', label: 'Collision depth', type: Number, min: 0.01, step: 0.1 },
    ] },
], { docs: DOCS });

const walker = (n: CharacterBody2DNode) => n.movement === 'walk';

declareProperties(CharacterBody2DNode, 'Character Body 2D', [
    { title: '', props: [
        { key: 'size', type: Vec2, min: 0.01, step: 0.1 },
        { key: 'layer', type: CollisionLayer },
        { key: 'stepHeight', label: 'Step height', type: Number, min: 0, step: 0.05 },
        { key: 'flipSprites', label: 'Flip sprites', type: Boolean },
        { key: 'oneWayPlatforms', label: 'One-way platforms', type: Boolean },
    ] },
    { title: 'Movement', props: [
        { key: 'movement', type: Choice(['walk', 'fly'], ['Walk', 'Fly']) },
        { key: 'walkSpeed', label: 'Walk speed', type: Number, min: 0, step: 0.5 },
        { key: 'runSpeed', label: 'Run speed', type: Number, min: 0, step: 0.5 },
        { key: 'acceleration', type: Number, min: 0, step: 5 },
        { key: 'deceleration', type: Number, min: 0, step: 5, when: walker },
        { key: 'airControl', label: 'Air control', type: Number, min: 0, max: 1, step: 0.05, when: walker },
    ] },
    { title: 'Jump', when: walker, props: [
        { key: 'jumpHeight', label: 'Jump height', type: Number, min: 0, step: 0.1 },
        { key: 'jumpTimeToApex', label: 'Time to apex', type: Number, min: 0, step: 0.02 },
        { key: 'fallGravityMultiplier', label: 'Fall gravity', type: Number, min: 0, step: 0.1 },
        { key: 'maxFallSpeed', label: 'Max fall speed', type: Number, min: 0, step: 1 },
        { key: 'coyoteSeconds', label: 'Coyote time', type: Number, min: 0, step: 0.01 },
        { key: 'jumpBufferSeconds', label: 'Jump buffer', type: Number, min: 0, step: 0.01 },
    ] },
    { title: 'Advanced', props: [
        { key: 'gravityScale', label: 'Gravity scale', type: Number, min: 0, step: 0.1 },
        { key: 'driveWhenUnpossessed', label: 'Drive without a controller', type: Boolean },
    ] },
], { docs: DOCS });

declareProperties(Body2DNode, 'Collider 2D', [
    { title: '', props: [
        { key: 'size', type: Vec2, min: 0, step: 0.1 },
        { key: 'kind', type: Choice(['solid', 'oneWay'], ['Solid', 'One-way platform']) },
        { key: 'mass', type: Number, min: 0, step: 0.1 },
        { key: 'gravityScale', label: 'Gravity scale', type: Number, step: 0.1, when: n => n.mass > 0 },
        { key: 'layer', type: CollisionLayer },
        { key: 'mask', label: 'Collides with', type: CollisionMask },
        { key: 'enabled', type: Boolean },
    ] },
], { docs: DOCS });
