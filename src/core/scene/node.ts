import { mat4, vec3, quat } from "gl-matrix";
import { Model } from "../../graphics/model";
import { DirectionalLight, Light, PointLight } from "../lighting";
import { Body } from "../../physics/body";
import { ShaderManager } from "../../graphics/systems/shaderManager";

export class Node {
    private readonly _name: string;
    private _parent: Node | null;
    private readonly _children: Node[];
    
    private readonly  _localTransform: mat4;
    private _worldTransform: mat4;

    private readonly _position: vec3;
    private readonly _translationMatrix: mat4;

    private readonly _quaternion: quat;
    private readonly _rotationMatrix: mat4;

    private readonly _scale: vec3;
    private readonly _scaleMatrix: mat4;

    private _body: Body | null;

    constructor(name: string) {
        this._name = name;
        this._parent = null;
        this._children = [];

        this._localTransform = mat4.create();
        this._worldTransform = mat4.create();

        this._position = vec3.create();
        this._translationMatrix = mat4.create();

        this._quaternion = quat.create();
        this._rotationMatrix = mat4.create();

        this._scale = vec3.fromValues(1, 1, 1);
        this._scaleMatrix = mat4.create();

        this._body = null;
    }

    public addChild(node: Node): void {
        node.parent = this;
        this._children.push(node);
    }

    public update(): void {
        if (this._parent)
            mat4.multiply(this._worldTransform, this._parent.worldTransform, this.localTransform);
        else
            this._worldTransform = this.localTransform; 

        for (const child of this._children)
            child.update();
    }

    public get name(): string { return this._name; }
    public get parent(): Node | null { return this._parent; }
    public get children(): Node[] { return this._children; }
    

    public set parent(node: Node | null) { this._parent = node; }

    public get localTransform(): mat4 {
        mat4.multiply(this._localTransform, this._translationMatrix, this._rotationMatrix);
        return mat4.multiply(this._localTransform, this._localTransform, this._scaleMatrix);
    }

    public get worldTransform(): mat4 {
        return this._worldTransform;
    }

    public get forward(): vec3 {
        // transpose(inverse(worldTransform))
        let rotTransform = mat4.create();
        if (this._parent)
            mat4.multiply(this._worldTransform, this._parent.worldTransform, this.localTransform);
        else
            this._worldTransform = this.localTransform;
        mat4.transpose(rotTransform, this.worldTransform);
        mat4.invert(rotTransform, rotTransform);
        let forward = vec3.fromValues(0, 0, 1);
        vec3.transformMat4(forward, forward, rotTransform);
        vec3.normalize(forward, forward);
        return forward;
    }

    public get worldPosition(): vec3 {
        return vec3.transformMat4(vec3.create(), vec3.create(), this.worldTransform);
    }

    public setX(value: number): Node {
        this._position[0] = value;
        this._updateTranslationMatrix();
        return this;
    }

    public addX(value: number): Node {
        this._position[0] += value;
        this._updateTranslationMatrix();
        return this;
    }

    public setY(value: number): Node {
        this._position[1] = value;
        this._updateTranslationMatrix();
        return this;
    }

    public addY(value: number): Node {
        this._position[1] += value;
        this._updateTranslationMatrix();
        return this;
    }

    public setZ(value: number): Node {
        this._position[2] = value;
        this._updateTranslationMatrix();
        return this;
    }

    public addZ(value: number): Node {
        this._position[2] += value;
        this._updateTranslationMatrix();
        return this;
    }

    public setPosition(pos: vec3): Node {
        vec3.copy(this._position, pos);
        this._updateTranslationMatrix();
        return this;
    }

    private _updateTranslationMatrix(): void {
        mat4.fromTranslation(this._translationMatrix, this._position);
    }

    public rotateX(value: number): Node {
        this._rotateOnAxis([1, 0, 0], value * Math.PI / 180);
        return this;
    }

    public rotateY(value: number): Node {
        this._rotateOnAxis([0, 1, 0], value * Math.PI / 180);
        return this;
    }

    public rotateZ(value: number): Node {
        this._rotateOnAxis([0, 0, 1], value * Math.PI / 180);
        return this;
    }

    public setRotation(value: vec3): Node {
        quat.fromEuler(this._quaternion, value[0], value[1], value[2]);
        this._updateRotationMatrix();
        return this;
    }

    public setQuaternion(quaternion: quat): Node {
        quat.copy(this._quaternion, quaternion);
        this._updateRotationMatrix();
        return this;
    }

