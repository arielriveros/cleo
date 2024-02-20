import { mat4, vec3, quat } from "gl-matrix";
import { Body } from "../../physics/body";
import { Model } from "../../graphics/model";
import { DirectionalLight, Light, PointLight } from "../../graphics/lighting";
import { Skybox } from "../../graphics/skybox";
import { ShaderManager } from "../../graphics/systems/shaderManager";
import { Scene } from "./scene";
import { v4 as uuidv4 } from 'uuid';
import { Camera } from "../camera";

type NodeType = 'node' | 'model' | 'light' | 'skybox' | 'camera';

export class Node {
    protected readonly _id: string;
    protected readonly _name: string;
    protected _parent: Node | null;
    protected readonly _children: Node[];
    protected _scene: Scene | null;
    protected readonly _nodeType: NodeType;
    
    protected readonly  _localTransform: mat4;
    protected _worldTransform: mat4;

    protected readonly _position: vec3;
    protected readonly _translationMatrix: mat4;

    protected readonly _quaternion: quat;
    protected readonly _euler: vec3;
    protected readonly _rotationMatrix: mat4;

    protected readonly _scale: vec3;
    protected readonly _scaleMatrix: mat4;

    protected _hasStarted: boolean = false;
    protected _markForRemoval: boolean = false;

    protected _body: Body | null;

    public onStart: (node: Node) => void = (node: Node) => {};
    public onSpawn: (node: Node) => void = (node: Node) => {};
    public onUpdate: (node: Node, delta: number, time: number) => void = (node: Node, delta: number, time: number) => {};
    public onCollision: (node: Node, other: Node) => void = () => {};
    public onChange: () => void = () => {};

