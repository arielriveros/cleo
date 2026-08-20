import { Tilemap } from "../../../graphics/tilemap/tilemap";
import { Terrain, TerrainLodSettings } from "../../../terrain/terrain";
import type { Scene } from "../scene";
import { vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { ModelNode } from "./modelNode";
import { Node } from "./node";

/**
 * Terrain: owns a `Terrain` and the generated render chunks it subdivides into.
 */

const TERRAIN_ATTRIBUTES = ['position', 'normal', 'uv', 'tangent', 'bitangent'];

/**
 * Scene node for a sculptable heightfield terrain. Owns a `Terrain` (heights + physics) and wraps each
 * of its render chunks in a child ModelNode. The chunk children are NOT serialized (they are rebuilt from
 * the compact terrain blob on load), so save/play stay small. Deforming the terrain (sculpt/import) flags
 * chunks dirty; `update()` re-uploads the affected chunk meshes to the GPU once they are initialized.
 */
export class LandscapeNode extends Node {
    private _terrain: Terrain;
    private _chunkNodes: ModelNode[] = [];

    constructor(name: string, terrain: Terrain, id: string = uuidv4()) {
        super(name, 'landscape', id);
        this._terrain = terrain;
        this._buildChunkNodes();
    }

    private _buildChunkNodes(): void {
        this._chunkNodes = [];
        for (let i = 0; i < this._terrain.chunks.length; i++) {
            const node = new ModelNode(`__terrain_chunk__${i}`, this._terrain.chunks[i].model);
            this._chunkNodes.push(node);
            this.addChild(node);
        }
    }

    public get terrain(): Terrain { return this._terrain; }

    /** Swap in a rebuilt terrain (e.g. resized/re-resolutioned) while keeping this node + its transform.
     *  Disposes the old physics body and replaces the internal chunk child nodes. */
    public setTerrain(terrain: Terrain): void {
        this._terrain.dispose();
        for (const c of this._chunkNodes) this.removeChild(c);
        this._chunkNodes = [];
        this._terrain = terrain;
        this._terrain.setOrigin(this.worldPosition);
        this._buildChunkNodes();
    }

    public update(delta: number, time: number): void {
        super.update(delta, time);
        // Keep the terrain's origin in sync with the node so sculpting/collision follow the node.
        this._terrain.setOrigin(this.worldPosition);
        const chunks = this._terrain.chunks;
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const node = this._chunkNodes[i];
            if (chunk.dirty && node && node.initialized) {
                chunk.model.mesh.updateVertexData(chunk.model.geometry.getData(TERRAIN_ATTRIBUTES));
                chunk.dirty = false;
            }
        }
    }

    /**
     * Pick each chunk's detail level for this camera position (called once per frame by the renderer,
     * before any pass, so the shadow maps draw the reduced terrain too). The coarse index buffers are
     * uploaded lazily on first use and re-built only when the configured vertex steps change; they index
     * the chunk's existing vertex buffer, so this never interferes with sculpting's vertex re-uploads.
     */
    public updateLod(camPos: vec3, settings: TerrainLodSettings): void {
        const chunks = this._terrain.chunks;
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const node = this._chunkNodes[i];
            if (!node || !node.initialized) continue; // mesh not created yet: draws full-res this frame
            const mesh = chunk.model.mesh;

            if (!settings.enabled) {
                chunk.lod = 0;
                mesh.activeLod = 0;
                continue;
            }
            const steps = chunk.lodSteps;
            if (!steps || steps[0] !== settings.step1 || steps[1] !== settings.step2) {
                mesh.setLodIndices([
                    this._terrain.buildLodIndices(chunk, settings.step1),
                    this._terrain.buildLodIndices(chunk, settings.step2),
                ]);
                chunk.lodSteps = [settings.step1, settings.step2];
            }
            chunk.lod = this._terrain.lodFor(chunk, camPos, settings);
            mesh.activeLod = chunk.lod;
        }
    }

    public getBoundingBox(): { min: vec3, max: vec3 } {
        const p = this.worldPosition;
        const half = this._terrain.size / 2;
        const heights = this._terrain.heights;
        let minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < heights.length; i++) {
            if (heights[i] < minY) minY = heights[i];
            if (heights[i] > maxY) maxY = heights[i];
        }
        if (!isFinite(minY)) { minY = 0; maxY = 0; }
        return {
            min: vec3.fromValues(p[0] - half, p[1] + minY - 0.1, p[2] - half),
            max: vec3.fromValues(p[0] + half, p[1] + maxY + 0.1, p[2] + half),
        };
    }

    /** The generated terrain chunks are children in the live tree but are rebuilt from the blob on parse. */
    protected _serializableChildren(): Node[] {
        return this._children.filter(c => !this._chunkNodes.includes(c as ModelNode));
    }

    protected _serializePayload(): any {
        return { terrain: this._terrain.serialize() };
    }

    public static parse(parent: Node, json: any) {
        const terrain = Terrain.deserialize(json.terrain);
        const node = new LandscapeNode(json.name, terrain, json.id);
        Node.finishParse(node, parent, json);
    }
}

/**
 * Scene node for a 2D tilemap. Owns a {@link Tilemap} (cells, layers, embedded tilesets and the static
 * colliders derived from them) positioned on the XY plane at this node's world position.
 *
 * Unlike LandscapeNode, the render chunks are NOT wrapped in child ModelNodes. Doing so would put every
 * chunk into `scene.models`, where the deferred geometry pass would rasterize it as opaque lit geometry
 * and the raycaster would pick it cell by cell. The tilemap owns its chunk meshes directly and the
 * renderer reaches them through `scene.tilemaps`, which also means this node has no internal children to
 * filter out when it serializes.
 */
