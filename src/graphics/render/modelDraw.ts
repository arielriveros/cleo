import { AnimatedModel } from '../../animation/animatedModel';
import { ModelNode } from '../../core/scene/nodes/modelNode';
import { Material, CustomMaterial } from '../material';
import type { RenderPassEncoder } from '../rhi/device';
import type { CullMode } from '../rhi/types';
import { customShaderReady } from '../systems/customShaders';
import type { PassEncoder } from './passEncoder';
import type { MaterialBinder } from './materialBinder';
import { ShaderManager } from '../systems/shaderManager';

/** `count` identity matrices, packed. */
function identityPalette(count: number): Float32Array {
    const out = new Float32Array(count * 16);
    for (let i = 0; i < count; i++) out[i * 16] = out[i * 16 + 5] = out[i * 16 + 10] = out[i * 16 + 15] = 1;
    return out;
}

/**
 * The pieces every model draw shares, whichever pass it is in: the submesh loop that binds each
 * range's material, the skinning palette upload, the material-side to cull-mode mapping, and the
 * stable object ids the draw sort and instancing keys are built from. Split out of Renderer.
 */
export class ModelDraw {
    private readonly _shaderManager = ShaderManager.Instance;

    constructor(private readonly _passes: PassEncoder,
                private readonly _materials: MaterialBinder) {}

    public specularAaEnabled: boolean = true;

    // Reused scratch to avoid per-frame allocations
    public boneMatrixScratch: Float32Array = new Float32Array(100 * 16);
    /** Preallocated identity bone matrices, uploaded for an animated model that has no animator. */
    public readonly boneIdentityScratch: Float32Array = identityPalette(100);

    // Object -> stable id (for grouping identical mesh+material into instanced draws)
    private _objIds: WeakMap<object, number> = new WeakMap();
    private _objIdCounter: number = 0;

    /**
     * `Material.config.side` as a cull mode. The mapping INVERTS: `side: 'front'` means show the front
     * faces, so the BACK ones are culled.
     */
    public static cullFor(side: 'front' | 'back' | 'double' | undefined): CullMode {
        if (side === 'double') return 'none';
        return side === 'back' ? 'front' : 'back';
    }

    // Whether this material has a program behind it at all. Checked HERE rather than in a bind
    // callback: those return false to mean "use the legacy `mesh.draw()`", which is a raw `gl` call.
    private static _drawable(mat: Material): boolean {
        return !(mat instanceof CustomMaterial) || customShaderReady(mat);
    }

    // Draw a model's index buffer, applying `bindMaterial` before each range. The single-material case
    // takes the same path with one range.
    public drawSubmeshes(node: ModelNode, bindMaterial: (material: Material) => boolean | void,
                           pass?: RenderPassEncoder): void {
        const model = node.model;
        if (!model.hasSubmeshes) {
            const mat = model.material;
            if (!ModelDraw._drawable(mat)) return;
            // A callback that set a PIPELINE has already fixed the cull mode; calling _materials.applyCull after
            // it would be harmless today and wrong the moment the two disagree.
            const viaPipeline = !!bindMaterial(mat);
            if (!viaPipeline) this._materials.applyCull(mat.config.side);
            if (viaPipeline && pass && this._passes.recordDraw(pass, model.mesh, 0, 0)) return;
            model.mesh.draw(mat.config.wireframe ? 'line-list' : 'triangle-list');
            return;
        }
        const submeshes = model.submeshes;
        for (let i = 0; i < submeshes.length; i++) {
            // `materials` is parallel to `submeshes` by construction, but indexing it unguarded turns any
            // future disagreement into a mid-frame TypeError rather than a wrong colour. Slot 0 always exists.
            const mat = model.materials[i] ?? model.materials[0];
            if (!ModelDraw._drawable(mat)) continue;
            const viaPipeline = !!bindMaterial(mat);
            if (!viaPipeline) this._materials.applyCull(mat.config.side);
            if (viaPipeline && pass
                && this._passes.recordDraw(pass, model.mesh, submeshes[i].start, submeshes[i].count)) continue;
            model.mesh.drawRange(submeshes[i].start, submeshes[i].count,
                mat.config.wireframe ? 'line-list' : 'triangle-list');
        }
    }

    public objectId(obj: object): number {
        let id = this._objIds.get(obj);
        if (id === undefined) { id = this._objIdCounter++; this._objIds.set(obj, id); }
        return id;
    }

    /**
     * Upload the skinning palette. By NAME, never a cached location: `getUniformLocation` returns null
     * for a std140 block member, which is indistinguishable from "this shader has no bones".
     */
    public uploadBoneMatrices(shaderType: string, node: ModelNode): void {
        const animatedModel = node.model as AnimatedModel;
        if (animatedModel.hasSkin && node.animator) {
            const boneMatrices = node.animator.getFinalBoneMatrices();
            const scratch = this.boneMatrixScratch;
            const n = Math.min(100, boneMatrices.length);
            for (let i = 0; i < n; i++) scratch.set(boneMatrices[i], i * 16);
            this._shaderManager.setUniform('u_boneMatrices', scratch.subarray(0, 100 * 16));
        } else {
            this._shaderManager.setUniform('u_boneMatrices', this.boneIdentityScratch);
        }
    }
}
