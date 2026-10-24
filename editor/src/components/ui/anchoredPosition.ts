/** Distance between the trigger and the panel, and the closest the panel may sit to a viewport edge. */
export const ANCHOR_GAP = 4;
export const ANCHOR_MARGIN = 8;

/**
 * Where a `position: fixed` panel goes beside its trigger: below it, flipped above when it would run off
 * the bottom of the viewport and there is room above, and clamped inside the viewport horizontally.
 * Shared by Popover and DocTooltip; both portal to <body> so no ancestor overflow can clip them.
 */
export function placeAnchored(trigger: DOMRect, panel: DOMRect, align: 'left' | 'right' = 'left'): { top: number; left: number } {
  let top = trigger.bottom + ANCHOR_GAP;
  if (top + panel.height > window.innerHeight - ANCHOR_MARGIN && trigger.top - ANCHOR_GAP - panel.height >= ANCHOR_MARGIN)
    top = trigger.top - ANCHOR_GAP - panel.height;

  let left = align === 'right' ? trigger.right - panel.width : trigger.left;
  left = Math.min(Math.max(left, ANCHOR_MARGIN), Math.max(ANCHOR_MARGIN, window.innerWidth - panel.width - ANCHOR_MARGIN));

  return { top, left };
}
