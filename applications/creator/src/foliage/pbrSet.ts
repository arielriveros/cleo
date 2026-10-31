// A downloaded PBR texture set (Poly Haven, ambientCG, a scan) sorted onto a material's texture slots by
// file name: `pine_bark_diff_1k.png` is the colour, `_nor_gl` the normal, `_arm` the packed ARM map, and
// so on. Pure, so the rules are tested.

import type { TextureKey } from './buildFoliage';
import type { MaterialKey } from './mesh';

export type PbrRole = 'color' | 'normal' | 'arm' | 'ao' | 'roughness' | 'metallic';

/** The slot each role fills, per material. A material missing a role has nowhere to put that map. */
export const PBR_SLOTS: Partial<Record<MaterialKey, Partial<Record<PbrRole, TextureKey>>>> = {
  bark: { color: 'bark', normal: 'barkNormal', arm: 'barkOrm', ao: 'barkAo', roughness: 'barkRoughness', metallic: 'barkMetallic' },
  rock: { color: 'rockAlbedo', normal: 'rockNormal' },
  leaves: { color: 'leaves', normal: 'leavesNormal' },
};

/** Name tokens per role, checked in this order (an `_arm` map is not read as its parts). */
const RULES: [PbrRole, RegExp][] = [
  ['arm', /^(arm|orm|mra|rma|occlusionroughnessmetallic)$/],
  ['ao', /^(ao|occ|occlusion|ambientocclusion)$/],
  ['roughness', /^(rough|roughness|rgh)$/],
  ['metallic', /^(metal|metallic|metalness|mtl)$/],
  ['normal', /^(nor|normal|nrm|nrml|normalgl|normaldx)$/],
  ['color', /^(diff|diffuse|albedo|basecolor|basecolour|color|colour|col|base)$/],
];
/** Maps a material cannot use: named so the user is told why they were skipped. */
const UNUSED = /^(disp|displacement|height|bump|spec|specular|gloss|glossiness|opacity|mask)$/;

export interface PbrFile { role: PbrRole; slot: TextureKey; name: string; flipGreen: boolean }
export interface PbrSetPlan { files: PbrFile[]; skipped: string[] }

const tokens = (name: string) => name.toLowerCase().replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]+$/, '').split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Which file goes in which slot. Images only; one file per role -- an OpenGL normal over a DirectX one
 * (which is used with its green flipped), a PNG over a JPG.
 */
export function planPbrSet(material: MaterialKey, names: string[]): PbrSetPlan {
  const slots = PBR_SLOTS[material] ?? {};
  const best = new Map<PbrRole, { name: string; score: number; flipGreen: boolean }>();
  const skipped: string[] = [];
  for (const name of names) {
    if (!/\.(png|jpe?g|webp|bmp|tga)$/i.test(name)) { skipped.push(name); continue; }
    const t = tokens(name);
    const role = RULES.find(([, re]) => t.some(x => re.test(x)))?.[0];
    if (!role || !slots[role] || t.some(x => UNUSED.test(x) && !RULES.some(([, re]) => re.test(x)))) { skipped.push(name); continue; }
    const dx = role === 'normal' && (t.includes('dx') || t.includes('normaldx') || t.includes('directx'));
    const score = (dx ? 0 : 2) + (/\.png$/i.test(name) ? 1 : 0);
    const prev = best.get(role);
    if (prev) skipped.push(score > prev.score ? prev.name : name);
    if (!prev || score > prev.score) best.set(role, { name, score, flipGreen: dx });
  }
  const files = [...best].map(([role, f]) => ({ role, slot: slots[role]!, name: f.name, flipGreen: f.flipGreen }));
  return { files, skipped };
}
