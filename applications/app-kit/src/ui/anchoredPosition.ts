/** Distance between the trigger and the panel, and the closest the panel may sit to a viewport edge. */
export const ANCHOR_GAP = 4;
export const ANCHOR_MARGIN = 8;

/**
 * Where a `position: fixed` panel goes beside its trigger: below it (or above, with `side: 'above'`),
 * flipped to the other side when it would run off the viewport there and the other side has room, and
 * clamped inside the viewport horizontally.
 * Shared by Popover and DocTooltip; both portal to <body> so no ancestor overflow can clip them.
 */
export function placeAnchored(trigger: DOMRect, panel: DOMRect, align: 'left' | 'right' = 'left',
                              side: 'below' | 'above' = 'below'): { top: number; left: number } {
  const below = trigger.bottom + ANCHOR_GAP;
  const above = trigger.top - ANCHOR_GAP - panel.height;
  const fitsBelow = below + panel.height <= window.innerHeight - ANCHOR_MARGIN;
  const fitsAbove = above >= ANCHOR_MARGIN;
  const top = side === 'above'
    ? (fitsAbove || !fitsBelow ? above : below)
    : (fitsBelow || !fitsAbove ? below : above);

  let left = align === 'right' ? trigger.right - panel.width : trigger.left;
  left = Math.min(Math.max(left, ANCHOR_MARGIN), Math.max(ANCHOR_MARGIN, window.innerWidth - panel.width - ANCHOR_MARGIN));

  return { top, left };
}
