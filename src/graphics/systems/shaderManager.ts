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
     * Unregister `name`. Does NOT dispose the shader — one program can be registered under several
     * names, so ownership is the caller's to decide.
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
     * Bind `name` if registered, and CLEAR the binding if not; returns whether it was. Clearing is the
     * load-bearing half — a pipeline with no engine-level program must not inherit the last one's.
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

    /** Upload any std140 block writes the bound program has pending. Called from the draw paths. */
    public flushBound(): void { this._boundShader?.flushUniformBlocks(); }

    /** The currently bound program, or null. Read-only: `bind(name)` is the only way to change it. */
    public get bound(): ShaderProgram | null { return this._boundShader; }

    public get registeredShaders(): string[] {
        return Array.from(this._shaders.keys());
    }
}