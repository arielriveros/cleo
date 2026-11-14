import { describe, it, expect } from 'vitest';
import { isSelectable, nextSelectable, type MenuEntry } from '../src/ui/AppMenuBar';

// The menu bar's keyboard walk (ui/AppMenuBar.tsx): which rows the arrow keys land on.

const item = (label: string, disabled = false): MenuEntry => ({ kind: 'item', label, disabled, onSelect: () => {} });
const sep: MenuEntry = { kind: 'separator' };

describe('the menu bar walk', () => {
  const items: MenuEntry[] = [item('Save'), item('Save All', true), sep, item('New Scene'), { kind: 'submenu', label: 'Publish', items: [item('Web')] }];

  it('lands only on rows that can be chosen', () => {
    expect(items.map(isSelectable)).toEqual([true, false, false, true, true]);
  });

  it('walks down and up past separators and disabled rows, wrapping round', () => {
    expect(nextSelectable(items, -1, 1)).toBe(0);
    expect(nextSelectable(items, 0, 1)).toBe(3);
    expect(nextSelectable(items, 3, 1)).toBe(4);
    expect(nextSelectable(items, 4, 1)).toBe(0);
    expect(nextSelectable(items, -1, -1)).toBe(4);
    expect(nextSelectable(items, 3, -1)).toBe(0);
  });

  it('finds nothing in a menu with nothing to choose', () => {
    expect(nextSelectable([], -1, 1)).toBe(-1);
    expect(nextSelectable([sep, item('Undo', true)], -1, 1)).toBe(-1);
  });
});