    private _rotateOnAxis(axis: vec3, value: number): void {
        const q = quat.create();
        quat.setAxisAngle(q, axis, value);
        quat.multiply(this._quaternion, q, this._quaternion);
        this._updateRotationMatrix();
    }

    private _updateRotationMatrix(): void {
        mat4.fromQuat(this._rotationMatrix, this._quaternion);
    }

    public setXScale(value: number): Node {
        this._scale[0] = value;
        this._updateScaleMatrix();
        return this;
    }

    public addXScale(value: number): Node {
        this._scale[0] += value;
        this._updateScaleMatrix();
        return this;
    }

    public setYScale(value: number): Node {
        this._scale[1] = value;
        this._updateScaleMatrix();
        return this;
    }

    public addYScale(value: number): Node {
        this._scale[1] += value;
        this._updateScaleMatrix();
        return this;
    }

    public setZScale(value: number): Node {
        this._scale[2] = value;
        this._updateScaleMatrix();
        return this;
    }

    public addZScale(value: number): Node {
        this._scale[2] += value;
        this._updateScaleMatrix();
        return this;
    }

    public setScale(scale: vec3): Node {
        vec3.copy(this._scale, scale);
        this._updateScaleMatrix();
        return this;
    }

    public setUniformScale(value: number): Node {
        vec3.set(this._scale, value, value, value);
        this._updateScaleMatrix();
        return this;
    }

    private _updateScaleMatrix(): void {
        mat4.fromScaling(this._scaleMatrix, this._scale);
    }


    public get body(): Body | null { return this._body; }
    public setBody(mass: number, linearDamping?: number, angularDamping?: number): Body {
        // when setting a non static body, detach from parent so that the body is not affected by the parent's transform
        if (this._parent && mass > 0) {
            this._parent.children.splice(this._parent.children.indexOf(this), 1);
            this._parent = null;
        }
        
        this._body = new Body({ 
            name: this._name,
            mass: mass,
            position: this._position,
            quaternion: this._quaternion,
            linearDamping: linearDamping,
            angularDamping: angularDamping,
        });

        return this._body;
    }
}

export class ModelNode extends Node {
    private _model: Model;
    private _initialized: boolean;

    constructor(name: string, model: Model) {
        super(name);
        this._model = model;
        this._initialized = false;
    }

    public initializeModel(): void {
        const shader = ShaderManager.Instance.getShader(this._model.material.type);
        this._model.mesh.initializeVAO(shader.attributes);
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
                case 'tangent':
                case 'a_tangent':
                    attributes.push('tangent');
                    break;
                case 'bitangent':
                case 'a_bitangent':
                    attributes.push('bitangent');
                    break;
                default:
                    throw new Error(`Attribute ${attr.name} not supported`);
            }
        }

        this._model.mesh.create(this._model.geometry.getData(attributes), this._model.geometry.vertexCount, this._model.geometry.indices);
        this._initialized = true;
    }

    public get model(): Model { return this._model; }
    public get initialized(): boolean { return this._initialized; }
}

export class LightNode extends Node {
    private readonly _light: Light
    private readonly _type: 'directional' | 'point' | 'spot';
    private _index: number;
    private _lightSpace: mat4;
    private _castShadows: boolean;

    constructor(name: string, light: Light, castShadows: boolean = false) {
        super(name);
        this._light = light;
        this._index = -1;
        this._lightSpace = mat4.create();
        this._castShadows = castShadows;

        if (light instanceof DirectionalLight)
            this._type = 'directional';
        else if (light instanceof PointLight)
            this._type = 'point';
        else
            throw new Error("Light type not supported");
    }

    public get light(): Light { return this._light; }
    public get type(): 'directional' | 'point' | 'spot' { return this._type; }
    public get index(): number { return this._index; }
    public set index(value: number) { this._index = value; }
    public get lightSpace(): mat4 {
        const lightView = mat4.create();
        const lightProjection = mat4.create();
        const lightPos = vec3.scale(vec3.create(), this.forward, -50);
        if (this._type === 'directional') {
            // TODO: Change look at position to be the center of where the camera is looking
            mat4.lookAt(lightView, lightPos, [0, 0, 0], [0, 1, 0]);
            mat4.ortho(lightProjection, -20, 20, -20, 20, 0.1, 100);
        }
        return mat4.multiply(this._lightSpace, lightProjection, lightView);
    }
    public get castShadows(): boolean { return this._castShadows; }
    public set castShadows(value: boolean) { this._castShadows = value; }
}