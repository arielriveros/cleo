import { createContext, useContext } from 'react';
import type { useCleoEngine } from './EngineContext';

type EngineValue = ReturnType<typeof useCleoEngine>;

/**
 * The asset libraries (templates, materials, terrain materials, models, script assets, animation fields)
 * plus their CRUD. The state lives in EngineProvider, persisted to IndexedDB by `usePersistedLibrary`;
 * this context re-exposes it as a narrow, memoized value, derived via `Pick` to stay in lockstep with it.
 */
export type AssetLibraryContextValue = Pick<EngineValue,
  | 'templates' | 'addTemplate' | 'removeTemplate' | 'updateTemplate'
  | 'materials' | 'addMaterial' | 'removeMaterial' | 'updateMaterial'
  | 'terrainMaterials' | 'addTerrainMaterial' | 'removeTerrainMaterial' | 'updateTerrainMaterial'
  | 'models' | 'addModel' | 'removeModel' | 'updateModel'
  | 'scriptAssets' | 'addScriptAsset' | 'removeScriptAsset' | 'updateScriptAsset'
  | 'animationFields' | 'addAnimationField' | 'removeAnimationField' | 'updateAnimationField'
  | 'animations' | 'addAnimation' | 'removeAnimation' | 'updateAnimation'
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
