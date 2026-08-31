import { describe, it, expect } from 'vitest';
import { impostorFraming, impostorTextureId } from '../src/utils/modelThumbnails';
import { addPreviewLights } from '../src/features/demoScene/createModelPreviewScene';

/**
 * The impostor bake, in the parts that do not need a GPU.
 *
 * Framing is the half most likely to be quietly wrong: a clip plane through the subject or a card sized
 * off the wrong axis produces a picture that looks plausible on its own and lines up with nothing in the
 * world. The card it feeds is `crossQuadGeometry(width, height)` and the runtime derives that same pair
 * from the prototype's box in `FoliageLayer._prototypeFootprint`, so the two have to agree exactly.
 */

const box = (min: [number, number, number], max: [number, number, number]) => ({ min, max });

describe('impostorFraming', () => {
  it('sizes the card the way the runtime footprint does', () => {
    // width = max(dx, dz), height = dy. A tree is tall and narrow, and depth must not become width.
    const f = impostorFraming(box([-1, 0, -3], [1, 20, 3]));
    expect(f.width).toBe(6);   // dz = 6 beats dx = 2
    expect(f.height).toBe(20);
  });

  it('centres the volume on the subject, not on the origin', () => {
    // A model authored away from the origin must still fill the frame.
    const f = impostorFraming(box([10, 5, 10], [14, 13, 14]));
    expect(f.position[0]).toBe(12);
    expect(f.position[1]).toBe(9);
  });

  it('makes the orthographic volume exactly the card', () => {
    const f = impostorFraming(box([-2, 0, -2], [2, 10, 2]));
    expect(f.right - f.left).toBeCloseTo(f.width, 10);
    expect(f.top - f.bottom).toBeCloseTo(f.height, 10);
  });

  it('keeps both clip planes clear of the subject', () => {
    // The failure this exists to stop: a near plane cutting into the canopy silently slices the front
    // off the card, and the result still looks like a tree.
    const b = box([-3, 0, -3], [3, 24, 3]);
    const f = impostorFraming(b);
    const camZ = f.position[2];
    // Distance from the camera to the nearest and farthest points of the subject, along -Z.
    const toNear = camZ - b.max[2];
    const toFar = camZ - b.min[2];
    expect(f.near).toBeLessThan(toNear);
    expect(f.far).toBeGreaterThan(toFar);
  });

  it('never emits a zero or negative near plane', () => {
    // A degenerate subject sitting on the camera would otherwise produce near <= 0, which is not a
    // projection at all.
    for (const b of [box([0, 0, 0], [0, 0, 0]), box([-0.001, 0, 0], [0.001, 0.001, 0])])
      expect(impostorFraming(b).near).toBeGreaterThan(0);
  });

  it('falls back to a unit card for a flat or empty subject', () => {
    // Matching `_prototypeFootprint`: a zero-area quad would draw nothing and read as a missing asset.
    const f = impostorFraming(box([0, 0, 0], [0, 0, 0]));
    expect(f.width).toBe(1);
    expect(f.height).toBe(1);
  });

  it('scales the whole volume with the subject', () => {
    const small = impostorFraming(box([-1, 0, -1], [1, 2, 1]));
    const large = impostorFraming(box([-10, 0, -10], [10, 20, 10]));
    expect(large.width).toBeCloseTo(small.width * 10, 10);
    expect(large.far).toBeGreaterThan(small.far);
  });
});

describe('impostorTextureId', () => {
  it('is deterministic, so a re-bake replaces the card a rule already points at', () => {
    // Otherwise the library accumulates an orphan sheet per bake and rules keep the first one forever.
    expect(impostorTextureId('oak')).toBe(impostorTextureId('oak'));
    expect(impostorTextureId('oak')).not.toBe(impostorTextureId('pine'));
  });
});

describe('addPreviewLights', () => {
  it('adds the key and fill without recursing', () => {
    // It recursed. Extracting the pair from `createModelPreviewScene` replaced the body of the new
    // function with a call to itself, and nothing caught it: no test touched the bake path, and the
    // harness exercises the RENDERER's impostor bucket rather than the editor's baker. One press of
    // "Bake impostor" was a stack overflow.
    const added: any[] = [];
    const scene = { addNode: (n: any) => added.push(n) } as any;
    addPreviewLights(scene);
    expect(added.map(n => n.name).sort()).toEqual(['fill', 'key']);
  });

  it('leaves both lights out of the shadow cascades', () => {
    // A preview capture has nothing to receive shadows and no cascades worth spending.
    const added: any[] = [];
    addPreviewLights({ addNode: (n: any) => added.push(n) } as any);
    for (const light of added) expect(light.castShadows).toBe(false);
  });
});
