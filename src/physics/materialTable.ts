import { ContactMaterial, Material, World } from 'cannon-es';

/**
 * A world's surfaces: one cannon Material per `friction|restitution`, created on first use and paired with
 * every other known one. cannon has no combination rule: it applies a registered ContactMaterial ONLY when
 * both bodies carry a material, else the pair silently falls back to the world default. Friction combines
 * as MIN, restitution as MAX.
 *
 * Materials are named by their key, which is how the physics worker (physics/worker/) rebuilds the same
 * surface for a body it is told about. A leaf: cannon-es only.
 */
export class MaterialTable {
  private readonly _materials = new Map<string, Material>();

  constructor(private readonly _world: World) {}

  /** The material for a surface, created (and paired with every other) on first use. */
  public materialFor(friction: number, restitution: number): Material {
    const key = `${friction}|${restitution}`;
    const cached = this._materials.get(key);
    if (cached) return cached;

    const material = new Material(key);
    for (const [otherKey, other] of this._materials) {
      const [otherFriction, otherRestitution] = otherKey.split('|').map(Number);
      this._world.addContactMaterial(new ContactMaterial(material, other, {
        friction: Math.min(friction, otherFriction),
        restitution: Math.max(restitution, otherRestitution),
      }));
    }
    this._world.addContactMaterial(new ContactMaterial(material, material, { friction, restitution }));

    this._materials.set(key, material);
    return material;
  }

  /** The material named `key` (`friction|restitution`), or null for a key that is not one. */
  public forKey(key: string | null | undefined): Material | null {
    if (!key) return null;
    const cached = this._materials.get(key);
    if (cached) return cached;
    const [f, r] = key.split('|').map(Number);
    return Number.isFinite(f) && Number.isFinite(r) ? this.materialFor(f, r) : null;
  }
}
