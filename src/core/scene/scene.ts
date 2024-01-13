import { LightNode, ModelNode, Node } from "./node";

export class Scene {
    private _root: Node;
    private _nodes: Set<Node>;
    private _lights: Set<LightNode>;
    private _models: Set<ModelNode>;
    private _dirty: boolean = true;

    // TODO: Move this to a LightManager class
    private _numPointLights: number;

    constructor() {
        this._root = new Node('root');
        this._nodes = new Set();
        this._lights = new Set();
        this._models = new Set();

        // TODO: Move this to a LightManager class
        this._numPointLights = 0;
    }

    public addNode(node: Node): void {
        this._root.addChild(node);
        this._dirty = true;
    }

    public removeNode(node: Node): void {
        if (node.parent)
            node.parent.children.splice(node.parent.children.indexOf(node), 1);
        node.parent = null;
        this._dirty = true;
    }

    public removeNodeByName(name: string): void {
        const node = this.getNode(name);
        if (node) {
            this.removeNode(node);
            this._dirty = true;
        }
    }

    public attachNode(node: Node, parent: string): void {
        const parentNode = this.getNode(parent);
        if (parentNode)
            parentNode.addChild(node);
        
        this._dirty = true;
    }

    public update(): void {
        if (this._dirty) {
            this.breadthFirstTraversal();
            for (const node of this._nodes)
                if (node instanceof LightNode)
                    this._asignLightIndices();
        }
        for (const node of this._nodes)
            node.update();
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

        this._lights = new Set();
        this._models = new Set();
        for (const node of this._nodes) {
            if (node instanceof LightNode)
                this._lights.add(node);
            if (node instanceof ModelNode)
                this._models.add(node);
        }
    }
 
    public getNode(name: string): Node | undefined {
        if (this._dirty)
            this.breadthFirstTraversal();
        for (const node of this._nodes) {
            if (node.name === name)
                return node;
        }
        return undefined;
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

    // TODO: Move this to a LightManager class
    public get numPointLights(): number { return this._numPointLights; }
}