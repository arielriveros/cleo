import { gl } from '../glContext';
import { frameStats } from '../renderStats';

/**
 * Central cache of WebGL global state, skipping every redundant driver call. Every state change must
 * go through it to stay authoritative; anything touching GL directly must call `reset()`.
 */
class GLStateCache {
    private _program: WebGLProgram | null = null;
    private _vao: WebGLVertexArrayObject | null = null;
    private _caps: Map<number, boolean> = new Map();
    private _cullFace: number | null = null;
    private _depthMask: boolean | null = null;
    private _activeTexture: number = -1;
    private _boundTextures: Map<number, WebGLTexture | null> = new Map();

    public useProgram(program: WebGLProgram | null): void {
        if (!gl) return;
        if (this._program !== program) {
            gl.useProgram(program);
            this._program = program;
            frameStats.stateChanges++;
        } else frameStats.stateChangesSaved++;
    }

    public get currentProgram(): WebGLProgram | null { return this._program; }
    /** The VAO this cache believes is bound, so an owner deleting one can invalidate the entry. */
    public get currentVAO(): WebGLVertexArrayObject | null { return this._vao; }

    public bindVAO(vao: WebGLVertexArrayObject | null): void {
        if (!gl) return;
        if (this._vao !== vao) {
            gl.bindVertexArray(vao);
            this._vao = vao;
            frameStats.stateChanges++;
        } else frameStats.stateChangesSaved++;
    }

    public enable(cap: number): void {
        if (!gl) return;
        if (this._caps.get(cap) !== true) {
            gl.enable(cap);
            this._caps.set(cap, true);
            frameStats.stateChanges++;
        } else frameStats.stateChangesSaved++;
    }

    public disable(cap: number): void {
        if (!gl) return;
        if (this._caps.get(cap) !== false) {
            gl.disable(cap);
            this._caps.set(cap, false);
            frameStats.stateChanges++;
        } else frameStats.stateChangesSaved++;
    }

    public setEnabled(cap: number, enabled: boolean): void {
        if (!gl) return;
        if (enabled) this.enable(cap); else this.disable(cap);
    }

    /**
     * Which face to cull, named rather than taking an enum: an argument like `gl.BACK` evaluates at the
     * CALL SITE and throws on a backend with no context, before any guard here can run.
     */
    public cullFace(side: 'front' | 'back'): void {
        const mode = side === 'front' ? 0x0404 /* FRONT */ : 0x0405 /* BACK */;
        if (!gl) return;
        if (this._cullFace !== mode) {
            gl.cullFace(mode);
            this._cullFace = mode;
            frameStats.stateChanges++;
        } else frameStats.stateChangesSaved++;
    }

    public depthMask(flag: boolean): void {
        if (!gl) return;
        if (this._depthMask !== flag) {
            gl.depthMask(flag);
            this._depthMask = flag;
            frameStats.stateChanges++;
        } else frameStats.stateChangesSaved++;
    }

    /**
     * Bind `texture` to `unit`. The cache key is the unit alone, not (unit, target) — a texture object
     * has one target for its lifetime, so the identity compare already separates them.
     */
    public bindTexture(unit: number, target: number, texture: WebGLTexture | null): void {
        if (!gl) return;
        if (this._boundTextures.get(unit) !== texture) {
            if (this._activeTexture !== unit) {
                gl.activeTexture(gl.TEXTURE0 + unit);
                this._activeTexture = unit;
            }
            gl.bindTexture(target, texture);
            this._boundTextures.set(unit, texture);
            frameStats.stateChanges++;
        } else frameStats.stateChangesSaved++;
    }

    /**
     * Bind unconditionally, for MUTATION paths, which act on the ACTIVE unit. The deduped
     * {@link bindTexture} may skip `activeTexture`, sending an upload to another unit's texture.
     */
    public bindTextureForced(unit: number, target: number, texture: WebGLTexture | null): void {
        if (!gl) return;
        gl.activeTexture(gl.TEXTURE0 + unit);
        this._activeTexture = unit;
        gl.bindTexture(target, texture);
        this._boundTextures.set(unit, texture);
        frameStats.stateChanges++;
    }

    /** Depth testing on or off. Named rather than enum-taking — see {@link cullFace}. */
    public depthTest(on: boolean): void { this.setEnabled(0x0B71 /* DEPTH_TEST */, on); }

    /** Blending on or off. See {@link depthTest} for why this is not an enum. */
    public blend(on: boolean): void { this.setEnabled(0x0BE2 /* BLEND */, on); }

    /** Face culling on or off. See {@link depthTest} for why this is not an enum. */
    public cull(on: boolean): void { this.setEnabled(0x0B44 /* CULL_FACE */, on); }

    public reset(): void {
        this._program = null;
        this._vao = null;
        this._caps.clear();
        this._cullFace = null;
        this._depthMask = null;
        this._activeTexture = -1;
        this._boundTextures.clear();
    }
}

export const GLState = new GLStateCache();
