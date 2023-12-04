import { DirectionalLight, Light } from "../../core/lighting";

export class LightingSystem {
    private static _instance: LightingSystem | null = null;
    private _lights: Light[] = [];
    private _directionalLight: DirectionalLight | null = null;

    private constructor() { }

    public addLight(light: Light): void {
        if (light instanceof DirectionalLight) {
            if (this._directionalLight) throw new Error("Directional light already added");
            this._directionalLight = light;
        }

        this._lights.push(light);
    }

    public static get Instance(): LightingSystem {
        if (!this._instance) {
            this._instance = new LightingSystem();
        }

        return this._instance;
    }

    public get directionalLight(): DirectionalLight | null { return this._directionalLight; }
}