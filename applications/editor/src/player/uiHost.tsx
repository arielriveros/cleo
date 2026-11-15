import ReactDOM from 'react-dom/client';
import type { Scene } from 'cleo';
import UILayer from '../features/gameUi/UILayer';

// The game's UI layer (its UI nodes, drawn as DOM over the canvas), a part of the published player of its own
// (vite.player.config.ts `ui-host`): React and the UI layer ship only with a game built with the Game UI feature.
// boot.tsx imports it on demand.

/** Render the UI layer into a layer of its own inside `root` (#ui-root). `getScene` follows Game.loadScene. */
export function mountUILayer(root: HTMLElement, getScene: () => Scene | null): void {
  const host = document.createElement('div');
  host.style.position = 'absolute';
  host.style.inset = '0';
  root.appendChild(host);
  ReactDOM.createRoot(host).render(<UILayer getScene={getScene} interactive />);
}
