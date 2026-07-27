import { describe, it, expect } from 'vitest';
import { TerrainMaterial, migrateFoliageRule, FOLIAGE_DENSITY_UNIT } from '../src/graphics/material';

/**
 * `density` used to mean two incompatible things: instances per 100x100 tile when regenerating a whole
 * terrain, and a flat per-stroke count in the brush. It now means instances per SQUARE METRE everywhere,
 * which changes what every already-saved rule's number is worth — so old rules divide by 100 on load.
 *
 * The migration therefore has to run EXACTLY once. Dividing twice is silent: the foliage simply comes
 * out 100x too sparse, which reads as "the generate button doesn't work". These tests pin the idempotence
 * rather than the arithmetic, because the arithmetic is the easy half.
 */

const legacyMaterial = (density: number) => ({
  type: 'blinn_phong',
  terrainMaterial: true,
  foliageInclude: [{ kind: 'billboard', name: 'grass', textureId: 'tex', density }], // no densityUnit
});

describe('foliage density unit migration', () => {
  it('divides a legacy rule by 100 on parse', () => {
    const tm = TerrainMaterial.parse(legacyMaterial(8));
    expect(tm.foliageInclude[0].density).toBeCloseTo(0.08, 10);
    expect(tm.foliageInclude[0].densityUnit).toBe(FOLIAGE_DENSITY_UNIT);
  });

  it('does not divide a second time across a serialize -> parse round trip', () => {
    const once = TerrainMaterial.parse(legacyMaterial(8));
    const twice = TerrainMaterial.parse(once.serialize());
    const thrice = TerrainMaterial.parse(twice.serialize());

    expect(twice.foliageInclude[0].density).toBeCloseTo(0.08, 10);
    expect(thrice.foliageInclude[0].density).toBeCloseTo(0.08, 10);
  });

  it('leaves an already-migrated rule alone', () => {
    const modern = {
      type: 'blinn_phong', terrainMaterial: true,
      foliageInclude: [{ kind: 'billboard', name: 'grass', density: 2.0, densityUnit: FOLIAGE_DENSITY_UNIT }],
    };
    expect(TerrainMaterial.parse(modern).foliageInclude[0].density).toBe(2.0);
  });

  it('stamps the unit on serialize so hand-built rules are never re-migrated', () => {
    // The editor's inspector pushes rules straight onto a live material, bypassing parse entirely.
    const tm = TerrainMaterial.Create('blinn_phong');
    tm.foliageInclude = [{ kind: 'billboard', name: 'grass', density: 2.0 }];

    expect(TerrainMaterial.parse(tm.serialize()).foliageInclude[0].density).toBe(2.0);
  });

  it('migrateFoliageRule is idempotent on its own', () => {
    const rule: any = { name: 'x', density: 4 };
    expect(migrateFoliageRule(rule).density).toBeCloseTo(0.04, 10);
    expect(migrateFoliageRule(rule).density).toBeCloseTo(0.04, 10);
    expect(migrateFoliageRule(rule).density).toBeCloseTo(0.04, 10);
  });

  it('defaults an absent density to the legacy 8 before migrating', () => {
    expect(migrateFoliageRule({ name: 'x' } as any).density).toBeCloseTo(0.08, 10);
  });

  it('carries a collision descriptor through the round trip', () => {
    const tm = TerrainMaterial.Create('pbr');
    tm.foliageInclude = [{
      kind: 'mesh', name: 'oak', density: 0.05, densityUnit: FOLIAGE_DENSITY_UNIT,
      collision: { shape: 'cylinder', radius: 0.4, height: 6 },
    }];

    const back = TerrainMaterial.parse(tm.serialize());
    expect(back.foliageInclude[0].collision).toEqual({ shape: 'cylinder', radius: 0.4, height: 6 });
  });
});
