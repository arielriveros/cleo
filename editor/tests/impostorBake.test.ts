import { describe, it, expect } from 'vitest';
import { Camera, CameraNode, Node } from 'cleo';
import { mat4, vec3, vec4 } from 'gl-matrix';
import { impostorFraming, impostorTextureId } from '../src/utils/modelThumbnails';
import { addPreviewLights } from '../src/features/demoScene/createModelPreviewScene';

/**
 * The impostor bake, in the parts that do not need a GPU.
 *
 * Framing is the half most likely to be quietly wrong: a clip plane through the subject or a card sized
 * off the wrong axis produces a picture that looks plausible on its own and lines up with nothing in the
 * world. The card it feeds is `crossQuadGeometry(width, height)` and the runtime derives that same pair
 * from the prototype's box in `FoliageLayer._prototypeFootprint`, so the two have to agree exactly.
 *
 * Aim belongs here too, and did not used to. A camera can be placed perfectly and pointed the wrong
 * way, and the capture that comes back is then a picture of nothing — which is indistinguishable from a
 * renderer fault, a missing texture or an asset that failed to instantiate. That is what happened: the
 * bake put the camera on the subject's +Z side and left its rotation at the identity, but engine forward
 * is +Z, so it looked away and every card baked empty for as long as the feature existed.
 */

const box = (min: [number, number, number], max: [number, number, number]) => ({ min, max });

const centreOf = (b: ReturnType<typeof box>): [number, number, number] =>
  [0, 1, 2].map(i => (b.min[i] + b.max[i]) / 2) as [number, number, number];

/**
 * The direction a node with this framing's placement actually faces, the way the renderer computes it:
 * `CameraNode.update` builds the look-at target from `Node.worldForward`, so that getter — not the
 * Euler triple — is what decides where the camera points.
 */
function facingOf(f: { position: [number, number, number]; rotation: [number, number, number] }) {
  const n = new Node('__probe');
  n.setPosition(f.position).setRotation(f.rotation);
  n.updateTransforms();
  return n.worldForward;
}

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

  it('puts the whole subject inside the clip volume', () => {
    // The end-to-end one, and the only case that exercises the framing the way the renderer consumes
    // it: Euler triple -> worldForward -> Camera.eye -> lookAt -> ortho -> clip space. Each half of
    // this was already covered on its own and the bake still captured nothing, because "placed right"
    // and "aimed right" were never checked against each other.
    //
    // Vertically the frame is FILLED — `height` is exactly `dy` — and that is what lets the square
    // sheet stretch back correctly over a `w x h` card. Horizontally it is `max(dx, dz)` on purpose:
    // the runtime card is billboarded, so it can be seen along either ground axis and has to be sized
    // for the wider one. A subject deeper than it is broad therefore leaves real slack at the sides,
    // and that slack is the card being the right size rather than the capture being mis-framed.
    for (const b of [box([-1, 0, -3], [1, 20, 3]),      // deeper than broad: slack in x
                     box([-4, 0, -4], [4, 9, 4])]) {    // square in plan: fills both axes
      const f = impostorFraming(b);

      const cam = new CameraNode('__probe__Camera', new Camera({
        type: 'orthographic',
        left: f.left, right: f.right, bottom: f.bottom, top: f.top, near: f.near, far: f.far,
      }));
      cam.setPosition(f.position).setRotation(f.rotation);
      cam.updateTransforms();
      cam.update(0, 0);                            // what `syncPreviewCamera` does before a capture
      cam.camera.resize(512, 512);                 // the capture is square, so aspect is 1

      const viewProj = mat4.multiply(mat4.create(), cam.camera.projectionMatrix, cam.camera.viewMatrix);
      let maxX = 0, maxY = 0;
      for (const x of [b.min[0], b.max[0]])
        for (const y of [b.min[1], b.max[1]])
          for (const z of [b.min[2], b.max[2]]) {
            const clip = vec4.transformMat4(vec4.create(), vec4.fromValues(x, y, z, 1), viewProj);
            const [cx, cy, cz] = [clip[0] / clip[3], clip[1] / clip[3], clip[2] / clip[3]];
            expect(Math.abs(cx)).toBeLessThanOrEqual(1 + 1e-6);
            expect(Math.abs(cy)).toBeLessThanOrEqual(1 + 1e-6);
            expect(Math.abs(cz)).toBeLessThanOrEqual(1 + 1e-6);   // between both clip planes
            maxX = Math.max(maxX, Math.abs(cx));
            maxY = Math.max(maxY, Math.abs(cy));
          }
      expect(maxY).toBeCloseTo(1, 6);                            // height IS dy
      expect(maxX).toBeCloseTo((b.max[0] - b.min[0]) / f.width, 6);
    }
  });

  it('aims the camera at the subject, not away from it', () => {
    // The relationship, never the literal `[0, 180, 0]`: an assertion on the Euler triple would have
    // been just as green against the broken value. What matters is that the direction the node ends up
    // FACING is the direction from the camera to the thing it is supposed to photograph.
    const b = box([-1, 0, -3], [1, 20, 3]);
    const f = impostorFraming(b);
    const c = centreOf(b);
    const facing = facingOf(f);
    const toSubject = [0, 1, 2].map(i => c[i] - f.position[i]);
    const len = Math.hypot(...toSubject);
    const dot = [0, 1, 2].reduce((s, i) => s + facing[i] * (toSubject[i] / len), 0);
    expect(dot).toBeCloseTo(1, 6);
  });

  it('keeps world +X on the right of the sheet', () => {
    // Aim alone does not settle it: the camera could face the subject from -Z instead, which frames the
    // model correctly and mirrors it. A card is looked at in the world beside the mesh it stands in for,
    // so the bake is a front elevation rather than a reflection of one. `Camera` builds its view with a
    // fixed world up, so screen-right is `cross(up, eye - target)`.
    const f = impostorFraming(box([-1, 0, -3], [1, 20, 3]));
    const facing = facingOf(f);
    const z = vec3.negate(vec3.create(), facing);                 // lookAt's +Z: target -> eye
    const right = vec3.cross(vec3.create(), vec3.fromValues(0, 1, 0), z);
    expect(right[0]).toBeCloseTo(1, 6);
  });

  it('keeps both clip planes clear of the subject', () => {
    // The failure this exists to stop: a near plane cutting into the canopy silently slices the front
    // off the card, and the result still looks like a tree.
    // The -Z arithmetic below is the framing's own convention, and it is only meaningful alongside the
    // aim case above — on its own it was describing a camera the baker never actually built.
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
