import { describe, it, expect } from 'vitest';
import { Material } from '../src/graphics/material';

/**
 * PBR materials now carry SEPARATE metallic / roughness / occlusion source maps, which the engine
 * combines into one packed ORM texture at render time (graphics/systems/texturePacker.ts).
 *
 * Two invariants matter here and both fail silently if broken:
 *
 *  1. Only the SOURCE maps are serialized. The packed texture is a GPU render target with no bytes
 *     behind it — if it ever leaked into a serialized material, publishing would ship a reference to a
 *     texture that cannot be encoded, and the material would come back with a missing map.
 *  2. A material saved before the split carried one `metallicRoughnessTexture`. It has to fan out onto
 *     BOTH source slots, because that pairing is what tells the packer the texture is already ORM-packed
 *     and can be reused verbatim. Fan out to only one slot and every old scene silently re-bakes its
 *     metal/rough map into a new texture with the channels in the wrong places.
 */

const pbr = (textures: any) => Material.PBR({ textures });

describe('PBR channel-packing source slots', () => {
  it('keeps metallic, roughness and occlusion as independent slots', () => {
    const m = pbr({ metallicMap: 'metal', roughnessMap: 'rough', occlusionMap: 'ao' });

    expect(m.textures.get('metallicMap')).toBe('metal');
    expect(m.textures.get('roughnessMap')).toBe('rough');
    expect(m.textures.get('occlusionMap')).toBe('ao');
    expect(m.properties.get('hasMetallicMap')).toBe(true);
    expect(m.properties.get('hasRoughnessMap')).toBe(true);
    expect(m.properties.get('hasOcclusionMap')).toBe(true);
  });

  it('leaves the flags false for slots with no map', () => {
    const m = pbr({ roughnessMap: 'rough' });

    expect(m.properties.get('hasRoughnessMap')).toBe(true);
    expect(m.properties.get('hasMetallicMap')).toBe(false);
    expect(m.properties.get('hasOcclusionMap')).toBe(false);
    expect(m.textures.has('metallicMap')).toBe(false);
  });

  it('fans a pre-packed metallicRoughnessTexture out to both source slots', () => {
    // The glTF import path and every scene saved before the split arrive this way. Both slots pointing
    // at one id is exactly what the packer reads as "already ORM-packed" -> identity, no bake.
    const m = pbr({ metallicRoughnessTexture: 'orm', occlusionMap: 'orm' });

    expect(m.textures.get('metallicMap')).toBe('orm');
    expect(m.textures.get('roughnessMap')).toBe('orm');
    expect(m.textures.get('occlusionMap')).toBe('orm');
  });

  it('prefers an explicit source map over the legacy packed one', () => {
    const m = pbr({ metallicRoughnessTexture: 'orm', metallicMap: 'metal' });

    expect(m.textures.get('metallicMap')).toBe('metal');
    expect(m.textures.get('roughnessMap')).toBe('orm');
  });

  it('round-trips the source slots through serialize/parse', () => {
    const round = Material.parse(pbr({
      baseColorTexture: 'albedo', metallicMap: 'metal', roughnessMap: 'rough',
      occlusionMap: 'ao', normalMap: 'normal', emissiveMap: 'emissive',
    }).serialize());

    expect(round.textures.get('metallicMap')).toBe('metal');
    expect(round.textures.get('roughnessMap')).toBe('rough');
    expect(round.textures.get('occlusionMap')).toBe('ao');
    expect(round.textures.get('baseColorTexture')).toBe('albedo');
  });

  it('migrates a legacy serialized material and re-saves it under the new keys', () => {
    const legacy = { type: 'pbr', textures: { metallicRoughnessTexture: 'orm', occlusionMap: 'ao' } };
    const migrated = Material.parse(legacy).serialize();

    expect(migrated.textures.metallicMap).toBe('orm');
    expect(migrated.textures.roughnessMap).toBe('orm');
    expect(migrated.textures.occlusionMap).toBe('ao');
    // The legacy key is read-only: it is never written back, so a project converges on the new shape.
    expect(migrated.textures.metallicRoughnessTexture).toBeUndefined();
  });

  it('never serializes the derived packed texture', () => {
    // The packer writes this slot on the live material every frame. Serializing it would publish a
    // reference to a GPU-only texture that has no bytes to ship.
    const m = pbr({ metallicMap: 'metal' });
    m.textures.set('ormTexture', '__packed__abc123');

    expect(m.serialize().textures.ormTexture).toBeUndefined();
    expect(Material.parse(m.serialize()).textures.has('ormTexture')).toBe(false);
  });
});
