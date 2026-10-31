// Foliage materials as the Materials tab edits them: the shared material editor's fields (app-kit
// MaterialFields), mapped onto each kind's parameters.
//
// A field the generator already has a parameter for -- a leaf's roughness and translucency, the plant's
// wind -- is LINKED: the tab edits that parameter, so the two can never disagree and presets keep
// working. Everything else (a tint over the generated texture, metallic, emission, the cutout threshold,
// how bark moves in the wind) is an OVERRIDE, stored per material under the kind's `materials` field and
// laid over the generated spec by `applyMaterialOverride`. Pure: used by the worker and the panels alike.

import type { MaterialFieldValues, MaterialPatch, Rgb, WindRole } from '@cleo/app-kit/materials/MaterialFields';
import type { FoliageDoc, FoliageKind } from './foliageParams';
import type { MaterialKey } from './mesh';

export interface MaterialOverride {
  /** Multiplies the generated (or replaced) base colour texture. */
  baseColor?: Rgb;
  metallic?: number;
  emissive?: Rgb;
  emissiveIntensity?: number;
  alphaCutoff?: number;
  windRole?: WindRole;
}
export type MaterialOverrides = Partial<Record<MaterialKey, MaterialOverride>>;

/** The materials each kind generates, in the order the tab lists them. */
export const MATERIAL_KEYS: Record<FoliageKind, MaterialKey[]> = {
  grass: ['grass', 'grassCard'],
  rock: ['rock'],
  tree: ['bark', 'leaves'],
  bush: ['bark', 'leaves'],
};

export function materialLabel(doc: FoliageDoc, key: MaterialKey): string {
  if (key === 'leaves') return doc[doc.kind as 'tree' | 'bush'].leafKind === 'needles' ? 'Needles' : 'Leaves';
  return { grass: 'Blades', grassCard: 'Clump card', rock: 'Rock', bark: 'Bark' }[key] ?? key;
}

/** Whether a kind's material is generated at all (a tree with leafKind 'none' has no leaves). */
export function hasMaterial(doc: FoliageDoc, key: MaterialKey): boolean {
  if (key === 'leaves') return doc[doc.kind as 'tree' | 'bush'].leafKind !== 'none';
  if (key === 'grassCard') return doc.kind === 'grass' && doc.grass.lod2Kind !== 'blades';
  return MATERIAL_KEYS[doc.kind].includes(key);
}

type Linked = 'roughness' | 'translucency' | 'translucencyColor' | 'translucencyBlend' | 'windStrength' | 'windStiffness' | 'windFlutter';

/** Fields linked to a kind's parameters: material field -> parameter key. */
const LINKS: Record<FoliageKind, Partial<Record<MaterialKey, Partial<Record<Linked, string>>>>> = {
  grass: {
    grass: { roughness: 'roughness', translucency: 'translucency', translucencyColor: 'translucencyColor', translucencyBlend: 'translucencyBlend', windStrength: 'windStrength', windStiffness: 'windStiffness', windFlutter: 'windFlutter' },
    grassCard: { roughness: 'roughness', translucency: 'translucency', translucencyColor: 'translucencyColor', translucencyBlend: 'translucencyBlend', windStrength: 'windStrength', windStiffness: 'windStiffness', windFlutter: 'windFlutter' },
  },
  rock: { rock: { roughness: 'roughness' } },
  tree: {
    bark: { roughness: 'barkRoughness', windStrength: 'windStrength', windStiffness: 'windStiffness' },
    leaves: { roughness: 'leafRoughness', translucency: 'leafTranslucency', translucencyColor: 'leafTranslucencyColor', translucencyBlend: 'leafTranslucencyBlend', windStrength: 'windStrength', windStiffness: 'windStiffness', windFlutter: 'windFlutter' },
  },
  bush: {
    bark: { roughness: 'barkRoughness', windStrength: 'windStrength', windStiffness: 'windStiffness' },
    leaves: { roughness: 'leafRoughness', translucency: 'leafTranslucency', translucencyColor: 'leafTranslucencyColor', translucencyBlend: 'leafTranslucencyBlend', windStrength: 'windStrength', windStiffness: 'windStiffness', windFlutter: 'windFlutter' },
  },
};

/** The role a material moves with unless overridden: the generator's choice. */
const DEFAULT_ROLE: Partial<Record<MaterialKey, WindRole>> = { grass: 'plant', grassCard: 'plant', bark: 'plant', leaves: 'leaves' };
/** Materials with a cutout, and the threshold they are generated with. */
export const DEFAULT_CUTOFF: Partial<Record<MaterialKey, number>> = { grassCard: 0.5, leaves: 0.5 };

