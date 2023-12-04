import { vec3 } from "gl-matrix";

interface LightProperties {
    diffuse?: vec3;
    specular?: vec3;
    ambient?: vec3;
}

export class Light {
    private _diffuse: vec3;
    private _specular: vec3;
    private _ambient: vec3;

    constructor(properties: LightProperties) {
        this._diffuse = properties.diffuse || vec3.fromValues(1.0, 1.0, 1.0);
        this._specular = properties.specular || vec3.fromValues(1.0, 1.0, 1.0);
        this._ambient = properties.ambient || vec3.fromValues(0.1, 0.1, 0.1);
    }

    public get diffuse(): vec3 { return this._diffuse; }
    public get specular(): vec3 { return this._specular; }
    public get ambient(): vec3 { return this._ambient; }
}

interface DirectionalLightProperties extends LightProperties{
    direction?: vec3;
}

export class DirectionalLight extends Light{
    private _direction: vec3;

    constructor(properties: DirectionalLightProperties) {
        super(properties);
        this._direction = properties.direction || vec3.fromValues(0.0, -1.0, 0.0);
    }

    public get direction(): vec3 { return this._direction; }
}