// A small picture of the current stage, for a saved asset's card in the Assets explorer: the scene as the
// viewport frames it, offscreen, without the grid. The editor's thumbnails are taken the same way
// (applications/editor/src/utils/modelThumbnails.ts `captureClean`).

import { useCallback } from 'react';
import { useCreatorEngine } from '../app/CreatorEngine';

export const THUMBNAIL_SIZE = 128;

export function useStageCapture(): () => Promise<string> {
  const { instance, scene } = useCreatorEngine();
  return useCallback(async () => {
    if (!instance || !scene) return '';
    const r = instance.renderer;
    const grid = r.gridVisible;
    r.setGridVisible(false);
    let pending: Promise<string>;
    try {
      pending = r.screenshotOffscreen(scene, THUMBNAIL_SIZE);
    } finally {
      r.setGridVisible(grid);
    }
    return pending;
  }, [instance, scene]);
}
