import { gl } from '../renderer';

/**
 * Central cache of WebGL global state. Every redundant `useProgram`, `bindVertexArray`,
 * `enable/disable`, `cullFace`, `depthMask` and `bindTexture` in a frame is a driver
 * call (and sometimes a sync point) we can skip when the requested state already matches.
 *
 * All state changes in the renderer should go through this singleton so the cache stays
 * authoritative. If external code touches GL state directly, call `reset()` to invalidate.
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
        if (this._program !== program) {
            gl.useProgram(program);
            this._program = program;
        }
    }

    public get currentProgram(): WebGLProgram | null { return this._program; }
    /** The VAO this cache believes is bound. Needed so an owner deleting one can invalidate the cache —
     *  a deleted VAO left here would make the next bind of that same handle a silent no-op. */
    public get currentVAO(): WebGLVertexArrayObject | null { return this._vao; }

    public bindVAO(vao: WebGLVertexArrayObject | null): void {
        if (this._vao !== vao) {
            gl.bindVertexArray(vao);
            this._vao = vao;
        }
    }

    public enable(cap: number): void {
        if (this._caps.get(cap) !== true) {
            gl.enable(cap);
            this._caps.set(cap, true);
        }
    }

    public disable(cap: number): void {
        if (this._caps.get(cap) !== false) {
            gl.disable(cap);
            this._caps.set(cap, false);
        }
    }

    public setEnabled(cap: number, enabled: boolean): void {
        if (enabled) this.enable(cap); else this.disable(cap);
    }

    public cullFace(mode: number): void {
        if (this._cullFace !== mode) {
            gl.cullFace(mode);
            this._cullFace = mode;
        }
    }

    public depthMask(flag: boolean): void {
        if (this._depthMask !== flag) {
            gl.depthMask(flag);
            this._depthMask = flag;
        }
    }

    public bindTexture(unit: number, target: number, texture: WebGLTexture | null): void {
        if (this._boundTextures.get(unit) !== texture) {
            if (this._activeTexture !== unit) {
                gl.activeTexture(gl.TEXTURE0 + unit);
                this._activeTexture = unit;
            }
            gl.bindTexture(target, texture);
            this._boundTextures.set(unit, texture);
        }
    }

    /** Invalidate the whole cache (e.g. after code paths that change GL state directly). */
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
