interface MaterialConfig {
    side?: 'front' | 'back' | 'double';
    transparent?: boolean;
    castShadow?: boolean;
    wireframe?: boolean;
}

interface BasicProperties {
    color?: number[];
    texture?: string;
    opacity?: number;
}

interface DefaultProperties {
    diffuse?: number[];
    specular?: number[];
    ambient?: number[];
    emissive?: number[];
    shininess?: number;
    opacity?: number;
    reflectivity?: number;

    textures?: {
        base?: string;
        specular?: string;
        emissive?: string;
        normal?: string;
        mask?: string;
        reflectivity?: string;
    }
}

enum MaterialType {
    Basic = 'basic',
    Default = 'default'
}

export class Material {
    public type: MaterialType = MaterialType.Basic;
    public properties: Map<string, any>;
    public textures: Map<string, string>;
    public config: MaterialConfig;

    constructor(config?: MaterialConfig) {
        this.properties = new Map<string, any>();
        this.textures = new Map<string, string>();
        this.config = {
            side: config?.side || 'front',
            transparent: config?.transparent || false,
            castShadow: config?.castShadow || false,
            wireframe: config?.wireframe || false
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
            material.properties.set('reflectivity', properties.reflectivity || 0.0);

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

            material.properties.set('hasNormalMap', properties.textures?.normal ? true : false);

            if (properties.textures?.normal) {
                const tex = properties.textures.normal;
                material.textures.set('normalMap', tex);
            }

            material.properties.set('hasMaskMap', properties.textures?.mask ? true : false);

            if (properties.textures?.mask) {
                const tex = properties.textures.mask;
                material.textures.set('maskMap', tex);
            }

            material.properties.set('hasReflectivityMap', properties.textures?.reflectivity ? true : false);

            if (properties.textures?.reflectivity) {
                const tex = properties.textures.reflectivity;
                material.textures.set('reflectivityMap', tex);
            }

            return material;
    }
}