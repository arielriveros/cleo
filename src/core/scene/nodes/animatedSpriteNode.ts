import { Sprite, legacySheetTileset, remapLegacyFrame } from "../../../graphics/sprite";
import type { Scene } from "../scene";
import { v4 as uuidv4 } from 'uuid';
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
    /** The `tile` source's rate: 0 plays at the tile's own fps, above 0 overrides it for this sprite only. */
    private _tileFps: number;
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
            tileFps?: number,
            constraints?: 'free' | 'spherical' | 'cylindrical',
            id?: string
        }
    ) {
        super(name, sprite, options?.constraints || 'spherical', options?.id || uuidv4(), 'animatedSprite');
        this._frames = [...(options?.frames ?? [])];
        this._frameSource = options?.frameSource ?? 'node';
        this._fps = Math.max(0.0001, options?.fps ?? 12);
        this._loop = options?.loop ?? true;
        this._tileFps = Math.max(0, options?.tileFps ?? 0);
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
            return tileset ? tileset.frameOf(this.tileIndex, this._elapsed, this._tileFps) : this.tileIndex;
        }
        if (this._frames.length === 0) return this.tileIndex;
        const i = Math.max(0, Math.min(this._currentFrame, this._frames.length - 1));
        return this._frames[i];
    }

    public uvRect(): [number, number, number, number] { return this.sprite.uvRectOf(this.currentTile); }

    protected _serializePayload(): any {
        // Must spread the parent's payload rather than replace it, or the sprite's own keys are dropped.
        return {
            ...super._serializePayload(),
            animation: {
                frames: [...this._frames],
                frameSource: this._frameSource,
                fps: this._fps,
                loop: this._loop,
                // Only when set, so a sprite that follows its tile serializes as it always did.
                ...(this._tileFps > 0 ? { tileFps: this._tileFps } : {}),
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
            tileFps: json?.animation?.tileFps,
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
    /** See `_tileFps`: 0 follows the tile's own rate. */
    public get tileFps(): number { return this._tileFps; }
    public set tileFps(v: number) { this._tileFps = Math.max(0, Number.isFinite(v) ? v : 0); }
    /**
     * The rate this sprite is playing at right now, whichever source it reads: its own `fps`, or for the
     * `tile` source the override or the tile's authored rate (0 when the tile does not animate).
     */
    public get effectiveFps(): number {
        if (this._frameSource === 'node') return this._fps;
        if (this._tileFps > 0) return this._tileFps;
        return this.sprite.tileset?.metaOf(this.tileIndex)?.animation?.fps ?? 0;
    }
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

/** Expand a legacy columns x rows sheet animation into an explicit list of tile indices. */
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
