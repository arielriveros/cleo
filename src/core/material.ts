import { Shader } from "../graphics/shader";
import { MaterialSystem } from "../graphics/systems/materialSystem";

interface MaterialConfig {
    side?: 'front' | 'back' | 'double';
}

interface BasicProperties {
    color?: number[];
}

interface DefaultProperties {
    diffuse?: number[];
    specular?: number[];
    ambient?: number[];
    shininess?: number;
}

enum MaterialType {
    Basic = 'basic',
    Default = 'default',
    Custom = 'custom'
}

export class Material {
    public type: MaterialType = MaterialType.Basic;
    public properties: Map<string, any>;
    public config: MaterialConfig;

    constructor(config?: MaterialConfig) {
        this.properties = new Map<string, any>();
        this.config = {
            side: config?.side || 'double'
        };
    }

    public static Basic( properties: BasicProperties, config?: MaterialConfig ): Material {
        const material = new Material(config);
        material.type = MaterialType.Basic;
        material.properties.set('color', properties.color || [1.0, 1.0, 1.0] );
        return material;
    }

    public static Default(properties: DefaultProperties, config?: MaterialConfig): Material {
            const material = new Material(config);
            material.type = MaterialType.Default;
            material.properties.set('diffuse', properties.diffuse || [1.0, 1.0, 1.0]);
            material.properties.set('specular', properties.specular || [0.25, 0.25, 0.25]);
            material.properties.set('ambient', properties.ambient || properties.diffuse || [0.25, 0.25, 0.25]);
            material.properties.set('shininess', properties.shininess || 32.0);
            return material;
    }

    public static Custom(name: string, source: {vertexShader: string, fragmentShader: string }, properties: Map<string, any>, config?: MaterialConfig): Material {
        const material = new Material(config);
        material.type = MaterialType.Custom;
        material.properties = properties;

        const shader: Shader = new Shader();
        shader.createFromFiles(source.vertexShader, source.fragmentShader);

        MaterialSystem.Instance.addShader(name, shader);

        return material;
    }
}