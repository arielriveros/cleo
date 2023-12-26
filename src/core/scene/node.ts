import { mat4, vec3 } from "gl-matrix";
import { Model } from "../../graphics/model";
import { DirectionalLight, Light, PointLight } from "../lighting";

export class Node {
    private readonly _name: string;
    private _parent: Node | null;
    private readonly _children: Node[];
    

    private readonly  _localTransform: mat4;
    private _worldTransform: mat4;

    private readonly _position: vec3;
    private readonly _rotation: vec3;
    private readonly _scale: vec3;

    constructor(name: string) {
        this._name = name;
        this._parent = null;
        this._children = [];

        this._localTransform = mat4.create();
        this._worldTransform = mat4.create();

        this._position = vec3.create();
        this._rotation = vec3.create();
        this._scale = vec3.fromValues(1, 1, 1);
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
        let posMat = mat4.create();
        let rotMat = mat4.create();
        let scaleMat = mat4.create();

        mat4.fromTranslation(posMat, this.position);
    
        let rotX = mat4.fromXRotation(mat4.create(), this.rotation[0]);
        let rotY = mat4.fromYRotation(mat4.create(), this.rotation[1]);
        let rotZ = mat4.fromZRotation(mat4.create(), this.rotation[2]);
        mat4.multiply(rotMat, rotX, rotZ);
        mat4.multiply(rotMat, rotMat, rotY);

        mat4.fromScaling(scaleMat, this.scale);

        mat4.multiply(this._localTransform, posMat, rotMat);
        return mat4.multiply(this._localTransform, this._localTransform, scaleMat);
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
        let pos = vec3.create();
        vec3.transformMat4(pos, pos, this.worldTransform);
        return pos;
    }

    public get position(): vec3 { return this._position; }
    public get rotation(): vec3 { return this._rotation; }
    public get scale(): vec3 { return this._scale; }
}

export class ModelNode extends Node {
    private _model: Model;
    private _initialized: boolean;

    constructor(name: string, model: Model) {
        super(name);
        this._model = model;
        this._initialized = false;
    }

    public get model(): Model { return this._model; }
    public get initialized(): boolean { return this._initialized; }
    public set initialized(value: boolean) { this._initialized = value; }
}

export class LightNode extends Node {
    private readonly _light: Light
    private readonly _type: 'directional' | 'point' | 'spot';
    private _index: number;

    constructor(name: string, light: Light) {
        super(name);
        this._light = light;
        this._index = -1;

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
}