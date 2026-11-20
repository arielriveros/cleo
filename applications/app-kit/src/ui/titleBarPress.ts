// Which presses on the desktop app's title bar (the menu bar, ui/Topbar.tsx) drag the window. Pure, for the tests.

/** What in the title bar is a control: a press on one is a click. */
export const TITLEBAR_CONTROL = "button, a, input, select, textarea, [role='button'], [role='menuitem']";

/** The DOM this needs of an element: enough for the tests to hand it a fake. */
export interface PressNode {
  closest(selector: string): unknown;
  parentElement: PressNode | null;
}

export interface PressBar extends PressNode {
  contains(node: unknown): boolean;
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number };
}

/**
 * Whether a press at (`x`, `y`) on `target` is a press on the title bar `bar` itself, which drags the window:
 * not on one of its controls, and not on something the bar only hosts. A modal opened from the menu bar (the
 * Projects browser) sits inside the bar's DOM, a dropdown hangs below it, a portal is its child in the React
 * tree: all three bubble their presses up through the bar like its own. Taken for drags, they captured the
 * pointer and swallowed the click, so no project card could be picked, and a double-click on one maximized the
 * window instead of opening it.
 *
 * So the press must land on an element inside the bar's DOM, inside the bar's own rectangle, with nothing
 * fixed-position (an overlay over the whole window, the bar's strip included) between it and the bar.
 */
export function isTitleBarPress(
  bar: PressBar, target: unknown, x: number, y: number,
  position: (node: PressNode) => string = node => getComputedStyle(node as unknown as Element).position,
): boolean {
  const node = target as PressNode | null;
  if (!node || typeof node.closest !== 'function') return false;
  if (node.closest(TITLEBAR_CONTROL)) return false;
  if (!bar.contains(node)) return false;
  const r = bar.getBoundingClientRect();
  if (x < r.left || x >= r.right || y < r.top || y >= r.bottom) return false;
  for (let n: PressNode | null = node; n && n !== bar; n = n.parentElement) {
    if (position(n) === 'fixed') return false;
  }
  return true;
}
