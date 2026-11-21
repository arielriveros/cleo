{
  "id": "20a2e2bd4133caf56852609a6033758d",
  "name": "Weapon",
  "nodeJson": {
    "id": "8e18382c2839fb29f2e8fbb5600618f2",
    "name": "Weapon",
    "type": "node",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1],
    "children": [
      {
        "id": "16a0ae6607aede4db015a2d65550be5b",
        "name": "Mesh",
        "type": "node",
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
        "children": [],
        "variables": {},
        "spawnOnStart": true
      },
      {
        "id": "b6f26d917aac25057fc5dfee7aa45a7a",
        "name": "Sounds",
        "type": "node",
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
        "children": [
          {
            "id": "895b076431dd19eb04820eaa8d62989b",
            "name": "Hit",
            "type": "sound",
            "position": [0, 0, 0],
            "rotation": [0, 0, 0],
            "scale": [1, 1, 1],
            "children": [],
            "variables": {},
            "spawnOnStart": true,
            "sound": {
              "mode": "spatial",
              "sampleId": null,
              "volume": 1,
              "loopMode": "inherit",
              "playOnStart": false,
              "distanceModel": "inverse",
              "refDistance": 2,
              "maxDistance": 40,
              "rolloffFactor": 1
            }
          }
        ],
        "variables": {},
        "spawnOnStart": true
      }
    ],
    "variables": {
      "__scriptId": {
        "type": "string",
        "value": "d7105dc67261ef28ea7bc4b2743b6cda",
        "access": "public"
      }
    },
    "spawnOnStart": true,
    "socketAttachment": {
      "target": "parent",
      "socket": "RightHand"
    },
    "script": "import { Node } from 'cleo'\nimport { find, attribute } from 'cleo/decorators'\nimport type { NodeName, SoundName, TemplateName, Vec3 } from 'cleo'\nimport { num, statBonus } from '@/Core/Scripts/SoulsMath'\nimport { playSound } from '@/Core/Scripts/SoulsAudio'\n\n/**\n * Hollow Keep — the base WEAPON. Every weapon is its own template, made from the base \"Weapon\" template\n * as a VARIANT, with its own script extending this one:\n *\n *   Weapon (template)            this script; Socket: RightHand (attach to socket, target parent)\n *   └── Mesh                     the visible weapon — its local transform IS the grip\n *\n *   Longsword (variant)          SoulsLongsword extends SoulsWeapon — its stats are that class's defaults\n *   ├── Mesh                     inherited, given the sword's parts and grip\n *   ├── Light1 Light2 Light3     SoulsMove data nodes, added by the variant — the moveset and its clips\n *   └── Heavy\n *\n * A character does not carry its weapons in its template. It names them (`weaponTemplates` on\n * SoulsCharacter) and spawns them on start, into the hand. So one \"Club\" template arms every Hollow,\n * and a change to it reaches them all.\n *\n * The weapon owns everything about itself: its numbers, its hitbox, its moves (with the clips the wielder\n * plays), and the maths that turns a swing into damage (`attackRating`, `hitFor`, `strike`). The wielder\n * only decides WHEN to swing and WHAT the blade reached.\n *\n * The weapon node itself is driven by the socket every frame, so never offset IT to fix a grip: rotate\n * and move the `Mesh` child instead (see SOULS_DEMO.md, \"Swapping a weapon\").\n *\n * ## Hitbox\n *\n * `bladeStart`/`bladeEnd`/`bladeRadius` is a capsule along the blade, in the `Mesh` child's space. The\n * first swing builds it as a TRIGGER on a `Hitbox` child of the Mesh; the attack's clip events switch it\n * on (`hit`) and off (`hitEnd`), and the hurtboxes it enters are what the swing damages (SoulsHitbox).\n *\n * ## Attack rating\n *\n *   AR = baseDamage × (1 + strScaling·bonus(STR) + dexScaling·bonus(DEX)),  × unmetRequirementPenalty\n *        when a requirement is unmet\n */\nexport default class SoulsWeaponNode extends Node {\n  @attribute\n  public displayName: string = 'Weapon'\n  @attribute\n  public baseDamage: number = 100\n  /** How fully the weapon scales with each stat: 1.0 is an \"A\", 0.2 an \"E\". */\n  @attribute\n  public strScaling: number = 0\n  @attribute\n  public dexScaling: number = 0\n  @attribute\n  public strRequirement: number = 0\n  @attribute\n  public dexRequirement: number = 0\n  /** Attack-rating multiplier when the wielder misses a STR or DEX requirement. */\n  @attribute\n  public unmetRequirementPenalty: number = 0.6\n  /** Poise damage per hit, before the move's own multiplier. */\n  @attribute\n  public poiseDamage: number = 15\n  /** Multiplies every move's stamina cost. */\n  @attribute\n  public staminaMul: number = 1\n  /** First move of the light chain, and the heavy attack. Names of child SoulsMove nodes. */\n  @attribute\n  public lightMove: NodeName = 'Light1'\n  @attribute\n  public heavyMove: NodeName = 'Heavy'\n  /** The blade hitbox capsule, in the Mesh child's space. See \"Hitbox\" above. */\n  @attribute\n  public bladeStart: Vec3 = [0, 0.12, 0]\n  @attribute\n  public bladeEnd: Vec3 = [0, 1, 0]\n  @attribute\n  public bladeRadius: number = 0.12\n  /**\n   * Real seconds game time slows for when a hit of this weapon lands (the GameManager's hit-stop), for the\n   * light moves and for the heavy move. A killing blow holds it longer. 0 turns it off for this weapon.\n   */\n  @attribute\n  public hitStop: number = 0.15\n  @attribute\n  public heavyHitStop: number = 0.22\n  /** Camera kick when a hit lands (the GameManager's shake), light and heavy. */\n  @attribute\n  public hitShake: number = 0.12\n  @attribute\n  public heavyHitShake: number = 0.25\n  /**\n   * Effect spawned where the blade meets a WALL (the swing bounces off it: SoulsPlayer/SoulsEnemy). A blade\n   * meeting a body draws blood instead (GameManager.bleed). And the sound of a hit.\n   */\n  @attribute\n  public hitSparkTemplate: TemplateName = 'Hit Spark'\n  @attribute\n  public hitSound: SoundName = 'Hit'\n  /** Marker characters look for among the nodes they spawn (a script class is never `instanceof`). */\n  @attribute\n  public isWeapon: boolean = true\n\n  @find('GameManager')\n  protected _gm: Node = null\n\n  onStart() {\n  }\n\n  /** The child SoulsMove named `name`, or null. */\n  public findMove(name: string): Node {\n    if (!name) return null\n    const found = this.getChildByName(name)[0]\n    return found && (found as any).isMove ? found : null\n  }\n\n  /** Every move, in hierarchy order. */\n  public moves(): Node[] {\n    return this.children.filter(c => (c as any).isMove)\n  }\n\n  /** This weapon's attack rating in the hands of someone with these stats. See \"Attack rating\". */\n  public attackRating(strength: number, dexterity: number): number {\n    let ar = this.baseDamage * (1 + this.strScaling * statBonus(strength) + this.dexScaling * statBonus(dexterity))\n    if (strength < this.strRequirement || dexterity < this.dexRequirement) ar *= this.unmetRequirementPenalty\n    return Math.round(ar)\n  }\n\n  /**\n   * What one hit of `move` deals when `wielder` swings this: attack rating (from the wielder's own\n   * STR/DEX, 10 when it has none) × the move's damage multiplier, and poise × the move's poise multiplier.\n   */\n  public hitFor(wielder: Node, move: any): { damage: number; poise: number } {\n    const w = wielder as any\n    const ar = this.attackRating(num(w?.strength, 10), num(w?.dexterity, 10))\n    return {\n      damage: Math.round(ar * num(move?.damageMul, 1)),\n      poise: this.poiseDamage * num(move?.poiseMul, 1),\n    }\n  }\n\n  /**\n   * The blade reached `target`'s hurtbox at `point` during `move`. The target takes the hit through its\n   * own `receiveHit` (its defence, its poise, its reaction are its business), with the point, where a body\n   * bleeds. No sparks: those are for a blade meeting a wall. Returns true if it landed.\n   */\n  public strike(wielder: Node, move: any, target: Node, point: ArrayLike<number>): boolean {\n    const t = target as any\n    if (!wielder || typeof t?.receiveHit !== 'function') return false\n    const { damage, poise } = this.hitFor(wielder, move)\n    if (!t.receiveHit(damage, poise, wielder, point ?? undefined)) return false\n    const gm = (this._gm ?? this.findNode?.('GameManager')) as any\n    playSound(this, this.hitSound)\n    const heavy = !!move && move.name === this.heavyMove\n    gm?.hitStop?.(heavy ? this.heavyHitStop : this.hitStop, !!t.isDead)\n    if (wielder === gm?.player) gm?.shake?.(heavy ? this.heavyHitShake : this.hitShake)\n    return true\n  }\n}\n",
    "scriptVars": {}
  },
  "textureIds": [],
  "scripts": {},
  "bodies": {},
  "triggers": {}
}
