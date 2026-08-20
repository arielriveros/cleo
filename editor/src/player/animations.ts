// Attaching a published game's SHARED animation clips to the characters that use them.
//
// A clip resolved from a shared `.anim` asset is not written into any serialized node — see
// `AnimatedModel.serialize`, which drops any clip carrying an `assetId`. Without that, a walk shared by
// two characters would ship once per character AND once per placement of each. So the game data instead
// carries the clips ONCE, in their source rig's space (`data.animations`), plus which model asset uses
// which (`data.modelAnimations`), and they are retargeted onto each character here, at scene load.
//
// The retarget is the same engine code the editor uses; the cost is one pass per (model, animation) pair
// for the whole session, memoised below, not one per placement.

import {
  AnimatedModel, ModelNode, buildBoneMapping, retargetAnimation, Logger,
  type Animation, type Node, type Scene, type Skin,
} from 'cleo';
import { mat4 } from 'gl-matrix';

/** Mirrors editor/src/utils/models.ts. Serialized into every placed model instance's `variables`. */
const MODEL_ID_VAR = '__modelId';
const LEGACY_MODEL_ID_VAR = '__meshId';

export type PublishedAnimations = {
  /** Shared clips, in SOURCE-rig space, with the skeleton they were authored against. */
  animations?: { id: string; name: string; clips: Animation[]; sourceSkin: any }[];
  /** model asset id -> the animation asset ids it plays. */
  modelAnimations?: Record<string, string[]>;
};

function toMat4(a: number[]): any {
  const m = mat4.create();
  for (let i = 0; i < 16 && i < a.length; i++) m[i] = a[i];
  return m;
}

/** Rebuild a live Skin from the flattened form the asset stores (Maps do not survive JSON). */
function loadSkin(stored: any): Skin | null {
  if (!stored) return null;
  return {
    name: stored.name,
    joints: (stored.joints ?? []).map((j: any) => ({
      nodeIndex: j.nodeIndex,
      inverseBindMatrix: toMat4(j.inverseBindMatrix ?? []),
      parentIndex: j.parentIndex,
    })),
    skeleton: stored.skeleton,
    nodeParents: new Map(stored.nodeParents ?? []),
    nodeTransforms: new Map((stored.nodeTransforms ?? []).map(([k, v]: [number, number[]]) => [k, toMat4(v)])),
    nodeNames: new Map(stored.nodeNames ?? []),
  } as Skin;
}

/** The model-asset id a node belongs to — its own, or the nearest ancestor's. */
function modelIdOf(node: Node | null | undefined): string | undefined {
  for (let n: any = node; n; n = n.parent) {
    const id = n.getVariable?.(MODEL_ID_VAR) ?? n.getVariable?.(LEGACY_MODEL_ID_VAR);
    if (id) return id as string;
  }
  return undefined;
}

/**
 * Resolve a game's shared animations onto every placed character in `scene`.
 *
 * Safe to call for a game with no shared animations (every published build before this existed): it
 * returns immediately when the data carries none.
 */
export function attachSharedAnimations(scene: Scene, data: PublishedAnimations): void {
  const assets = data.animations;
  const byModel = data.modelAnimations;
  if (!assets?.length || !byModel) return;

  const assetById = new Map(assets.map(a => [a.id, a]));
  // (model asset id -> clips), computed once per model however many placements it has.
  const perModel = new Map<string, Animation[]>();
  let attached = 0;

  for (const node of Array.from(scene.nodes)) {
    if (!(node instanceof ModelNode)) continue;
    const model: any = node.model;
    if (!(model instanceof AnimatedModel) || !model.hasSkin || !model.skin) continue;

    const modelId = modelIdOf(node);
    if (!modelId) continue;
    const ids = byModel[modelId];
    if (!ids?.length) continue;

    let clips = perModel.get(modelId);
    if (!clips) {
      clips = [];
      for (const id of ids) {
        const asset = assetById.get(id);
        if (!asset) continue;
        const sourceSkin = loadSkin(asset.sourceSkin);
        if (!sourceSkin) { clips.push(...asset.clips.map(c => ({ ...c }))); continue; }
        try {
          // One mapping per asset — every clip in it shares the source skeleton.
          const mapping = buildBoneMapping(asset.clips, sourceSkin, model.skin as Skin);
          for (const c of asset.clips) clips.push(retargetAnimation(c, sourceSkin, model.skin as Skin, mapping));
        } catch (e) {
          Logger.warn(`Could not retarget "${asset.name}" onto model ${modelId}: ${e}`, 'Player');
        }
      }
      perModel.set(modelId, clips);
    }
    for (const clip of clips) model.addAnimation({ ...clip });
    attached++;
  }

  if (attached) Logger.info(`shared animations attached to ${attached} model node(s)`, 'Player');
}
