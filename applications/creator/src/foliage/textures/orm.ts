// The bark's packed ORM map, in glTF's layout: R = ambient occlusion, G = roughness, B = metallic.
//
// The engine READS these channels as the surface's values (a map replaces the material's factor, it does
// not scale it -- chunks/pbrGBuffer.wgsl), and the .glb writes factors of 1 beside the map so glTF's
// "factor x texel" gives the same result in any other tool. So the material's own sliders are baked in
// here: roughness scales the roughness channel, metallic fills the metallic channel when no metallic map
// is given.
//
// Sources, lowest priority first:
//   1. generated -- AO and roughness from the procedural bark's relief (cracks darker and rougher);
//   2. a packed ARM/ORM image (a scan's `*_arm` map) -- all three channels;
//   3. a single-channel image per channel (`*_ao`, `*_rough`, `*_metal`) -- that channel only, read off
//      its red channel (greyscale maps store the same value in all three).

import { createImage, type Image } from './image';

export interface OrmSources {
  /** The generated bark's relief, 0..1 (0 = the bottom of a crack), size x size. */
  height?: Float32Array;
  /** A packed ARM/ORM image, already resized to size x size. */
  packed?: Image;
  ao?: Image;
  roughness?: Image;
  metallic?: Image;
}

export interface OrmSettings {
  /** The material's roughness: the generated roughness, or the factor a roughness map is scaled by. */
  roughness: number;
  /** The material's metallic: the value where no map gives one, or the factor a metallic map is scaled by. */
  metallic: number;
  /** How deep the generated cavities occlude, 0..1. */
  aoStrength: number;
}

const clamp01 = (x: number) => x < 0 ? 0 : x > 1 ? 1 : x;

export function ormMap(size: number, src: OrmSources, s: OrmSettings): Image {
  const out = createImage(size, size);
  const d = out.data;
  // A metallic map's own value is used as is unless the material asks for less; without one, the
  // material's metallic fills the channel.
  const metalScale = src.metallic || src.packed ? Math.min(1, s.metallic > 0 ? s.metallic : 1) : 0;
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    const h = src.height ? src.height[i] : 1;
    // Generated: cavities darken to (1 - aoStrength), and are a touch rougher than the plates' tops.
    let ao = 1 - s.aoStrength * (1 - h) * (1 - h * 0.5);
    let rough = s.roughness * (1.08 - 0.16 * h);
    let metal = s.metallic;
    if (src.packed) {
      const p = src.packed.data;
      ao = p[o] / 255; rough = (p[o + 1] / 255) * s.roughness; metal = (p[o + 2] / 255) * metalScale;
    }
    if (src.ao) ao = src.ao.data[o] / 255;
    if (src.roughness) rough = (src.roughness.data[o] / 255) * s.roughness;
    if (src.metallic) metal = (src.metallic.data[o] / 255) * metalScale;
    d[o] = Math.round(clamp01(ao) * 255);
    d[o + 1] = Math.round(clamp01(rough) * 255);
    d[o + 2] = Math.round(clamp01(metal) * 255);
    d[o + 3] = 255;
  }
  return out;
}
