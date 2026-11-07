import { Framebuffer } from '../framebuffer';

/** What a history's two targets are built with. */
type FramebufferOptions = ConstructorParameters<typeof Framebuffer>[0];

/**
 * A temporal history: two framebuffers ping-ponged frame to frame — last frame's result is read while
 * this frame's is written — allocated on first use, resized with the view, and whether the one last
 * written may be trusted. Storage only: what else "trusted" needs (a previous camera, a fresh companion
 * target) is the owner's to add. Shared by TAA, the cloud and fluid reprojection, and SSIL.
 */
export class TemporalHistory {
    private readonly _targets: Framebuffer[] = [];
    private _index = 0;
    private _width = 0;
    private _height = 0;

    /**
     * Whether {@link read} holds a result this history wrote. Set by {@link swap}; dropped when the
     * storage is reallocated and by {@link invalidate} (a camera cut, a setting that changes the image).
     */
    public valid = false;

    constructor(private readonly _options: FramebufferOptions) {}

    /**
     * Allocate on first use and size both targets to `width` x `height`. True when the storage was
     * (re)allocated, which also drops {@link valid}: `Framebuffer.resize` recreates every attachment, so
     * a history that survived a resize would be uninitialized memory rather than merely stale.
     */
    public ensure(width: number, height: number): boolean {
        if (this._targets.length === 0)
            for (let i = 0; i < 2; i++) this._targets.push(new Framebuffer(this._options));
        if (this._width === width && this._height === height) return false;
        for (const fbo of this._targets) fbo.resize(width, height);
        this._width = width;
        this._height = height;
        this.valid = false;
        return true;
    }

    /** Last frame's result. */
    public get read(): Framebuffer { return this._targets[this._index]; }

    /** This frame's target. */
    public get write(): Framebuffer { return this._targets[this._index ^ 1]; }

    /**
     * After writing {@link write}: it becomes {@link read}, and is trusted from now on. `preExposure` is the
     * factor the frame stored its values with (FrameView.preExposure), remembered so the next frame can
     * bring them to ITS factor ({@link rescale}). Required, so no owner can forget to stamp it.
     */
    public swap(preExposure: number): void {
        this._index ^= 1;
        this.valid = true;
        this._readPreExposure = preExposure > 0 ? preExposure : 1;
    }

    /** The pre-exposure {@link read} was written with. */
    private _readPreExposure = 1;

    /** The pre-exposure {@link read} was written with: what `rescale` divides out. */
    public get readPreExposure(): number { return this._readPreExposure; }

    /**
     * What {@link read}'s colour must be multiplied by to be in a frame pre-exposed by `preExposure`:
     * `k_now / k_written`. Exactly 1 while the factor holds, and an exact power of two when it changes,
     * so a history survives an exposure change without a pop or a loss of precision. Never a reason to
     * invalidate one.
     */
    public rescale(preExposure: number): number {
        return (preExposure > 0 ? preExposure : 1) / this._readPreExposure;
    }

    /** Stop trusting the history; the next frame starts it over. */
    public invalidate(): void { this.valid = false; }

    /** Both targets, for memory accounting. Empty until first use. */
    public get targets(): readonly Framebuffer[] { return this._targets; }

    /** Whether {@link ensure} has run at all. */
    public get allocated(): boolean { return this._targets.length > 0; }
}
