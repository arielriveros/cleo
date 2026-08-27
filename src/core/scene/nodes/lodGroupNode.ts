import { Terrain } from "../../../terrain/terrain";
import { vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { ModelNode } from "./modelNode";
import { Node } from "./node";

/**
 * Distance-based level-of-detail switching over its own children.
 */

export class LodGroupNode extends Node {
    public distances: number[] = [0];
    public cullDistance: number = 0;

    private _activeLod: number = 0;
    private _distanceCulled: boolean = false;

    constructor(name: string, id: string = uuidv4()) {
        super(name, 'lodGroup', id);
    }

    public get activeLod(): number { return this._activeLod; }
    public get distanceCulled(): boolean { return this._distanceCulled; }

    // Show exactly the active level, or nothing while distance-culled.
    private _applyActiveLod(): void {
        for (let i = 0; i < this._children.length; i++)
            this._children[i].setLodVisible(!this._distanceCulled && i === this._activeLod);
    }

    /**
     * Pick the level from the camera's distance to the *surface* of the group's bounding sphere.
     * Thresholds carry ×0.9 hysteresis: coarsen and cull immediately, refine only once inside it.
     */
    public updateLod(camPos: vec3): void {
        if (this._children.length === 0) return;

        const sphere = this.getBoundingSphere();
        const d = Math.max(0, vec3.distance(camPos, sphere.center) - sphere.radius);

        const culled = this.cullDistance > 0 &&
            (this._distanceCulled ? d > this.cullDistance * 0.9 : d > this.cullDistance);
        if (culled !== this._distanceCulled) {
            this._distanceCulled = culled;
            this._applyActiveLod();
        }
        if (culled) return;

        let target = 0;
        for (let i = Math.min(this._children.length, this.distances.length) - 1; i > 0; i--) {
            if (d >= this.distances[i]) { target = i; break; }
        }
        if (target > this._activeLod ||
            (target < this._activeLod && d < this.distances[this._activeLod] * 0.9)) {
            this._activeLod = target;
            this._applyActiveLod();
        }
    }

    /**
     * Union of the level-0 subtree's ModelNode spheres. Level 0 is the authored mesh, so its bound
     * serves the whole group. Uses the shared per-frame _worldSphere cache.
     */
    public getBoundingSphere(): { center: vec3; radius: number } {
        if (!this._worldSphereDirty) return this._worldSphere;

        let found = false;
        const center = vec3.create();
        let radius = 0;
        const merge = (s: { center: vec3; radius: number }) => {
            if (!found) { vec3.copy(center, s.center); radius = s.radius; found = true; return; }
            const dist = vec3.distance(center, s.center);
            if (dist + s.radius <= radius) return;              // s inside current
            if (dist + radius <= s.radius) {                    // current inside s
                vec3.copy(center, s.center); radius = s.radius; return;
            }
            const newRadius = (dist + radius + s.radius) / 2;
            vec3.lerp(center, center, s.center, (newRadius - radius) / dist);
            radius = newRadius;
        };
        const visit = (node: Node) => {
            if (node instanceof ModelNode) merge(node.getBoundingSphere());
            for (const child of node.children) visit(child);
        };
        if (this._children[0]) visit(this._children[0]);
        if (!found) return super.getBoundingSphere();

        vec3.copy(this._worldSphere.center, center);
        this._worldSphere.radius = radius;
        this._worldSphereDirty = false;
        return this._worldSphere;
    }

    protected _serializePayload(): any {
        return {
                    distances: [...this.distances],
                    cullDistance: this.cullDistance,
        };
    }

    public static parse(parent: Node, json: any) {
        const node = new LodGroupNode(json.name, json.id);
        node.distances = Array.isArray(json.distances) && json.distances.length ? json.distances.map(Number) : [0];
        node.cullDistance = typeof json.cullDistance === 'number' ? json.cullDistance : 0;
        Node.finishParse(node, parent, json);
    }

    protected _afterParse(_json: any): void {
        this._applyActiveLod(); // children exist only after finishParse: start showing level 0
    }
}