const paramsOf = (doc: FoliageDoc) => doc[doc.kind] as unknown as Record<string, unknown> & { materials?: MaterialOverrides };

/** One material's values for the shared material editor. Fields the material does not have are left out. */
export function materialValues(doc: FoliageDoc, key: MaterialKey): MaterialFieldValues {
  const p = paramsOf(doc);
  const links = LINKS[doc.kind][key] ?? {};
  const o = p.materials?.[key] ?? {};
  const linked = (f: Linked) => links[f] !== undefined ? Number(p[links[f]!]) : undefined;
  const role = o.windRole ?? DEFAULT_ROLE[key];
  return {
    baseColor: o.baseColor ?? [1, 1, 1],
    metallic: o.metallic ?? 0,
    roughness: linked('roughness'),
    translucency: linked('translucency'),
    translucencyColor: links.translucencyColor ? (p[links.translucencyColor] as number[]).slice(0, 3) as Rgb : undefined,
    translucencyBlend: linked('translucencyBlend'),
    emissive: o.emissive ?? [0, 0, 0],
    emissiveIntensity: o.emissiveIntensity ?? 1,
    alphaCutoff: DEFAULT_CUTOFF[key] !== undefined ? o.alphaCutoff ?? DEFAULT_CUTOFF[key] : undefined,
    windStrength: linked('windStrength'),
    windStiffness: linked('windStiffness'),
    windRole: role,
    // Flutter belongs to leaves; bark only has it when it is set to move as leaves.
    windFlutter: linked('windFlutter') ?? (role === 'leaves' ? Number(p.windFlutter ?? 0.5) : undefined),
  };
}

/** A patch from the shared material editor, written into the document. */
export function applyMaterialPatch(doc: FoliageDoc, key: MaterialKey, patch: MaterialPatch): FoliageDoc {
  const p = { ...paramsOf(doc) };
  const links = LINKS[doc.kind][key] ?? {};
  const o: MaterialOverride = { ...(p.materials?.[key] ?? {}) };
  for (const [field, value] of Object.entries(patch) as [keyof MaterialPatch, unknown][]) {
    if (value === undefined) continue;
    const link = links[field as Linked] ?? (field === 'windFlutter' ? 'windFlutter' : undefined);
    // A colour parameter is an Rgba; the editor hands back an Rgb.
    if (link && field === 'translucencyColor') p[link] = [...(value as number[]).slice(0, 3), 1];
    else if (link) p[link] = value;
    else if (field === 'baseColor' || field === 'emissive') o[field] = value as Rgb;
    else if (field === 'metallic' || field === 'emissiveIntensity' || field === 'alphaCutoff') o[field] = value as number;
    else if (field === 'windRole') o.windRole = value as WindRole;
  }
  p.materials = { ...(p.materials ?? {}), [key]: o };
  return { ...doc, [doc.kind]: p };
}

/** The kind's material overrides back to the generator's choices. */
export function resetMaterial(doc: FoliageDoc, key: MaterialKey): FoliageDoc {
  const p = { ...paramsOf(doc) };
  const rest = { ...(p.materials ?? {}) };
  delete rest[key];
  p.materials = rest;
  return { ...doc, [doc.kind]: p };
}

const num = (v: unknown, lo: number, hi: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined;
const rgb = (v: unknown): Rgb | undefined =>
  Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every(x => typeof x === 'number' && Number.isFinite(x))
    ? v.slice(0, 3).map(x => Math.min(1, Math.max(0, x))) as Rgb : undefined;

/** A stored `materials` field made safe: known keys and fields only, numbers clamped. */
export function normaliseOverrides(raw: unknown, kind: FoliageKind): MaterialOverrides {
  const out: MaterialOverrides = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const key of MATERIAL_KEYS[kind]) {
    const o = (raw as Record<string, unknown>)[key] as Record<string, unknown> | undefined;
    if (!o || typeof o !== 'object') continue;
    const clean: MaterialOverride = {
      baseColor: rgb(o.baseColor), emissive: rgb(o.emissive),
      metallic: num(o.metallic, 0, 1), emissiveIntensity: num(o.emissiveIntensity, 0, 100), alphaCutoff: num(o.alphaCutoff, 0, 1),
      windRole: o.windRole === 'leaves' || o.windRole === 'plant' ? o.windRole : undefined,
    };
    for (const k of Object.keys(clean) as (keyof MaterialOverride)[]) if (clean[k] === undefined) delete clean[k];
    if (Object.keys(clean).length) out[key] = clean;
  }
  return out;
}
