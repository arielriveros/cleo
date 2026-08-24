import type { ShaderProgram } from "../rhi/shaderProgram";

export class ShaderManager {
    private static _instance: ShaderManager | null = null;
    private _shaders: Map<string, ShaderProgram>;
    private _boundShader: ShaderProgram | null = null;

    private constructor() {
        this._shaders = new Map<string, ShaderProgram>();
    }

    public static get Instance(): ShaderManager {
        if (!ShaderManager._instance)
            ShaderManager._instance = new ShaderManager();
        return ShaderManager._instance;
    }

    public addShader(name: string, shader: ShaderProgram): void {
        this._shaders.set(name, shader);
    }

    public getShader(name: string): ShaderProgram {
        const shader = this._shaders.get(name);
        if (!shader) throw new Error(`ShaderProgram ${name} not found`);
        return shader;
    }

    /** The shader registered under `name`, or undefined — unlike {@link getShader}, does not throw. */
    public find(name: string): ShaderProgram | undefined { return this._shaders.get(name); }

    /**
     * Unregisters `name`. Does NOT dispose the shader: one ShaderProgram instance can be registered under
     * several names (every failing custom-shader key shares one magenta fallback), so ownership is the
     * caller's to decide — see {@link isRegistered}.
     */
    public removeShader(name: string): void {
        const shader = this._shaders.get(name);
        if (shader && this._boundShader === shader) this._boundShader = null;
        this._shaders.delete(name);
    }

    /** Whether this exact ShaderProgram instance is still registered under any name. */
    public isRegistered(shader: ShaderProgram): boolean {
        for (const s of this._shaders.values()) if (s === shader) return true;
        return false;
    }

    public bind(name: string): void {
        this._boundShader = this.getShader(name);
        this._boundShader.use();
    }

    /**
     * Bind `name` if it is registered, and bind NOTHING if it is not. Returns whether it was.
     *
     * For the WebGPU pass encoder, which binds the program a pipeline names on every `setPipeline`.
     * A pipeline can legitimately have no engine-level program behind it — one built straight from a
     * shader module, which is what the device-tier harness does and what any future device-level test
     * would do — and `bind` throwing turns that into a dead run rather than a pipeline with no
     * uniforms to flush.
     *
     * Clearing the binding is the load-bearing half. Leaving the previous pass's program bound is
     * exactly the failure `WebGPURenderPassEncoder._flushUniforms` documents: uniforms written for one
     * program, read by a draw recorded against another, reported by the driver as a binding-size
     * mismatch a long way from the pass that caused it.
     */
    public bindIfRegistered(name: string): boolean {
        const shader = this._shaders.get(name);
        this._boundShader = shader ?? null;
        shader?.use();
        return !!shader;
    }

    public setUniform(name: string, value: any): void {
        if (!this._boundShader) throw new Error("No shader bound");
        this._boundShader.setUniform(name, value);
    }

    /**
     * Upload any std140 block writes the bound program has pending.
     *
     * Called from the draw paths rather than from `setUniform`, so a pass that sets a dozen members
     * pays one buffer upload instead of a dozen. A no-op for every hand-written GLSL program, which
     * has no blocks at all — the check is a null test on a field.
     */
    public flushBound(): void { this._boundShader?.flushUniformBlocks(); }

    /**
     * The currently bound program, or null.
     *
     * Exposed for the WebGPU pass encoder, which has to BIND that program's uniform blocks as bind
     * groups - WebGL2 uploads them to global binding points and needs no such step. Read-only on
     * purpose: `bind(name)` stays the only way to change it.
     */
    public get bound(): ShaderProgram | null { return this._boundShader; }

    public get registeredShaders(): string[] {
        return Array.from(this._shaders.keys());
    }
}