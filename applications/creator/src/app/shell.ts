import { createContext, useContext } from 'react';

// The Creator's app switch, for panels that move between apps (the Assets explorer opens a saved asset
// in the app that made it). 'home' is the start page that picks an app.

export type AppId = 'world' | 'fx' | 'foliage' | 'motion';
export type Tool = AppId | 'home';

/** The Creator's apps, in the order the home page lists them. */
export const APPS: { id: AppId; label: string; description: string }[] = [
  { id: 'world', label: 'World Creator', description: 'Landscape heightmaps from landforms and erosion' },
  { id: 'fx', label: 'FX Creator', description: 'Fire and smoke flipbooks from a volumetric fluid simulation' },
  { id: 'foliage', label: 'Foliage Creator', description: 'Grass, bushes, rocks and trees with LODs, exported as glTF' },
  { id: 'motion', label: 'Motion Creator', description: 'Character animation from a few key poses, exported as an .anim clip' },
];

export const appLabel = (tool: Tool) => APPS.find(a => a.id === tool)?.label ?? 'Home';

export interface CreatorShell {
  tool: Tool;
  choose: (tool: Tool) => void;
}

export const CreatorShellContext = createContext<CreatorShell>({ tool: 'home', choose: () => {} });
export const useCreatorShell = () => useContext(CreatorShellContext);
