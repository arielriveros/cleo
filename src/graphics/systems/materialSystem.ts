import { mat4, vec2, vec3, vec4 } from "gl-matrix";
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
        const shader = this._shaders.get(name);
        if (!shader) throw new Error(`Shader ${name} not found`);
        this._boundShader = shader;
        shader.use();
    }

    public setProperty(name: string, value: any): void {
        if (!this._boundShader) throw new Error("No shader bound");
        if (this._boundShader.uniforms[name])
            this._boundShader.uniforms[name].value = value;
    }

    public update(): void {
        for (const shader of this._shaders.values())
            shader.update();
    }
}