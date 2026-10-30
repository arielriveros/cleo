// What the Foliage Creator's Download writes: one .glb per level, the impostor atlases for a tree, and a
// sidecar that records how to regenerate the asset and how to set it up in the Editor.

import { sidecar, type ExportFile } from '../core/generator';
import type { FoliageFiles, FoliageSummary, ImpostorBake } from './buildFoliage';
import type { FoliageDoc } from './foliageParams';

const fileStem = (name: string) => name.trim().replace(/\s+/g, '_') || 'foliage';

export function exportFoliage(doc: FoliageDoc, model: FoliageSummary, files: FoliageFiles, impostor: ImpostorBake | null): ExportFile[] {
  const stem = fileStem(model.name);
  const out: ExportFile[] = files.glbs.map((bytes, i) => ({ name: `${stem}_LOD${i}.glb`, mime: 'model/gltf-binary', bytes }));
  if (impostor) {
    out.push({ name: `${stem}_impostor_albedo.png`, mime: 'image/png', bytes: impostor.albedo });
    out.push({ name: `${stem}_impostor_normal.png`, mime: 'image/png', bytes: impostor.normal });
  }
  const wind = model.materials.find(m => m.wind)?.wind ?? null;
  const json = sidecar('foliage', doc[doc.kind], doc.seed, {
    kind: model.kind,
    name: model.name,
    // Distances are metres from the camera to the bounding sphere's SURFACE, the Editor's LOD rule.
    lods: model.levels.map((l, i) => ({ file: out[i].name, distance: l.distance, triangles: l.triangles, vertices: l.vertices })),
    cullDistance: model.cullDistance,
    impostor: impostor && model.impostor ? {
      distance: model.impostor.distance, albedo: `${stem}_impostor_albedo.png`, normal: `${stem}_impostor_normal.png`,
      frames: impostor.info.frames, radius: impostor.info.radius, center: impostor.info.center,
    } : null,
    wind,
    collider: model.collider,
    bounds: model.bounds,
    materials: model.materials.map(m => ({
      name: m.name, alphaCutoff: m.alphaCutoff ?? 0, doubleSided: !!m.doubleSided, translucency: m.translucency ?? 0,
    })),
  });
  out.push({ ...json, name: `${stem}.foliage.json` });
  return out;
}
