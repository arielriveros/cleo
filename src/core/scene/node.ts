import { mat4, vec3 } from "gl-matrix";
import { Model } from "../../graphics/model";

export class Node {
    private _name: string;
    private _parent: Node | null;
    private _children: Node[];
    private _initialized: boolean;

    private readonly  _localTransform: mat4;
    private _worldTransform: mat4;

    private _position: vec3;
    private _rotation: vec3;
    private _scale: vec3;

    constructor(name: string) {
        this._name = name;
        this._parent = null;
        this._children = [];
        this._initialized = false;

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
    public get initialized(): boolean { return this._initialized; }
    public set initialized(value: boolean) { this._initialized = value; }

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

    public get position(): vec3 { return this._position; }
    public get rotation(): vec3 { return this._rotation; }
    public get scale(): vec3 { return this._scale; }
}

export class ModelNode extends Node {
    private _model: Model;

    constructor(name: string, model: Model) {
        super(name);
        this._model = model;
    }

    public get model(): Model { return this._model; }
}