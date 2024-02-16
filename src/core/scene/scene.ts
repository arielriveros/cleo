import { Texture, TextureManager } from "../../cleo";
import { LightNode, ModelNode, Node, SkyboxNode } from "./node";

export class Scene {
    private _root: Node = new Node('root');
    private _nodes: Set<Node>;
    private _lights: Set<LightNode>;
    private _models: Set<ModelNode>;
    private _skybox: SkyboxNode | null;
    private _environmentMap: Texture | null = null;
    private _dirty: boolean = true;
    private _hasStarted: boolean = false;

    // TODO: Move this to a LightManager class
    private _numPointLights: number;
    public onChange: ((scene: Scene) => void) | null;

    constructor() {
        this._root.scene = this;
        this._root.onChange = this._onChange.bind(this);
        this._nodes = new Set();
        this._lights = new Set();
        this._models = new Set();
        this._skybox = null;

        // TODO: Move this to a LightManager class
        this._numPointLights = 0;

        this.onChange = null;
    }

    public start(): void {
        if (this._hasStarted) return;

        // TODO: Store the initial state of the scene and allow to reset it
        for (const node of this._nodes)
            node.start();

        this._hasStarted = true;
    }

    public stop(): void {
        this._hasStarted = false;
        // TODO: Reset the initial state of the scene
    }

    public addNode(node: Node): void {
        node.scene = this;
        this._root.addChild(node);
        /* for (const child of node.children)
            child.scene = this; */
    }

    public addNodes(...nodes: Node[]): void {
        for (const node of nodes)
            this.addNode(node);
    }

    public removeNode(node: Node): void {
        this._root.removeChild(node);
    }

    public removeNodeByName(name: string): void {
        const nodesToRemove = this.getNodesByName(name);
        if (nodesToRemove.length > 0) {
            for (const node of nodesToRemove)
                this.removeNode(node);
        }
    }

    public update(delta: number, time: number): void {
        if (this._dirty) {
            this.breadthFirstTraversal();
            for (const node of this._nodes)
                if (node instanceof LightNode)
                    this._asignLightIndices();
        }
        for (const node of this._nodes) {
            if (node.markForRemoval) {
                this.removeNode(node);
                continue;
            }
            node.updateWorldTransform();
            if (this._hasStarted && node.onUpdate)
                node.onUpdate(node, delta, time);
        }
    }
    
    public breadthFirstTraversal(): void {
        const visited: Set<Node> = new Set();
        const queue: Node[] = [];

        visited.add(this._root);
        queue.push(this._root);

        while (queue.length > 0) {
            const current = queue.shift() as Node;

            for (const child of current.children) {
                if (!visited.has(child)) {
                    visited.add(child);
                    queue.push(child);
                }
            }
        }

        this._nodes = visited;
        this._dirty = false;

        this._filterByType();
    }

    private _filterByType(): void {
        // This seems unoptimized, TODO: Fix later
        this._lights = new Set();
        this._models = new Set();
        this._skybox = null;
        for (const node of this._nodes) {
            if (node instanceof LightNode)
                this._lights.add(node);
            if (node instanceof ModelNode)
                this._models.add(node);
            if (node instanceof SkyboxNode)
                this._skybox = node;
        }
    }
 
    public getNodesByName(name: string): Node[] {
        if (this._dirty)
            this.breadthFirstTraversal();

        const nodes: Node[] = [];
        for (const node of this._nodes) {
            if (node.name === name)
                nodes.push(node);
        }

        return nodes;
    }

    public getNodeById(id: string): Node | undefined {
        if (this._dirty)
            this.breadthFirstTraversal();
        for (const node of this._nodes) {
            if (node.id === id)
                return node;
        }
        return undefined;
    }

    public serialize(storeTextures: boolean = true): Promise<any> {
        const output: {scene: any, textures: any} = {scene: {}, textures: {}};
        return new Promise((resolve, reject) => {
            this._root.serialize().then((json: any) => {
                output.scene = json;
                if (storeTextures)
                    output.textures = TextureManager.Instance.serializeTextureData();
                resolve(output);
            });
        });
    }

    public parse(json: any, loadTextures: boolean = true): void {
        // change the root node entirely not just its children
        let newScene = new Node('root');
        newScene.scene = this;
        newScene.onChange = this._onChange.bind(this);
        Node.parse(newScene, json.scene);
        if (loadTextures)
            for (const texture of json.textures)
                TextureManager.Instance.addTextureFromBase64(texture.data, texture.config, texture.id);
        this._dirty = true;
        this._root = newScene.getChildByName('root')[0] as Node;
    }

    // TODO: Move this to a LightManager class
    private _asignLightIndices(): void {
        const nodes = this.nodes;
        let pointLights = 0;
        for (const node of nodes) {
            if (node instanceof LightNode) {
                if (node.type === 'point') {
                    node.index = pointLights;
                    pointLights++;
                }
            }
        }
        this._numPointLights = pointLights;
    }

    private _onChange() {
        this._dirty = true;
        if (this.onChange)
            this.onChange(this);
    }

    public get root(): Node { return this._root; }

    public get nodes(): Set<Node> {
        if (this._dirty)
            this.breadthFirstTraversal();
        return this._nodes;
    }

    public get lights(): Set<LightNode> {
        if (this._dirty)
            this.breadthFirstTraversal();
        return this._lights;
    }

    public get models(): Set<ModelNode> {
        if (this._dirty)
            this.breadthFirstTraversal();
        return this._models;
    }

    public get skybox(): SkyboxNode | null {
        if (this._dirty)
            this.breadthFirstTraversal();
        return this._skybox;
    }

    public get environmentMap(): Texture | null { return this._environmentMap; }
    public set environmentMap(envMapTex: Texture | null) { this._environmentMap = envMapTex; }

    // TODO: Move this to a LightManager class
    public get numPointLights(): number { return this._numPointLights; }
}