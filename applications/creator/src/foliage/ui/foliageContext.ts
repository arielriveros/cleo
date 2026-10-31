import { createContext, useContext } from 'react';
import type { TextureKey } from '../buildFoliage';
import type { FoliageBuild } from '../foliageClient';
import type { FoliageDoc } from '../foliageParams';
import type { Image } from '../textures/image';
import type { StageSettings } from './foliageStage';

// The Foliage Creator workspace's shared state, read by every dock panel (FoliageWorkspace provides it).

export interface SavedVariant { id: string; label: string; doc: FoliageDoc }

/**
 * A user's replacement for one generated texture: the decoded pixels, a preview URL, and the file as
 * loaded (kept with a saved asset, so reopening it restores the override).
 */
export interface TextureOverride { image: Image; url: string; fileName: string; bytes: Uint8Array; mime: string; flipGreen: boolean }

export interface FoliageState {
  doc: FoliageDoc;
  setDoc: (d: FoliageDoc) => void;
  /** Replace the current kind's parameters. */
  setParams: (p: object) => void;
  build: FoliageBuild | null;
  building: boolean;
  stage: StageSettings;
  setStage: (s: StageSettings) => void;
  overrides: Partial<Record<TextureKey, TextureOverride>>;
  /** `flipGreen`: the file is a DirectX normal map. */
  setOverride: (key: TextureKey, file: File | null, opts?: { flipGreen?: boolean }) => Promise<void>;
  variants: SavedVariant[];
  setVariants: (v: SavedVariant[]) => void;
  /** Seeds tried this session, newest first. */
  seedHistory: number[];
  impostorPreview: { albedoUrl: string; normalUrl: string } | null;
  bakeImpostorPreview: () => void;
  exporting: boolean;
  onExport: () => void;
}

export const FoliageContext = createContext<FoliageState | null>(null);
export const useFoliage = () => useContext(FoliageContext)!;

