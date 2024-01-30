import { mat4, vec3, quat } from "gl-matrix";
import { Model } from "../../graphics/model";
import { Body } from "../../physics/body";
import { DirectionalLight, Light, PointLight } from "../../graphics/lighting";
import { ShaderManager } from "../../graphics/systems/shaderManager";
import { Scene } from "./scene";
import { v4 as uuidv4 } from 'uuid';

export class Node {
    protected readonly _id: string = uuidv4();
    protected readonly _name: string;
    protected _parent: Node | null;
    protected readonly _children: Node[];
    protected _scene: Scene | null;
    protected readonly _nodeType: 'node' | 'model' | 'light';
    
    protected readonly  _localTransform: mat4;
    protected _worldTransform: mat4;

    protected readonly _position: vec3;
    protected readonly _translationMatrix: mat4;

    protected readonly _quaternion: quat;
    protected readonly _rotationMatrix: mat4;

    protected readonly _scale: vec3;
    protected readonly _scaleMatrix: mat4;

    protected _markForRemoval: boolean = false;

    protected _body: Body | null;

    public onSpawn: (node: Node) => void = () => {};
    public onCollision: (node: Node, other: Node) => void = () => {};
    public onUpdate: (node: Node, delta: number, time: number) => void = () => {};
    public onChange: () => void = () => {};

    constructor(name: string, type: 'node' | 'model' | 'light' = 'node') {
        this._name = name;
        this._parent = null;
        this._children = [];
        this._scene = null;
        this._nodeType = type;

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
        node.onChange = this.onChange;
        node.onSpawn(node);
        if (this.scene) {
            node.scene = this.scene;
            for (const child of node.children)
                child.onSpawn(child);
        }
        this.onChange();
    }

    public removeChild(node: Node): void {
        node.parent = null;
        node.scene = null;
        this._children.splice(this._children.indexOf(node), 1);
        this.onChange();
    }

    public getChildByName(name: string): Node[] {
        const nodes: Node[] = [];
        for (const child of this._children)
            if (child.name === name)
                nodes.push(child);
        return nodes;
    }

    public getChildById = (id: string): Node | null => {
        for (const child of this._children)
            if (child.id === id)
                return child;
        return null;
    }

    public updateWorldTransform(): void {
        if (this._parent)
            mat4.multiply(this._worldTransform, this._parent.worldTransform, this.localTransform);

        for (const child of this._children)
            child.updateWorldTransform();
    }

    public remove(): void {
        this._markForRemoval = true;
        for (const child of this._children)
            child.remove();
    }

    public serialize(): Promise<any> {
        return new Promise((resolve, reject) => {
            Promise.all(this._children.map(child => child.serialize())).then(children => {
                resolve({
                    name: this._name,
                    type: this._nodeType,
                    position: [this._position[0], this._position[1], this._position[2]],
                    rotation: [this.rotation[0], this.rotation[1], this.rotation[2]],
                    scale: [this._scale[0], this._scale[1], this._scale[2]],
                    children: children
                });
            });
        });
    }

    public static parse(parent: Node, json: any) {
        const node = new Node(json.name, json.type);
        if (json.position)
            node.setPosition(json.position);
        if (json.rotation)
            node.setRotation(json.rotation);
        if (json.scale)
            node.setScale(json.scale);
        if (json.children) {
            for (const child of json.children) {
                if (child.type === 'model')
                    ModelNode.parse(node, child);
                else if (child.type === 'light')
                    LightNode.parse(node, child);
                else
                    Node.parse(node, child);
            }
        }
        
        parent.addChild(node);
    }

    public get id(): string { return this._id; }
    public get name(): string { return this._name; }
    public set parent(node: Node | null) { this._parent = node; }
    public get parent(): Node | null { return this._parent; }
    public get children(): Node[] { return this._children; }
    public get scene(): Scene | null { return this._scene; }
    public set scene(scene: Scene | null) {
        this._scene = scene;
        for (const child of this._children)
            child.scene = scene;
    }
    public get markForRemoval(): boolean { return this._markForRemoval; }

    public get localTransform(): mat4 {
        mat4.multiply(this._localTransform, this._translationMatrix, this._rotationMatrix);
        return mat4.multiply(this._localTransform, this._localTransform, this._scaleMatrix);
    }

    public get worldTransform(): mat4 {
        if (this._parent)
            return this._worldTransform;
        else
            return this.localTransform;
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
        if (this._body)
            this._body.setPosition(this._position);
        
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
        if (this._body)
            this._body.setQuaternion(this._quaternion);
        
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
        // TODO: when setting a non static body, detach from parent so that the body is not affected by the parent's transform
        
        this._body = new Body({
            mass: mass,
            position: vec3.transformMat4(vec3.create(), this._position, this._worldTransform),
            quaternion: this._quaternion,
            linearDamping: linearDamping,
            angularDamping: angularDamping
        }, this);

        return this._body;
    }

