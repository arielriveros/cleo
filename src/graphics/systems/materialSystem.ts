import { Shader } from "../shader";

export class MaterialSystem {
    private static _instance: MaterialSystem | null = null;
    private _shaders: Map<string, Shader>;
    private _boundShader: Shader | null = null;

    private constructor() {
        console.log("Material system created");
        this._shaders = new Map<string, Shader>();
    }

    public static get Instance(): MaterialSystem {
        if (!MaterialSystem._instance)
            MaterialSystem._instance = new MaterialSystem();
        return MaterialSystem._instance;
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

    public setProperty(name: string, value: any): void {
        if (!this._boundShader) throw new Error("No shader bound");
        this._boundShader.setUniform(name, value);
    }

    public update(): void {
        this._boundShader?.update();
    }

    public get registeredShaders(): string[] {
        return Array.from(this._shaders.keys());
    }
}