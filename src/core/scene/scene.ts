import { Node } from "./node";

export class Scene {
    private _root: Node;

    constructor() {
        this._root = new Node('root');
    }

    public addNode(node: Node): void {
        this._root.addChild(node);
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
}