    constructor(name: string, type: NodeType = 'node', id: string = uuidv4()) {
        this._name = name;
        this._id = id;
        this._parent = null;
        this._children = [];
        this._scene = null;
        this._nodeType = type;

        this._localTransform = mat4.create();
        this._worldTransform = mat4.create();

        this._position = vec3.create();
        this._translationMatrix = mat4.create();

        this._euler = vec3.create();
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
        if (this._hasStarted)
            node.start();
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

    public start(): void {
        this._hasStarted = true;
        this.onStart(this);
        for (const child of this._children)
            child.start();
    }
    public update(delta: number, time: number): void {
        this.onUpdate(this, delta, time);
    }

    public serialize(): Promise<any> {
        return new Promise((resolve, reject) => {
            Promise.all(this._children.map(child => child.serialize())).then(children => {
                resolve({
                    id: this._id,
                    name: this._name,
                    type: this._nodeType,
                    position: [this._position[0], this._position[1], this._position[2]],
                    rotation: [this.rotation[0], this.rotation[1], this.rotation[2]],
                    scale: [this._scale[0], this._scale[1], this._scale[2]],
                    children: children,
                    scripts: {
                        // TODO: Only serialize the function body
                        onStart: this.onStart.toString(),
                        onSpawn: this.onSpawn.toString(),
                        onUpdate: this.onUpdate.toString()
                    }
                });
            });
        });
    }

    public static parse(parent: Node, json: any) {
        const node = new Node(json.name, json.type, json.id);
        node.onChange = parent.onChange;
        node.setPosition(json.position);
        node.setRotation(json.rotation);
        node.setScale(json.scale);
        if (json.scripts) {
            if (json.scripts.start)
                node.onStart = new Function('node', json.scripts.start) as (node: Node) => void
            if (json.scripts.spawn)
                node.onSpawn = new Function('node', json.scripts.spawn) as (node: Node) => void
            if (json.scripts.update)
                node.onUpdate = new Function('node', 'delta', 'time', json.scripts.update) as (node: Node, delta: number, time: number) => void
        }

        if (json.children) {
            for (const child of json.children) {
                if (child.type === 'model')
                    ModelNode.parse(node, child);
                else if (child.type === 'light')
                    LightNode.parse(node, child);
                else if (child.type === 'skybox')
                    SkyboxNode.parse(node, child);
                else if (child.type === 'camera')
                    CameraNode.parse(node, child);
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
    public get hasStarted(): boolean { return this._hasStarted; }
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
        let forward = vec3.fromValues(0, 0, 1);
        vec3.transformMat4(forward, forward, this._rotationMatrix);
        return forward;
    }

    public get worldPosition(): vec3 {
        return vec3.transformMat4(vec3.create(), vec3.create(), this.worldTransform);
    }

    public get worldForward(): vec3 {
        let wForward = vec3.add(vec3.create(), this.worldPosition, this.forward);
        return wForward;
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

    public addForward(value: number) {
        vec3.add(this._position, this._position, vec3.scale(vec3.create(), this.forward, value));
        this._updateTranslationMatrix();
    }

    public addRight(value: number) {
        // normalize forward vector
        vec3.normalize(this.forward, this.forward);
        // normalize right vector
        let right = vec3.cross(vec3.create(), this.forward, vec3.fromValues(0, 1, 0));
        vec3.normalize(right, right);
        // move along right vector
        vec3.add(this._position, this._position, vec3.scale(vec3.create(), right, value));
        this._updateTranslationMatrix();
    }

    public addUp(value: number) {
        vec3.normalize(this.forward, this.forward);
        let right = vec3.cross(vec3.create(), this.forward, vec3.fromValues(0, 1, 0));
        vec3.normalize(right, right);
        let up = vec3.cross(vec3.create(), right, this.forward);
        vec3.normalize(up, up);
        vec3.add(this._position, this._position, vec3.scale(vec3.create(), up, value));
        this._updateTranslationMatrix();
    }

    private _updateTranslationMatrix(): void {
        if (this._body)
            this._body.setPosition(this._position);
        
        mat4.fromTranslation(this._translationMatrix, this._position);
    }

    public rotateX(value: number): Node {
        this._euler[0] += value;
        this._updateRotationMatrix();
        return this;
    }
    
    public rotateY(value: number): Node {
        this._euler[1] += value;
        this._updateRotationMatrix();
        return this;
    }
    
    public rotateZ(value: number): Node {
        this._euler[2] += value;
        this._updateRotationMatrix();
        return this;
    }
    
    public setRotation(value: vec3): Node {
        vec3.copy(this._euler, value);
        this._updateRotationMatrix();
        return this;
    }

    public setQuaternion(quaternion: quat): Node {
        quat.copy(this._quaternion, quaternion);
        mat4.fromQuat(this._rotationMatrix, this._quaternion);
        return this;
    }
    
    private _updateRotationMatrix(): void {
        quat.fromEuler(this._quaternion, this._euler[0], this._euler[1], this._euler[2]);
        if (this._body) this._body.setQuaternion(this._quaternion);
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
    public get rotation(): vec3 { return this._euler; }

    public get quaternion(): quat { return this._quaternion; }
    public get scale(): vec3 { return this._scale; }
    public get nodeType(): string { return this._nodeType; }
}

export class ModelNode extends Node {
    private _model: Model;
    private _initialized: boolean;

    constructor(name: string, model: Model, id: string = uuidv4()) {
        super(name, 'model', id);
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
            const model = this._model.serialize()
            Promise.all(this._children.map(child => child.serialize())).then(children => {
                resolve({
                    name: this._name,
                    id: this._id,
                    type: this._nodeType,
                    position: [this._position[0], this._position[1], this._position[2]],
                    rotation: [this.rotation[0], this.rotation[1], this.rotation[2]],
                    scale: [this._scale[0], this._scale[1], this._scale[2]],
                    children: children,
                    model: model
                });
            });
        });
    }

    public static parse(parent: Node, json: any) {
        const node = new ModelNode(json.name, Model.parse(json.model), json.id);
        node.setPosition(json.position);
        node.setRotation(json.rotation);
        node.setScale(json.scale);
        if (json.scripts) {
            if (json.scripts.start)
                node.onStart = new Function('node', json.scripts.start) as (node: Node) => void
            if (json.scripts.spawn)
                node.onSpawn = new Function('node', json.scripts.spawn) as (node: Node) => void
            if (json.scripts.update)
                node.onUpdate = new Function('node', 'delta', 'time', json.scripts.update) as (node: Node, delta: number, time: number) => void
        }
        if (json.children) {
            for (const child of json.children) {
                if (child.type === 'model')
                    ModelNode.parse(node, child);
                else if (child.type === 'light')
                    LightNode.parse(node, child);
                else if (child.type === 'skybox')
                    SkyboxNode.parse(node, child);
                else if (child.type === 'camera')
                    CameraNode.parse(node, child);
                else
                    Node.parse(node, child);
            }
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

    constructor(name: string, light: Light, castShadows: boolean = false, id: string = uuidv4()) {
        super(name, 'light', id);
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
                    id: this._id,
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
        const node = new LightNode(json.name, light, json.lightType === 'directional' ? true : false, json.id);
        node.setPosition(json.position);
        node.setRotation(json.rotation);
        node.setScale(json.scale);
        if (json.scripts) {
            if (json.scripts.start)
                node.onStart = new Function('node', json.scripts.start) as (node: Node) => void
            if (json.scripts.spawn)
                node.onSpawn = new Function('node', json.scripts.spawn) as (node: Node) => void
            if (json.scripts.update)
                node.onUpdate = new Function('node', 'delta', 'time', json.scripts.update) as (node: Node, delta: number, time: number) => void
        }
        if (json.children) {
            for (const child of json.children) {
                if (child.type === 'model')
                    ModelNode.parse(node, child);
                else if (child.type === 'light')
                    LightNode.parse(node, child);
                else if (child.type === 'skybox')
                    SkyboxNode.parse(node, child);
                else if (child.type === 'camera')
                    CameraNode.parse(node, child);
                else
                    Node.parse(node, child);
            }
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

export class SkyboxNode extends Node {
    private readonly _skybox: Skybox
    private _initialized: boolean;

    constructor(name: string, skybox: Skybox, id: string = uuidv4()) {
        super(name, 'skybox', id);
        this._skybox = skybox;
        this._initialized = false;
    }

    public initializeSkybox(): void {
        this._skybox.mesh.initializeVAO(ShaderManager.Instance.getShader('skybox').attributes);
        this._skybox.mesh.create(this._skybox.box.getData(['position']), this._skybox.box.indices.length, this._skybox.box.indices);
        this._initialized = true;
    }

    public static parse(parent: Node, json: any) {
        Skybox.fromBase64({
            posX: json.skybox.faces.positiveX,
            negX: json.skybox.faces.negativeX,
            posY: json.skybox.faces.positiveY,
            negY: json.skybox.faces.negativeY,
            posZ: json.skybox.faces.positiveZ,
            negZ: json.skybox.faces.negativeZ
        }).then(skybox => {
            const node = new SkyboxNode(json.name, skybox, json.id);
            node.setPosition(json.position);
            node.setRotation(json.rotation);
            node.setScale(json.scale);
            if (json.scripts) {
                if (json.scripts.start)
                    node.onStart = new Function('node', json.scripts.start) as (node: Node) => void
                if (json.scripts.spawn)
                    node.onSpawn = new Function('node', json.scripts.spawn) as (node: Node) => void
                if (json.scripts.update)
                    node.onUpdate = new Function('node', 'delta', 'time', json.scripts.update) as (node: Node, delta: number, time: number) => void
            }
            if (json.children) {
                for (const child of json.children) {
                    if (child.type === 'model')
                        ModelNode.parse(node, child);
                    else if (child.type === 'light')
                        LightNode.parse(node, child);
                    else if (child.type === 'skybox')
                        SkyboxNode.parse(node, child);
                    else if (child.type === 'camera')
                        CameraNode.parse(node, child);
                    else
                        Node.parse(node, child);
                }
            }
            
            parent.addChild(node);
        });
    }

    public serialize(): Promise<any> {
        return new Promise((resolve, reject) => {
            const skybox = this._skybox.serialize()
            Promise.all(this._children.map(child => child.serialize())).then(children => {
                resolve({
                    name: this._name,
                    id: this._id,
                    type: this._nodeType,
                    position: [this._position[0], this._position[1], this._position[2]],
                    rotation: [this.rotation[0], this.rotation[1], this.rotation[2]],
                    scale: [this._scale[0], this._scale[1], this._scale[2]],
                    children: children,
                    skybox: skybox
                });
            });
        });
    }

    public get skybox(): Skybox { return this._skybox; }
    public get initialized(): boolean { return this._initialized; }
}

export class CameraNode extends Node {
    private readonly _camera: Camera;
    private _active: boolean;

    constructor(name: string, camera: Camera, id: string = uuidv4()) {
        super(name, 'camera', id);
        this._camera = camera;
        this._active = true;
    }

    public update(delta: number, time: number): void {
        super.update(delta, time);
        this._camera.position = this.worldPosition;
        this._camera.eye = this.worldForward;
    }

    public static parse(parent: Node, json: any) {
        const node = new CameraNode(json.name, new Camera({
            fov: json.camera.fov,
            near: json.camera.near,
            far: json.camera.far
        }), json.id);
        node.setPosition(json.position);
        node.setRotation(json.rotation);
        node.setScale(json.scale);
        node.active = json.active;
        if (json.scripts) {
            if (json.scripts.start)
                node.onStart = new Function('node', json.scripts.start) as (node: Node) => void
            if (json.scripts.spawn)
                node.onSpawn = new Function('node', json.scripts.spawn) as (node: Node) => void
            if (json.scripts.update)
                node.onUpdate = new Function('node', 'delta', 'time', json.scripts.update) as (node: Node, delta: number, time: number) => void
        }
        if (json.children) {
            for (const child of json.children) {
                if (child.type === 'model')
                    ModelNode.parse(node, child);
                else if (child.type === 'light')
                    LightNode.parse(node, child);
                else if (child.type === 'skybox')
                    SkyboxNode.parse(node, child);
                else if (child.type === 'camera')
                    CameraNode.parse(node, child);
                else
                    Node.parse(node, child);
            }
        }
        
        parent.addChild(node);
    }

    public serialize(): Promise<any> {
        return new Promise((resolve, reject) => {
            Promise.all(this._children.map(child => child.serialize())).then(children => {
                resolve({
                    name: this._name,
                    id: this._id,
                    type: this._nodeType,
                    position: [this._position[0], this._position[1], this._position[2]],
                    rotation: [this.rotation[0], this.rotation[1], this.rotation[2]],
                    scale: [this._scale[0], this._scale[1], this._scale[2]],
                    children: children,
                    camera: {
                        fov: this._camera.fov,
                        near: this._camera.near,
                        far: this._camera.far
                    },
                    active: this._active
                });
            });
        });
    }

    public get camera(): Camera { return this._camera; }
    public get active(): boolean { return this._active; }
    public set active(value: boolean) { this._active = value; }
}