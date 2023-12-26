import { LightNode, Node } from "./node";

export class Scene {
    private _root: Node;
    private _numPointLights: number = 0;

    constructor() {
        this._root = new Node('root');
    }

    public addNode(node: Node): void {
        this._root.addChild(node);
        if (node instanceof LightNode)
            this._asignLightIndices();
    }

    public attachNode(node: Node, parent: string): void {
        const parentNode = this.getNode(parent);
        if (parentNode)
            parentNode.addChild(node);

        if (node instanceof LightNode)
            this._asignLightIndices();
    }

    public get nodes(): Set<Node> {
        const visited: Set<Node> = new Set();
        const queue: Node[] = [];

        visited.add(this._root);
        queue.push(this._root);

        while (queue.length > 0) {
            const current = queue.shift() as Node;

            for (const child of current.children) {
                if (!visited.has(child)) {
                    child.update();
                    visited.add(child);
                    queue.push(child);
                }
            }
        }

        return visited;
    }

    public getNode(name: string): Node | null {
        const visited: Set<Node> = new Set();
        const queue: Node[] = [];

        visited.add(this._root);
        queue.push(this._root);

        while (queue.length > 0) {
            const current = queue.shift() as Node;

            if (current.name === name)
                return current;

            for (const child of current.children) {
                if (!visited.has(child)) {
                    visited.add(child);
                    queue.push(child);
                }
            }
        }

        return null;
    }

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

    public get numPointLights(): number { return this._numPointLights; }
}