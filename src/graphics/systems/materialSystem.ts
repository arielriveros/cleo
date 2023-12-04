import { mat4, vec2, vec3, vec4 } from "gl-matrix";
import { Shader } from "../shader";

export class MaterialSystem {
    private static _instance: MaterialSystem | null = null;
    private _shaders: Map<string, Shader>;
    private _uniforms: Map<string, Map<string, {type: string, value: any}>>;

    private constructor() {
        console.log("Material system created");
        this._shaders = new Map<string, Shader>();
        this._uniforms = new Map<string, Map<string, {type: string, value: any}>>();
    }

    public static get Instance(): MaterialSystem {
        if (!MaterialSystem._instance)
            MaterialSystem._instance = new MaterialSystem();
        return MaterialSystem._instance;
    }

    public addShader(name: string, shader: Shader): void {
        this._shaders.set(name, shader);

        const uniforms = new Map<string, {type: string, value: any}>();

        for (const uniform of shader.uniforms) {
            const uniformName = uniform.name;
            const uniformType = uniform.type;
            let defaultValue;

            switch (uniformType) {
                case 'float':
                    defaultValue = 0.0;
                    break;
                case 'vec2':
                    defaultValue = vec2.create();
                    break;
                case 'vec3':
                    defaultValue = vec3.create();
                    break;
                case 'vec4':
                    defaultValue = vec4.create();
                    break;
                case 'mat4':
                    defaultValue = mat4.create();
                    break;
                case 'sampler2D':
                    defaultValue = 0;
                    break;
                default:
                    throw new Error(`Uniform type ${uniformType} not supported`);
            }

            uniforms.set(uniformName, {type: uniformType, value: defaultValue});
        }

        this._uniforms.set(name, uniforms);
        console.log(`Shader ${name} added with uniforms: `, uniforms);
    }

    public getShader(name: string): Shader {
        const shader = this._shaders.get(name);
        if (!shader) throw new Error(`Shader ${name} not found`);
        return shader;
    }

    public bind(name: string): void {
        const shader = this._shaders.get(name);
        if (!shader) throw new Error(`Shader ${name} not found`);
        shader.use();
    }

    public update(): void {
        for (const [name, uniforms] of this._uniforms) {
            const shader = this._shaders.get(name);
            if (!shader) throw new Error(`Shader ${name} not found`);

            for (const [uniformName, uniformValue] of uniforms) {
                shader.setUniform(uniformName, uniformValue.type, uniformValue.value);
            }
        }
    }

    public getUniforms(name: string): Map<string, {type: string, value: any}> {
        const uniforms = this._uniforms.get(name);
        if (!uniforms) throw new Error(`Shader ${name} not found`);
        return uniforms;
    }

    public setUniform(shaderName: string, uniformName: string, value: any): void {
        const uniforms = this._uniforms.get(shaderName);
        if (!uniforms) throw new Error(`Shader ${shaderName} not found`);

        const uniform = uniforms.get(uniformName);
        if (!uniform) throw new Error(`Uniform ${uniformName} not found`);

        this._uniforms.get(shaderName)?.set(uniformName, {type: uniform.type, value: value});
    }
}