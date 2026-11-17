import { describe, it, expect } from 'vitest';
import { SILENT_CONTEXT } from '../src/core/generator';
import { generateWorld } from '../src/world/generateWorld';
import { buildFields } from '../src/world/pipeline';
import { WORLD_PRESETS } from '../src/world/presets';
import { stockBiomeOf } from '../src/world/surfaces/presets';
import { terrainStats } from '../src/world/terrainStats';
import { normaliseWorld } from '../src/world/worldDoc';

// The World Creator's presets, held to what real land is (terrainStats.ts): slopes in the range such land
// has, no closed hollows but the lakes a preset means, rivers that steepen upstream, a sea where one is
// meant. At the fine preview's resolution, at the preset's own seed and at another (a preset drains
// whatever the seed: applying one keeps the artist's).

interface Expect {
  /** Mean slope over the land, degrees. */
  slope: [number, number];
  /** At most this many lakes. */
  lakes: number;
  /** Share of the map above the sea. */
  land: [number, number];
}

const EXPECT: Record<string, Expect> = {
  island: { slope: [20, 36], lakes: 2, land: [0.45, 0.8] },
  'coastal-range': { slope: [22, 38], lakes: 3, land: [0.6, 0.95] },
  alpine: { slope: [28, 40], lakes: 0, land: [0.95, 1] },
  hills: { slope: [4, 16], lakes: 0, land: [0.95, 1] },
  mesa: { slope: [4, 20], lakes: 0, land: [0.95, 1] },
  highlands: { slope: [8, 22], lakes: 1, land: [0.8, 1] },
  badlands: { slope: [12, 30], lakes: 0, land: [0.95, 1] },
};

describe('the world presets', { timeout: 120_000 }, () => {
  it('every preset is described, and starts with a stock surface set', () => {
    expect(Object.keys(EXPECT).sort()).toEqual(WORLD_PRESETS.map(p => p.id).sort());
    for (const p of WORLD_PRESETS) {
      expect(p.description, p.id).toBeTruthy();
      expect(stockBiomeOf(p.params().surfaces), p.id).not.toBeNull();
    }
  });

  for (const p of WORLD_PRESETS) {
    it(`"${p.label}" reads as land at its own seed and another`, async () => {
      const e = EXPECT[p.id];
      for (const seed of [undefined, 1234]) {
        const doc = normaliseWorld(p.params());
        if (seed !== undefined) doc.settings.seed = seed;
        const out = await generateWorld(doc, SILENT_CONTEXT, { resolution: 257 });
        const fields = buildFields(out, doc);
        const R = out.frame.resolution, kh = doc.settings.heightScale;
        const hm = Float32Array.from(out.heights, h => h * kh);
        const s = terrainStats(hm, R, doc.settings.size / (R - 1), doc.settings.seaLevel * kh, { hollowDepth: 2 });
        const tag = `${p.id} seed ${doc.settings.seed}`;
        expect(s.slopeMean, `${tag} mean slope`).toBeGreaterThan(e.slope[0]);
        expect(s.slopeMean, `${tag} mean slope`).toBeLessThan(e.slope[1]);
        expect(s.land, `${tag} land`).toBeGreaterThanOrEqual(e.land[0]);
        expect(s.land, `${tag} land`).toBeLessThanOrEqual(e.land[1]);
        // Drained: no closed hollow two metres deep over more than a hundredth of the land (the lakes it means aside).
        expect(s.hollows, `${tag} hollows`).toBeLessThan(0.02);
        expect(fields.water.lakes.length, `${tag} lakes`).toBeLessThanOrEqual(e.lakes);
        expect(hm.every(Number.isFinite), tag).toBe(true);
      }
    });
  }

  it('the island has the lake the Island example is built round', async () => {
    const doc = normaliseWorld(WORLD_PRESETS.find(p => p.id === 'island')!.params());
    const out = await generateWorld(doc, SILENT_CONTEXT, { resolution: 257 });
    const lakes = buildFields(out, doc).water.lakes;
    expect(lakes.length).toBeGreaterThanOrEqual(1);
    expect(lakes[0].area).toBeGreaterThan(6000);
  });
});
