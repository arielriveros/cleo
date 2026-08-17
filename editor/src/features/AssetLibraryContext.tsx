import { createContext, useContext } from 'react';
import type { useCleoEngine } from './EngineContext';

type EngineValue = ReturnType<typeof useCleoEngine>;

/**
 * The asset libraries (templates, materials, terrain materials, models, script assets, animation fields)
 * plus their CRUD, split out of the large EngineContext.
 *
 * This is the biggest self-contained cluster in the old context, and the Assets explorer / VfsContext
 * consume exactly this slice — so they can subscribe here instead of re-rendering on every unrelated
 * EngineContext change. The state still lives in EngineProvider (each library is persisted to IndexedDB
 * by `usePersistedLibrary`); this context only re-exposes it as a narrow, memoized value.
 *
 * Derived via `Pick` so the signatures stay in lockstep with the context they are lifted from.
 */
export type AssetLibraryContextValue = Pick<EngineValue,
  | 'templates' | 'addTemplate' | 'removeTemplate' | 'updateTemplate'
  | 'materials' | 'addMaterial' | 'removeMaterial' | 'updateMaterial'
  | 'terrainMaterials' | 'addTerrainMaterial' | 'removeTerrainMaterial' | 'updateTerrainMaterial'
  | 'models' | 'addModel' | 'removeModel' | 'updateModel'
  | 'scriptAssets' | 'addScriptAsset' | 'removeScriptAsset' | 'updateScriptAsset'
  | 'animationFields' | 'addAnimationField' | 'removeAnimationField' | 'updateAnimationField'
  | 'tilesets' | 'addTileset' | 'removeTileset' | 'updateTileset'
  | 'assetsLoaded'
>;

export const AssetLibraryContext = createContext<AssetLibraryContextValue | null>(null);

/** Read the asset-library slice. Provided by EngineProvider. */
export function useAssetLibrary(): AssetLibraryContextValue {
  const ctx = useContext(AssetLibraryContext);
  if (!ctx) throw new Error('useAssetLibrary must be used within an EngineProvider');
  return ctx;
}
