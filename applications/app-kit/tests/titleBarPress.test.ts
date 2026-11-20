import { describe, it, expect } from 'vitest';
import { isTitleBarPress, type PressBar, type PressNode } from '../src/ui/titleBarPress';

// In the desktop app the menu bar is the window's title bar: a press on it drags the window, a double-click
// maximizes it. Everything the bar hosts bubbles its presses up through it too: the Projects browser opened
// from the logo, the dropdown menus, portals. Those must stay clicks, or no project can be picked.

interface Fake extends PressNode { tag: string; fixed?: boolean; control?: boolean }

function node(tag: string, parent: Fake | null, extra: Partial<Fake> = {}): Fake {
  const n: Fake = {
    tag, parentElement: parent, ...extra,
    closest(selector: string) {
      for (let p: Fake | null = n; p; p = p.parentElement as Fake | null) if (p.control) return p;
      void selector;
      return null;
    },
  };
  return n;
}

function bar(): Fake & PressBar {
  const b = node('bar', null) as Fake & PressBar;
  b.contains = (n: unknown) => {
    for (let p = n as PressNode | null; p; p = p.parentElement) if (p === b) return true;
    return false;
  };
  b.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1280, bottom: 30 });
  return b;
}

const position = (n: PressNode) => ((n as Fake).fixed ? 'fixed' : 'static');
const press = (b: PressBar, target: unknown, x = 600, y = 15) => isTitleBarPress(b, target, x, y, position);

describe('a press on the title bar', () => {
  it('drags on the bar and its plain parts (the title, the gaps)', () => {
    const b = bar();
    expect(press(b, b)).toBe(true);
    expect(press(b, node('span', node('div', b)))).toBe(true);
  });

  it('is a click on a control: the logo, a menu, the window buttons', () => {
    const b = bar();
    const button = node('button', b, { control: true });
    expect(press(b, node('svg', button))).toBe(false);
  });

  it('is a click inside a modal the bar hosts (the Projects browser), even over the bar\'s own strip', () => {
    const b = bar();
    const backdrop = node('div', node('div', b), { fixed: true });
    const card = node('div', node('div', backdrop));
    expect(press(b, card, 640, 300)).toBe(false);
    expect(press(b, card, 640, 10)).toBe(false);
    expect(press(b, backdrop, 20, 10)).toBe(false);
  });

  it('is a click on a dropdown hanging below the bar', () => {
    const b = bar();
    const menu = node('div', b);
    expect(press(b, node('div', menu), 80, 60)).toBe(false);
  });

  it('is a click on a portal: the bar\'s child in React, not in the page', () => {
    expect(press(bar(), node('div', node('body', null)))).toBe(false);
  });

  it('ignores a target that is not an element', () => {
    expect(press(bar(), null)).toBe(false);
    expect(press(bar(), {})).toBe(false);
  });
});
