import { Shader } from './shader';

export class Material {
    private _type: 'basic' | 'lit' = 'basic';
    public diffuse: number[];
    public specular: number[];
    public shininess: number;

    constructor() {
        this.diffuse = [1.0, 1.0, 1.0];
        this.specular = [1.0, 1.0, 1.0];
        this.shininess = 32.0;
    }

    public static Basic(color: number[] = [1.0, 1.0, 1.0]): Material {
        const material = new Material();
        material._type = 'basic';
        material.diffuse = color;
        return material;
    }

    public static Lit(diffuse: number[] = [1.0, 1.0, 1.0], specular: number[]= [1.0, 1.0, 1.0], shininess: number = 32.0): Material {
        const material = new Material();
        material._type = 'lit';
        material.diffuse = diffuse;
        material.specular = specular;
        material.shininess = shininess;
        return material;
    }
}