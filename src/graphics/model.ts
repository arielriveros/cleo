import { Material } from './material';
import { Mesh } from './mesh';
import { mat4, quat, vec3 } from 'gl-matrix';


export class Model {
    private readonly  _mesh: Mesh;
    private readonly  _material: Material;
    private readonly  _modelMatrix: mat4;

    private _position: vec3;
    private _rotation: vec3;
    private _scale: vec3;

    constructor(mesh: Mesh, material: Material) {
        this._mesh = mesh;
        this._material = material;

        this._modelMatrix = mat4.create();

        this._position = vec3.create();
        this._rotation = vec3.create();
        this._scale = vec3.fromValues(1, 1, 1);
    }

    public draw(): void {
        this._mesh.draw();
    }

    public get mesh(): Mesh { return this._mesh; }
    public get material(): Material { return this._material; }
    public get modelMatrix(): mat4 {
        let posMat = mat4.create();
        let rotMat = mat4.create();
        let scaleMat = mat4.create();

        mat4.fromTranslation(posMat, this.position);
    
        let rotX = mat4.fromXRotation(mat4.create(), this.rotation[0]);
        let rotY = mat4.fromYRotation(mat4.create(), this.rotation[1]);
        let rotZ = mat4.fromZRotation(mat4.create(), this.rotation[2]);
        mat4.multiply(rotMat, rotX, rotY);
        mat4.multiply(rotMat, rotMat, rotZ);

        mat4.fromScaling(scaleMat, this.scale);

        mat4.multiply(this._modelMatrix, posMat, rotMat);
        return mat4.multiply(this._modelMatrix, this._modelMatrix, scaleMat);
    }

    public get position(): vec3 { return this._position; }
    public get rotation(): vec3 { return this._rotation; }
    public get scale(): vec3 { return this._scale; }
}