    public get position(): vec3 { return this._position; }
    public get rotation(): vec3 {
        // FIX: Some rotations are not correct
        let rotMat: mat4 = mat4.fromQuat(mat4.create(), this._quaternion);
        let out = vec3.create();
        let m11 = rotMat[0], m12 = rotMat[1], m13 = rotMat[2];
        let m21 = rotMat[4], m22 = rotMat[5], m23 = rotMat[6];
        let m31 = rotMat[8], m32 = rotMat[9], m33 = rotMat[10];


        out[1] = -Math.asin(Math.min(Math.max(m13, -1), 1));

        if (Math.abs(m13) < 0.99999) {
            out[0] = -Math.atan2(-m23, m33);
            out[2] = Math.atan2(-m12, m11);
        }
        else {
            out[0] = -Math.atan2(m32, m11);
            out[2] = 0;
        }

        out.forEach((value, index) => {
            // convert to degrees and reduce precision
            out[index] = Math.round(value * (180 / Math.PI) * 100) / 100;
        });

        return out;
    }

    public get quaternion(): quat { return this._quaternion; }
    public get scale(): vec3 { return this._scale; }
    public get nodeType(): string { return this._nodeType; }
}

export class ModelNode extends Node {
    private _model: Model;
    private _initialized: boolean;

    constructor(name: string, model: Model) {
        super(name, 'model');
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

    public serialize(): Promise<any> {
        return new Promise((resolve, reject) => {
            this._model.serialize().then(model => {
                Promise.all(this._children.map(child => child.serialize())).then(children => {
                    resolve({
                        name: this._name,
                        type: this._nodeType,
                        position: [this._position[0], this._position[1], this._position[2]],
                        rotation: [this.rotation[0], this.rotation[1], this.rotation[2]],
                        scale: [this._scale[0], this._scale[1], this._scale[2]],
                        children: children,
                        model: model
                    });
                });
            });
        });
    }

    public static parse(parent: Node, json: any) {
        const node = new ModelNode(json.name, Model.parse(json.model));
        node.setPosition(json.position);
        node.setRotation(json.rotation);
        node.setScale(json.scale);
        for (const child of json.children) {
            if (child.type === 'model')
                ModelNode.parse(node, child);
            else if (child.type === 'light')
                LightNode.parse(node, child);
            else
                Node.parse(node, child);
        }
        
        parent.addChild(node);
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
        super(name, 'light');
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

    public serialize(): Promise<any> {
        return new Promise((resolve, reject) => {
            let lightData = {};
            switch (this._type) {
                case 'directional':
                    lightData = {
                        diffuse: [this._light.diffuse[0], this._light.diffuse[1], this._light.diffuse[2]],
                        specular: [this._light.specular[0], this._light.specular[1], this._light.specular[2]],
                        ambient: [this._light.ambient[0], this._light.ambient[1], this._light.ambient[2]],
                    };
                    break;
                case 'point':
                    lightData = {
                        diffuse: [this._light.diffuse[0], this._light.diffuse[1], this._light.diffuse[2]],
                        specular: [this._light.specular[0], this._light.specular[1], this._light.specular[2]],
                        ambient: [this._light.ambient[0], this._light.ambient[1], this._light.ambient[2]],
                        linear: (this._light as PointLight).linear,
                        quadratic: (this._light as PointLight).quadratic
                    };
                    break;
                case 'spot':
                    lightData = {
                        diffuse: [this._light.diffuse[0], this._light.diffuse[1], this._light.diffuse[2]],
                        specular: [this._light.specular[0], this._light.specular[1], this._light.specular[2]],
                        ambient: [this._light.ambient[0], this._light.ambient[1], this._light.ambient[2]],
                        /* 
                        linear: (this._light as SpotLight).linear,
                        quadratic: (this._light as SpotLight).quadratic,
                        cutOff: (this._light as SpotLight).cutOff, */
                    };
                    break;
            }
            Promise.all(this._children.map(child => child.serialize())).then(children => {
                resolve({
                    name: this._name,
                    type: this._nodeType,
                    position: [this._position[0], this._position[1], this._position[2]],
                    rotation: [this.rotation[0], this.rotation[1], this.rotation[2]],
                    scale: [this._scale[0], this._scale[1], this._scale[2]],
                    children: children,
                    lightType: this._type,
                    light: lightData
                });
            });
        });
    }

    public static parse(parent: Node, json: any) {
        let light;
        switch (json.lightType) {
            case 'directional':
                light = new DirectionalLight({
                    diffuse: json.light.diffuse,
                    specular: json.light.specular,
                    ambient: json.light.ambient,
                });
                break;
            case 'point':
                light = new PointLight({
                    diffuse: json.light.diffuse,
                    specular: json.light.specular,
                    ambient: json.light.ambient,
                    linear: json.light.linear,
                    quadratic: json.light.quadratic
                });
                break;
            default:
                throw new Error(`Light ${json} of type ${json.type} not supported`);
        }
        const node = new LightNode(json.name, light, json.lightType === 'directional' ? true : false);
        node.setPosition(json.position);
        node.setRotation(json.rotation);
        node.setScale(json.scale);
        for (const child of json.children) {
            Node.parse(node, child);
        }
        
        parent.addChild(node);
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