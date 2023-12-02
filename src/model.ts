import { Material } from './material';
import { Mesh } from './mesh';

export class Model {
    private _mesh: Mesh;
    private _material: Material;

    constructor(mesh: Mesh, material: Material) {
        this._mesh = mesh;
        this._material = material;
    }

    public draw(): void {
        this._mesh.draw();
    }

    public get mesh(): Mesh { return this._mesh; }
    public get material(): Material { return this._material; }
}