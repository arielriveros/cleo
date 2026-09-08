// Attaching a published game's SHARED animation clips to the characters that use them.
// Clips ship once in their source rig's space (`data.animations`) plus which model asset uses which
// (`data.modelAnimations`), and are retargeted onto each character at scene load, memoised per model.

import {
  AnimatedModel, ModelNode, buildBoneMapping, applyManualMapping, retargetAnimation, Logger,
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
  /**
   * Manual bone re-points, resolved at pack time: model asset id -> animation asset id -> the corrections
   * to apply after the automatic match.
   *
   * The editor stores these on the target RIG keyed by source rig (see `RigAsset.retargets`); publish
   * flattens that to the pair the player can actually index, the same way it flattens a rig's skeleton into
   * each animation's `sourceSkin`. Optional and additive — an older player simply retargets automatically,
   * which is what it did before corrections could be saved at all.
   */
  retargets?: Record<string, Record<string, { sourceName: string; targetName: string | null }[]>>;
};

/** A skin's node index for a bone name. Overrides are stored by NAME — see RigAsset.retargets. */
function nodeNamed(skin: Skin, name: string): number | undefined {
  for (const [node, n] of skin.nodeNames ?? new Map<number, string>()) if (n === name) return node;
  return undefined;
}

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
 * Returns immediately when the data carries no shared animations.
 */
export function attachSharedAnimations(scene: Scene, data: PublishedAnimations): void {
  const assets = data.animations;
  const byModel = data.modelAnimations;
  if (!assets?.length || !byModel) return;

  const assetById = new Map(assets.map(a => [a.id, a]));
  // model asset id -> clips, computed once per model however many placements it has.
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
          let mapping = buildBoneMapping(asset.clips, sourceSkin, model.skin as Skin);
          // ...then the corrections the author made in the rig editor. Without this a published game
          // animates with the automatic match the user explicitly fixed — visibly different from the
          // editor, with nothing logged.
          for (const o of data.retargets?.[modelId]?.[id] ?? []) {
            const sn = nodeNamed(sourceSkin, o.sourceName);
            if (sn === undefined) continue;
            const tn = o.targetName === null ? null : nodeNamed(model.skin as Skin, o.targetName);
            if (tn === undefined) continue;
            mapping = applyManualMapping(mapping, sn, tn);
          }
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
