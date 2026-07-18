import { Shader } from "../shader";

export class ShaderManager {
    private static _instance: ShaderManager | null = null;
    private _shaders: Map<string, Shader>;
    private _boundShader: Shader | null = null;

    private constructor() {
        this._shaders = new Map<string, Shader>();
    }

    public static get Instance(): ShaderManager {
        if (!ShaderManager._instance)
            ShaderManager._instance = new ShaderManager();
        return ShaderManager._instance;
    }

    public addShader(name: string, shader: Shader): void {
        this._shaders.set(name, shader);
    }

    public getShader(name: string): Shader {
        const shader = this._shaders.get(name);
        if (!shader) throw new Error(`Shader ${name} not found`);
        return shader;
    }

    /** The shader registered under `name`, or undefined — unlike {@link getShader}, does not throw. */
    public find(name: string): Shader | undefined { return this._shaders.get(name); }

    /**
     * Unregisters `name`. Does NOT dispose the shader: one Shader instance can be registered under
     * several names (every failing custom-shader key shares one magenta fallback), so ownership is the
     * caller's to decide — see {@link isRegistered}.
     */
    public removeShader(name: string): void {
        const shader = this._shaders.get(name);
        if (shader && this._boundShader === shader) this._boundShader = null;
        this._shaders.delete(name);
    }

    /** Whether this exact Shader instance is still registered under any name. */
    public isRegistered(shader: Shader): boolean {
        for (const s of this._shaders.values()) if (s === shader) return true;
        return false;
    }

    public bind(name: string): void {
        this._boundShader = this.getShader(name);
        this._boundShader.use();
    }

    public setUniform(name: string, value: any): void {
        if (!this._boundShader) throw new Error("No shader bound");
        this._boundShader.setUniform(name, value);
    }

    public get registeredShaders(): string[] {
        return Array.from(this._shaders.keys());
    }
}