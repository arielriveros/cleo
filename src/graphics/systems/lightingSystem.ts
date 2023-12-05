import { DirectionalLight, Light } from "../../core/lighting";
import { MaterialSystem } from "./materialSystem";

export class LightingSystem {
    private static _instance: LightingSystem | null = null;
    private _lights: Light[] = [];
    private _directionalLight: DirectionalLight | null = null;
    private _lightsUpdated: boolean = false;
    
    private constructor() { }
    
    public addLight(light: Light): void {
        if (light instanceof DirectionalLight) {
            if (this._directionalLight) throw new Error("Directional light already added");
            this._directionalLight = light;
        }
        
        this._lights.push(light);
        this._lightsUpdated = true;
    }
    public update() {

        const materialSys = MaterialSystem.Instance;

        if (this._directionalLight) {
            materialSys.setProperty('u_dirLight.diffuse', this._directionalLight.diffuse);
            materialSys.setProperty('u_dirLight.specular', this._directionalLight.specular);
            materialSys.setProperty('u_dirLight.ambient', this._directionalLight.ambient);
            materialSys.setProperty('u_dirLight.direction', this._directionalLight.direction);
        }
    }

    public static get Instance(): LightingSystem {
        if (!this._instance) {
            this._instance = new LightingSystem();
        }

        return this._instance;
    }

    public get directionalLight(): DirectionalLight | null { return this._directionalLight; }
}