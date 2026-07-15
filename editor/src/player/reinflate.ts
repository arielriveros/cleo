// Reverse of the publish `packAssets` transform: turn the compact `assets` table back into the inline
// shape Scene.parse expects (engine untouched). Geometry refs become inline geometry again (multiple
// nodes share the same array object — Model.parse builds a fresh Geometry from it each time), and the
// textures table moves back to `data.textures`.

export function reinflate(data: any): any {
  if (!data || typeof data !== 'object') return data;
  const assets = data.assets;
  const geometries: Record<string, any> = assets?.geometries ?? {};

  const visit = (node: any): void => {
    if (node && typeof node === 'object') {
      const model = node.model;
      if (model && typeof model.geometryRef === 'string') {
        model.geometry = geometries[model.geometryRef];
        delete model.geometryRef;
      }
      for (const child of (node.children ?? [])) visit(child);
    }
  };
  if (data.scene) visit(data.scene);                                                  // v1
  if (data.scenes) for (const s of Object.values<any>(data.scenes)) visit(s?.scene);  // v2: reinflate each

  // Scene.parse reads data.textures (unless useCache); restore it from the assets table.
  if (assets && Array.isArray(assets.textures)) data.textures = assets.textures;
  else if (!Array.isArray(data.textures)) data.textures = [];

  return data;
}
