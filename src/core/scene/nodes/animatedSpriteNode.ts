import { Sprite, legacySheetTileset, remapLegacyFrame } from "../../../graphics/sprite";
import { Tileset } from "../../../graphics/tilemap/tileset";
import type { Scene } from "../scene";
import { v4 as uuidv4 } from 'uuid';
import { ModelNode } from "./modelNode";
import { Node } from "./node";
import { SpriteNode, spritePayload } from "./spriteNode";

/**
 * A sprite that plays a frame sequence.
 */

export type SpriteFrameSource = 'node' | 'tile';

export class AnimatedSpriteNode extends SpriteNode {
    private _frames: number[];
    private _frameSource: SpriteFrameSource;
    private _fps: number;
    private _loop: boolean;
    /** Index INTO `_frames`, not a tile index. */
    private _currentFrame: number;
    private _accumulator: number;
    /** Scene time, for the `tile` source — `Tileset.frameOf` is a pure function of it. */
    private _elapsed: number;

    constructor(
        name: string,
        sprite: Sprite,
        options?: {
            frames?: number[],
            frameSource?: SpriteFrameSource,
            fps?: number,
            loop?: boolean,
            constraints?: 'free' | 'spherical' | 'cylindrical',
            id?: string
        }
    ) {
        super(name, sprite, options?.constraints || 'spherical', options?.id || uuidv4(), 'animatedSprite');
        this._frames = [...(options?.frames ?? [])];
        this._frameSource = options?.frameSource ?? 'node';
        this._fps = Math.max(0.0001, options?.fps ?? 12);
        this._loop = options?.loop ?? true;
        this._currentFrame = 0;
        this._accumulator = 0;
        this._elapsed = 0;
    }

    public update(delta: number, time: number): void {
        super.update(delta, time);
        this._elapsed += delta;
        // The `tile` source is a pure function of elapsed time (see uvRect) — nothing to step.
        if (this._frameSource === 'tile') return;
        if (this._frames.length === 0) return;

        const frameTime = 1.0 / this._fps;
        this._accumulator += delta;
        while (this._accumulator >= frameTime) {
            this._accumulator -= frameTime;
            if (this._currentFrame < this._frames.length - 1) this._currentFrame++;
            else if (this._loop) this._currentFrame = 0;
            // Non-looping holds on the last frame.
        }
    }

    /** The tile index actually on screen this instant. */
    public get currentTile(): number {
        if (this._frameSource === 'tile') {
            const tileset = this.sprite.tileset;
            return tileset ? tileset.frameOf(this.tileIndex, this._elapsed) : this.tileIndex;
        }
        if (this._frames.length === 0) return this.tileIndex;
        const i = Math.max(0, Math.min(this._currentFrame, this._frames.length - 1));
        return this._frames[i];
    }

    public uvRect(): [number, number, number, number] { return this.sprite.uvRectOf(this.currentTile); }

    protected _serializePayload(): any {
        // Spreads the parent's payload rather than replacing it: this is the only two-level node subclass
        // outside the UI family, so it is the one place where forgetting `super` silently drops a key —
        // it cost the sprite's `constraints` and tileset on the first attempt.
        return {
            ...super._serializePayload(),
            animation: {
                frames: [...this._frames],
                frameSource: this._frameSource,
                fps: this._fps,
                loop: this._loop,
            },
        };
    }

    public static parse(parent: Node, json: any) {
        const sprite = Sprite.parse(spritePayload(json));
        const animation = migrateLegacyAnimation(json, sprite);
        const spriteNode = new AnimatedSpriteNode(json.name, sprite, {
            id: json.id,
            constraints: json.sprite?.constraints,
            frames: animation.frames,
            frameSource: animation.frameSource,
            fps: animation.fps,
            loop: animation.loop,
        });
        Node.finishParse(spriteNode, parent, json);
    }

