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