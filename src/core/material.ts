import { Shader } from "../graphics/shader";
import { MaterialSystem } from "../graphics/systems/materialSystem";
import { Texture } from "../graphics/texture";

interface MaterialConfig {
    side?: 'front' | 'back' | 'double';
    transparent?: boolean;
}

interface BasicProperties {
    color?: number[];
    texture?: Texture;
    opacity?: number;
}

interface DefaultProperties {
    diffuse?: number[];
    specular?: number[];
    ambient?: number[];
    emissive?: number[];
    shininess?: number;
    opacity?: number;

    textures?: {
        base?: Texture;
        specular?: Texture;
        emissive?: Texture;
    }
}

enum MaterialType {
    Basic = 'basic',
    Default = 'default',
    Custom = 'custom'
}

export class Material {
    public type: MaterialType = MaterialType.Basic;
    public properties: Map<string, any>;
    public textures: Map<string, Texture>;
    public config: MaterialConfig;

    constructor(config?: MaterialConfig) {
        this.properties = new Map<string, any>();
        this.textures = new Map<string, Texture>();
        this.config = {
            side: config?.side || 'front',
            transparent: config?.transparent || false
        };
    }

    public static Basic( properties: BasicProperties, config?: MaterialConfig ): Material {
        const material = new Material(config);
        material.type = MaterialType.Basic;
        material.properties.set('color', properties.color || [1.0, 1.0, 1.0] );
        material.properties.set('opacity', properties.opacity || 1.0);

        material.properties.set('hasTexture', properties.texture ? true : false);

        if (properties.texture) {
            const tex = properties.texture;
            material.textures.set('texture', tex);
        }

        return material;
    }

    public static Default(properties: DefaultProperties, config?: MaterialConfig): Material {
            const material = new Material(config);
            material.type = MaterialType.Default;
            material.properties.set('diffuse', properties.diffuse || [1.0, 1.0, 1.0]);
            material.properties.set('specular', properties.specular || [1.0, 1.0, 1.0]);
            material.properties.set('ambient', properties.ambient || properties.diffuse || [1.0, 1.0, 1.0]);
            material.properties.set('emissive', properties.emissive || [0.0, 0.0, 0.0]);
            material.properties.set('shininess', properties.shininess || 32.0);
            material.properties.set('opacity', properties.opacity || 1.0);

            material.properties.set('hasBaseTexture', properties.textures?.base ? true : false);

            if (properties.textures?.base) {
                const tex = properties.textures.base;
                material.textures.set('baseTexture', tex);
            }

            material.properties.set('hasSpecularMap', properties.textures?.specular ? true : false);

            if (properties.textures?.specular) {
                const tex = properties.textures.specular;
                material.textures.set('specularMap', tex);
            }

            material.properties.set('hasEmissiveMap', properties.textures?.emissive ? true : false);

            if (properties.textures?.emissive) {
                const tex = properties.textures.emissive;
                material.textures.set('emissiveMap', tex);
            }

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