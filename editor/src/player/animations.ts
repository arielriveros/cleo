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
 * The clips one model asset plays, retargeted onto `targetSkin`.
 *
 * Split out so the placed-node pass and the TEMPLATE pass below resolve identically. They ask the same
 * question about the same skeleton — a template's subtree is a copy of the model asset's — so two
 * implementations would only be two chances to answer it differently.
 */
function resolveFor(
  modelId: string, targetSkin: Skin, data: PublishedAnimations,
  assetById: Map<string, NonNullable<PublishedAnimations['animations']>[number]>,
): Animation[] {
  const clips: Animation[] = [];
  for (const id of data.modelAnimations?.[modelId] ?? []) {
    const asset = assetById.get(id);
    if (!asset) continue;
    const sourceSkin = loadSkin(asset.sourceSkin);
    if (!sourceSkin) { clips.push(...asset.clips.map(c => ({ ...c }))); continue; }
    try {
      // One mapping per asset — every clip in it shares the source skeleton.
      let mapping = buildBoneMapping(asset.clips, sourceSkin, targetSkin);
      // ...then the corrections the author made in the rig editor. Without this a published game
      // animates with the automatic match the user explicitly fixed — visibly different from the
      // editor, with nothing logged.
      for (const o of data.retargets?.[modelId]?.[id] ?? []) {
        const sn = nodeNamed(sourceSkin, o.sourceName);
        if (sn === undefined) continue;
        const tn = o.targetName === null ? null : nodeNamed(targetSkin, o.targetName);
        if (tn === undefined) continue;
        mapping = applyManualMapping(mapping, sn, tn);
      }
      for (const c of asset.clips) clips.push(retargetAnimation(c, sourceSkin, targetSkin, mapping));
    } catch (e) {
      Logger.warn(`Could not retarget "${asset.name}" onto model ${modelId}: ${e}`, 'Player');
    }
  }
  return clips;
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
    if (!byModel[modelId]?.length) continue;

    let clips = perModel.get(modelId);
    if (!clips) {
      clips = resolveFor(modelId, model.skin as Skin, data, assetById);
      perModel.set(modelId, clips);
    }
    for (const clip of clips) model.addAnimation({ ...clip });
    attached++;
  }

  if (attached) Logger.info(`shared animations attached to ${attached} model node(s)`, 'Player');
}

/** The model-asset id a serialized node belongs to — its own, or the nearest ancestor's. */
function modelIdOfJson(json: any, inherited?: string): string | undefined {
  const own = json?.variables?.[MODEL_ID_VAR]?.value ?? json?.variables?.[LEGACY_MODEL_ID_VAR]?.value;
  return (typeof own === 'string' && own) ? own : inherited;
}

/**
 * Write each template's shared clips INTO its baked subtree, so a character spawned at runtime carries
 * them.
 *
 * {@link attachSharedAnimations} walks the scene that exists at load. A template is not in it: it is JSON
 * in the global registry that `Scene.instantiate` deep-copies on demand, long after this ran. So a
 * character that only ever appears through `scene.instantiate` — a spawned enemy, a projectile — got no
 * clips at all once its model started owning them through a rig, and T-posed with nothing logged. It
 * worked before only because clips were still embedded in the template subtree.
 *
 * Patching the JSON once at boot rather than after each spawn keeps the retarget off the spawn path,
 * which is the one place in a horde game that must not do work per instance.
 *
 * Must run BEFORE `registerTemplates`, or the registry holds the un-patched copies.
 */
export function attachTemplateAnimations(templates: { name: string; node: any }[] | undefined, data: PublishedAnimations): void {
  if (!templates?.length || !data.animations?.length || !data.modelAnimations) return;

  const assetById = new Map(data.animations.map(a => [a.id, a]));
  const perModel = new Map<string, Animation[]>();
  let patched = 0;

  const walk = (json: any, inherited?: string): void => {
    if (!json || typeof json !== 'object') return;
    const modelId = modelIdOfJson(json, inherited);
    const model = json.model;
    if (model?.skin && modelId && data.modelAnimations![modelId]?.length) {
      let clips = perModel.get(modelId);
      if (!clips) {
        const skin = loadSkin(model.skin);
        clips = skin ? resolveFor(modelId, skin, data, assetById) : [];
        perModel.set(modelId, clips);
      }
      // Replace, never append: a template that still embeds a clip of the same name would otherwise
      // reach `addAnimation`'s de-dupe and come back as "Walk (2)", which no state machine names.
      const own = (model.animations ?? []).filter((c: any) => !c.assetId);
      const shared = clips.map(c => ({ ...c }));
      model.animations = [...own, ...shared.filter(c => !own.some((o: any) => o.name === c.name))];
      if (clips.length) patched++;
    }
    for (const child of json.children ?? []) walk(child, modelId);
  };

  for (const template of templates) walk(template.node);
  if (patched) Logger.info(`shared animations baked into ${patched} template model(s)`, 'Player');
}
