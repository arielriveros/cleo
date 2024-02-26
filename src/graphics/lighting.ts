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
    public set diffuse(value: vec3) { this._diffuse = value; }
    public get specular(): vec3 { return this._specular; }
    public set specular(value: vec3) { this._specular = value; }
    public get ambient(): vec3 { return this._ambient; }
    public set ambient(value: vec3) { this._ambient = value; }
}

export class DirectionalLight extends Light{
    constructor(properties: LightProperties) {
        super(properties);
    }
}

export interface PointLightProperties extends LightProperties {
    constant?: number;
    linear?: number;
    quadratic?: number;
}

export class PointLight extends Light {
    private _constant: number;
    private _linear: number;
    private _quadratic: number;

    constructor(properties: PointLightProperties) {
        super(properties);
        this._constant = properties.constant || 1.0;
        this._linear = properties.linear || 0.09;
        this._quadratic = properties.quadratic || 0.032;
    }

    public get constant(): number { return this._constant; }
    public set constant(value: number) { this._constant = value; }
    public get linear(): number { return this._linear; }
    public set linear(value: number) { this._linear = value; }
    public get quadratic(): number { return this._quadratic; }
    public set quadratic(value: number) { this._quadratic = value; }
}

export interface SpotlightProperties extends PointLightProperties {
    cutOff?: number;
    outerCutOff?: number;
}

export class Spotlight extends Light {
    private _constant: number;
    private _linear: number;
    private _quadratic: number;
    private _cutOff: number;
    private _outerCutOff: number;

    constructor(properties: SpotlightProperties) {
        super(properties);
        this._constant = properties.constant || 1.0;
        this._linear = properties.linear || 0.09;
        this._quadratic = properties.quadratic || 0.032;
        this._cutOff = properties.cutOff || 30.5;
        this._outerCutOff = properties.outerCutOff || 35.5;
    }

    public get constant(): number { return this._constant; }
    public set constant(value: number) { this._constant = value; }
    public get linear(): number { return this._linear; }
    public set linear(value: number) { this._linear = value; }
    public get quadratic(): number { return this._quadratic; }
    public set quadratic(value: number) { this._quadratic = value; }
    public get cutOff(): number { return this._cutOff; }
    public set cutOff(value: number) { this._cutOff = value; }
    public get outerCutOff(): number { return this._outerCutOff; }
    public set outerCutOff(value: number) { this._outerCutOff = value; }
}