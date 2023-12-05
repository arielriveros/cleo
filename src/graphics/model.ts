import { gl } from './renderer';
import { mat4, vec3 } from 'gl-matrix';
import { Mesh } from './mesh';
import { MaterialSystem } from './systems/materialSystem';
import { Material } from '../core/material';
import { Geometry } from '../core/geometry';


export class Model {
    private readonly  _geometry: Geometry;
    private readonly  _mesh: Mesh;
    private readonly  _material: Material;
    private readonly  _modelMatrix: mat4;

    private _position: vec3;
    private _rotation: vec3;
    private _scale: vec3;

    constructor(geometry: Geometry, material: Material) {
        this._geometry = geometry;
        this._material = material;

        this._mesh = new Mesh();

        this._modelMatrix = mat4.create();

        this._position = vec3.create();
        this._rotation = vec3.create();
        this._scale = vec3.fromValues(1, 1, 1);
    }

    public initialize(): void {
        const shader = MaterialSystem.Instance.getShader(this._material.type);
        this._mesh.initializeVAO(shader.attributes);
        const attributes = [];

        for (const attr of shader.attributes) {
            switch (attr.name) {
                case 'position':
                case 'a_position':
                    attributes.push('position');
                    break;
                case 'normal':
                case 'a_normal':
                    attributes.push('normal');
                    break;
                case 'uv':
                case 'a_uv':
                case 'texCoord':
                case 'a_texCoord':
                    attributes.push('uv');
                    break;
                default:
                    throw new Error(`Attribute ${attr.name} not supported`);
            }
        }

        this._mesh.create(this._geometry.getData(attributes), this._geometry.vertexCount, this._geometry.indices);
    }

    public draw(): void {
        const materialSys = MaterialSystem.Instance;

        materialSys.bind(this._material.type);

        // Set Transform releted uniforms on the model's shader type
        materialSys.setProperty('u_model', this.modelMatrix);

        // Set Material releted uniforms on the model's shader type
        for (const [name, value] of this._material.properties)
            materialSys.setProperty(`u_material.${name}`, value);

        // Update the material system before drawing the respective mesh
        materialSys.update();

        const materialConfig = this._material.config;

        switch(materialConfig.side) {
            case 'front':
                gl.enable(gl.CULL_FACE);
                gl.cullFace(gl.BACK);
                break;
            case 'back':
                gl.enable(gl.CULL_FACE);
                gl.cullFace(gl.FRONT);
                break;
            case 'double':
                gl.disable(gl.CULL_FACE);
                break;
        }

        this._mesh.draw();

        gl.disable(gl.CULL_FACE);
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