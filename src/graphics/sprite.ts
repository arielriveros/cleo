import { Geometry } from '../core/geometry';
import { Mesh } from './mesh';
import { Material } from './material';

export class Sprite {
  private readonly  _geometry: Geometry;
  private readonly  _mesh: Mesh;
  private _material: Material;

  constructor(material: Material) {
      this._geometry = Geometry.Quad();
      this._mesh = new Mesh();
      this._material = material;
  }

  public get mesh(): Mesh { return this._mesh; }
  public get material(): Material { return this._material; }
  public get geometry(): Geometry { return this._geometry; }

  public static parse(data: any): Sprite {
    let material = Material.Basic({
        color: data.material.color,
        opacity: data.material.opacity,
        texture: data.material.texture},
        {
          side: data.material.config?.side,
          wireframe: data.material.config?.wireframe,
          transparent: data.material.config?.transparent,
          castShadow: data.material.config?.castShadow
      }
    );

    return new Sprite(material);
  }

  public serialize(): any {
    let material = {
      color: this._material.properties.get('color'),
      texture: this._material.textures.get('texture'),
      opacity: this._material.properties.get('opacity'),
      config: {
          side: this._material.config.side,
          wireframe: this._material.config.wireframe,
          transparent: this._material.config.transparent,
          castShadow: this._material.config.castShadow,
      }
    };

    return { material };
  }
}