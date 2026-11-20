import { useEffect } from 'react';
import type { CleoEngine } from 'cleo';
import type { ReferencePlayer, ShownFrame } from '../reference/referencePlayer';
import type { Rect } from '../reference/gate';

/**
 * The Stage's Behind: every frame the player shows goes to the renderer's reference backdrop, drawn where no
 * geometry is (behind the character, under the skeleton), in the film gate's rectangle. Cleared when the
 * mode changes, the clip goes, or the workspace closes.
 */
export function useReferenceBackdrop(instance: CleoEngine | null, player: ReferencePlayer | null, gate: Rect | null,
                                     view: { w: number; h: number } | null, active: boolean, flipX: boolean): void {
  const key = gate && view ? [gate.x, gate.y, gate.w, gate.h, view.w, view.h].map(v => v.toFixed(1)).join(',') : '';
  useEffect(() => {
    const renderer = instance?.renderer;
    if (!renderer) return;
    if (!active || !player || !gate || !view || view.w < 1 || view.h < 1) { renderer.setReferenceBackdrop(null); return; }
    const rect: [number, number, number, number] = [gate.x / view.w, gate.y / view.h, (gate.x + gate.w) / view.w, (gate.y + gate.h) / view.h];
    const push = (f: ShownFrame | null) => renderer.setReferenceBackdrop(f
      ? { source: f.canvas as TexImageSource, width: f.width, height: f.height, version: f.version, rect, opacity: 1, flipX }
      : null);
    push(player.current);
    const off = player.subscribe(push);
    return () => { off(); renderer.setReferenceBackdrop(null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance, player, key, active, flipX]);
}
