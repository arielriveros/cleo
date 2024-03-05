import { CleoEngine, Texture, TextureManager } from "../../cleo";
import { CameraNode, LightNode, ModelNode, Node, SkyboxNode, SpriteNode } from "./node";
import { Logger } from '../logger'

export class Scene {
    private _root: Node = new Node('root');
    private _nodes: Set<Node>;
    private _cameras: Set<CameraNode>;
    private _lights: Set<LightNode>;
    private _models: Set<ModelNode>;
    private _sprites: Set<SpriteNode>;
    private _skybox: SkyboxNode | null;
    private _environmentMap: Texture | null = null;
    private _dirty: boolean = true;
    private _hasStarted: boolean = false;

    // TODO: Move this to a LightManager class
    private _numPointLights: number;
    private _numSpotlights: number;

    constructor() {
        this._root.scene = this;
        this._nodes = new Set();
        this._lights = new Set();
        this._models = new Set();
        this._sprites = new Set();
        this._skybox = null;

        // TODO: Move this to a LightManager class
        this._numPointLights = 0;
        this._numSpotlights = 0;

        CleoEngine.eventEmitter.on('SCENE_CHANGED', () => this._onChange());
    }

    public start(): void {
        if (this._hasStarted) return;
        Logger.info('Scene starting');
        
        this._root.start();
        
        this._hasStarted = true;
    }

    public stop(): void {
        this._hasStarted = false;
        Logger.info('Scene stopped');
    }

    public addNode(node: Node): void {
        node.scene = this;
        this._root.addChild(node);
    }

    public addNodes(...nodes: Node[]): void {
        for (const node of nodes)
            this.addNode(node);
    }

    public removeNode(node: Node): void {
        this._root.removeChild(node);
    }

    public removeNodesByName(name: string): void {
        const nodesToRemove = this.getNodesByName(name);
        if (nodesToRemove.length > 0) {
            for (const node of nodesToRemove)
                this.removeNode(node);
        }
    }

    public removeNodeById(id: string): void {
        const nodeToRemove = this.getNodeById(id);
        if (nodeToRemove)
            this.removeNode(nodeToRemove);
    }

    public update(delta: number, time: number, paused: boolean): void {
        try {
            this._root.updateTransforms();
            for (const node of this._nodes) {
                if (node instanceof LightNode) this._asignLightIndices();
    
                if (node.markForRemoval) {
                    this.removeNode(node);
                    continue;
                }
                
                if (this._hasStarted && !paused)
                    node.update(delta, time);
            }
        } catch (e) {
            Logger.error(e);
        }
    }
    
    private _breadthFirstTraversal(): void {
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
        this._cameras = new Set();
        this._lights = new Set();
        this._models = new Set();
        this._sprites = new Set();
        this._skybox = null;
        for (const node of this._nodes) {
            if (node instanceof LightNode)
                this._lights.add(node);
            if (node instanceof ModelNode)
                this._models.add(node);
            if (node instanceof SpriteNode)
                this._sprites.add(node);
            if (node instanceof SkyboxNode)
                this._skybox = node;
            if (node instanceof CameraNode)
                this._cameras.add(node);
        }
    }
 
    public getNodesByName(name: string): Node[] {
        if (this._dirty)
            this._breadthFirstTraversal();

        const nodes: Node[] = [];
        for (const node of this._nodes) {
            if (node.name === name)
                nodes.push(node);
        }

        return nodes;
    }

    public getNodeById(id: string): Node | undefined {
        if (this._dirty)
            this._breadthFirstTraversal();
        for (const node of this._nodes) {
            if (node.id === id)
                return node;
        }
        return undefined;
    }

    public serialize(useCache: boolean = false): Promise<any> {
        const output: {scene: any, textures: any} = {scene: {}, textures: {}};
        return new Promise((resolve, reject) => {
            this._root.serialize().then((json: any) => {
                output.scene = json;
                if (!useCache)
                    output.textures = TextureManager.Instance.serializeTextureData();
                resolve(output);
            });
        });
    }

    public parse(json: any, useCache: boolean = false): void {
        // change the root node entirely not just its children
        let newScene = new Node('root');
        newScene.scene = this;
        Node.parse(newScene, json.scene);
        if (!useCache)
            for (const texture of json.textures)
                TextureManager.Instance.addTextureFromBase64(texture.data, texture.config, texture.id);
        this._dirty = true;
        this._root = newScene.getChildByName('root')[0] as Node;
    }

    // TODO: Move this to a LightManager class
    private _asignLightIndices(): void {
        const nodes = this.nodes;
        let pointLights = 0;
        let spotlights = 0;
        for (const node of nodes) {
            if (node instanceof LightNode) {
                if (node.type === 'point') {
                    node.index = pointLights;
                    pointLights++;
                }

                if (node.type === 'spotlight') {
                    node.index = spotlights;
                    spotlights++;
                }
            }
        }
        this._numPointLights = pointLights;
        this._numSpotlights = spotlights;
    }

    private _onChange() {
        this._dirty = true;
    }

    public get root(): Node { return this._root; }

    public get nodes(): Set<Node> {
        if (this._dirty)
            this._breadthFirstTraversal();
        return this._nodes;
    }

    public get activeCamera(): CameraNode {
        if (this._dirty)
            this._breadthFirstTraversal();
        for (const camera of this._cameras)
            if (camera.active)
                return camera;
    }

    public get lights(): Set<LightNode> {
        if (this._dirty)
            this._breadthFirstTraversal();
        return this._lights;
    }

    public get models(): Set<ModelNode> {
        if (this._dirty)
            this._breadthFirstTraversal();
        return this._models;
    }

    public get sprites(): Set<SpriteNode> {
        if (this._dirty)
            this._breadthFirstTraversal();
        return this._sprites;
    }

    public get skybox(): SkyboxNode | null {
        if (this._dirty)
            this._breadthFirstTraversal();
        return this._skybox;
    }

    public get environmentMap(): Texture | null { return this._environmentMap; }
    public set environmentMap(envMapTex: Texture | null) { this._environmentMap = envMapTex; }

    // TODO: Move this to a LightManager class
    public get numPointLights(): number { return this._numPointLights; }
    public get numSpotlights(): number { return this._numSpotlights; }
}