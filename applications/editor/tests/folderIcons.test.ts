import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { badgeStyles, folderIconFor, iconFor } from '../src/features/assets/assetKinds';
import { AssetKind, AUDIO_EXTS, KIND_LABEL } from '../src/utils/vfs';

// A folder holding exactly one kind of asset used to wear that kind's icon INSTEAD of a folder icon, so
// a folder of images was drawn as an image and the only thing left saying "folder" was a name the card
// ellipsizes at 80px. It now keeps the folder and badges the kind into a notch in its corner — the same
// relationship a thumbnailed card has with its type badge (see `badgeStyles`).

const KINDS = Object.keys(KIND_LABEL) as AssetKind[];

/** The decoded SVG source behind a `data:image/svg+xml;utf8,` URL. */
function svgOf(uri: string): string {
  expect(uri.startsWith('data:image/svg+xml;utf8,')).toBe(true);
  return decodeURIComponent(uri.slice('data:image/svg+xml;utf8,'.length));
}

describe('folderIconFor — badge, not replacement', () => {
  it('draws the folder AND the kind, for every kind', () => {
    // Exhaustive: a kind added to AssetKind with no glyph would produce `undefined` markup rather than
    // failing anywhere visible.
    const folderBody = svgOf(iconFor('folder')).match(/<path d="([^"]+)"/)![1];

    for (const kind of KINDS) {
      const svg = svgOf(folderIconFor(kind));
      // The folder outline is still there...
      expect(svg, kind).toContain(folderBody);
      // ...and so is the kind's own glyph, lifted verbatim out of its standalone icon.
      const own = svgOf(iconFor(kind));
      const firstShape = own.match(/<(?:path|rect|circle)[^>]*\/>/)![0];
      expect(svg, kind).toContain(firstShape);
    }
  });

  it('is neither of the two icons it is made from', () => {
    for (const kind of KINDS) {
      expect(folderIconFor(kind), kind).not.toBe(iconFor('folder'));
      expect(folderIconFor(kind), kind).not.toBe(iconFor(kind));
    }
    // And each kind gets a different one — a badge that collapsed to one image would be worse than none.
    expect(new Set(KINDS.map(folderIconFor)).size).toBe(KINDS.length);
  });

  it('cuts the corner out rather than covering it with a colour', () => {
    // A data URI cannot read a CSS variable, so an opaque chip would have to hard-code a background and
    // would be wrong in the other theme, and on the sidebar, and in the Add menu.
    const svg = svgOf(folderIconFor('model'));
    expect(svg).toMatch(/<mask id="b">/);
    expect(svg).toMatch(/mask="url\(#b\)"/);
    // Nothing that is actually PAINTED is opaque. The mask's own black and white are excluded: those
    // are luminance, not ink.
    const painted = svg.replace(/<mask id="b">.*?<\/mask>/s, '');
    expect(painted).not.toMatch(/fill="#[0-9a-f]{3,6}"(?![^>]*fill-opacity)/i);
  });

  it('keeps the badge inside the notch it cut', () => {
    // The glyphs are drawn in a 0..24 box; the transform must land that box inside the hole, or a glyph
    // with content at its edges (terrainMaterial starts at x=2) spills onto the folder outline.
    const svg = svgOf(folderIconFor('terrainMaterial'));
    const hole = svg.match(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="([\d.]+)" fill="#000"/)!;
    const [hx, hy, hw, hh, rx] = hole.slice(1).map(Number);
    const g = svg.match(/translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+)\)/)!;
    const [tx, ty, scale] = g.slice(1).map(Number);

    // The whole 24-unit box, inset by the corner radius so a rounded corner cannot clip a glyph edge.
    expect(tx).toBeGreaterThanOrEqual(hx);
    expect(ty).toBeGreaterThanOrEqual(hy);
    expect(tx + 24 * scale).toBeLessThanOrEqual(hx + hw);
    expect(ty + 24 * scale).toBeLessThanOrEqual(hy + hh);
    expect(rx).toBeLessThan(hw / 2);
  });

  it('compensates the stroke width for the scale', () => {
    // Stroke scales with the group: the set's 1.6 would come out under 0.7 and vanish at the 30px the
    // card renders an icon at.
    const svg = svgOf(folderIconFor('script'));
    const scale = Number(svg.match(/scale\(([\d.]+)\)/)![1]);
    const width = Number(svg.match(/stroke-width="([\d.]+)">/)![1]);
    expect(width * scale).toBeGreaterThan(1.2);
    expect(width * scale).toBeLessThan(1.8);
  });

  it('memoizes, since the file manager asks per card per render', () => {
    expect(folderIconFor('material')).toBe(folderIconFor('material'));
  });
});

describe('badgeStyles', () => {
  it('badges raw audio files too', () => {
    // The audio rules were built and then not spread into the returned CSS, so an .mp3 card was the one
    // thumbnail-less kind with no type badge.
    const css = badgeStyles();
    for (const ext of AUDIO_EXTS) expect(css, ext).toContain(`[data-id$="${ext}" i]`);
  });
});

describe('the explorer badges folders instead of replacing them', () => {
  it('calls folderIconFor for a single-kind folder', () => {
    const source = readFileSync(
      join(__dirname, '../src/features/assets/AssetsExplorer.tsx'), 'utf8').replace(/\r\n/g, '\n');

    expect(source).toContain('folderIconFor(only)');
    // The regression: `iconFor(only ?? 'folder')` swapped the folder icon out entirely.
    expect(source).not.toMatch(/iconFor\(only\b/);
  });
});
