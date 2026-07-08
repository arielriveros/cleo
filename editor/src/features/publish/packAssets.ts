// Publish-time transform: move shared/heavy asset data into a top-level `assets` table and replace
// inline copies with references, so the published game.json is smaller and free of duplication.
//
// - Geometry: Model.serialize() inlines full vertex arrays in EVERY ModelNode (model.ts). Identical
//   meshes (e.g. many crates) therefore repeat. We dedupe by exact serialized content into
//   `assets.geometries` and leave each model with a `geometryRef`.
// - Textures: already deduped by id in `data.textures`; we just move them under `assets.textures`
//   for a single, unified asset object. Materials keep referencing texture ids, unchanged.
//
// The player's reinflate() reverses this before Scene.parse, so the engine is untouched.

export interface PackedAssets {
  geometries: Record<string, any>;
  textures: any[];
}

// Replace every `model.geometry` in the scene tree with a `geometryRef` into a deduped table.
function packGeometries(scene: any, geometries: Record<string, any>): void {
  const keyToId = new Map<string, string>(); // exact geometry JSON -> asset id
  let counter = 0;

  const visit = (node: any): void => {
    if (node && typeof node === 'object') {
      const model = node.model;
      if (model && model.geometry && typeof model.geometry === 'object') {
        const key = JSON.stringify(model.geometry);
        let id = keyToId.get(key);
        if (!id) {
          id = `g${counter++}`;
          keyToId.set(key, id);
          geometries[id] = model.geometry;
        }
        model.geometryRef = id;
        delete model.geometry;
      }
    }
    for (const child of (node?.children ?? [])) visit(child);
  };

  visit(scene);
}

// Mutates `data`: builds `data.assets = { geometries, textures }`, replaces inline geometry with refs,
// and moves `data.textures` under the assets table.
export function packAssets(data: any): any {
  const geometries: Record<string, any> = {};
  if (data?.scene) packGeometries(data.scene, geometries);

  const textures = Array.isArray(data?.textures) ? data.textures : [];
  data.assets = { geometries, textures } as PackedAssets;
  delete data.textures;
  return data;
}
