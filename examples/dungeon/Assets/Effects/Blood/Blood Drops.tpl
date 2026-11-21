{
  "id": "9bd3bd60b36803c24417cf13093e0136",
  "name": "Blood Drops",
  "nodeJson": {
    "id": "ac8854b2cfb6d7d4244ef0c631afb006",
    "name": "Blood Drops",
    "type": "node",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1],
    "children": [
      {
        "id": "983ac2cbaeac16bb462e89dfca0979c7",
        "name": "Decal",
        "type": "decal",
        "position": [0.0105, 0, 0.21825],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
        "children": [],
        "variables": {
          "__materialId": {
            "type": "string",
            "value": "7f1c7815561e409ea5bf0c4c13e8250d",
            "access": "public"
          }
        },
        "spawnOnStart": true,
        "decal": {
          "size": [0.996, 0.4, 0.8835],
          "opacity": 1,
          "sortOrder": 0,
          "angleFade": 0.35,
          "depthFade": 0.25,
          "affects": {
            "albedo": true,
            "normal": true,
            "surface": true,
            "emissive": false
          },
          "receivers": "all",
          "pattern": "material",
          "material": {
            "type": "pbr",
            "baseColor": [1, 1, 1],
            "metallic": 0,
            "roughness": 1,
            "reflectance": 0.5,
            "opacity": 1,
            "emissiveFactor": [0, 0, 0],
            "emissiveIntensity": 1,
            "textures": {
              "baseColorTexture": "d88596b430c455d1e99953a4dc4286e4",
              "metallicRoughnessTexture": "13d83f4367b7e64a8afbe7d3d9e3ae06",
              "occlusionMap": "13d83f4367b7e64a8afbe7d3d9e3ae06",
              "normalMap": "abb1275c521aca6df2499615e2c3d791"
            },
            "config": {
              "side": "front",
              "wireframe": false,
              "transparent": false,
              "castShadow": false,
              "probeable": true
            }
          },
          "albedoOpacity": 0.997,
          "flipbook": {
            "columns": 4,
            "rows": 4,
            "frames": 16,
            "fps": 8,
            "loop": false,
            "blend": true
          }
        }
      }
    ],
    "variables": {
      "__scriptId": {
        "type": "string",
        "value": "db0e6f860cce40a79b8f0da69731607b",
        "access": "public"
      }
    },
    "spawnOnStart": true,
    "script": "import { Node } from 'cleo'\nimport { attribute } from 'cleo/decorators'\nimport { clamp, num } from '@/Core/Scripts/SoulsMath'\n\n/**\n * Hollow Keep — a blood decal on the ground. Attach to the root of a template whose children include\n * Decal nodes (`Blood Splat`, `Blood Drops`); the GameManager instantiates one where a hit lands and\n * sets `yaw` and `sizeScale` on it (see `bleed`).\n *\n * On its first frame it finds the floor below with a raycast, moves there and tilts so its decals\n * project straight into the surface — a ramp included — then gives them a random size. It removes\n * itself when there is no floor in reach: blood is never left hanging over a drop. After `lifetime`\n * it fades out over `fadeSeconds` and is removed.\n *\n * Placement waits for the first update rather than onStart, so the spawner's `yaw` and `sizeScale` are\n * in place whichever runs first; the decals stay invisible until then. A decal with a flipbook (the FX\n * Creator's liquid decals: the blood landing and spreading) plays it from that moment, `flipbookStart`\n * seconds in.\n */\nexport default class SoulsBloodSplatNode extends Node {\n  /** Seconds before the splat is gone, its fade included. */\n  @attribute\n  public lifetime: number = 12\n  /** The last part of `lifetime`, over which the decals fade out. */\n  @attribute\n  public fadeSeconds: number = 3\n  /** Random size range, as a multiple of each decal's authored size. */\n  @attribute\n  public minSize: number = 0.65\n  @attribute\n  public maxSize: number = 1.25\n  /** How far below the spawn point the floor may be. */\n  @attribute\n  public snapDown: number = 2.5\n  /** Tilt onto sloped ground. Off, the splat lies flat and the decal's angle fade handles the slope. */\n  @attribute\n  public alignToSurface: boolean = true\n  /** Set by the spawner. Which way the decal's +Z points, in degrees; NaN for a random turn. */\n  @attribute\n  public yaw: number = NaN\n  /** Set by the spawner: a bigger hit leaves a bigger splat. */\n  @attribute\n  public sizeScale: number = 1\n  /**\n   * Seconds into a decal's flipbook it starts from: skip the frames before the liquid reaches the floor\n   * when nothing else (a spray of droplets) covers that gap. 0 plays it from its first frame.\n   */\n  @attribute\n  public flipbookStart: number = 0\n\n  private _age: number = 0\n  private _placed: boolean = false\n  private _decals: any[] = []\n  private _sizes: number[][] = []\n  /** Each decal's authored place under the root (a liquid bake's decal stands where its liquid lay). */\n  private _offsets: number[][] = []\n\n  onStart() {\n    this._decals = this.children.filter(c => c.nodeType === 'decal')\n    this._sizes = this._decals.map(d => [...d.size])\n    this._offsets = this._decals.map(d => [d.position[0], d.position[1], d.position[2]])\n    for (const d of this._decals) d.opacity = 0\n  }\n\n  onUpdate(delta: number) {\n    if (!this._placed) {\n      this._placed = true\n      if (!this._place()) { this.remove({ immediate: true }); return }\n    }\n    this._age += delta\n    const fade = Math.max(0.01, this.fadeSeconds)\n    const k = clamp((this.lifetime - this._age) / fade, 0, 1)\n    for (const d of this._decals) d.opacity = k\n    // Its own opacity fade has already run; nothing is left to dissolve.\n    if (this._age >= this.lifetime) this.remove({ immediate: true })\n  }\n\n  /** Snap onto the floor below, turn, size. False when there is no floor in reach. */\n  private _place(): boolean {\n    // Spawned this frame, its world matrix may not have been computed yet: do it now, from the parent's.\n    this.updateTransforms(this.parent ? this.parent.worldTransform : null)\n    const p = this.worldPosition\n    const physics = this.scene?.physics as any\n    const hit = physics?.raycast?.([p[0], p[1] + 0.5, p[2]], [p[0], p[1] - this.snapDown, p[2]], {\n      reject: (owner: Node) => isCharacterPart(owner),\n    })\n    if (!hit) return false\n\n    const yaw = Number.isFinite(this.yaw) ? this.yaw : Math.random() * 360\n    const n = hit.normal\n    // Local +Y onto the surface normal: rotations compose Ry(yaw)·Rx(pitch), and Rx(p)·(0,1,0) turned by\n    // Ry(y) is (sin p sin y, cos p, sin p cos y). That spends the root's yaw on the slope's own heading, so\n    // on a slope the decals turn the rest of the way about the normal themselves: the spatter still runs\n    // along the blow.\n    const tilt = this.alignToSurface ? Math.acos(clamp(n[1], -1, 1)) * 180 / Math.PI : 0\n    const heading = Math.atan2(n[0], n[2]) * 180 / Math.PI\n    const sloped = tilt > 2\n    this.setPosition([hit.point[0], hit.point[1], hit.point[2]])\n    this.setRotation(sloped ? [tilt, heading, 0] : [0, yaw, 0])\n    const turn = sloped ? yaw - heading : 0\n    for (const d of this._decals) d.setRotation([0, turn, 0])\n\n    const scale = num(this.sizeScale, 1) * (this.minSize + Math.random() * Math.max(0, this.maxSize - this.minSize))\n    const c = Math.cos(turn * Math.PI / 180), sn = Math.sin(turn * Math.PI / 180)\n    this._decals.forEach((d, i) => {\n      const s = this._sizes[i]\n      // Height stays: it is how far the projection reaches, not how big the splat looks.\n      d.size = [s[0] * scale, s[1], s[2] * scale]\n      // Its place scales with it, and turns with it on a slope (Ry(turn), as its own rotation).\n      const o = this._offsets[i]\n      d.setPosition([(o[0] * c + o[2] * sn) * scale, o[1], (-o[0] * sn + o[2] * c) * scale])\n      d.opacity = 1\n      if (d.flipbook) d.flipbookTime = Math.max(0, num(this.flipbookStart, 0))\n    })\n    return true\n  }\n}\n\n/** A character, or anything inside one (a ragdolled limb): blood lands on the floor, not on a body. */\nfunction isCharacterPart(owner: Node): boolean {\n  // A character's body is its Collider, which holds the character.\n  if (owner?.character) return true\n  for (let n: Node = owner; n; n = n.parent) if (n.nodeType === 'character') return true\n  return false\n}\n",
    "scriptVars": {
      "minSize": 0.85,
      "maxSize": 1.15,
      "flipbookStart": 0.25
    }
  },
  "textureIds": [
    "d88596b430c455d1e99953a4dc4286e4",
    "abb1275c521aca6df2499615e2c3d791",
    "13d83f4367b7e64a8afbe7d3d9e3ae06"
  ],
  "scripts": {},
  "bodies": {},
  "triggers": {}
}
