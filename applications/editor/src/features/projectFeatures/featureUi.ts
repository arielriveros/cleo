// Where the engine's optional features (the engine's src/modules/catalog.ts) show in the editor: the Add menu
// items, New asset entries and editor modes each one owns. A feature the project leaves out (Project ▸
// Features) hides them; what is already in a scene stays, marked as not shipped.
import { useMemo } from 'react'
import { enabledFeatures, featureOfNodeType, type FeatureDef } from 'cleo'
import { useCleoEngine } from '../EngineContext'

/** Add menu items (sceneInspector/addCatalog.ts ids) by the feature that owns them. */
export const FEATURE_ADD_ITEMS: Readonly<Record<string, readonly string[]>> = {
  gi: ['giVolume'],
  volumetricFog: ['volumetricFog'],
  volumetricClouds: ['volumetricClouds'],
  skyAtmosphere: ['skyAtmosphere'],
  decals: ['decal'],
  landscape: ['landscape'],
  water: ['waterVolume'],
  particles: ['particleSystem', 'forceField'],
  weather: ['weather'],
  world2d: ['tilemap', 'camera2D', 'room2D', 'parallaxLayer'],
  physics2d: ['characterBody2D', 'body2D'],
  cloth: ['cloth'],
  ai: ['navMesh'],
  gameUi: ['uiCanvas', 'uiWorldRoot', 'uiStackColumn', 'uiStackRow', 'uiSpacer', 'uiPanel', 'uiText', 'uiImage', 'uiButton',
           'uiProgressBar', 'uiSlider', 'uiToggle', 'uiTextInput'],
  sequencer: ['sequence'],
}

/** New asset menu entries (assets/AssetsExplorer.tsx labels) by the feature that owns them. */
export const FEATURE_NEW_ASSETS: Readonly<Record<string, readonly string[]>> = {
  landscape: ['Landscape Material', 'Foliage Material'],
  world2d: ['Tileset'],
  particles: ['Particle System'],
  sequencer: ['Sequence'],
}

/** Editor modes the mode selector offers, by the feature that owns them. */
export const FEATURE_MODES: Readonly<Record<string, readonly string[]>> = {
  landscape: ['landscape'],
  world2d: ['tilemap'],
  gameUi: ['ui'],
}

const owner = (table: Readonly<Record<string, readonly string[]>>, key: string): string | undefined =>
  Object.keys(table).find(id => table[id].includes(key))

/** The feature an Add menu item belongs to, if one does. */
export const featureOfAddItem = (itemId: string) => owner(FEATURE_ADD_ITEMS, itemId)
/** The feature a New asset entry belongs to, if one does. */
export const featureOfNewAsset = (label: string) => owner(FEATURE_NEW_ASSETS, label)
/** The feature an editor mode belongs to, if one does. */
export const featureOfMode = (mode: string) => owner(FEATURE_MODES, mode)

export interface ProjectFeatures {
  /** The features the project's games carry. */
  readonly enabled: ReadonlySet<string>;
  /** Whether a feature is on; no feature (core) always is. */
  isOn(id: string | undefined): boolean;
  /** The feature a node type belongs to when the project leaves it out: the node will not ship. */
  offFeatureOfNodeType(type: string | undefined): FeatureDef | undefined;
}

/** The project's features, from its settings. */
export function projectFeatures(disabled: readonly string[]): ProjectFeatures {
  const enabled = enabledFeatures(disabled)
  return {
    enabled,
    isOn: id => !id || enabled.has(id),
    offFeatureOfNodeType: type => {
      const f = type ? featureOfNodeType(type) : undefined
      return f && !enabled.has(f.id) ? f : undefined
    },
  }
}

/** The open project's features (Project ▸ Features), for what the editor offers. */
export function useProjectFeatures(): ProjectFeatures {
  const { projectSettings } = useCleoEngine()
  const disabled = projectSettings.features.disabled
  return useMemo(() => projectFeatures(disabled), [disabled])
}
