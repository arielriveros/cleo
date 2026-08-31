import { useRef } from 'react';
import { CleoEngine, Logger } from 'cleo';
import { MaterialAsset } from '../../utils/materials';
import { TerrainMaterialAsset } from '../../utils/terrainMaterials';
import { ModelAsset } from '../../utils/models';
import {
  renderModelAssetThumbnail, renderMaterialAssetThumbnail, renderTerrainMaterialAssetThumbnail,
} from '../../utils/modelThumbnails';

/**
 * The asset-thumbnail slice, lifted out of EngineProvider verbatim.
 *
 * It owns exactly one piece of state (the in-flight set) and reads the three asset libraries it can
 * capture a preview for. Everything it touches is passed in, so the closure it returns sees the same
 * render's values it saw when it lived in the provider body.
 */
export function useAssetThumbnails(deps: {
  instanceRef: React.MutableRefObject<CleoEngine | null>;
  materials: MaterialAsset[];
  setMaterials: React.Dispatch<React.SetStateAction<MaterialAsset[]>>;
  terrainMaterials: TerrainMaterialAsset[];
  setTerrainMaterials: React.Dispatch<React.SetStateAction<TerrainMaterialAsset[]>>;
  models: ModelAsset[];
  setModels: React.Dispatch<React.SetStateAction<ModelAsset[]>>;
}) {
  const { instanceRef, materials, setMaterials, terrainMaterials, setTerrainMaterials, models, setModels } = deps;

  // ---- Thumbnails on open --------------------------------------------------------------------------
  //
  // An asset is stored with an empty thumbnail (the explorer shows the kind's icon) and its preview is
  // rendered the first time it is opened — every capture is a full GL frame. Always render from the
  // asset's *saved* data, never a live tab scene: renderModelThumbnail reparents the node it is given.
  const thumbnailPendingRef = useRef(new Set<string>());

  const captureAssetThumbnail = (kind: 'material' | 'terrainMaterial' | 'model', id: string) => {
    const engine = instanceRef.current;
    if (!engine) return;
    // One capture per asset in flight; a re-open while one is running must not queue a second GL render.
    if (thumbnailPendingRef.current.has(id)) return;
    thumbnailPendingRef.current.add(id);

    // Deliberately not awaited: the tab opens immediately and the card updates whenever the render lands.
    // The write patches only `thumbnail` through the functional setter, so a concurrent edit is not lost.
    (async () => {
      try {
        if (kind === 'material') {
          const asset = materials.find(m => m.id === id);
          if (!asset) return;
          const thumbnail = await renderMaterialAssetThumbnail(engine, asset);
          if (thumbnail) setMaterials(prev => prev.map(x => x.id === id ? { ...x, thumbnail } : x));
        } else if (kind === 'terrainMaterial') {
          const asset = terrainMaterials.find(m => m.id === id);
          if (!asset) return;
          const thumbnail = await renderTerrainMaterialAssetThumbnail(engine, asset);
          if (thumbnail) setTerrainMaterials(prev => prev.map(x => x.id === id ? { ...x, thumbnail } : x));
        } else {
          const asset = models.find(m => m.id === id);
          if (!asset) return;
          const thumbnail = await renderModelAssetThumbnail(engine, asset);
          if (thumbnail) setModels(prev => prev.map(x => x.id === id ? { ...x, thumbnail } : x));
        }
      } catch (e) {
        Logger.warn(`Could not render the thumbnail for this asset: ${e}`, 'Editor');
      } finally {
        thumbnailPendingRef.current.delete(id);
      }
    })();
  };

  return { captureAssetThumbnail };
}