    /** Ordered tile indices this sprite cycles through. */
    public get frames(): number[] { return this._frames; }
    public set frames(frames: number[]) {
        this._frames = [...(frames ?? [])];
        this._currentFrame = 0;
        this._accumulator = 0;
    }
    public get frameSource(): SpriteFrameSource { return this._frameSource; }
    public set frameSource(source: SpriteFrameSource) { this._frameSource = source; this.reset(); }
    public get fps(): number { return this._fps; }
    public set fps(v: number) { this._fps = Math.max(0.0001, v); }
    public get loop(): boolean { return this._loop; }
    public set loop(v: boolean) { this._loop = v; }
    /** Position within `frames`. Clamped, and resets the sub-frame accumulator. */
    public get currentFrame(): number { return this._currentFrame; }
    public set currentFrame(v: number) {
        const last = Math.max(0, this._frames.length - 1);
        this._currentFrame = Math.max(0, Math.min(Math.floor(v), last));
        this._accumulator = 0;
    }

    /** Restart from the first frame. */
    public reset(): void {
        this._currentFrame = 0;
        this._accumulator = 0;
        this._elapsed = 0;
    }
}

/**
 * The sprite payload to hand `Sprite.parse`, across both formats.
 *
 * Legacy nodes nested one level deeper than they looked: `Sprite.serialize` returned `{material}`, and
 * `SpriteNode.serialize` stored THAT under `sprite.material` — so the legacy material object is at
 * `json.sprite.material.material`. Unwrapping one level here hands `Sprite.parse` a `{material}` in both
 * eras and keeps the double-nesting quirk contained to this function.
 */

function migrateLegacyAnimation(json: any, sprite: Sprite): {
    frames: number[]; frameSource: SpriteFrameSource; fps: number; loop: boolean;
} {
    const animation = json?.animation ?? {};
    const fps = animation.fps ?? 12;
    const loop = animation.loop ?? true;

    if (Array.isArray(animation.frames)) {
        return { frames: animation.frames, frameSource: animation.frameSource ?? 'node', fps, loop };
    }

    const columns = Math.max(1, animation.columns ?? 1);
    const rows = Math.max(1, animation.rows ?? 1);
    const textureId = sprite.tileset?.textureId;
    if (textureId) sprite.tileset = legacySheetTileset(textureId, columns, rows);

    const legacy: number[] = Array.isArray(animation.sequence) && animation.sequence.length > 0
        ? animation.sequence
        : (() => {
            const start = Math.max(0, animation.startFrame ?? 0);
            const end = Math.min(columns * rows - 1, animation.endFrame ?? (columns * rows - 1));
            const out: number[] = [];
            for (let i = start; i <= end; i++) out.push(i);
            return out;
        })();

    return { frames: legacy.map(i => remapLegacyFrame(i, columns, rows)), frameSource: 'node', fps, loop };
}
/**
 * Reconstruct a serialized subtree under `parent`, dispatching on its `type`.
 *
 * `Node.parse` alone always builds a plain Node, so anything routed through it loses its subclass — a model
 * comes back as an empty transform. Every path that materializes a subtree (scene parse via
 * `_commonParse`, runtime `Scene.instantiate`, the editor's template/mesh instantiation) goes through here,
 * so a new node type only has to be registered in one place. `ModelNode.parse` detects animated vs static
 * models itself, so skinned meshes round-trip through the single `'model'` case.
 *
 * Declared last in this module because it needs every node class above it in scope.
 */

// ============================================================================================
// UI NODES
//
// A UI element is a Node. That is the whole design: parenting, `visible`, spawn/despawn
// serialization, templates, undo/redo, dirty-tracking and the class-based script system all come
// from the base class rather than being reimplemented against a parallel element tree.
//
// Layout is resolved once per frame by the scene's UI late pass (see `Scene.update`), never during
// render. The resolved rects are plain derived fields that deliberately do NOT emit SCENE_CHANGED —
// a solve that notified would mark the tab permanently unsaved and push sixty undo entries per
// second. The AUTHORED fields do notify, which is what makes a UI edit dirty the tab and be
// undoable — neither of which the legacy overlay ever managed.
//
// The layout math lives in `src/core/uiLayout.ts` so the unit suite can reach it (node.ts
// transitively needs a GL context) — the same split `cameraRigMath.ts` uses for the camera rig.
// ============================================================================================

/** How an image fills its element's rect. */
