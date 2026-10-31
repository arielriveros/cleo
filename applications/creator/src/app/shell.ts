import { createContext, useContext } from 'react';

// The Creator's tool switch, for panels that move between tools (the Assets explorer opens a saved asset
// in the tool that made it).

export type Tool = 'world' | 'fx' | 'foliage';

export interface CreatorShell {
  tool: Tool;
  choose: (tool: Tool) => void;
}

export const CreatorShellContext = createContext<CreatorShell>({ tool: 'world', choose: () => {} });
export const useCreatorShell = () => useContext(CreatorShellContext);
