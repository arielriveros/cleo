{
  "id": "81b29eae60dd51dade5ae6d1d3ca32e7",
  "name": "Player",
  "nodeJson": {
    "type": "collider",
    "name": "Player Collider",
    "id": "f569b1f64a57cd501c8bb7b31c83eba9:collider",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1],
    "collider": {
      "mass": 70,
      "linearDamping": 0,
      "angularDamping": 0,
      "linearConstraints": [1, 1, 1],
      "angularConstraints": [0, 0, 0],
      "friction": 0,
      "restitution": 0,
      "simulatePhysics": true,
      "groundProbeDistance": 0.12,
      "motionSmoothing": 0,
      "shapes": [
        {
          "type": "capsule",
          "radius": 0.3,
          "height": 1.78,
          "numSegments": 16,
          "offset": [0, 0.89, 0],
          "rotation": [0, 0, 0]
        }
      ],
      "simulationMode": "always",
      "layer": 1
    },
    "children": [
      {
        "id": "f569b1f64a57cd501c8bb7b31c83eba9",
        "name": "Player",
        "type": "character",
        "children": [
          {
            "id": "faa43db6ed18dda924b3c125bb09e2b7",
            "name": "camera rig",
            "type": "cameraRig",
            "position": [0, 1.5, 0],
            "rotation": [0, 0, 0],
            "scale": [1, 1, 1],
            "children": [
              {
                "name": "camera",
                "id": "f5f6bf33d2f9795e38df0ef692ae02c8",
                "type": "camera",
                "position": [0, 0, -5],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1],
                "children": [],
                "variables": {},
                "spawnOnStart": true,
                "camera": {
                  "type": "perspective",
                  "fov": 73,
                  "near": 0.1,
                  "far": 3000,
                  "left": -1,
                  "right": 1,
                  "bottom": -1,
                  "top": 1
                },
                "active": true,
                "screenMaterials": []
              }
            ],
            "variables": {
              "__scriptId": {
                "type": "string",
                "value": "bcb122a89dac4287ff7315e61288e5ab",
                "access": "public"
              }
            },
            "spawnOnStart": true,
            "followId": "8ce5dff09d6770739a24a356a2fe4bfd",
            "lookAtId": null,
            "cameraNodeId": null,
            "followOffset": [0, 1.5, 0],
            "followSpace": "world",
            "followDamping": [0.04, 0.08, 0.04],
            "followDampingSpace": "world",
            "aimMode": "orbit",
            "lookAtOffset": [0, 0, 0],
            "aimDamping": 0.08,
            "yaw": 0,
            "pitch": 0,
            "yawSensitivity": 0.2,
            "pitchSensitivity": 0.2,
            "invertPitch": false,
            "yawMin": null,
            "yawMax": null,
            "pitchMin": -40,
            "pitchMax": 65,
            "armLength": 2.4,
            "socketOffset": [0, 0.35, 0],
            "fovEnabled": false,
            "fov": 60,
            "fovDamping": 0.2,
            "collisionEnabled": true,
            "collisionRadius": 0.2,
            "collisionMinRatio": 0.05,
            "collisionPullTime": 0,
            "collisionReturnTime": 0.35,
            "collisionIgnoreIds": [],
            "shakePositionAmplitude": [0.15000000596046448, 0.15000000596046448, 0.05000000074505806],
            "shakeRotationAmplitude": [1.5, 1.5, 2.5],
            "shakeFrequency": 22,
            "shakeDecay": 1.4,
            "scriptVars": {
              "lockedArmLength": 1.6
            },
            "script": "import { CameraRigNode, Input, Node, dampTime } from 'cleo'\nimport { find, onAction, attribute } from 'cleo/decorators'\nimport { angleDiff, planarDistance, yawTo } from '@/Core/Scripts/SoulsMath'\nimport { playSound } from '@/Core/Scripts/SoulsAudio'\n\n/**\n * Hollow Keep — the third-person camera with target lock. Attach to the Player's `camera rig`, a Camera\n * Rig node that sits BEFORE the Player Controller among the Player's children.\n *\n * Free: an ordinary orbit camera the controller steers with Look.\n *\n * Locked: the rig switches to `aimMode = 'lookAt'` on the target's `LockPoint`, so the camera holds the\n * enemy in frame by itself. The controller keeps writing the rig's yaw into the intent as the aim, which\n * is what makes the player STRAFE around the target — SoulsPlayer sets `facingMode = 'aim'` while locked.\n *\n *   LockOn                   toggle. With nothing to lock, it re-centres the camera behind the player.\n *   SwitchTargetLeft/Right   cycle (keys); a hard flick of the right stick or the mouse does the same\n *\n * Candidates are the manager's live enemies within `lockRange` and in line of sight, ranked by angle off\n * the camera's forward and then by distance (rankLockTargets, below). The lock breaks past\n * `breakRange`, after `losBreakSeconds` behind a wall, or when the target dies — in which case another\n * enemy within `retargetRange` is picked up, as the games do.\n *\n * The reticle is a world-space UI Root named `LockReticle`, a child of the player beside this rig. Its\n * `uiTargetId` is kept pointed at the\n * target's lock point.\n *\n * Framing: while locked, the boom eases in to `lockedArmLength` and over the shoulder to\n * `lockedSocketOffset`, so the fight fills the frame; unlocking eases it back out to the authored values.\n * Both blend over `lockBlendSeconds` — the rig itself does not damp its arm, so a snap would be a cut.\n */\nexport default class SoulsLockOnNode extends CameraRigNode {\n  @attribute\n  public lockRange: number = 20\n  @attribute\n  public breakRange: number = 26\n  /** Seconds the target may stay hidden behind geometry before the lock lets go. */\n  @attribute\n  public losBreakSeconds: number = 1.5\n  /** Seconds between two target switches, so one flick switches once. */\n  @attribute\n  public switchCooldown: number = 0.35\n  /** Right-stick deflection (scaled ×4 in the map) that counts as a flick. */\n  @attribute\n  public stickFlick: number = 2.6\n  /**\n   * Mouse speed, in pixels per SECOND, that counts as a flick. A per-frame pixel threshold made switching\n   * targets harder the higher the frame rate, since the same flick is spread over more frames.\n   */\n  @attribute\n  public mouseFlickPerSecond: number = 2700\n  /** Pitch limits while locked (positive looks down). Keeps a tall boss from flipping the camera. */\n  @attribute\n  public lockedPitchMin: number = -25\n  @attribute\n  public lockedPitchMax: number = 35\n  @attribute\n  public reticleName: string = 'LockReticle'\n  /** When the target dies, the lock jumps to another enemy only if one is this close. */\n  @attribute\n  public retargetRange: number = 10\n  /** Boom length while locked: closer than the free camera, for a tighter view of the fight. */\n  @attribute\n  public lockedArmLength: number = 2.3\n  /**\n   * Pivot offset while locked (rig space: +X is the rig's LEFT, +Y up) — negative X, so the camera sits\n   * over the RIGHT shoulder and the target is framed past it.\n   */\n  @attribute\n  public lockedSocketOffset: [number, number, number] = [-0.6, 0.15, 0]\n  /** Seconds the camera takes to move in on a lock, and back out on release. */\n  @attribute\n  public lockBlendSeconds: number = 0.3\n\n  /** The locked enemy (a SoulsEnemy root), or null. SoulsPlayer reads this. */\n  public lockTarget: Node = null\n\n  @find('GameManager')\n  private _gm: Node = null\n  private _player: Node = null\n  private _reticle: Node = null\n  private _hiddenFor: number = 0\n  private _switchWait: number = 0\n  private _freePitchMin: number = -80\n  private _freePitchMax: number = 80\n  private _freeArmLength: number = 4\n  private _freeSocket: [number, number, number] = [0, 0, 0]\n\n  onStart() {\n    this._player = this.parent\n    // The reticle is the player's (a sibling of this rig, inside the Player template).\n    this._reticle = this._player?.getChildByName(this.reticleName)[0] ?? null\n    this._freePitchMin = this.pitchMin\n    this._freePitchMax = this.pitchMax\n    this._freeArmLength = this.armLength\n    this._freeSocket = [this.socketOffset[0], this.socketOffset[1], this.socketOffset[2]]\n    this.aimMode = 'orbit'\n    this._showReticle(null)\n    // Start behind the player, whichever way the level placed them: the orbit's yaw is a world angle\n    // and does not follow the player's own rotation.\n    if (this._player) {\n      const f = this._player.worldForward\n      this.yaw = Math.atan2(f[0], f[2]) * 180 / Math.PI\n    }\n  }\n\n  /** The lock-on press: release the target, or lock the best one, or recentre the camera behind the player. */\n  @onAction('LockOn')\n  private _onLockOn(): void {\n    if ((this._player as any)?.isDead) return\n    if (this.lockTarget) this.unlock()\n    else if (!this._lockBest()) this._recenter()\n  }\n\n  onUpdate(delta: number) {\n    this._switchWait = Math.max(0, this._switchWait - delta)\n    const player = this._player as any\n    if (player?.isDead) { if (this.lockTarget) this.unlock(); return }\n\n    // Every frame, locked or not, so a release eases back out rather than stopping where it was. Runs\n    // before the rig's lateUpdate, so the boom it builds this frame already uses these values.\n    this._frame(delta)\n    if (!this.lockTarget) return\n\n    // Lost?\n    const target = this.lockTarget as any\n    if (!target || target.isDead || target.spawned === false || !this.scene?.getNodeById(this.lockTarget.id)) {\n      this.onTargetDied(this.lockTarget)\n      return\n    }\n    const me = this._player.worldPosition\n    const at = this.lockTarget.worldPosition\n    if (Math.hypot(at[0] - me[0], at[2] - me[2]) > this.breakRange) { this.unlock(); return }\n    this._hiddenFor = this._hasLineOfSight(this.lockTarget) ? 0 : this._hiddenFor + delta\n    if (this._hiddenFor > this.losBreakSeconds) { this.unlock(); return }\n\n    // Switching.\n    let dir = 0\n    if (Input.started('SwitchTargetLeft')) dir = 1\n    if (Input.started('SwitchTargetRight')) dir = -1\n    if (!dir && this._switchWait <= 0) {\n      const look = Input.vector('Look')\n      const device = Input.device('Look')\n      // A stick is a deflection; a mouse delta is distance this frame, so it is turned into a speed.\n      const amount = device === 'gamepadAxis' ? Math.abs(look[0]) : Math.abs(look[0]) / Math.max(delta, 1e-3)\n      const flick = device === 'gamepadAxis' ? this.stickFlick : this.mouseFlickPerSecond\n      // Look X is positive to the RIGHT; right means a clockwise (negative) yaw step.\n      if (amount >= flick) dir = look[0] > 0 ? -1 : 1\n    }\n    if (dir) this._switch(dir)\n  }\n\n  /** Drop the lock and hand the camera back to the player. */\n  public unlock(): void {\n    this.lockTarget = null\n    this.aimMode = 'orbit'\n    this.lookAtId = null\n    this.pitchMin = this._freePitchMin\n    this.pitchMax = this._freePitchMax\n    this._hiddenFor = 0\n    this._showReticle(null)\n  }\n\n  /** The manager calls this when any enemy dies; only our target matters. */\n  public onTargetDied(enemy: Node): void {\n    if (!this.lockTarget || enemy !== this.lockTarget) return\n    this.unlock()\n    const near = this._candidates().find(c => {\n      const me = this._player.worldPosition\n      return Math.hypot(c.position[0] - me[0], c.position[2] - me[2]) <= this.retargetRange\n    })\n    if (near) this.lockOnto(near.node)\n  }\n\n  /** Lock onto a specific enemy (e.g. the boss when its fight starts). */\n  public lockOnto(enemy: Node): void {\n    if (!enemy) return\n    const point = this._lockPoint(enemy)\n    this.lockTarget = enemy\n    this.aimMode = 'lookAt'\n    this.lookAtId = point.id\n    this.lookAtOffset = [0, 0, 0]\n    this.pitchMin = this.lockedPitchMin\n    this.pitchMax = this.lockedPitchMax\n    this._hiddenFor = 0\n    this._showReticle(point)\n  }\n\n  private _lockBest(): boolean {\n    const best = this._candidates()[0]\n    if (!best) return false\n    this.lockOnto(best.node)\n    playSound(this, 'Lock On')\n    return true\n  }\n\n  /** Step to the next candidate clockwise (dir -1) or counter-clockwise (dir +1) of the current one. */\n  private _switch(dir: number): void {\n    this._switchWait = this.switchCooldown\n    const current = this.lockTarget\n    const me = this._player.worldPosition\n    const base = yawTo(me, current.worldPosition)\n    let best: Node = null\n    let bestStep = Infinity\n    for (const c of this._candidates()) {\n      if (c.node === current) continue\n      // How far round in the requested direction this candidate is, 0..360.\n      let step = (yawTo(me, c.position) - base) * dir\n      step = ((step % 360) + 360) % 360\n      if (step > 0 && step < bestStep) { bestStep = step; best = c.node }\n    }\n    if (best) this.lockOnto(best)\n  }\n\n  private _candidates(): { node: Node, position: ArrayLike<number> }[] {\n    const gm = this._gm as any\n    if (!gm?.liveEnemies || !this._player) return []\n    const me = this._player.worldPosition\n    // Range BEFORE line of sight: the ray is the expensive half (a long one over the terrain walks every\n    // cell under it), and an enemy out of range is never a candidate whatever it can see.\n    const list = gm.liveEnemies()\n      .filter((e: Node) => planarDistance(me, e.worldPosition) <= this.lockRange)\n      .filter((e: Node) => this._hasLineOfSight(e))\n      .map((e: Node) => ({ node: e, position: e.worldPosition }))\n    return this.rankLockTargets(me, this.yaw, list, this.lockRange)\n  }\n\n  /** Ease the boom toward the locked framing, or back to the free one. */\n  private _frame(delta: number): void {\n    const locked = !!this.lockTarget\n    const s = this.lockBlendSeconds\n    this.armLength = dampTime(this.armLength, locked ? this.lockedArmLength : this._freeArmLength, s, delta)\n    const to = locked ? this.lockedSocketOffset : this._freeSocket\n    for (let i = 0; i < 3; i++) this.socketOffset[i] = dampTime(this.socketOffset[i], to[i], s, delta)\n  }\n\n  /**\n   * Order lock-on candidates: smallest angle off the camera's forward first, distance breaking ties in\n   * 10-degree buckets so two enemies side by side resolve to the nearer.\n   */\n  public rankLockTargets(origin: ArrayLike<number>, yawDeg: number, candidates: any[], maxRange: number): any[] {\n    return candidates\n      .map(c => ({ c, d: planarDistance(origin, c.position), a: Math.abs(angleDiff(yawTo(origin, c.position), yawDeg)) }))\n      .filter(x => x.d <= maxRange)\n      .sort((x, y) => (Math.floor(x.a / 10) - Math.floor(y.a / 10)) || (x.d - y.d))\n      .map(x => x.c)\n  }\n\n  /** Line of sight from the camera pivot to the enemy's lock point, ignoring characters. */\n  private _hasLineOfSight(enemy: Node): boolean {\n    const physics = this.scene?.physics as any\n    if (!physics?.raycast) return true\n    const from = this.worldPosition\n    const to = this._lockPoint(enemy).worldPosition\n    const hit = physics.raycast([from[0], from[1], from[2]], [to[0], to[1], to[2]], {\n      // A character's body is its Collider: it stands for the character.\n      reject: (owner: Node) => { const o = owner?.character ?? owner; return !!o && (o.nodeType === 'character'\n        || !!o.getVariable?.('isEnemy') || !!o.getVariable?.('isPlayer')) },\n    })\n    return !hit\n  }\n\n  private _lockPoint(enemy: Node): Node {\n    const e = enemy as any\n    return (e.lockPoint ? e.lockPoint() : null) ?? enemy.getChildByName('LockPoint')[0] ?? enemy\n  }\n\n  /** Swing the camera behind the player — what pressing lock with nothing in range does. */\n  private _recenter(): void {\n    if (!this._player) return\n    const f = this._player.worldForward\n    this.setOrbit(Math.atan2(f[0], f[2]) * 180 / Math.PI, 12)\n  }\n\n  private _showReticle(point: Node): void {\n    const reticle = this._reticle as any\n    if (!reticle) return\n    reticle.uiTargetId = point ? point.id : null\n    if (reticle.visible !== !!point) reticle.visible = !!point\n  }\n}\n",
            "ditherRadius": 1.1,
            "ditherStrength": 0.85,
            "collisionLayers": -13,
            "seeThroughLayers": 4
          },
          {
            "name": "Knight",
            "id": "8ce5dff09d6770739a24a356a2fe4bfd",
            "type": "model",
            "position": [0, 0, 0],
            "rotation": [0, 0, 0],
            "scale": [1, 1, 1],
            "children": [],
            "variables": {
              "__modelId": {
                "type": "string",
                "value": "3842ecac5cc3898f5a9f9469253faece",
                "access": "public"
              },
              "__materialId": {
                "type": "string",
                "value": "cba4b592eb108c6c8620f50667d6ad14",
                "access": "public"
              },
              "__materialIds": {
                "type": "string",
                "value": "[\"cba4b592eb108c6c8620f50667d6ad14\",\"45fcc4049f80a742e68e7bf77cf4d26e\",\"b77e7781df07534bd457c6f0f50cc4b4\"]",
                "access": "public"
              }
            },
            "spawnOnStart": true,
            "model": {
              "geometry": {
                "$geo": {
                  "positions": {
                    "h": "c6e5a83a5a3bbf29c9481e45d0450adc1f239dc31effd987da944a864a17cb1e",
                    "l": 381060
                  },
                  "normals": {
                    "h": "063f132df0dbf1f7f550168ee35eae9aa8fa5752755a244ca22f5a7443bfb5be",
                    "l": 381060
                  },
                  "empty": [
                    "tangents",
                    "bitangents"
                  ],
                  "texCoords": {
                    "h": "03e10184c97fcc2fd7410769e51ac4b32a326bccad58222194f2fc31cd5304f8",
                    "l": 254040
                  },
                  "indices": {
                    "h": "2a7e59d8ec990303dc9c2919c75d1efbe9dd0bb471d0d31abb20ab558d4c3b9e",
                    "l": 248628,
                    "bits": 16
                  },
                  "typed": true
                }
              },
              "material": {
                "type": "pbr",
                "baseColor": [1, 1, 1],
                "metallic": 1,
                "roughness": 1,
                "reflectance": 0.5,
                "opacity": 1,
                "alphaCutoff": 0.5,
                "emissiveFactor": [0, 0, 0],
                "emissiveIntensity": 1,
                "textures": {
                  "baseColorTexture": "9483feb09d8a8b7060c57cf542762665",
                  "metallicRoughnessTexture": "95daea2404623cbe46eef3a4f1f96573",
                  "occlusionMap": "95daea2404623cbe46eef3a4f1f96573",
                  "normalMap": "b7822a21fc8d24e2e246aa2918442c77",
                  "mask": "bdc4a42acb7790627130a4bf631dab1a"
                },
                "config": {
                  "side": "double",
                  "wireframe": false,
                  "transparent": false,
                  "castShadow": true,
                  "probeable": true
                }
              },
              "materials": [
                {
                  "type": "pbr",
                  "baseColor": [1, 1, 1],
                  "metallic": 1,
                  "roughness": 1,
                  "reflectance": 0.5,
                  "opacity": 1,
                  "alphaCutoff": 0.5,
                  "emissiveFactor": [0, 0, 0],
                  "emissiveIntensity": 1,
                  "textures": {
                    "baseColorTexture": "9483feb09d8a8b7060c57cf542762665",
                    "metallicRoughnessTexture": "95daea2404623cbe46eef3a4f1f96573",
                    "occlusionMap": "95daea2404623cbe46eef3a4f1f96573",
                    "normalMap": "b7822a21fc8d24e2e246aa2918442c77",
                    "mask": "bdc4a42acb7790627130a4bf631dab1a"
                  },
                  "config": {
                    "side": "double",
                    "wireframe": false,
                    "transparent": false,
                    "castShadow": true,
                    "probeable": true
                  }
                },
                {
                  "type": "pbr",
                  "baseColor": [1, 1, 1],
                  "metallic": 1,
                  "roughness": 1,
                  "reflectance": 0.5,
                  "opacity": 1,
                  "emissiveFactor": [0, 0, 0],
                  "emissiveIntensity": 1,
                  "textures": {
                    "baseColorTexture": "9078ae2cae2bd6a78e5f3cdf8c5862e6",
                    "metallicRoughnessTexture": "3ba285e7e185c9fa47b494c8d4ce3b36",
                    "occlusionMap": "3ba285e7e185c9fa47b494c8d4ce3b36",
                    "normalMap": "43a40d25ade55ed3960fbc27889c8940"
                  },
                  "config": {
                    "side": "double",
                    "wireframe": false,
                    "transparent": false,
                    "castShadow": true,
                    "probeable": true
                  }
                },
                {
                  "type": "pbr",
                  "baseColor": [1, 1, 1],
                  "metallic": 1,
                  "roughness": 1,
                  "reflectance": 0.5,
                  "opacity": 1,
                  "alphaCutoff": 0.5,
                  "emissiveFactor": [0, 0, 0],
                  "emissiveIntensity": 1,
                  "textures": {
                    "baseColorTexture": "d6a2fdab8069567256010f2a96f06a72",
                    "metallicRoughnessTexture": "4b80c0941c19d68a7ea1968f3098d1dd",
                    "occlusionMap": "4b80c0941c19d68a7ea1968f3098d1dd",
                    "normalMap": "1227b61993cfe3b97568f136968a5136",
                    "mask": "de486eca8338ddeceb24178d258e0903"
                  },
                  "config": {
                    "side": "double",
                    "wireframe": false,
                    "transparent": false,
                    "castShadow": true,
                    "probeable": true
                  }
                }
              ],
              "submeshes": [
                {
                  "start": 0,
                  "count": 45738
                },
                {
                  "start": 45738,
                  "count": 37908
                },
                {
                  "start": 83646,
                  "count": 40668
                }
              ],
              "skin": {
                "name": "Armature",
                "joints": [
                  {
                    "nodeIndex": 5,
                    "inverseBindMatrix": [1, 0, 0, 0, 0, 1, -2.220446049250313e-16, 0, 0, 2.220446049250313e-16, 1, 0, 0, 0, 0, 1],
                    "parentIndex": 4
                  },
                  {
                    "nodeIndex": 94,
                    "inverseBindMatrix": [1, 0, 0, 0, 0, 1, -2.220446049250313e-16, 0, 0, 2.220446049250313e-16, 1, 0, 0, -1.0425360202789307, -0.000044159034587210044, 1],
                    "parentIndex": 5
                  },
                  {
                    "nodeIndex": 95,
                    "inverseBindMatrix": [1, 0, 0, 0, 0, 0.996716320514679, 0.08097269386053085, 0, 0, -0.08097269386053085, 0.996716320514679, 0, 0, -1.1390843391418457, -0.08446095883846283, 1],
                    "parentIndex": 94
                  },
                  {
                    "nodeIndex": 96,
                    "inverseBindMatrix": [1, 0, 0, 0, 0, 0.996716320514679, 0.08097274601459503, 0, 0, -0.08097274601459503, 0.996716320514679, 0, 0, -1.255721926689148, -0.0844610184431076, 1],
                    "parentIndex": 95
                  },
                  {
                    "nodeIndex": 97,
                    "inverseBindMatrix": [1, 0, 0, 0, 0, 0.996716320514679, 0.08097274601459503, 0, 0, -0.08097274601459503, 0.996716320514679, 0, 0, -1.3890222311019897, -0.0844610184431076, 1],
                    "parentIndex": 96
                  },
                  {
                    "nodeIndex": 98,
                    "inverseBindMatrix": [1, 0, 0, 0, 0, 1, 6.890017001381921e-9, 0, 0, -6.890017001381921e-9, 1, 0, 0, -1.5407706499099731, 0.0404321551322937, 1],
                    "parentIndex": 97
                  },
                  {
                    "nodeIndex": 99,
                    "inverseBindMatrix": [1, 0, 0, 0, 0, 1, 6.890017001381921e-9, 0, 0, -6.890017001381921e-9, 1, 0, 0, -1.6055529117584229, 0.015177649445831776, 1],
                    "parentIndex": 98
                  },
                  {
                    "nodeIndex": 100,
                    "inverseBindMatrix": [1, 0, 0, 0, 0, 1, 6.890017001381921e-9, 0, 0, -6.890017001381921e-9, 1, 0, 0, -1.867836594581604, -0.08707030862569809, 1],
                    "parentIndex": 99
                  },
                  {
                    "nodeIndex": 101,
                    "inverseBindMatrix": [-0.026633357629179955, 0.950822651386261, -0.30858874320983887, 0, -0.08089249581098557, -0.30973583459854126, -0.9473754167556763, 0, -0.9963669776916504, -0.000269267096882686, 0.08516370505094528, 0, 0.08435923606157303, 0.4014406204223633, 1.4632278680801392, 1],
                    "parentIndex": 97
                  },
                  {
                    "nodeIndex": 102,
                    "inverseBindMatrix": [0.020910991355776787, 0.6889167428016663, -0.7245388031005859, 0, 0.0650596022605896, -0.7240988612174988, -0.6866207718849182, 0, -0.9976622462272644, -0.032780274748802185, -0.05996229499578476, 0, -0.14058665931224823, 0.9112548828125, 1.165598750114441, 1],
                    "parentIndex": 101
                  },
                  {
                    "nodeIndex": 103,
                    "inverseBindMatrix": [-0.041056372225284576, 0.7895706295967102, -0.6122846603393555, 0, -0.6177415251731873, -0.5017033815383911, -0.6055485606193542, 0, -0.7853086590766907, 0.3533720076084137, 0.5083487629890442, 0, 0.769572913646698, 0.345828115940094, 1.0448318719863892, 1],
                    "parentIndex": 102
                  },
                  {
                    "nodeIndex": 104,
                    "inverseBindMatrix": [-0.15462027490139008, 0.5670601725578308, -0.8090335726737976, 0, -0.298756867647171, -0.8073803782463074, -0.5088038444519043, 0, -0.941720187664032, 0.16303296387195587, 0.2942504584789276, 0, 0.47745394706726074, 0.5806755423545837, 1.0612406730651855, 1],
                    "parentIndex": 103
                  },
                  {
                    "nodeIndex": 105,
                    "inverseBindMatrix": [0.08637823909521103, 0.12343251705169678, -0.9885864853858948, 0, -0.5981166958808899, -0.7871427536010742, -0.1505414843559265, 0, -0.7967403531074524, 0.6042935848236084, 0.00583503907546401, 0, 0.6783698797225952, 0.7549299001693726, 0.7693308591842651, 1],
                    "parentIndex": 104
                  },
                  {
                    "nodeIndex": 106,
                    "inverseBindMatrix": [0.08637822419404984, 0.07583851367235184, -0.9933717846870422, 0, -0.5981168150901794, -0.7934614419937134, -0.11258549243211746, 0, -0.7967403531074524, 0.6038772463798523, -0.023177625611424446, 0, 0.6845818161964417, 0.7500986456871033, 0.7341727614402771, 1],
                    "parentIndex": 105
                  },
                  {
                    "nodeIndex": 107,
                    "inverseBindMatrix": [0.08637819439172745, 0.3754819631576538, -0.922795832157135, 0, -0.5981167554855347, -0.7212108373641968, -0.3494444787502289, 0, -0.7967404127120972, 0.5821239948272705, 0.16228508949279785, 0, 0.6846853494644165, 0.4501061737537384, 0.915279746055603, 1],
                    "parentIndex": 106
                  },
                  {
                    "nodeIndex": 108,
                    "inverseBindMatrix": [0.08637819439172745, 0.3754819631576538, -0.922795832157135, 0, -0.5981167554855347, -0.7212108373641968, -0.3494444787502289, 0, -0.7967404127120972, 0.5821239948272705, 0.16228508949279785, 0, 0.6783699989318848, 0.4148698151111603, 0.9152796864509583, 1],
                    "parentIndex": 107
                  },
                  {
                    "nodeIndex": 109,
                    "inverseBindMatrix": [-0.03052503615617752, 0.4181423485279083, -0.9078684449195862, 0, -0.46358025074005127, -0.8106160759925842, -0.3577633798122406, 0, -0.8855289220809937, 0.4099491238594055, 0.2185867726802826, 0, 0.5933117866516113, 0.5499325394630432, 0.9776192903518677, 1],
                    "parentIndex": 104
                  },
                  {
                    "nodeIndex": 110,
                    "inverseBindMatrix": [-0.030525121837854385, -0.3707662522792816, -0.9282244443893433, 0, -0.4635803699493408, -0.8174846768379211, 0.34177786111831665, 0, -0.8855289220809937, 0.4407394528388977, -0.1469261348247528, 0, 0.5909525156021118, 1.0462712049484253, 0.3176467716693878, 1],
                    "parentIndex": 109
                  },
                  {
                    "nodeIndex": 111,
                    "inverseBindMatrix": [-0.03052513115108013, 0.5083171129226685, -0.8606287837028503, 0, -0.46358031034469604, -0.7700222730636597, -0.4383593499660492, 0, -0.8855289220809937, 0.3855895400047302, 0.259150892496109, 0, 0.5946469306945801, 0.378214031457901, 1.0099931955337524, 1],
                    "parentIndex": 110
                  },
                  {
                    "nodeIndex": 112,
                    "inverseBindMatrix": [-0.03052513301372528, 0.5083171129226685, -0.8606287837028503, 0, -0.46358034014701843, -0.7700222730636597, -0.4383593201637268, 0, -0.8855289220809937, 0.385589599609375, 0.259150892496109, 0, 0.5933119058609009, 0.35242196917533875, 1.0099931955337524, 1],
                    "parentIndex": 111
                  },
                  {
                    "nodeIndex": 113,
                    "inverseBindMatrix": [-0.33695122599601746, 0.1620616912841797, -0.9274696111679077, 0, -0.00870006438344717, -0.9855685830116272, -0.1690528839826584, 0, -0.9414819478988647, -0.048893533647060394, 0.3334985077381134, 0, 0.2988310754299164, 0.9225303530693054, 0.7860552072525024, 1],
                    "parentIndex": 104
                  },
                  {
                    "nodeIndex": 114,
                    "inverseBindMatrix": [-0.33695122599601746, -0.14878727495670319, -0.9296914339065552, 0, -0.008700033649802208, -0.9869003891944885, 0.16109612584114075, 0, -0.9414819478988647, 0.06236988306045532, 0.33124279975891113, 0, 0.29896092414855957, 1.0988425016403198, 0.45292049646377563, 1],
                    "parentIndex": 113
                  },
                  {
                    "nodeIndex": 115,
                    "inverseBindMatrix": [-0.3369511663913727, 0.0030037888791412115, -0.9415172934532166, 0, -0.008700037375092506, -0.9999621510505676, -0.00007667145109735429, 0, -0.94148188829422, 0.00816540140658617, 0.33696454763412476, 0, 0.29883357882499695, 0.9825671911239624, 0.6193868517875671, 1],
                    "parentIndex": 114
                  },
                  {
                    "nodeIndex": 116,
                    "inverseBindMatrix": [-0.3369511663913727, 0.0030037895776331425, -0.9415172934532166, 0, -0.008700037375092506, -0.9999621510505676, -0.00007667210593353957, 0, -0.94148188829422, 0.00816540140658617, 0.33696454763412476, 0, 0.2988310158252716, 0.9615920186042786, 0.6193868517875671, 1],
                    "parentIndex": 115
                  },
                  {
                    "nodeIndex": 117,
                    "inverseBindMatrix": [-0.3634118139743805, -0.049336571246385574, -0.9303213357925415, 0, 0.0395585298538208, -0.9985133409500122, 0.03750015050172806, 0, -0.9307883977890015, -0.023174148052930832, 0.3648231625556946, 0, 0.23560313880443573, 1.0784869194030762, 0.5760255455970764, 1],
                    "parentIndex": 104
                  },
                  {
                    "nodeIndex": 118,
                    "inverseBindMatrix": [-0.3634117841720581, -0.34795093536376953, -0.8642116785049438, 0, 0.03955848887562752, -0.9325620532035828, 0.35883548855781555, 0, -0.9307882785797119, 0.09621816128492355, 0.3526686131954193, 0, 0.23566505312919617, 1.186428189277649, 0.20274055004119873, 1],
                    "parentIndex": 117
                  },
                  {
                    "nodeIndex": 119,
                    "inverseBindMatrix": [-0.3634118139743805, 0.10012370347976685, -0.9262327551841736, 0, 0.0395585335791111, -0.9916530847549438, -0.12271647155284882, 0, -0.9307883977890015, -0.08123702555894852, 0.35641762614250183, 0, 0.23533010482788086, 0.9287961721420288, 0.7257717847824097, 1],
                    "parentIndex": 118
                  },
                  {
                    "nodeIndex": 120,
                    "inverseBindMatrix": [-0.3634118139743805, 0.10012370347976685, -0.9262327551841736, 0, 0.0395585335791111, -0.9916530847549438, -0.12271647155284882, 0, -0.9307883977890015, -0.08123702555894852, 0.35641762614250183, 0, 0.23560313880443573, 0.9143338203430176, 0.7257718443870544, 1],
                    "parentIndex": 119
                  },
                  {
                    "nodeIndex": 121,
                    "inverseBindMatrix": [-0.026067275553941727, -0.950822651386261, 0.3086371123790741, 0, 0.08088722825050354, -0.30973583459854126, -0.9473758339881897, 0, 0.9963822960853577, 0.00026929000159725547, 0.08498337864875793, 0, -0.08435148000717163, 0.4014624059200287, 1.4632211923599243, 1],
                    "parentIndex": 97
                  },
                  {
                    "nodeIndex": 122,
                    "inverseBindMatrix": [0.014492442831397057, -0.6891259551048279, 0.724496603012085, 0, -0.043620139360427856, -0.7243186235427856, -0.6880841255187988, 0, 0.998943030834198, -0.02163064293563366, -0.04055687040090561, 0, 0.10760201513767242, 0.9119860529899597, 1.1685304641723633, 1],
                    "parentIndex": 121
                  },
                  {
                    "nodeIndex": 123,
                    "inverseBindMatrix": [-0.070851631462574, -0.7942185401916504, 0.6034873127937317, 0, 0.6300886273384094, -0.5046566724777222, -0.5901778936386108, 0, 0.7732841372489929, 0.33843547105789185, 0.5361838340759277, 0, -0.8001860976219177, 0.34600889682769775, 1.0213749408721924, 1],
                    "parentIndex": 122
                  },
                  {
                    "nodeIndex": 124,
                    "inverseBindMatrix": [-0.1030312329530716, -0.562884509563446, 0.8200888633728027, 0, 0.2873770594596863, -0.8061618804931641, -0.5172210335731506, 0, 0.9522600173950195, 0.18238480389118195, 0.24481981992721558, 0, -0.4323800206184387, 0.5812150835990906, 1.0800461769104004, 1],
                    "parentIndex": 123
                  },
                  {
                    "nodeIndex": 125,
                    "inverseBindMatrix": [0.1550130695104599, -0.12025873363018036, 0.9805655479431152, 0, 0.6126294732093811, -0.7669669985771179, -0.19091027975082397, 0, 0.7750200033187866, 0.6303169131278992, -0.045215852558612823, 0, -0.6516273021697998, 0.7332314848899841, 0.8130924105644226, 1],
                    "parentIndex": 124
                  },
                  {
                    "nodeIndex": 126,
                    "inverseBindMatrix": [0.1550130844116211, -0.0816945806145668, 0.9845287799835205, 0, 0.6126294732093811, -0.773866593837738, -0.16067208349704742, 0, 0.7750200033187866, 0.6280576586723328, -0.06991090625524521, 0, -0.657785177230835, 0.7235552668571472, 0.7853090763092041, 1],
                    "parentIndex": 125
                  },
                  {
                    "nodeIndex": 127,
                    "inverseBindMatrix": [0.15501315891742706, -0.2016773819923401, 0.9671075940132141, 0, 0.6126294732093811, -0.7483576536178589, -0.2542555034160614, 0, 0.7750200629234314, 0.6318916082382202, 0.007548214867711067, 0, -0.6560128331184387, 0.5800325274467468, 0.8628570437431335, 1],
                    "parentIndex": 126
                  },
                  {
                    "nodeIndex": 128,
                    "inverseBindMatrix": [0.15501312911510468, -0.20167730748653412, 0.9671076536178589, 0, 0.6126295328140259, -0.7483577132225037, -0.2542554438114166, 0, 0.7750200629234314, 0.6318916082382202, 0.007548192050307989, 0, -0.6516273617744446, 0.5445911288261414, 0.862856924533844, 1],
                    "parentIndex": 127
                  },
                  {
                    "nodeIndex": 129,
                    "inverseBindMatrix": [-0.26230156421661377, 0.09737371653318405, 0.9600604772567749, 0, 0.04046490415930748, -0.9929107427597046, 0.11176111549139023, 0, 0.964137077331543, 0.06816388666629791, 0.2565019726753235, 0, -0.3205292820930481, 1.1073797941207886, 0.5229290127754211, 1],
                    "parentIndex": 124
                  },
                  {
                    "nodeIndex": 130,
                    "inverseBindMatrix": [-0.2623016834259033, -0.20091596245765686, 0.9438382387161255, 0, 0.04046490043401718, -0.9795147776603699, -0.1972648948431015, 0, 0.9641371369361877, -0.013550582341849804, 0.26505836844444275, 0, -0.32138580083847046, 0.8578096628189087, 0.8248025178909302, 1],
                    "parentIndex": 129
                  },
                  {
                    "nodeIndex": 131,
                    "inverseBindMatrix": [-0.2623017132282257, -0.038140080869197845, 0.9642319083213806, 0, 0.04046491160988808, -0.9987744688987732, -0.028498666360974312, 0, 0.9641371369361877, 0.031542304903268814, 0.26352354884147644, 0, -0.3205264210700989, 0.9612022042274475, 0.6716946959495544, 1],
                    "parentIndex": 130
                  },
                  {
                    "nodeIndex": 132,
                    "inverseBindMatrix": [-0.2623017132282257, -0.038140084594488144, 0.9642319083213806, 0, 0.04046490788459778, -0.9987744688987732, -0.028498675674200058, 0, 0.9641371369361877, 0.031542304903268814, 0.26352354884147644, 0, -0.32052940130233765, 0.9358839988708496, 0.6716946959495544, 1],
                    "parentIndex": 131
                  },
                  {
                    "nodeIndex": 133,
                    "inverseBindMatrix": [-0.2311338186264038, -0.17580527067184448, 0.956906259059906, 0, 0.09197919815778732, -0.9830818772315979, -0.15839740633964539, 0, 0.9685643911361694, 0.05140446498990059, 0.2433939427137375, 0, -0.31143417954444885, 0.9007309675216675, 0.8031477332115173, 1],
                    "parentIndex": 124
                  },
                  {
                    "nodeIndex": 134,
                    "inverseBindMatrix": [-0.23113374412059784, 0.23486819863319397, 0.9441471695899963, 0, 0.0919792503118515, -0.9608029723167419, 0.26152870059013367, 0, 0.9685643315315247, 0.14729008078575134, 0.20047111809253693, 0, -0.3110235035419464, 1.1250698566436768, 0.3718983232975006, 1],
                    "parentIndex": 133
                  },
                  {
                    "nodeIndex": 135,
                    "inverseBindMatrix": [-0.2311338186264038, -0.17125959694385529, 0.9577302932739258, 0, 0.09197918325662613, -0.9838229417800903, -0.15372763574123383, 0, 0.9685643911361694, 0.052559588104486465, 0.2431470900774002, 0, -0.3116619288921356, 0.848570704460144, 0.787159264087677, 1],
                    "parentIndex": 134
                  },
                  {
                    "nodeIndex": 136,
                    "inverseBindMatrix": [-0.2311338186264038, -0.17125959694385529, 0.9577302932739258, 0, 0.09197917580604553, -0.9838229417800903, -0.15372765064239502, 0, 0.9685643911361694, 0.05255957692861557, 0.2431470900774002, 0, -0.3114341199398041, 0.830230712890625, 0.787159264087677, 1],
                    "parentIndex": 135
                  },
                  {
                    "nodeIndex": 137,
                    "inverseBindMatrix": [-0.29927557706832886, 0.14797359704971313, 0.9426229000091553, 0, -0.02301052398979664, -0.98873370885849, 0.14790643751621246, 0, 0.9538892507553101, 0.02257453091442585, 0.29930874705314636, 0, -0.2100265622138977, 1.1319903135299683, 0.472748726606369, 1],
                    "parentIndex": 124
                  },
                  {
                    "nodeIndex": 138,
                    "inverseBindMatrix": [-0.29927560687065125, 0.33128347992897034, 0.8948102593421936, 0, -0.023010514676570892, -0.9400254487991333, 0.3403273820877075, 0, 0.9538892507553101, 0.08126161992549896, 0.2889496386051178, 0, -0.20999963581562042, 1.1809287071228027, 0.24425634741783142, 1],
                    "parentIndex": 137
                  },
                  {
                    "nodeIndex": 139,
                    "inverseBindMatrix": [-0.29927557706832886, -0.005827490705996752, 0.9541490077972412, 0, -0.02301051653921604, -0.9996465444564819, -0.013322778977453709, 0, 0.9538892507553101, -0.025942640379071236, 0.29903560876846313, 0, -0.2099948227405548, 0.9965028762817383, 0.63692307472229, 1],
                    "parentIndex": 138
                  },
                  {
                    "nodeIndex": 140,
                    "inverseBindMatrix": [-0.29927557706832886, -0.005827486515045166, 0.9541490077972412, 0, -0.02301051653921604, -0.9996465444564819, -0.013322773389518261, 0, 0.9538892507553101, -0.025942638516426086, 0.29903560876846313, 0, -0.2100265622138977, 0.9837029576301575, 0.63692307472229, 1],
                    "parentIndex": 139
                  },
                  {
                    "nodeIndex": 141,
                    "inverseBindMatrix": [-0.9990766644477844, 0.042959995567798615, -7.919798150624047e-11, 0, -0.0429471880197525, -0.998778760433197, -0.02442147582769394, 0, -0.001049146638251841, -0.0243989285081625, 0.999701738357544, 0, 0.15873320400714874, 0.9813405871391296, 0.006869032979011536, 1],
                    "parentIndex": 94
                  },
                  {
                    "nodeIndex": 142,
                    "inverseBindMatrix": [-0.9973474144935608, 0.07234702259302139, 0.007996206171810627, 0, -0.07276587188243866, -0.9883323311805725, -0.13380631804466248, 0, -0.001777580939233303, -0.13403324782848358, 0.9909752011299133, 0, 0.17508673667907715, 0.5407423377037048, 0.0666767954826355, 1],
                    "parentIndex": 141
                  },
                  {
                    "nodeIndex": 143,
                    "inverseBindMatrix": [-0.9743479490280151, 0.2241823673248291, 0.019706372171640396, 0, -0.09874816983938217, -0.5045768618583679, 0.8577010035514832, 0, 0.20222482085227966, 0.8337531685829163, 0.5137710571289062, 0, 0.18506157398223877, 0.06502421945333481, -0.07513955980539322, 1],
                    "parentIndex": 142
                  },
                  {
                    "nodeIndex": 144,
                    "inverseBindMatrix": [-0.9704400300979614, 0.2386547327041626, -0.03591645136475563, 0, -0.037120405584573746, -0.0005507089081220329, 0.9993106126785278, 0, 0.2384704351425171, 0.9711043238639832, 0.009393421933054924, 0, 0.17921039462089539, -0.18056707084178925, 0.003355752443894744, 1],
                    "parentIndex": 143
                  },
                  {
                    "nodeIndex": 145,
                    "inverseBindMatrix": [-0.9704400300979614, 0.2386547327041626, -0.03591645136475563, 0, -0.037120405584573746, -0.0005507089081220329, 0.9993106126785278, 0, 0.2384704351425171, 0.9711043238639832, 0.009393421933054924, 0, 0.17921039462089539, -0.2654668688774109, 0.0033557566348463297, 1],
                    "parentIndex": 144
                  },
                  {
                    "nodeIndex": 146,
                    "inverseBindMatrix": [-0.999076247215271, -0.04297030717134476, -5.734471925089579e-11, 0, 0.04296781122684479, -0.9990181922912598, -0.010784020647406578, 0, 0.0004633926728274673, -0.010774059221148491, 0.999941885471344, 0, -0.15873992443084717, 0.981259822845459, 0.0009166353265754879, 1],
                    "parentIndex": 94
                  },
                  {
                    "nodeIndex": 147,
                    "inverseBindMatrix": [-0.9973387718200684, -0.07238790392875671, -0.00868600606918335, 0, 0.07290292531251907, -0.9888930916786194, -0.12952111661434174, 0, 0.0007862308411858976, -0.1298096626996994, 0.9915385842323303, 0, -0.17515385150909424, 0.5408082604408264, 0.06581614166498184, 1],
                    "parentIndex": 146
                  },
                  {
                    "nodeIndex": 148,
                    "inverseBindMatrix": [-0.9743015766143799, -0.22428977489471436, -0.020752480253577232, 0, 0.09794586896896362, -0.5048251152038574, 0.8576469421386719, 0, -0.20283780992031097, 0.8335740566253662, 0.5138201117515564, 0, -0.1849362850189209, 0.06479007750749588, -0.07545103132724762, 1],
                    "parentIndex": 147
                  },
                  {
                    "nodeIndex": 149,
                    "inverseBindMatrix": [-0.970540463924408, -0.2380453199148178, 0.037226609885692596, 0, 0.03846492990851402, -0.0005575348623096943, 0.9992598295211792, 0, -0.23784837126731873, 0.9712539315223694, 0.009697431698441505, 0, -0.1792822778224945, -0.1806039661169052, 0.0035998099483549595, 1],
                    "parentIndex": 148
                  },
                  {
                    "nodeIndex": 150,
                    "inverseBindMatrix": [-0.970540463924408, -0.2380453199148178, 0.037226609885692596, 0, 0.03846492990851402, -0.0005575348623096943, 0.9992598295211792, 0, -0.23784837126731873, 0.9712539315223694, 0.009697431698441505, 0, -0.1792822778224945, -0.2657211720943451, 0.0035998132079839706, 1],
                    "parentIndex": 149
                  }
                ],
                "nodeParents": [
                  [1, 0],
                  [2, 1],
                  [3, 2],
                  [4, 3],
                  [5, 4],
                  [7, 4],
                  [9, 4],
                  [11, 4],
                  [13, 4],
                  [15, 4],
                  [17, 4],
                  [19, 4],
                  [21, 4],
                  [23, 4],
                  [25, 4],
                  [27, 4],
                  [29, 4],
                  [31, 4],
                  [33, 4],
                  [35, 4],
                  [37, 4],
                  [39, 4],
                  [41, 4],
                  [43, 4],
                  [45, 4],
                  [47, 4],
                  [49, 4],
                  [51, 4],
                  [53, 4],
                  [55, 4],
                  [57, 4],
                  [59, 4],
                  [61, 4],
                  [63, 4],
                  [65, 4],
                  [67, 4],
                  [69, 4],
                  [71, 4],
                  [73, 4],
                  [75, 4],
                  [77, 4],
                  [79, 4],
                  [81, 4],
                  [83, 4],
                  [85, 4],
                  [87, 4],
                  [89, 4],
                  [91, 4],
                  [93, 4],
                  [6, 4],
                  [8, 4],
                  [10, 4],
                  [12, 4],
                  [14, 4],
                  [16, 4],
                  [18, 4],
                  [20, 4],
                  [22, 4],
                  [24, 4],
                  [26, 4],
                  [28, 4],
                  [30, 4],
                  [32, 4],
                  [34, 4],
                  [36, 4],
                  [38, 4],
                  [40, 4],
                  [42, 4],
                  [44, 4],
                  [46, 4],
                  [48, 4],
                  [50, 4],
                  [52, 4],
                  [54, 4],
                  [56, 4],
                  [58, 4],
                  [60, 4],
                  [62, 4],
                  [64, 4],
                  [66, 4],
                  [68, 4],
                  [70, 4],
                  [72, 4],
                  [74, 4],
                  [76, 4],
                  [78, 4],
                  [80, 4],
                  [82, 4],
                  [84, 4],
                  [86, 4],
                  [88, 4],
                  [90, 4],
                  [92, 4],
                  [151, 4],
                  [152, 4],
                  [153, 4],
                  [154, 4],
                  [155, 4],
                  [156, 4],
                  [157, 4],
                  [158, 4],
                  [159, 4],
                  [160, 4],
                  [161, 4],
                  [162, 4],
                  [163, 4],
                  [164, 4],
                  [165, 4],
                  [166, 4],
                  [167, 4],
                  [168, 4],
                  [169, 4],
                  [170, 4],
                  [171, 4],
                  [172, 4],
                  [173, 4],
                  [174, 4],
                  [175, 4],
                  [176, 4],
                  [177, 4],
                  [178, 4],
                  [179, 4],
                  [180, 4],
                  [181, 4],
                  [182, 4],
                  [183, 4],
                  [184, 4],
                  [185, 4],
                  [186, 4],
                  [187, 4],
                  [188, 4],
                  [189, 4],
                  [190, 4],
                  [191, 4],
                  [192, 4],
                  [193, 4],
                  [194, 4],
                  [94, 5],
                  [95, 94],
                  [141, 94],
                  [146, 94],
                  [96, 95],
                  [97, 96],
                  [98, 97],
                  [101, 97],
                  [121, 97],
                  [99, 98],
                  [100, 99],
                  [102, 101],
                  [103, 102],
                  [104, 103],
                  [105, 104],
                  [109, 104],
                  [113, 104],
                  [117, 104],
                  [106, 105],
                  [107, 106],
                  [108, 107],
                  [110, 109],
                  [111, 110],
                  [112, 111],
                  [114, 113],
                  [115, 114],
                  [116, 115],
                  [118, 117],
                  [119, 118],
                  [120, 119],
                  [122, 121],
                  [123, 122],
                  [124, 123],
                  [125, 124],
                  [129, 124],
                  [133, 124],
                  [137, 124],
                  [126, 125],
                  [127, 126],
                  [128, 127],
                  [130, 129],
                  [131, 130],
                  [132, 131],
                  [134, 133],
                  [135, 134],
                  [136, 135],
                  [138, 137],
                  [139, 138],
                  [140, 139],
                  [142, 141],
                  [143, 142],
                  [144, 143],
                  [145, 144],
                  [147, 146],
                  [148, 147],
                  [149, 148],
                  [150, 149]
                ],
                "nodeTransforms": [
                  [
                    0,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    1,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    2,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    3,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    4,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    5,
                    [1, 0, 0, 0, 0, 1, 2.220446049250313e-16, 0, 0, -2.220446049250313e-16, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    6,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    7,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    8,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    9,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    10,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    11,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    12,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    13,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    14,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    15,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    16,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    17,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    18,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    19,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    20,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    21,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    22,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    23,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    24,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    25,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    26,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    27,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    28,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    29,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    30,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    31,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    32,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    33,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    34,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    35,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    36,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    37,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    38,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    39,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    40,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    41,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    42,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    43,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    44,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    45,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    46,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    47,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    48,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    49,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    50,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    51,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    52,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    53,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    54,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    55,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    56,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    57,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    58,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    59,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    60,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    61,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    62,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    63,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    64,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    65,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    66,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    67,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    68,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    69,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    70,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    71,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    72,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    73,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    74,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    75,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    76,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    77,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    78,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    79,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    80,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    81,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    82,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    83,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    84,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    85,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    86,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    87,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    88,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    89,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    90,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    91,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    92,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    93,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    94,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.0425360202789307, 0.000044159034587210044, 1]
                  ],
                  [
                    95,
                    [1, 0, 0, 0, 0, 0.996716320514679, -0.08097269386053085, 0, 0, 0.08097269386053085, 0.996716320514679, 0, 0, 0.0996469259262085, -0.008095263503491879, 1]
                  ],
                  [
                    96,
                    [1, 0, 0, 0, 0, 1, -5.198280561558022e-8, 0, 0, 5.198280561558022e-8, 1, 0, 0, 0.11663765460252762, -3.737709253215371e-9, 1]
                  ],
                  [
                    97,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0.13330034911632538, 7.781585376065436e-10, 1]
                  ],
                  [
                    98,
                    [1, 0, 0, 0, 0, 0.996716320514679, 0.08097273856401443, 0, 0, -0.08097273856401443, 0.996716320514679, 0, 0, 0.14996293187141418, 1.20256835600685e-8, 1]
                  ],
                  [
                    99,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0.06478226184844971, 0.02525450475513935, 1]
                  ],
                  [
                    100,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0.26228368282318115, 0.10224795341491699, 1]
                  ],
                  [
                    101,
                    [-0.02663334645330906, 0.00005170946678845212, -0.9996452331542969, 0, 0.9508225917816162, -0.3086969256401062, -0.025348549708724022, 0, -0.30858874320983887, -0.9511604309082031, 0.008172477595508099, 0, 0.07208360731601715, 0.12666134536266327, -0.0019139681244269013, 1]
                  ],
                  [
                    102,
                    [0.9882179498672485, 7.058633233469891e-9, -0.1530533879995346, 0, 0.07288718968629837, 0.879325807094574, 0.4706098139286041, 0, 0.13458380103111267, -0.47622063755989075, 0.8689655065536499, 0, -7.06849911935592e-9, 0.15523283183574677, -2.3084028910602683e-8, 1]
                  ],
                  [
                    103,
                    [0.7424243092536926, 0.4447641670703888, 0.500990092754364, 0, -0.3686758875846863, 0.8956477642059326, -0.2487836480140686, 0, -0.5593606233596802, 5.716896112062386e-8, 0.8289244771003723, 0, 4.042998380526797e-9, 0.259236216545105, 2.7554760251291555e-8, 1]
                  ],
                  [
                    104,
                    [0.9304436445236206, -0.304973840713501, -0.20313891768455505, 0, 0.3474397361278534, 0.9104107618331909, 0.22458334267139435, 0, 0.11644775420427322, -0.27954068779945374, 0.9530461430549622, 0, 6.702131116753662e-8, 0.25944578647613525, -5.034417682736603e-8, 1]
                  ],
                  [
                    105,
                    [0.9156421422958374, 0.40199440717697144, -4.1299703212871464e-8, 0, -0.3529963493347168, 0.8040369749069214, 0.4784538447856903, 0, 0.1923358291387558, -0.4380924701690674, 0.8781127333641052, 0, -0.025172488763928413, 0.03802113234996796, 0.02448239177465439, 1]
                  ],
                  [
                    106,
                    [0.9999999403953552, 7.118126177374506e-8, -9.844817583370968e-8, 0, -9.002528145174438e-8, 0.998847246170044, 0.04799960181117058, 0, -2.766137185972184e-8, -0.04799957200884819, 0.9988473057746887, 0, -0.006211800035089254, 0.04093588516116142, 5.063975017094435e-9, 1]
                  ],
                  [
                    107,
                    [1, -8.398240680662639e-8, 9.271150958056751e-8, 0, 8.809605134274534e-8, 0.9522602558135986, -0.30528751015663147, 0, 7.779898503201821e-9, 0.30528751015663147, 0.9522602558135986, 0, -0.00010357305291108787, 0.04205698519945145, -6.293053900208179e-8, 1]
                  ],
                  [
                    108,
                    [1, -3.513623170192659e-9, -9.212671514546855e-9, 0, -7.789817679793032e-10, 1, 2.7490791865147912e-9, 0, 4.779897366802288e-9, 4.492058280902711e-9, 1, 0, 0.006315356586128473, 0.035236358642578125, 7.570355364805437e-8, 1]
                  ],
                  [
                    109,
                    [0.9771381616592407, 0.21260567009449005, 4.862174307618261e-8, 0, -0.20853358507156372, 0.9584228992462158, 0.19478118419647217, 0, 0.04141170158982277, -0.19032800197601318, 0.9808467626571655, 0, -0.028099101036787033, 0.11353450268507004, -0.004770571831613779, 1]
                  ],
                  [
                    110,
                    [0.9999999403953552, 4.850187806937356e-8, -3.4331133491605215e-8, 0, -1.2911073099530768e-7, 0.6883138418197632, 0.7254128456115723, 0, -4.003170417377078e-8, -0.7254128456115723, 0.6883139610290527, 0, 0.0023594230879098177, 0.060194604098796844, 1.0175419618008164e-8, 1]
                  ],
                  [
                    111,
                    [1, -3.132766934754727e-8, 6.26530507474854e-8, 0, 5.1716224191977744e-8, 0.6109591722488403, -0.7916622161865234, 0, 1.7825890097356023e-8, 0.7916622161865234, 0.6109591126441956, 0, -0.0036944712046533823, 0.01562448125332594, -3.432293738114822e-8, 1]
                  ],
                  [
                    112,
                    [1, 3.206694643154151e-8, 4.631324657111691e-9, 0, -2.348613392655352e-8, 0.9999999403953552, 4.7177124429254036e-8, 0, -1.4102903733714811e-8, -1.361248891385003e-8, 1, 0, 0.001335040433332324, 0.025792067870497704, 1.7451306177918013e-8, 1]
                  ],
                  [
                    113,
                    [0.9413111805915833, -0.337539941072464, 2.1617494461168008e-9, 0, 0.3154313862323761, 0.879656195640564, 0.35596078634262085, 0, -0.12015093117952347, -0.335069864988327, 0.9345008730888367, 0, -0.0003888591891154647, 0.1334168016910553, -0.001713255071081221, 1]
                  ],
                  [
                    114,
                    [1, -2.2679813582726638e-8, -4.3798124238492164e-8, 0, 3.0609090373445724e-8, 0.9454957842826843, 0.32563427090644836, 0, -2.532916321129619e-9, -0.32563430070877075, 0.9454958438873291, 0, -0.00012988368689548224, 0.031065847724676132, -2.32823040846597e-8, 1]
                  ],
                  [
                    115,
                    [1.0000001192092896, 1.5525648544567616e-9, -1.7914448591227483e-8, 0, -4.082892690604467e-9, 0.9869253635406494, -0.1611778885126114, 0, 2.6715159862078508e-8, 0.16117790341377258, 0.9869253635406494, 0, 0.0001273100933758542, 0.02929053269326687, 9.628827513097349e-9, 1]
                  ],
                  [
                    116,
                    [1, -1.8977099058847813e-10, 6.631166282744516e-9, 0, 7.263451645700414e-11, 1, -7.120654066383736e-10, 0, -9.313074755823436e-9, 8.0387796419501e-10, 1, 0, 0.00000257059355135425, 0.020975185558199883, 2.5746984988472832e-8, 1]
                  ],
                  [
                    117,
                    [0.9209145903587341, -0.38976427912712097, -1.1544323541556878e-7, 0, 0.32776468992233276, 0.7744250893592834, 0.5411433577537537, 0, -0.21091824769973755, -0.49834686517715454, 0.8409303426742554, 0, 0.02848794497549534, 0.12435846775770187, -0.0067726923152804375, 1]
                  ],
                  [
                    118,
                    [1.0000001192092896, 2.194121506704505e-8, 1.584351991823496e-7, 0, -3.224370459520287e-8, 0.9461128115653992, 0.32383760809898376, 0, 1.3602321047301302e-8, -0.32383763790130615, 0.9461126923561096, 0, -0.00006191169086378068, 0.021646961569786072, 5.10670083997411e-9, 1]
                  ],
                  [
                    119,
                    [0.9999998807907104, -8.373047677423529e-8, -1.6886890819023392e-7, 0, 3.5358649341787896e-8, 0.8821233510971069, -0.47101810574531555, 0, 4.3807737881707e-8, 0.47101813554763794, 0.8821234703063965, 0, 0.00033491384238004684, 0.025263749063014984, 6.734806845543062e-8, 1]
                  ],
                  [
                    120,
                    [1, 2.7210922404208304e-9, -1.1142272882125326e-8, 0, -2.2714063963036324e-9, 1, 1.368765545350925e-9, 0, 2.343747418365183e-8, -3.78172426707124e-9, 1, 0, -0.0002730445994529873, 0.014462335966527462, -4.329006486614162e-8, 1]
                  ],
                  [
                    121,
                    [-0.026067279279232025, -0.00005818747740704566, 0.9996601939201355, 0, -0.9508225917816162, -0.3087405562400818, -0.024811752140522003, 0, 0.3086370825767517, -0.9511463046073914, 0.00799269787967205, 0, -0.07208360731601715, 0.12665796279907227, -0.0018723001703619957, 1]
                  ],
                  [
                    122,
                    [0.9914231300354004, 2.3284743022600196e-8, 0.13069109618663788, 0, -0.062176864594221115, 0.8795782327651978, 0.4716739058494568, 0, -0.11495307832956314, -0.47575443983078003, 0.8720342516899109, 0, -4.424005162206868e-9, 0.15523284673690796, 2.187931613661931e-8, 1]
                  ],
                  [
                    123,
                    [0.7439554333686829, -0.4242858588695526, -0.5162477493286133, 0, 0.3485807478427887, 0.9055282473564148, -0.24188826978206635, 0, 0.5701067447662354, 2.660521047914699e-8, 0.821570634841919, 0, 1.6395786950340607e-9, 0.25915753841400146, 1.5165305455866473e-8, 1]
                  ],
                  [
                    124,
                    [0.9247403740882874, 0.25908106565475464, 0.27880483865737915, 0, -0.3270368278026581, 0.91561359167099, 0.2338770180940628, 0, -0.19468434154987335, -0.3074549734592438, 0.9314340353012085, 0, -5.1060116135204225e-8, 0.2579275071620941, 8.127658546186467e-9, 1]
                  ],
                  [
                    125,
                    [0.8981050848960876, -0.4397810995578766, -9.732335115586466e-8, 0, 0.3922073245048523, 0.8009516000747681, 0.4523827135562897, 0, -0.19894938170909882, -0.4062872529029846, 0.891823947429657, 0, 0.027035262435674667, 0.03770788758993149, 0.023209553211927414, 1]
                  ],
                  [
                    126,
                    [0.9999999403953552, -9.156126168363699e-8, -4.8618771231190294e-9, 0, -2.6923387963506684e-9, 0.9992300271987915, 0.03923402354121208, 0, -1.4464211162135143e-8, -0.039234038442373276, 0.9992300271987915, 0, 0.00615787785500288, 0.041044119745492935, -1.628963097743963e-8, 1]
                  ],
                  [
                    127,
                    [0.9999999403953552, 2.9983969085378703e-8, 1.1156015489177662e-7, 0, 1.1651525966271947e-8, 0.9924693703651428, -0.12249311059713364, 0, -6.938368812825502e-8, 0.12249312549829483, 0.9924693703651428, 0, -0.0017723344499245286, 0.04219672456383705, -3.637121892552386e-8, 1]
                  ],
                  [
                    128,
                    [1, 3.915140567301023e-8, -2.3267574533747393e-8, 0, 4.583844415151361e-8, 1, 6.513239725336462e-8, 0, 4.381972118494559e-8, -8.517748284475601e-8, 1, 0, -0.004385543521493673, 0.03544151410460472, 6.953651876528966e-8, 1]
                  ],
                  [
                    129,
                    [0.9567632675170898, 0.29086828231811523, -1.2049933673097257e-7, 0, -0.23046264052391052, 0.7580689191818237, 0.6100974678993225, 0, 0.17745785415172577, -0.5837187767028809, 0.7923265099525452, 0, 0.03670245036482811, 0.14022018015384674, -0.00989397894591093, 1]
                  ],
                  [
                    130,
                    [0.9999998807907104, 1.9921966298852567e-8, 5.7397016917093424e-8, 0, -2.22027729535057e-8, 0.9520831108093262, -0.3058388829231262, 0, 7.856427686192546e-8, 0.30583885312080383, 0.9520832300186157, 0, 0.0008564465097151697, 0.038417037576436996, -4.356598282129198e-8, 1]
                  ],
                  [
                    131,
                    [1, 2.672607135600913e-10, -4.822266674864295e-8, 0, 9.111460030908347e-9, 0.9855498671531677, 0.169385626912117, 0, 2.01663414856057e-8, -0.1693856120109558, 0.9855498671531677, 0, -0.0008593899547122419, 0.024272335693240166, 5.990499118979642e-8, 1]
                  ],
                  [
                    132,
                    [1, -1.92168037038698e-9, -8.779515781043301e-9, 0, -2.551442168652329e-9, 1, -9.658370991871834e-9, 0, -9.189992766778232e-9, 5.907200062438278e-9, 1, 0, 0.000002994187980220886, 0.025318199768662453, -8.566014564337365e-9, 1]
                  ],
                  [
                    133,
                    [0.972571849822998, 0.23260296881198883, -1.2723130282665807e-7, 0, -0.21545134484767914, 0.9008566737174988, 0.37687957286834717, 0, 0.08766326308250427, -0.36654242873191833, 0.926262378692627, 0, -0.005830762442201376, 0.13661378622055054, -0.0033464885782450438, 1]
                  ],
                  [
                    134,
                    [1.0000001192092896, -3.269628479074527e-8, -2.208723159924375e-8, 0, 4.446442503081016e-8, 0.9108284711837769, 0.412785142660141, 0, -6.479385916691172e-8, -0.412785142660141, 0.9108284711837769, 0, -0.0004106880514882505, 0.02949945628643036, 4.191409530562851e-8, 1]
                  ],
                  [
                    135,
                    [0.9999999403953552, 6.762861204379078e-8, 2.7992596685066928e-8, 0, -8.432252940338003e-8, 0.9127781391143799, -0.4084555208683014, 0, 4.173151069153391e-8, 0.4084555208683014, 0.9127781391143799, 0, 0.0006384318694472313, 0.02899354323744774, -3.0218414437399588e-9, 1]
                  ],
                  [
                    136,
                    [1, 9.296797109925592e-9, -2.1466237676293076e-9, 0, -6.231629878783451e-9, 1, -2.4290107702995556e-8, 0, -6.1946177076777076e-9, 1.0261108407405573e-8, 1, 0, -0.00022778975835535675, 0.018339993432164192, 3.2526958904099956e-8, 1]
                  ],
                  [
                    137,
                    [0.9325725436210632, 0.36098265647888184, -1.4833211992026918e-8, 0, -0.2778884172439575, 0.7179045081138611, 0.6382719874382019, 0, 0.23040509223937988, -0.5952349901199341, 0.7698109745979309, 0, -0.030871734023094177, 0.12576666474342346, -0.006398668047040701, 1]
                  ],
                  [
                    138,
                    [1, -1.0367816827283605e-8, -8.33509705699953e-9, 0, 1.499305746222035e-8, 0.980290412902832, 0.19756190478801727, 0, 1.5267724862155774e-8, -0.19756193459033966, 0.980290412902832, 0, -0.000026949062885250896, 0.022592997178435326, 5.982283823868784e-8, 1]
                  ],
                  [
                    139,
                    [1, 2.3527439552140095e-8, 5.273683001405516e-8, 0, -8.31480662100148e-10, 0.93565434217453, -0.3529176414012909, 0, -4.249336171824325e-8, 0.3529176414012909, 0.93565434217453, 0, -0.000004789264494320378, 0.023765113204717636, -2.9648484556332733e-8, 1]
                  ],
                  [
                    140,
                    [1, 4.959868626919217e-10, -1.0660349936131297e-8, 0, 1.239979674494407e-9, 1, 5.408276049223559e-9, 0, -1.4139843962368559e-8, -4.361935701524544e-9, 1, 0, 0.000031739513360662386, 0.012799899093806744, -1.2553428518913279e-8, 1]
                  ],
                  [
                    141,
                    [-0.9990769028663635, -0.0429471917450428, -0.001049146754667163, 0, 0.04296000674366951, -0.9987788796424866, -0.024398930370807648, 0, -9.044150151016339e-11, -0.02442147582769394, 0.999701738357544, 0, 0.11642827838659286, -0.05540889501571655, 0.01719905063509941, 1]
                  ],
                  [
                    142,
                    [0.9995536208152771, 0.029874339699745178, -3.9644204585798093e-10, 0, -0.029693514108657837, 0.9935038089752197, -0.1098567470908165, 0, -0.003281895536929369, 0.10980770736932755, 0.993947446346283, 0, -8.107587490258084e-9, 0.431558758020401, -2.200702953203404e-9, 1]
                  ],
                  [
                    143,
                    [0.9785894155502319, -1.3714986479840263e-8, 0.20582182705402374, 0, -0.18835380673408508, 0.40315794944763184, 0.8955369591712952, 0, -0.08297872543334961, -0.9151302576065063, 0.3945261538028717, 0, 1.2854506792336906e-8, 0.44576480984687805, 1.4672419723638086e-8, 1]
                  ],
                  [
                    144,
                    [0.9974365234375, 2.3897440470932452e-8, 0.07155714184045792, 0, -0.0360969677567482, 0.8634414076805115, 0.5031559467315674, 0, -0.06178539618849754, -0.5044491291046143, 0.8612280488014221, 0, -9.225455066541599e-9, 0.22262610495090485, -1.5907412276305877e-8, 1]
                  ],
                  [
                    145,
                    [1, -6.99267488357691e-9, -1.270252347751466e-9, 0, 8.401299211868718e-9, 1, 7.717446126598304e-10, 0, -2.2216830597443504e-9, -2.623803674328684e-10, 1, 0, 9.70864633131896e-9, 0.08489981293678284, -3.777294921292196e-9, 1]
                  ],
                  [
                    146,
                    [-0.9990764260292053, 0.042967814952135086, 0.0004633926728274673, 0, -0.042970314621925354, -0.9990183115005493, -0.010774060152471066, 0, -4.075039611306508e-11, -0.010784020647406578, 0.9999418258666992, 0, -0.11642827838659286, -0.05540889501571655, 0.00968497060239315, 1]
                  ],
                  [
                    147,
                    [0.9995502829551697, -0.029983868822455406, -9.792490152094047e-10, 0, 0.02977030910551548, 0.9924311637878418, -0.11913787573575974, 0, 0.0035722150932997465, 0.11908429861068726, 0.9928777813911438, 0, 8.004428231345173e-9, 0.4314553737640381, -7.925615025383692e-11, 1]
                  ],
                  [
                    148,
                    [0.9786896705627441, -3.239573942437346e-8, -0.2053447663784027, 0, 0.1875450313091278, 0.4072479009628296, 0.8938544988632202, 0, 0.08362620323896408, -0.9133176803588867, 0.39856934547424316, 0, 2.315079683512522e-9, 0.4455118775367737, 1.0763120172896379e-8, 1]
                  ],
                  [
                    149,
                    [0.9976110458374023, 6.719425016399327e-11, -0.06908082962036133, 0, 0.03486630693078041, 0.8632845878601074, 0.5035117268562317, 0, 0.05963641032576561, -0.5047174096107483, 0.8612223267555237, 0, 8.906332560343344e-9, 0.22251959145069122, -2.5209670795334205e-8, 1]
                  ],
                  [
                    150,
                    [1, -9.625703789595264e-9, 1.794693171852657e-9, 0, 6.553300124778616e-9, 1, 2.9011271163170704e-10, 0, 7.935577750473044e-10, 3.6483513432550296e-10, 1, 0, 2.3122831427357937e-10, 0.08511721342802048, -2.9357178910061066e-9, 1]
                  ],
                  [
                    151,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    152,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    153,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    154,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    155,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    156,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    157,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    158,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    159,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    160,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    161,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    162,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    163,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    164,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    165,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    166,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    167,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    168,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    169,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    170,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    171,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    172,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    173,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    174,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    175,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    176,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    177,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    178,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    179,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    180,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    181,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    182,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    183,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    184,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    185,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    186,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    187,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    188,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    189,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    190,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    191,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    192,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    193,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ],
                  [
                    194,
                    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
                  ]
                ],
                "nodeNames": [
                  [
                    0,
                    "Sketchfab_model"
                  ],
                  [
                    1,
                    "985ec9739c20496b97be5cb1a0679ffb.fbx"
                  ],
                  [
                    2,
                    "Object_2"
                  ],
                  [
                    3,
                    "RootNode"
                  ],
                  [
                    4,
                    "Object_4"
                  ],
                  [
                    5,
                    "_rootJoint"
                  ],
                  [
                    6,
                    "Object_6"
                  ],
                  [
                    7,
                    "Object_7"
                  ],
                  [
                    8,
                    "Object_8"
                  ],
                  [
                    9,
                    "Object_9"
                  ],
                  [
                    10,
                    "Object_10"
                  ],
                  [
                    11,
                    "Object_11"
                  ],
                  [
                    12,
                    "Object_12"
                  ],
                  [
                    13,
                    "Object_13"
                  ],
                  [
                    14,
                    "Object_14"
                  ],
                  [
                    15,
                    "Object_15"
                  ],
                  [
                    16,
                    "Object_16"
                  ],
                  [
                    17,
                    "Object_17"
                  ],
                  [
                    18,
                    "Object_18"
                  ],
                  [
                    19,
                    "Object_19"
                  ],
                  [
                    20,
                    "Object_20"
                  ],
                  [
                    21,
                    "Object_21"
                  ],
                  [
                    22,
                    "Object_22"
                  ],
                  [
                    23,
                    "Object_23"
                  ],
                  [
                    24,
                    "Object_24"
                  ],
                  [
                    25,
                    "Object_25"
                  ],
                  [
                    26,
                    "Object_26"
                  ],
                  [
                    27,
                    "Object_27"
                  ],
                  [
                    28,
                    "Object_28"
                  ],
                  [
                    29,
                    "Object_29"
                  ],
                  [
                    30,
                    "Object_30"
                  ],
                  [
                    31,
                    "Object_31"
                  ],
                  [
                    32,
                    "Object_32"
                  ],
                  [
                    33,
                    "Object_33"
                  ],
                  [
                    34,
                    "Object_34"
                  ],
                  [
                    35,
                    "Object_35"
                  ],
                  [
                    36,
                    "Object_36"
                  ],
                  [
                    37,
                    "Object_37"
                  ],
                  [
                    38,
                    "Object_38"
                  ],
                  [
                    39,
                    "Object_39"
                  ],
                  [
                    40,
                    "Object_40"
                  ],
                  [
                    41,
                    "Object_41"
                  ],
                  [
                    42,
                    "Object_42"
                  ],
                  [
                    43,
                    "Object_43"
                  ],
                  [
                    44,
                    "Object_44"
                  ],
                  [
                    45,
                    "Object_45"
                  ],
                  [
                    46,
                    "Object_46"
                  ],
                  [
                    47,
                    "Object_47"
                  ],
                  [
                    48,
                    "Object_48"
                  ],
                  [
                    49,
                    "Object_49"
                  ],
                  [
                    50,
                    "Object_50"
                  ],
                  [
                    51,
                    "Object_51"
                  ],
                  [
                    52,
                    "Object_52"
                  ],
                  [
                    53,
                    "Object_53"
                  ],
                  [
                    54,
                    "Object_54"
                  ],
                  [
                    55,
                    "Object_55"
                  ],
                  [
                    56,
                    "Object_56"
                  ],
                  [
                    57,
                    "Object_57"
                  ],
                  [
                    58,
                    "Object_58"
                  ],
                  [
                    59,
                    "Object_59"
                  ],
                  [
                    60,
                    "Object_60"
                  ],
                  [
                    61,
                    "Object_61"
                  ],
                  [
                    62,
                    "Object_62"
                  ],
                  [
                    63,
                    "Object_63"
                  ],
                  [
                    64,
                    "Object_64"
                  ],
                  [
                    65,
                    "Object_65"
                  ],
                  [
                    66,
                    "Object_66"
                  ],
                  [
                    67,
                    "Object_67"
                  ],
                  [
                    68,
                    "Object_68"
                  ],
                  [
                    69,
                    "Object_69"
                  ],
                  [
                    70,
                    "Object_70"
                  ],
                  [
                    71,
                    "Object_71"
                  ],
                  [
                    72,
                    "Object_72"
                  ],
                  [
                    73,
                    "Object_73"
                  ],
                  [
                    74,
                    "Object_74"
                  ],
                  [
                    75,
                    "Object_75"
                  ],
                  [
                    76,
                    "Object_76"
                  ],
                  [
                    77,
                    "Object_77"
                  ],
                  [
                    78,
                    "Object_78"
                  ],
                  [
                    79,
                    "Object_79"
                  ],
                  [
                    80,
                    "Object_80"
                  ],
                  [
                    81,
                    "Object_81"
                  ],
                  [
                    82,
                    "Object_82"
                  ],
                  [
                    83,
                    "Object_83"
                  ],
                  [
                    84,
                    "Object_84"
                  ],
                  [
                    85,
                    "Object_85"
                  ],
                  [
                    86,
                    "Object_86"
                  ],
                  [
                    87,
                    "Object_87"
                  ],
                  [
                    88,
                    "Object_88"
                  ],
                  [
                    89,
                    "Object_89"
                  ],
                  [
                    90,
                    "Object_90"
                  ],
                  [
                    91,
                    "Object_91"
                  ],
                  [
                    92,
                    "Object_92"
                  ],
                  [
                    93,
                    "Object_93"
                  ],
                  [
                    94,
                    "mixamorig:Hips_01"
                  ],
                  [
                    95,
                    "mixamorig:Spine_02"
                  ],
                  [
                    96,
                    "mixamorig:Spine1_03"
                  ],
                  [
                    97,
                    "mixamorig:Spine2_04"
                  ],
                  [
                    98,
                    "mixamorig:Neck_05"
                  ],
                  [
                    99,
                    "mixamorig:Head_06"
                  ],
                  [
                    100,
                    "mixamorig:HeadTop_End_07"
                  ],
                  [
                    101,
                    "mixamorig:LeftShoulder_08"
                  ],
                  [
                    102,
                    "mixamorig:LeftArm_09"
                  ],
                  [
                    103,
                    "mixamorig:LeftForeArm_010"
                  ],
                  [
                    104,
                    "mixamorig:LeftHand_011"
                  ],
                  [
                    105,
                    "mixamorig:LeftHandThumb1_012"
                  ],
                  [
                    106,
                    "mixamorig:LeftHandThumb2_013"
                  ],
                  [
                    107,
                    "mixamorig:LeftHandThumb3_014"
                  ],
                  [
                    108,
                    "mixamorig:LeftHandThumb4_015"
                  ],
                  [
                    109,
                    "mixamorig:LeftHandIndex1_016"
                  ],
                  [
                    110,
                    "mixamorig:LeftHandIndex2_017"
                  ],
                  [
                    111,
                    "mixamorig:LeftHandIndex3_018"
                  ],
                  [
                    112,
                    "mixamorig:LeftHandIndex4_019"
                  ],
                  [
                    113,
                    "mixamorig:LeftHandMiddle1_020"
                  ],
                  [
                    114,
                    "mixamorig:LeftHandMiddle2_021"
                  ],
                  [
                    115,
                    "mixamorig:LeftHandMiddle3_022"
                  ],
                  [
                    116,
                    "mixamorig:LeftHandMiddle4_023"
                  ],
                  [
                    117,
                    "mixamorig:LeftHandRing1_024"
                  ],
                  [
                    118,
                    "mixamorig:LeftHandRing2_025"
                  ],
                  [
                    119,
                    "mixamorig:LeftHandRing3_00"
                  ],
                  [
                    120,
                    "mixamorig:LeftHandRing4_026"
                  ],
                  [
                    121,
                    "mixamorig:RightShoulder_027"
                  ],
                  [
                    122,
                    "mixamorig:RightArm_028"
                  ],
                  [
                    123,
                    "mixamorig:RightForeArm_029"
                  ],
                  [
                    124,
                    "mixamorig:RightHand_030"
                  ],
                  [
                    125,
                    "mixamorig:RightHandThumb1_031"
                  ],
                  [
                    126,
                    "mixamorig:RightHandThumb2_032"
                  ],
                  [
                    127,
                    "mixamorig:RightHandThumb3_033"
                  ],
                  [
                    128,
                    "mixamorig:RightHandThumb4_034"
                  ],
                  [
                    129,
                    "mixamorig:RightHandIndex1_035"
                  ],
                  [
                    130,
                    "mixamorig:RightHandIndex2_036"
                  ],
                  [
                    131,
                    "mixamorig:RightHandIndex3_037"
                  ],
                  [
                    132,
                    "mixamorig:RightHandIndex4_038"
                  ],
                  [
                    133,
                    "mixamorig:RightHandMiddle1_039"
                  ],
                  [
                    134,
                    "mixamorig:RightHandMiddle2_040"
                  ],
                  [
                    135,
                    "mixamorig:RightHandMiddle3_041"
                  ],
                  [
                    136,
                    "mixamorig:RightHandMiddle4_042"
                  ],
                  [
                    137,
                    "mixamorig:RightHandRing1_043"
                  ],
                  [
                    138,
                    "mixamorig:RightHandRing2_044"
                  ],
                  [
                    139,
                    "mixamorig:RightHandRing3_045"
                  ],
                  [
                    140,
                    "mixamorig:RightHandRing4_046"
                  ],
                  [
                    141,
                    "mixamorig:LeftUpLeg_047"
                  ],
                  [
                    142,
                    "mixamorig:LeftLeg_048"
                  ],
                  [
                    143,
                    "mixamorig:LeftFoot_049"
                  ],
                  [
                    144,
                    "mixamorig:LeftToeBase_050"
                  ],
                  [
                    145,
                    "mixamorig:LeftToe_End_051"
                  ],
                  [
                    146,
                    "mixamorig:RightUpLeg_052"
                  ],
                  [
                    147,
                    "mixamorig:RightLeg_053"
                  ],
                  [
                    148,
                    "mixamorig:RightFoot_054"
                  ],
                  [
                    149,
                    "mixamorig:RightToeBase_055"
                  ],
                  [
                    150,
                    "mixamorig:RightToe_End_056"
                  ],
                  [
                    151,
                    "under_low"
                  ],
                  [
                    152,
                    "cheville_low"
                  ],
                  [
                    153,
                    "feet_low"
                  ],
                  [
                    154,
                    "up_low"
                  ],
                  [
                    155,
                    "leg_low"
                  ],
                  [
                    156,
                    "knee_low"
                  ],
                  [
                    157,
                    "wing01_low"
                  ],
                  [
                    158,
                    "wing02_low"
                  ],
                  [
                    159,
                    "attach_low"
                  ],
                  [
                    160,
                    "face_low"
                  ],
                  [
                    161,
                    "Helmet_low"
                  ],
                  [
                    162,
                    "Jaw_low"
                  ],
                  [
                    163,
                    "Mohawks_low"
                  ],
                  [
                    164,
                    "cross_low"
                  ],
                  [
                    165,
                    "Ears_low"
                  ],
                  [
                    166,
                    "Forhead_low"
                  ],
                  [
                    167,
                    "chest_low"
                  ],
                  [
                    168,
                    "bavet_low"
                  ],
                  [
                    169,
                    "neck_low"
                  ],
                  [
                    170,
                    "manche_low"
                  ],
                  [
                    171,
                    "strap_low"
                  ],
                  [
                    172,
                    "patch_low"
                  ],
                  [
                    173,
                    "elbow_low"
                  ],
                  [
                    174,
                    "chains02_low"
                  ],
                  [
                    175,
                    "arm_low"
                  ],
                  [
                    176,
                    "epaulette_low"
                  ],
                  [
                    177,
                    "shoulder_low"
                  ],
                  [
                    178,
                    "glove_low"
                  ],
                  [
                    179,
                    "hand_low"
                  ],
                  [
                    180,
                    "thumps_low"
                  ],
                  [
                    181,
                    "fingers_low"
                  ],
                  [
                    182,
                    "hips_low"
                  ],
                  [
                    183,
                    "sidepatch_low"
                  ],
                  [
                    184,
                    "donut_low"
                  ],
                  [
                    185,
                    "belt_low"
                  ],
                  [
                    186,
                    "chains_low"
                  ],
                  [
                    187,
                    "hold_low"
                  ],
                  [
                    188,
                    "o_low"
                  ],
                  [
                    189,
                    "short_low"
                  ],
                  [
                    190,
                    "robe_low"
                  ],
                  [
                    191,
                    "bouclier_low"
                  ],
                  [
                    192,
                    "twist_low"
                  ],
                  [
                    193,
                    "tickle_low"
                  ],
                  [
                    194,
                    "twist01_low"
                  ]
                ],
                "ikRig": {
                  "feet": [
                    {
                      "thigh": 141,
                      "shin": 142,
                      "foot": 143,
                      "toe": 144
                    },
                    {
                      "thigh": 146,
                      "shin": 147,
                      "foot": 148,
                      "toe": 149
                    }
                  ],
                  "hips": 94
                },
                "sockets": [
                  {
                    "name": "RightHand",
                    "bone": "mixamorig:RightHand_030",
                    "offset": {
                      "t": [0, 0, 0],
                      "r": [-0.02698, -0.233403, 0.023907, 0.971712],
                      "s": [1, 1, 1]
                    }
                  },
                  {
                    "name": "LeftHand",
                    "bone": "mixamorig:LeftHand_011",
                    "offset": {
                      "t": [0, 0, 0],
                      "r": [-0.024721, 0.262827, -0.020722, 0.964303],
                      "s": [1, 1, 1]
                    }
                  }
                ]
              },
              "jointIndices": {
                "$idx": {
                  "h": "106930d2d1b3304c016cfcc7c05fcecfe93689b32b28b179652fe4a79e8e4ccb",
                  "l": 254040,
                  "bits": 16
                }
              },
              "jointWeights": {
                "$f64": {
                  "h": "557a674572b6049cdd917eb4bebc9a41e95944e031fb48558aa9fd366559a36c",
                  "l": 1016160
                }
              },
              "animations": null
            },
            "animationMappings": [],
            "stateMachine": {
              "parameters": [
                {
                  "name": "Speed",
                  "type": "variable",
                  "default": 0,
                  "variable": {
                    "nodeRef": "parent",
                    "varName": "planarSpeed",
                    "varType": "number",
                    "source": "builtin"
                  }
                },
                {
                  "name": "Direction",
                  "type": "variable",
                  "default": 0,
                  "variable": {
                    "nodeRef": "parent",
                    "varName": "planarAngle",
                    "varType": "number",
                    "source": "builtin"
                  }
                },
                {
                  "name": "Died",
                  "type": "trigger",
                  "default": false
                },
                {
                  "name": "Revive",
                  "type": "trigger",
                  "default": false
                },
                {
                  "name": "InCombat",
                  "type": "bool",
                  "default": false
                },
                {
                  "name": "Stop",
                  "type": "trigger",
                  "default": false
                },
                {
                  "name": "Cut",
                  "type": "trigger",
                  "default": false
                },
                {
                  "name": "Roll",
                  "type": "trigger",
                  "default": false
                },
                {
                  "name": "Backstep",
                  "type": "trigger",
                  "default": false
                },
                {
                  "name": "RunTurnRight",
                  "type": "trigger",
                  "default": false
                },
                {
                  "name": "RunTurnLeft",
                  "type": "trigger",
                  "default": false
                },
                {
                  "name": "Drink",
                  "type": "trigger",
                  "default": false
                },
                {
                  "name": "HitLight",
                  "type": "trigger",
                  "default": false
                },
                {
                  "name": "HitHeavy",
                  "type": "trigger",
                  "default": false
                },
                {
                  "name": "Recoil",
                  "type": "trigger",
                  "default": false
                },
                {
                  "name": "Swap",
                  "type": "trigger",
                  "default": false
                },
                {
                  "name": "Rest",
                  "type": "trigger",
                  "default": false
                },
                {
                  "name": "FogWalk",
                  "type": "trigger",
                  "default": false
                },
                {
                  "name": "Pickup",
                  "type": "trigger",
                  "default": false
                },
                {
                  "name": "Interact",
                  "type": "trigger",
                  "default": false
                },
                {
                  "name": "Longsword Light1",
                  "type": "trigger",
                  "default": false
                },
                {
                  "name": "Longsword Light2",
                  "type": "trigger",
                  "default": false
                },
                {
                  "name": "Longsword Light3",
                  "type": "trigger",
                  "default": false
                },
                {
                  "name": "Longsword Heavy",
                  "type": "trigger",
                  "default": false
                },
                {
                  "name": "Greatsword Light1",
                  "type": "trigger",
                  "default": false
                },
                {
                  "name": "Greatsword Light2",
                  "type": "trigger",
                  "default": false
                },
                {
                  "name": "Greatsword Heavy",
                  "type": "trigger",
                  "default": false
                }
              ],
              "states": [
                {
                  "name": "Idle",
                  "clipName": "Idle",
                  "loop": true,
                  "speed": 1,
                  "isEntry": true,
                  "x": 40,
                  "y": 40
                },
                {
                  "name": "Locomotion",
                  "clipName": "",
                  "fieldId": "b5c38e9c94a6b087db47b12df05a9264",
                  "field": {
                    "mode": "2d",
                    "xAxis": {
                      "name": "Direction",
                      "min": -180,
                      "max": 180,
                      "wrap": true,
                      "smoothing": 0.04,
                      "deadzone": 0
                    },
                    "samples": [
                      {
                        "clipName": "Walk",
                        "x": 0,
                        "y": 1.5
                      },
                      {
                        "clipName": "Run",
                        "x": 0,
                        "rateScale": 1,
                        "y": 4
                      },
                      {
                        "clipName": "WalkStrafeRight",
                        "x": -90,
                        "y": 1.5
                      },
                      {
                        "clipName": "RunStrafeRight",
                        "x": -90,
                        "y": 4
                      },
                      {
                        "clipName": "WalkStrafeLeft",
                        "x": 90,
                        "y": 1.5
                      },
                      {
                        "clipName": "RunStrafeLeft",
                        "x": 90,
                        "y": 4
                      },
                      {
                        "clipName": "WalkBackwards",
                        "x": 180,
                        "y": 1.5
                      },
                      {
                        "clipName": "RunBackwards",
                        "x": 180,
                        "y": 4
                      },
                      {
                        "clipName": "RunDiagLeft",
                        "x": 135,
                        "y": 4
                      },
                      {
                        "clipName": "RunDiagRight",
                        "x": -135,
                        "y": 4
                      },
                      {
                        "clipName": "Run",
                        "x": 0,
                        "y": 5.8,
                        "rateScale": 1.4
                      }
                    ],
                    "yAxis": {
                      "name": "Speed",
                      "min": 0,
                      "max": 5.8,
                      "smoothing": 0.04
                    },
                    "weightSmoothing": 0.06
                  },
                  "fieldInputs": {
                    "x": "Direction",
                    "y": "Speed"
                  },
                  "loop": true,
                  "speed": 1,
                  "isEntry": false,
                  "x": 300,
                  "y": 40
                },
                {
                  "name": "Dead",
                  "clipName": "Souls_Dying",
                  "loop": false,
                  "speed": 1,
                  "isEntry": false,
                  "x": 170,
                  "y": 200
                },
                {
                  "name": "CombatIdle",
                  "clipName": "Souls_LS_Stance",
                  "loop": true,
                  "speed": 1,
                  "isEntry": false,
                  "x": 40,
                  "y": 200
                }
              ],
              "transitions": [
                {
                  "from": "Idle",
                  "to": "Dead",
                  "conditions": [],
                  "minDwell": 0,
                  "hasExitTime": false,
                  "exitTime": 1,
                  "condition": {
                    "op": "and",
                    "children": [
                      {
                        "param": "Died",
                        "op": "trigger"
                      }
                    ]
                  }
                },
                {
                  "from": "Locomotion",
                  "to": "Dead",
                  "conditions": [],
                  "minDwell": 0,
                  "hasExitTime": false,
                  "exitTime": 1,
                  "condition": {
                    "op": "and",
                    "children": [
                      {
                        "param": "Died",
                        "op": "trigger"
                      }
                    ]
                  }
                },
                {
                  "from": "Dead",
                  "to": "Idle",
                  "conditions": [],
                  "minDwell": 0,
                  "hasExitTime": false,
                  "exitTime": 1,
                  "condition": {
                    "op": "and",
                    "children": [
                      {
                        "param": "Revive",
                        "op": "trigger"
                      }
                    ]
                  }
                },
                {
                  "from": "Idle",
                  "to": "Locomotion",
                  "conditions": [],
                  "minDwell": 0.05,
                  "hasExitTime": false,
                  "exitTime": 1,
                  "condition": {
                    "op": "and",
                    "children": [
                      {
                        "param": "Speed",
                        "op": "gt",
                        "value": 0.5,
                        "hysteresis": 0.15
                      }
                    ]
                  },
                  "blendTime": 0.25
                },
                {
                  "from": "Locomotion",
                  "to": "Idle",
                  "conditions": [],
                  "minDwell": 0.1,
                  "hasExitTime": false,
                  "exitTime": 1,
                  "condition": {
                    "op": "and",
                    "children": [
                      {
                        "param": "Speed",
                        "op": "lt",
                        "value": 0.5,
                        "hysteresis": 0.15
                      },
                      {
                        "param": "InCombat",
                        "op": "false"
                      }
                    ]
                  },
                  "blendTime": 0.3
                },
                {
                  "from": "Locomotion",
                  "to": "CombatIdle",
                  "conditions": [],
                  "minDwell": 0.1,
                  "hasExitTime": false,
                  "exitTime": 1,
                  "condition": {
                    "op": "and",
                    "children": [
                      {
                        "param": "Speed",
                        "op": "lt",
                        "value": 0.5,
                        "hysteresis": 0.15
                      },
                      {
                        "param": "InCombat",
                        "op": "true"
                      }
                    ]
                  },
                  "blendTime": 0.3
                },
                {
                  "from": "Idle",
                  "to": "CombatIdle",
                  "conditions": [],
                  "minDwell": 0,
                  "hasExitTime": false,
                  "exitTime": 1,
                  "condition": {
                    "op": "and",
                    "children": [
                      {
                        "param": "InCombat",
                        "op": "true"
                      }
                    ]
                  },
                  "blendTime": 0.35
                },
                {
                  "from": "CombatIdle",
                  "to": "Idle",
                  "conditions": [],
                  "minDwell": 0.5,
                  "hasExitTime": false,
                  "exitTime": 1,
                  "condition": {
                    "op": "and",
                    "children": [
                      {
                        "param": "InCombat",
                        "op": "false"
                      }
                    ]
                  },
                  "blendTime": 0.6
                },
                {
                  "from": "CombatIdle",
                  "to": "Locomotion",
                  "conditions": [],
                  "minDwell": 0.05,
                  "hasExitTime": false,
                  "exitTime": 1,
                  "condition": {
                    "op": "and",
                    "children": [
                      {
                        "param": "Speed",
                        "op": "gt",
                        "value": 0.5,
                        "hysteresis": 0.15
                      }
                    ]
                  },
                  "blendTime": 0.25
                },
                {
                  "from": "CombatIdle",
                  "to": "Dead",
                  "conditions": [],
                  "minDwell": 0,
                  "hasExitTime": false,
                  "exitTime": 1,
                  "condition": {
                    "op": "and",
                    "children": [
                      {
                        "param": "Died",
                        "op": "trigger"
                      }
                    ]
                  }
                }
              ],
              "layers": [
                {
                  "name": "Guard",
                  "blend": "override",
                  "weight": 1,
                  "maskId": "f2b756eabaf08fa36011c6ac25913f7f",
                  "mask": {
                    "mixamorig1:LeftShoulder": 1,
                    "mixamorig1:LeftArm": 1,
                    "mixamorig1:LeftForeArm": 1,
                    "mixamorig1:LeftHand": 1,
                    "mixamorig1:LeftHandThumb1": 1,
                    "mixamorig1:LeftHandThumb2": 1,
                    "mixamorig1:LeftHandThumb3": 1,
                    "mixamorig1:LeftHandThumb4": 1,
                    "mixamorig1:LeftHandIndex1": 1,
                    "mixamorig1:LeftHandIndex2": 1,
                    "mixamorig1:LeftHandIndex3": 1,
                    "mixamorig1:LeftHandIndex4": 1,
                    "mixamorig1:LeftHandMiddle1": 1,
                    "mixamorig1:LeftHandMiddle2": 1,
                    "mixamorig1:LeftHandMiddle3": 1,
                    "mixamorig1:LeftHandMiddle4": 1,
                    "mixamorig1:LeftHandRing1": 1,
                    "mixamorig1:LeftHandRing2": 1,
                    "mixamorig1:LeftHandRing3": 1,
                    "mixamorig1:LeftHandRing4": 1,
                    "mixamorig1:LeftHandPinky1": 1,
                    "mixamorig1:LeftHandPinky2": 1,
                    "mixamorig1:LeftHandPinky3": 1,
                    "mixamorig1:LeftHandPinky4": 1,
                    "mixamorig1:RightShoulder": 1,
                    "mixamorig1:RightArm": 1,
                    "mixamorig1:RightForeArm": 1,
                    "mixamorig1:RightHand": 1,
                    "mixamorig1:RightHandThumb1": 1,
                    "mixamorig1:RightHandThumb2": 1,
                    "mixamorig1:RightHandThumb3": 1,
                    "mixamorig1:RightHandThumb4": 1,
                    "mixamorig1:RightHandIndex1": 1,
                    "mixamorig1:RightHandIndex2": 1,
                    "mixamorig1:RightHandIndex3": 1,
                    "mixamorig1:RightHandIndex4": 1,
                    "mixamorig1:RightHandMiddle1": 1,
                    "mixamorig1:RightHandMiddle2": 1,
                    "mixamorig1:RightHandMiddle3": 1,
                    "mixamorig1:RightHandMiddle4": 1,
                    "mixamorig1:RightHandRing1": 1,
                    "mixamorig1:RightHandRing2": 1,
                    "mixamorig1:RightHandRing3": 1,
                    "mixamorig1:RightHandRing4": 1,
                    "mixamorig1:RightHandPinky1": 1,
                    "mixamorig1:RightHandPinky2": 1,
                    "mixamorig1:RightHandPinky3": 1,
                    "mixamorig1:RightHandPinky4": 1
                  },
                  "states": [
                    {
                      "name": "Off",
                      "clipName": "",
                      "loop": true,
                      "speed": 1,
                      "isEntry": true,
                      "x": 40,
                      "y": 40
                    },
                    {
                      "name": "Guard",
                      "clipName": "Souls_LS_Guard",
                      "loop": true,
                      "speed": 1,
                      "isEntry": false,
                      "x": 300,
                      "y": 40
                    }
                  ],
                  "transitions": [
                    {
                      "from": "Off",
                      "to": "Guard",
                      "conditions": [],
                      "minDwell": 0.1,
                      "hasExitTime": false,
                      "exitTime": 1,
                      "condition": {
                        "op": "and",
                        "children": [
                          {
                            "param": "InCombat",
                            "op": "true"
                          },
                          {
                            "param": "Speed",
                            "op": "gt",
                            "value": 0.5,
                            "hysteresis": 0.15
                          },
                          {
                            "param": "Speed",
                            "op": "lt",
                            "value": 4.7,
                            "hysteresis": 0.15
                          }
                        ]
                      },
                      "blendTime": 0.3
                    },
                    {
                      "from": "Guard",
                      "to": "Off",
                      "conditions": [],
                      "minDwell": 0.15,
                      "hasExitTime": false,
                      "exitTime": 1,
                      "condition": {
                        "op": "or",
                        "children": [
                          {
                            "param": "InCombat",
                            "op": "false"
                          },
                          {
                            "param": "Speed",
                            "op": "lt",
                            "value": 0.4,
                            "hysteresis": 0.15
                          },
                          {
                            "param": "Speed",
                            "op": "gt",
                            "value": 4.9,
                            "hysteresis": 0.15
                          }
                        ]
                      },
                      "blendTime": 0.35
                    },
                    {
                      "from": "Guard",
                      "to": "Off",
                      "conditions": [],
                      "minDwell": 0,
                      "hasExitTime": false,
                      "exitTime": 1,
                      "condition": {
                        "op": "and",
                        "children": [
                          {
                            "param": "Died",
                            "op": "trigger"
                          }
                        ]
                      },
                      "blendTime": 0.15
                    }
                  ]
                },
                {
                  "name": "UpperBody",
                  "blend": "override",
                  "weight": 1,
                  "maskId": "5932b38920918b4dcb769072b1d2a6a0",
                  "mask": {
                    "mixamorig1:RightShoulder": 1,
                    "mixamorig1:RightArm": 1,
                    "mixamorig1:RightForeArm": 1,
                    "mixamorig1:RightHand": 1,
                    "mixamorig1:RightHandThumb1": 1,
                    "mixamorig1:RightHandThumb2": 1,
                    "mixamorig1:RightHandThumb3": 1,
                    "mixamorig1:RightHandThumb4": 1,
                    "mixamorig1:RightHandIndex1": 1,
                    "mixamorig1:RightHandIndex2": 1,
                    "mixamorig1:RightHandIndex3": 1,
                    "mixamorig1:RightHandIndex4": 1,
                    "mixamorig1:RightHandMiddle1": 1,
                    "mixamorig1:RightHandMiddle2": 1,
                    "mixamorig1:RightHandMiddle3": 1,
                    "mixamorig1:RightHandMiddle4": 1,
                    "mixamorig1:RightHandRing1": 1,
                    "mixamorig1:RightHandRing2": 1,
                    "mixamorig1:RightHandRing3": 1,
                    "mixamorig1:RightHandRing4": 1,
                    "mixamorig1:RightHandPinky1": 1,
                    "mixamorig1:RightHandPinky2": 1,
                    "mixamorig1:RightHandPinky3": 1,
                    "mixamorig1:RightHandPinky4": 1
                  },
                  "states": [
                    {
                      "name": "Off",
                      "clipName": "",
                      "loop": true,
                      "speed": 1,
                      "isEntry": true,
                      "x": 40,
                      "y": 40
                    },
                    {
                      "name": "Sword Run",
                      "clipName": "Souls_RunWithSword",
                      "loop": true,
                      "speed": 1,
                      "isEntry": false,
                      "x": 300,
                      "y": 40
                    }
                  ],
                  "transitions": [
                    {
                      "from": "Off",
                      "to": "Sword Run",
                      "conditions": [],
                      "minDwell": 0.1,
                      "hasExitTime": false,
                      "exitTime": 1,
                      "condition": {
                        "op": "and",
                        "children": [
                          {
                            "param": "Speed",
                            "op": "gt",
                            "value": 2.2,
                            "hysteresis": 0.15
                          },
                          {
                            "op": "or",
                            "children": [
                              {
                                "param": "InCombat",
                                "op": "false"
                              },
                              {
                                "param": "Speed",
                                "op": "gt",
                                "value": 4.7,
                                "hysteresis": 0.15
                              }
                            ]
                          }
                        ]
                      },
                      "blendTime": 0.25
                    },
                    {
                      "from": "Sword Run",
                      "to": "Off",
                      "conditions": [],
                      "minDwell": 0.15,
                      "hasExitTime": false,
                      "exitTime": 1,
                      "condition": {
                        "op": "and",
                        "children": [
                          {
                            "param": "Speed",
                            "op": "lt",
                            "value": 1.8,
                            "hysteresis": 0.15
                          }
                        ]
                      },
                      "blendTime": 0.3
                    },
                    {
                      "from": "Sword Run",
                      "to": "Off",
                      "conditions": [],
                      "minDwell": 0,
                      "hasExitTime": false,
                      "exitTime": 1,
                      "condition": {
                        "op": "and",
                        "children": [
                          {
                            "param": "Died",
                            "op": "trigger"
                          }
                        ]
                      },
                      "blendTime": 0.15
                    },
                    {
                      "from": "Sword Run",
                      "to": "Off",
                      "conditions": [],
                      "minDwell": 0.15,
                      "hasExitTime": false,
                      "exitTime": 1,
                      "condition": {
                        "op": "and",
                        "children": [
                          {
                            "param": "InCombat",
                            "op": "true"
                          },
                          {
                            "param": "Speed",
                            "op": "lt",
                            "value": 4.5,
                            "hysteresis": 0.15
                          }
                        ]
                      },
                      "blendTime": 0.3
                    }
                  ]
                },
                {
                  "name": "Actions",
                  "blend": "override",
                  "weight": 1,
                  "states": [
                    {
                      "name": "Off",
                      "clipName": "",
                      "loop": true,
                      "speed": 1,
                      "isEntry": true,
                      "x": 40,
                      "y": 40,
                      "triggers": [
                        {
                          "trigger": "Died",
                          "blendTime": 0.15
                        },
                        {
                          "trigger": "Stop",
                          "blendTime": 0.22
                        },
                        {
                          "trigger": "Cut",
                          "blendTime": 0
                        }
                      ]
                    },
                    {
                      "name": "Roll",
                      "clipName": "Souls_Roll",
                      "loop": false,
                      "speed": 1.5,
                      "isEntry": false,
                      "triggers": [
                        {
                          "trigger": "Roll",
                          "blendTime": 0.1
                        }
                      ],
                      "ikWeight": 0,
                      "extractRootMotion": true,
                      "x": 300,
                      "y": 40
                    },
                    {
                      "name": "Backstep",
                      "clipName": "Souls_Backstep",
                      "loop": false,
                      "speed": 1,
                      "isEntry": false,
                      "triggers": [
                        {
                          "trigger": "Backstep",
                          "blendTime": 0.1
                        }
                      ],
                      "ikWeight": 0,
                      "x": 510,
                      "y": 40
                    },
                    {
                      "name": "RunTurnRight",
                      "clipName": "Souls_RunTurn180",
                      "loop": false,
                      "speed": 1.2,
                      "isEntry": false,
                      "triggers": [
                        {
                          "trigger": "RunTurnRight",
                          "blendTime": 0.1
                        }
                      ],
                      "ikWeight": 0,
                      "x": 720,
                      "y": 40
                    },
                    {
                      "name": "RunTurnLeft",
                      "clipName": "Souls_RunTurn180L",
                      "loop": false,
                      "speed": 1.2,
                      "isEntry": false,
                      "triggers": [
                        {
                          "trigger": "RunTurnLeft",
                          "blendTime": 0.1
                        }
                      ],
                      "ikWeight": 0,
                      "x": 930,
                      "y": 40
                    },
                    {
                      "name": "Drink",
                      "clipName": "Souls_Drink",
                      "loop": false,
                      "speed": 1,
                      "isEntry": false,
                      "triggers": [
                        {
                          "trigger": "Drink",
                          "blendTime": 0.1
                        }
                      ],
                      "x": 300,
                      "y": 160
                    },
                    {
                      "name": "HitLight",
                      "clipName": "Souls_HitLight",
                      "loop": false,
                      "speed": 1,
                      "isEntry": false,
                      "triggers": [
                        {
                          "trigger": "HitLight",
                          "blendTime": 0.1
                        }
                      ],
                      "x": 510,
                      "y": 160
                    },
                    {
                      "name": "HitHeavy",
                      "clipName": "Souls_HitHeavy",
                      "loop": false,
                      "speed": 1,
                      "isEntry": false,
                      "triggers": [
                        {
                          "trigger": "HitHeavy",
                          "blendTime": 0.1
                        }
                      ],
                      "x": 720,
                      "y": 160
                    },
                    {
                      "name": "Recoil",
                      "clipName": "Souls_HitLight",
                      "loop": false,
                      "speed": 1.4,
                      "isEntry": false,
                      "triggers": [
                        {
                          "trigger": "Recoil",
                          "blendTime": 0.1
                        }
                      ],
                      "x": 930,
                      "y": 160
                    },
                    {
                      "name": "Sheath",
                      "clipName": "Souls_Sheath",
                      "loop": false,
                      "speed": 2,
                      "isEntry": false,
                      "triggers": [
                        {
                          "trigger": "Swap",
                          "blendTime": 0.1
                        }
                      ],
                      "x": 300,
                      "y": 280
                    },
                    {
                      "name": "Draw",
                      "clipName": "Souls_Draw",
                      "loop": false,
                      "speed": 2,
                      "isEntry": false,
                      "x": 510,
                      "y": 280
                    },
                    {
                      "name": "Rest",
                      "clipName": "Souls_Rest",
                      "loop": true,
                      "speed": 1,
                      "isEntry": false,
                      "triggers": [
                        {
                          "trigger": "Rest",
                          "blendTime": 0.1
                        }
                      ],
                      "x": 720,
                      "y": 280
                    },
                    {
                      "name": "FogWalk",
                      "clipName": "Souls_FogWalk",
                      "loop": false,
                      "speed": 1,
                      "isEntry": false,
                      "triggers": [
                        {
                          "trigger": "FogWalk",
                          "blendTime": 0.1
                        }
                      ],
                      "x": 930,
                      "y": 280
                    },
                    {
                      "name": "Pickup",
                      "clipName": "Souls_Pickup",
                      "loop": false,
                      "speed": 1,
                      "isEntry": false,
                      "triggers": [
                        {
                          "trigger": "Pickup",
                          "blendTime": 0.1
                        }
                      ],
                      "x": 300,
                      "y": 400
                    },
                    {
                      "name": "Interact",
                      "clipName": "Souls_Interact",
                      "loop": false,
                      "speed": 1,
                      "isEntry": false,
                      "triggers": [
                        {
                          "trigger": "Interact",
                          "blendTime": 0.1
                        }
                      ],
                      "x": 510,
                      "y": 400
                    },
                    {
                      "name": "Longsword Light1",
                      "clipName": "Souls_LS_Combo",
                      "loop": false,
                      "speed": 1.1,
                      "isEntry": false,
                      "triggers": [
                        {
                          "trigger": "Longsword Light1",
                          "blendTime": 0.12
                        }
                      ],
                      "extractRootMotion": true,
                      "x": 720,
                      "y": 400
                    },
                    {
                      "name": "Longsword Light2",
                      "clipName": "Souls_LS_Combo",
                      "loop": false,
                      "speed": 1.1,
                      "isEntry": false,
                      "startTime": 0.9,
                      "extractRootMotion": true,
                      "x": 930,
                      "y": 400
                    },
                    {
                      "name": "Longsword Light3",
                      "clipName": "Souls_LS_Combo",
                      "loop": false,
                      "speed": 1.1,
                      "isEntry": false,
                      "startTime": 1.74,
                      "extractRootMotion": true,
                      "x": 300,
                      "y": 520
                    },
                    {
                      "name": "Longsword Heavy",
                      "clipName": "Souls_LS_Heavy",
                      "loop": false,
                      "speed": 1.05,
                      "isEntry": false,
                      "triggers": [
                        {
                          "trigger": "Longsword Heavy",
                          "blendTime": 0.12
                        }
                      ],
                      "extractRootMotion": true,
                      "x": 510,
                      "y": 520
                    },
                    {
                      "name": "Greatsword Light1",
                      "clipName": "Souls_GS_L1",
                      "loop": false,
                      "speed": 1.35,
                      "isEntry": false,
                      "triggers": [
                        {
                          "trigger": "Greatsword Light1",
                          "blendTime": 0.12
                        }
                      ],
                      "x": 720,
                      "y": 520
                    },
                    {
                      "name": "Greatsword Light2",
                      "clipName": "Souls_GS_L2",
                      "loop": false,
                      "speed": 1.35,
                      "isEntry": false,
                      "triggers": [
                        {
                          "trigger": "Greatsword Light2",
                          "blendTime": 0.12
                        }
                      ],
                      "x": 930,
                      "y": 520
                    },
                    {
                      "name": "Greatsword Heavy",
                      "clipName": "Souls_GS_Heavy",
                      "loop": false,
                      "speed": 1.15,
                      "isEntry": false,
                      "triggers": [
                        {
                          "trigger": "Greatsword Heavy",
                          "blendTime": 0.12
                        }
                      ],
                      "x": 300,
                      "y": 640
                    }
                  ],
                  "transitions": [
                    {
                      "from": "Sheath",
                      "to": "Draw",
                      "conditions": [],
                      "minDwell": 0,
                      "hasExitTime": true,
                      "exitTime": 1,
                      "blendTime": 0.1
                    },
                    {
                      "from": "Longsword Light1",
                      "to": "Longsword Light2",
                      "conditions": [],
                      "minDwell": 0,
                      "hasExitTime": true,
                      "exitTime": 0.28938906752411575,
                      "condition": {
                        "op": "and",
                        "children": [
                          {
                            "param": "Longsword Light2",
                            "op": "trigger"
                          }
                        ]
                      },
                      "blendTime": 0
                    },
                    {
                      "from": "Longsword Light2",
                      "to": "Longsword Light3",
                      "conditions": [],
                      "minDwell": 0,
                      "hasExitTime": true,
                      "exitTime": 0.5594855305466239,
                      "condition": {
                        "op": "and",
                        "children": [
                          {
                            "param": "Longsword Light3",
                            "op": "trigger"
                          }
                        ]
                      },
                      "blendTime": 0
                    },
                    {
                      "from": "Roll",
                      "to": "Off",
                      "conditions": [],
                      "minDwell": 0,
                      "hasExitTime": true,
                      "exitTime": 0.798,
                      "blendTime": 0.22
                    },
                    {
                      "from": "Backstep",
                      "to": "Off",
                      "conditions": [],
                      "minDwell": 0,
                      "hasExitTime": true,
                      "exitTime": 0.511,
                      "blendTime": 0.22
                    },
                    {
                      "from": "RunTurnRight",
                      "to": "Off",
                      "conditions": [],
                      "minDwell": 0,
                      "hasExitTime": true,
                      "exitTime": 1,
                      "blendTime": 0
                    },
                    {
                      "from": "RunTurnLeft",
                      "to": "Off",
                      "conditions": [],
                      "minDwell": 0,
                      "hasExitTime": true,
                      "exitTime": 1,
                      "blendTime": 0
                    },
                    {
                      "from": "Drink",
                      "to": "Off",
                      "conditions": [],
                      "minDwell": 0,
                      "hasExitTime": true,
                      "exitTime": 0.843,
                      "blendTime": 0.22
                    },
                    {
                      "from": "HitLight",
                      "to": "Off",
                      "conditions": [],
                      "minDwell": 0,
                      "hasExitTime": true,
                      "exitTime": 0.511,
                      "blendTime": 0.22
                    },
                    {
                      "from": "HitHeavy",
                      "to": "Off",
                      "conditions": [],
                      "minDwell": 0,
                      "hasExitTime": true,
                      "exitTime": 0.787,
                      "blendTime": 0.22
                    },
                    {
                      "from": "Recoil",
                      "to": "Off",
                      "conditions": [],
                      "minDwell": 0,
                      "hasExitTime": true,
                      "exitTime": 0.316,
                      "blendTime": 0.22
                    },
                    {
                      "from": "Draw",
                      "to": "Off",
                      "conditions": [],
                      "minDwell": 0,
                      "hasExitTime": true,
                      "exitTime": 0.707,
                      "blendTime": 0.22
                    },
                    {
                      "from": "FogWalk",
                      "to": "Off",
                      "conditions": [],
                      "minDwell": 0,
                      "hasExitTime": true,
                      "exitTime": 0.853,
                      "blendTime": 0.22
                    },
                    {
                      "from": "Pickup",
                      "to": "Off",
                      "conditions": [],
                      "minDwell": 0,
                      "hasExitTime": true,
                      "exitTime": 0.725,
                      "blendTime": 0.22
                    },
                    {
                      "from": "Interact",
                      "to": "Off",
                      "conditions": [],
                      "minDwell": 0,
                      "hasExitTime": true,
                      "exitTime": 0.756,
                      "blendTime": 0.22
                    },
                    {
                      "from": "Longsword Light1",
                      "to": "Off",
                      "conditions": [],
                      "minDwell": 0,
                      "hasExitTime": true,
                      "exitTime": 0.28938906752411575,
                      "blendTime": 0.35
                    },
                    {
                      "from": "Longsword Light2",
                      "to": "Off",
                      "conditions": [],
                      "minDwell": 0,
                      "hasExitTime": true,
                      "exitTime": 0.5594855305466239,
                      "blendTime": 0.35
                    },
                    {
                      "from": "Longsword Light3",
                      "to": "Off",
                      "conditions": [],
                      "minDwell": 0,
                      "hasExitTime": true,
                      "exitTime": 0.876,
                      "blendTime": 0.35
                    },
                    {
                      "from": "Longsword Heavy",
                      "to": "Off",
                      "conditions": [],
                      "minDwell": 0,
                      "hasExitTime": true,
                      "exitTime": 0.799,
                      "blendTime": 0.35
                    },
                    {
                      "from": "Greatsword Light1",
                      "to": "Off",
                      "conditions": [],
                      "minDwell": 0,
                      "hasExitTime": true,
                      "exitTime": 0.851,
                      "blendTime": 0.35
                    },
                    {
                      "from": "Greatsword Light2",
                      "to": "Off",
                      "conditions": [],
                      "minDwell": 0,
                      "hasExitTime": true,
                      "exitTime": 0.851,
                      "blendTime": 0.35
                    },
                    {
                      "from": "Greatsword Heavy",
                      "to": "Off",
                      "conditions": [],
                      "minDwell": 0,
                      "hasExitTime": true,
                      "exitTime": 0.822,
                      "blendTime": 0.35
                    }
                  ]
                }
              ],
              "events": [],
              "controllerId": "4d2aab21ab7c1d64de571708556d90b5"
            },
            "ragdoll": null
          },
          {
            "id": "884b01184bf51119ad40f25ac7cf5e76",
            "name": "Weapons",
            "type": "node",
            "position": [0, 0, 0],
            "rotation": [0, 0, 0],
            "scale": [1, 1, 1],
            "children": [],
            "variables": {},
            "spawnOnStart": true
          },
          {
            "id": "2bb60b13511e40bd38d7ea74086ece2b",
            "name": "Hurtbox",
            "type": "trigger",
            "position": [0, 0, 0],
            "rotation": [0, 0, 0],
            "scale": [1, 1, 1],
            "children": [],
            "variables": {},
            "spawnOnStart": true,
            "sensor": {
              "shapes": [
                {
                  "type": "capsule",
                  "radius": 0.3,
                  "height": 1.78,
                  "numSegments": 16,
                  "offset": [0, 0.89, 0],
                  "rotation": [0, 0, 0]
                }
              ],
              "layer": 256,
              "mask": 1024,
              "detectTriggers": true,
              "continuous": false,
              "enabled": true
            }
          },
          {
            "id": "749fba79e76d6baa402df550137fb3b0",
            "name": "HUD",
            "type": "uiRoot",
            "position": [0, 0, 0],
            "rotation": [0, 0, 0],
            "scale": [1, 1, 1],
            "children": [
              {
                "id": "5d7d7bd54961a07441b1cb6792178c8e",
                "name": "HealthBack",
                "type": "uiPanel",
                "position": [0, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1],
                "children": [],
                "variables": {},
                "spawnOnStart": true,
                "visible": true,
                "ui": {
                  "anchorMin": [0, 0],
                  "anchorMax": [0, 0],
                  "offsetMin": [48, 40],
                  "offsetMax": [348, 60],
                  "pivot": [0, 0],
                  "rotationDeg": 0,
                  "scale2d": [1, 1],
                  "opacity": 1,
                  "tint": [0, 0, 0, 0.55],
                  "zOrder": 0,
                  "interactive": false,
                  "clip": false,
                  "sizing": "fixed",
                  "padding": [0, 0, 0, 0],
                  "borderRadius": 4,
                  "borderWidth": 0,
                  "borderColor": [0, 0, 0, 1]
                }
              },
              {
                "id": "1f4382a1315ab0f56351150f84b3b47e",
                "name": "HealthLag",
                "type": "uiProgressBar",
                "position": [0, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1],
                "children": [],
                "variables": {},
                "spawnOnStart": true,
                "visible": true,
                "ui": {
                  "anchorMin": [0, 0],
                  "anchorMax": [0, 0],
                  "offsetMin": [48, 40],
                  "offsetMax": [348, 60],
                  "pivot": [0, 0],
                  "rotationDeg": 0,
                  "scale2d": [1, 1],
                  "opacity": 1,
                  "tint": [0, 0, 0, 0],
                  "zOrder": 1,
                  "interactive": false,
                  "clip": false,
                  "sizing": "fixed",
                  "padding": [0, 0, 0, 0],
                  "borderRadius": 2,
                  "borderWidth": 0,
                  "borderColor": [0, 0, 0, 1],
                  "min": 0,
                  "max": 100,
                  "value": 100,
                  "fillTint": [0.85, 0.7, 0.25, 1],
                  "direction": "ltr",
                  "smoothing": 1.2
                }
              },
              {
                "id": "f6a4420a0e0ff6337187eba85c91bfe2",
                "name": "Health",
                "type": "uiProgressBar",
                "position": [0, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1],
                "children": [],
                "variables": {},
                "spawnOnStart": true,
                "visible": true,
                "ui": {
                  "anchorMin": [0, 0],
                  "anchorMax": [0, 0],
                  "offsetMin": [48, 40],
                  "offsetMax": [348, 60],
                  "pivot": [0, 0],
                  "rotationDeg": 0,
                  "scale2d": [1, 1],
                  "opacity": 1,
                  "tint": [0, 0, 0, 0],
                  "zOrder": 2,
                  "interactive": false,
                  "clip": false,
                  "sizing": "fixed",
                  "padding": [0, 0, 0, 0],
                  "borderRadius": 2,
                  "borderWidth": 0,
                  "borderColor": [0, 0, 0, 1],
                  "min": 0,
                  "max": 100,
                  "value": 100,
                  "fillTint": [0.62, 0.08, 0.06, 1],
                  "direction": "ltr",
                  "smoothing": 0.05
                }
              },
              {
                "id": "c91a763ba48be5f0d30312cab9aaab09",
                "name": "StaminaBack",
                "type": "uiPanel",
                "position": [0, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1],
                "children": [],
                "variables": {},
                "spawnOnStart": true,
                "visible": true,
                "ui": {
                  "anchorMin": [0, 0],
                  "anchorMax": [0, 0],
                  "offsetMin": [48, 68],
                  "offsetMax": [264, 80],
                  "pivot": [0, 0],
                  "rotationDeg": 0,
                  "scale2d": [1, 1],
                  "opacity": 1,
                  "tint": [0, 0, 0, 0.55],
                  "zOrder": 0,
                  "interactive": false,
                  "clip": false,
                  "sizing": "fixed",
                  "padding": [0, 0, 0, 0],
                  "borderRadius": 4,
                  "borderWidth": 0,
                  "borderColor": [0, 0, 0, 1]
                }
              },
              {
                "id": "d38ef010f95f4c6e2bdc3614ec4bc46f",
                "name": "Stamina",
                "type": "uiProgressBar",
                "position": [0, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1],
                "children": [],
                "variables": {},
                "spawnOnStart": true,
                "visible": true,
                "ui": {
                  "anchorMin": [0, 0],
                  "anchorMax": [0, 0],
                  "offsetMin": [48, 68],
                  "offsetMax": [264, 80],
                  "pivot": [0, 0],
                  "rotationDeg": 0,
                  "scale2d": [1, 1],
                  "opacity": 1,
                  "tint": [0, 0, 0, 0],
                  "zOrder": 2,
                  "interactive": false,
                  "clip": false,
                  "sizing": "fixed",
                  "padding": [0, 0, 0, 0],
                  "borderRadius": 2,
                  "borderWidth": 0,
                  "borderColor": [0, 0, 0, 1],
                  "min": 0,
                  "max": 100,
                  "value": 100,
                  "fillTint": [0.2, 0.55, 0.22, 1],
                  "direction": "ltr",
                  "smoothing": 0.05
                }
              },
              {
                "id": "80c1139bae04f5f3691838dc8f6b712c",
                "name": "Estus",
                "type": "uiText",
                "position": [0, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1],
                "children": [],
                "variables": {},
                "spawnOnStart": true,
                "visible": true,
                "ui": {
                  "anchorMin": [0, 1],
                  "anchorMax": [0, 1],
                  "offsetMin": [48, -118],
                  "offsetMax": [520, -84],
                  "pivot": [0, 0],
                  "rotationDeg": 0,
                  "scale2d": [1, 1],
                  "opacity": 1,
                  "tint": [0.92, 0.78, 0.46, 1],
                  "zOrder": 0,
                  "interactive": false,
                  "clip": false,
                  "sizing": "fixed",
                  "padding": [0, 0, 0, 0],
                  "borderRadius": 0,
                  "borderWidth": 0,
                  "borderColor": [0, 0, 0, 1],
                  "text": "Estus Flask  3 / 3",
                  "fontSize": 24,
                  "fontFamily": "Georgia, \"Times New Roman\", serif",
                  "fontWeight": 400,
                  "align": "left",
                  "vAlign": "middle",
                  "wrap": true,
                  "lineHeight": 1.25
                }
              },
              {
                "id": "0fb050fc0727256f26b5007b99fdbe78",
                "name": "Weapon",
                "type": "uiText",
                "position": [0, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1],
                "children": [],
                "variables": {},
                "spawnOnStart": true,
                "visible": true,
                "ui": {
                  "anchorMin": [0, 1],
                  "anchorMax": [0, 1],
                  "offsetMin": [48, -78],
                  "offsetMax": [520, -44],
                  "pivot": [0, 0],
                  "rotationDeg": 0,
                  "scale2d": [1, 1],
                  "opacity": 1,
                  "tint": [0.7, 0.67, 0.6, 1],
                  "zOrder": 0,
                  "interactive": false,
                  "clip": false,
                  "sizing": "fixed",
                  "padding": [0, 0, 0, 0],
                  "borderRadius": 0,
                  "borderWidth": 0,
                  "borderColor": [0, 0, 0, 1],
                  "text": "Longsword",
                  "fontSize": 22,
                  "fontFamily": "Georgia, \"Times New Roman\", serif",
                  "fontWeight": 400,
                  "align": "left",
                  "vAlign": "middle",
                  "wrap": true,
                  "lineHeight": 1.25
                }
              },
              {
                "id": "d38341cf8eac54ab17e1e047bed2d695",
                "name": "SoulsGain",
                "type": "uiText",
                "position": [0, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1],
                "children": [],
                "variables": {},
                "spawnOnStart": true,
                "visible": true,
                "ui": {
                  "anchorMin": [1, 1],
                  "anchorMax": [1, 1],
                  "offsetMin": [-380, -120],
                  "offsetMax": [-56, -88],
                  "pivot": [0, 0],
                  "rotationDeg": 0,
                  "scale2d": [1, 1],
                  "opacity": 1,
                  "tint": [0.7, 0.67, 0.6, 1],
                  "zOrder": 0,
                  "interactive": false,
                  "clip": false,
                  "sizing": "fixed",
                  "padding": [0, 0, 0, 0],
                  "borderRadius": 0,
                  "borderWidth": 0,
                  "borderColor": [0, 0, 0, 1],
                  "text": "",
                  "fontSize": 22,
                  "fontFamily": "Georgia, \"Times New Roman\", serif",
                  "fontWeight": 400,
                  "align": "right",
                  "vAlign": "middle",
                  "wrap": true,
                  "lineHeight": 1.25
                }
              },
              {
                "id": "b68d1719d1b4eced6c4874f2891ed995",
                "name": "Souls",
                "type": "uiText",
                "position": [0, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1],
                "children": [],
                "variables": {},
                "spawnOnStart": true,
                "visible": true,
                "ui": {
                  "anchorMin": [1, 1],
                  "anchorMax": [1, 1],
                  "offsetMin": [-380, -84],
                  "offsetMax": [-56, -40],
                  "pivot": [0, 0],
                  "rotationDeg": 0,
                  "scale2d": [1, 1],
                  "opacity": 1,
                  "tint": [0.93, 0.9, 0.84, 1],
                  "zOrder": 0,
                  "interactive": false,
                  "clip": false,
                  "sizing": "fixed",
                  "padding": [0, 0, 0, 0],
                  "borderRadius": 0,
                  "borderWidth": 0,
                  "borderColor": [0, 0, 0, 1],
                  "text": "0",
                  "fontSize": 34,
                  "fontFamily": "Georgia, \"Times New Roman\", serif",
                  "fontWeight": 400,
                  "align": "right",
                  "vAlign": "middle",
                  "wrap": true,
                  "lineHeight": 1.25
                }
              },
              {
                "id": "4cb3124407c4611c0b2ce38da1fc386f",
                "name": "Prompt",
                "type": "uiPanel",
                "position": [0, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1],
                "children": [
                  {
                    "id": "118699b5e159bdd5e58a0f3b8e3dd457",
                    "name": "PromptText",
                    "type": "uiText",
                    "position": [0, 0, 0],
                    "rotation": [0, 0, 0],
                    "scale": [1, 1, 1],
                    "children": [],
                    "variables": {},
                    "spawnOnStart": true,
                    "visible": true,
                    "ui": {
                      "anchorMin": [0, 0],
                      "anchorMax": [1, 1],
                      "offsetMin": [6, 6],
                      "offsetMax": [-6, -6],
                      "pivot": [0, 0],
                      "rotationDeg": 0,
                      "scale2d": [1, 1],
                      "opacity": 1,
                      "tint": [0.93, 0.9, 0.84, 1],
                      "zOrder": 0,
                      "interactive": false,
                      "clip": false,
                      "sizing": "fixed",
                      "padding": [0, 0, 0, 0],
                      "borderRadius": 0,
                      "borderWidth": 0,
                      "borderColor": [0, 0, 0, 1],
                      "text": "E   Interact",
                      "fontSize": 24,
                      "fontFamily": "Georgia, \"Times New Roman\", serif",
                      "fontWeight": 400,
                      "align": "center",
                      "vAlign": "middle",
                      "wrap": true,
                      "lineHeight": 1.25
                    }
                  }
                ],
                "variables": {},
                "spawnOnStart": true,
                "visible": true,
                "ui": {
                  "anchorMin": [0.5, 1],
                  "anchorMax": [0.5, 1],
                  "offsetMin": [-280, -232],
                  "offsetMax": [280, -186],
                  "pivot": [0, 0],
                  "rotationDeg": 0,
                  "scale2d": [1, 1],
                  "opacity": 1,
                  "tint": [0, 0, 0, 0.62],
                  "zOrder": 0,
                  "interactive": false,
                  "clip": false,
                  "sizing": "fixed",
                  "padding": [0, 0, 0, 0],
                  "borderRadius": 4,
                  "borderWidth": 0,
                  "borderColor": [0, 0, 0, 1]
                }
              },
              {
                "id": "fba7c30d245eae9b377eed032556bfad",
                "name": "Notice",
                "type": "uiText",
                "position": [0, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1],
                "children": [],
                "variables": {},
                "spawnOnStart": true,
                "visible": true,
                "ui": {
                  "anchorMin": [0.5, 1],
                  "anchorMax": [0.5, 1],
                  "offsetMin": [-500, -290],
                  "offsetMax": [500, -246],
                  "pivot": [0, 0],
                  "rotationDeg": 0,
                  "scale2d": [1, 1],
                  "opacity": 1,
                  "tint": [0.92, 0.78, 0.46, 1],
                  "zOrder": 0,
                  "interactive": false,
                  "clip": false,
                  "sizing": "fixed",
                  "padding": [0, 0, 0, 0],
                  "borderRadius": 0,
                  "borderWidth": 0,
                  "borderColor": [0, 0, 0, 1],
                  "text": "",
                  "fontSize": 24,
                  "fontFamily": "Georgia, \"Times New Roman\", serif",
                  "fontWeight": 400,
                  "align": "center",
                  "vAlign": "middle",
                  "wrap": true,
                  "lineHeight": 1.25
                }
              },
              {
                "id": "f8d71e93f1924395ea0b4ee88f89ee0c",
                "name": "Message",
                "type": "uiPanel",
                "position": [0, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1],
                "children": [
                  {
                    "id": "a518f5062c7596db4b209a2a5268b51d",
                    "name": "MessageTitle",
                    "type": "uiText",
                    "position": [0, 0, 0],
                    "rotation": [0, 0, 0],
                    "scale": [1, 1, 1],
                    "children": [],
                    "variables": {},
                    "spawnOnStart": true,
                    "visible": true,
                    "ui": {
                      "anchorMin": [0, 0],
                      "anchorMax": [1, 0],
                      "offsetMin": [32, 24],
                      "offsetMax": [-32, 70],
                      "pivot": [0, 0],
                      "rotationDeg": 0,
                      "scale2d": [1, 1],
                      "opacity": 1,
                      "tint": [0.92, 0.78, 0.46, 1],
                      "zOrder": 0,
                      "interactive": false,
                      "clip": false,
                      "sizing": "fixed",
                      "padding": [0, 0, 0, 0],
                      "borderRadius": 0,
                      "borderWidth": 0,
                      "borderColor": [0, 0, 0, 1],
                      "text": "Title",
                      "fontSize": 32,
                      "fontFamily": "Georgia, \"Times New Roman\", serif",
                      "fontWeight": 400,
                      "align": "center",
                      "vAlign": "middle",
                      "wrap": true,
                      "lineHeight": 1.25
                    }
                  },
                  {
                    "id": "11b4e6baeae91dce32ad37ed56f8dd01",
                    "name": "MessageBody",
                    "type": "uiText",
                    "position": [0, 0, 0],
                    "rotation": [0, 0, 0],
                    "scale": [1, 1, 1],
                    "children": [],
                    "variables": {},
                    "spawnOnStart": true,
                    "visible": true,
                    "ui": {
                      "anchorMin": [0, 0],
                      "anchorMax": [1, 1],
                      "offsetMin": [40, 84],
                      "offsetMax": [-40, -24],
                      "pivot": [0, 0],
                      "rotationDeg": 0,
                      "scale2d": [1, 1],
                      "opacity": 1,
                      "tint": [0.93, 0.9, 0.84, 1],
                      "zOrder": 0,
                      "interactive": false,
                      "clip": false,
                      "sizing": "fixed",
                      "padding": [0, 0, 0, 0],
                      "borderRadius": 0,
                      "borderWidth": 0,
                      "borderColor": [0, 0, 0, 1],
                      "text": "Body",
                      "fontSize": 24,
                      "fontFamily": "Georgia, \"Times New Roman\", serif",
                      "fontWeight": 400,
                      "align": "center",
                      "vAlign": "top",
                      "wrap": true,
                      "lineHeight": 1.45
                    }
                  }
                ],
                "variables": {},
                "spawnOnStart": true,
                "visible": true,
                "ui": {
                  "anchorMin": [0.5, 0.5],
                  "anchorMax": [0.5, 0.5],
                  "offsetMin": [-430, -150],
                  "offsetMax": [430, 150],
                  "pivot": [0, 0],
                  "rotationDeg": 0,
                  "scale2d": [1, 1],
                  "opacity": 1,
                  "tint": [0.04, 0.035, 0.03, 0.86],
                  "zOrder": 0,
                  "interactive": false,
                  "clip": false,
                  "sizing": "fixed",
                  "padding": [0, 0, 0, 0],
                  "borderRadius": 6,
                  "borderWidth": 0,
                  "borderColor": [0, 0, 0, 1]
                }
              },
              {
                "id": "8ee24b240104aaea26102e2ae6e8d80e",
                "name": "Controls",
                "type": "uiText",
                "position": [0, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1],
                "children": [],
                "variables": {},
                "spawnOnStart": true,
                "visible": true,
                "ui": {
                  "anchorMin": [1, 0],
                  "anchorMax": [1, 0],
                  "offsetMin": [-760, 28],
                  "offsetMax": [-40, 56],
                  "pivot": [0, 0],
                  "rotationDeg": 0,
                  "scale2d": [1, 1],
                  "opacity": 1,
                  "tint": [0.75, 0.72, 0.66, 0.7],
                  "zOrder": 0,
                  "interactive": false,
                  "clip": false,
                  "sizing": "fixed",
                  "padding": [0, 0, 0, 0],
                  "borderRadius": 0,
                  "borderWidth": 0,
                  "borderColor": [0, 0, 0, 1],
                  "text": "LMB light · RMB heavy · Space roll/sprint · Q lock · R drink · F swap · E interact",
                  "fontSize": 16,
                  "fontFamily": "Georgia, \"Times New Roman\", serif",
                  "fontWeight": 400,
                  "align": "right",
                  "vAlign": "middle",
                  "wrap": true,
                  "lineHeight": 1.25
                }
              }
            ],
            "variables": {
              "__scriptId": {
                "type": "string",
                "value": "5afbf02b28415b469ef4571f7b9e5233",
                "access": "public"
              }
            },
            "spawnOnStart": true,
            "visible": true,
            "ui": {
              "anchorMin": [0, 0],
              "anchorMax": [1, 1],
              "offsetMin": [0, 0],
              "offsetMax": [0, 0],
              "pivot": [0, 0],
              "rotationDeg": 0,
              "scale2d": [1, 1],
              "opacity": 1,
              "tint": [1, 1, 1, 1],
              "zOrder": 0,
              "interactive": false,
              "clip": false,
              "sizing": "fixed",
              "padding": [0, 0, 0, 0],
              "borderRadius": 0,
              "borderWidth": 0,
              "borderColor": [0, 0, 0, 1],
              "space": "screen",
              "referenceResolution": [1920, 1080],
              "scaleMode": "scaleWithScreen",
              "matchWidthOrHeight": 0.5,
              "referenceDpr": 1,
              "uiTargetId": null,
              "referenceDistance": 10,
              "minScale": 0.1,
              "maxScale": 4,
              "billboard": true,
              "clampToScreen": false,
              "hideBehindCamera": true
            },
            "script": "import { Node, UIProgressBarNode, UIRootNode, UITextNode } from 'cleo'\nimport { attribute } from 'cleo/decorators'\n\n/**\n * Hollow Keep — the PLAYER's HUD. Attach to the `HUD` node, a screen-space UI Root that is a CHILD of\n * the player (in the Player template): the HUD belongs to the character it shows, and reads that\n * character — its parent — not some node found by name. A second player would bring its own HUD.\n *\n * One script for the whole HUD. It finds its widgets by NAME once (missing ones are skipped, so you can\n * restyle or rebuild the HUD freely as long as the names stay) and writes them every frame from its\n * owner's public fields:\n *\n *   Health, HealthLag        uiProgressBar   HP, and the yellow \"damage taken\" bar that drains behind it\n *   Stamina                  uiProgressBar\n *   Estus                    uiText          flask count\n *   Weapon                   uiText          weapon in hand\n *   Souls, SoulsGain         uiText          souls held, and the +N popup\n *   Prompt / PromptText      uiPanel/uiText  \"E  Rest at bonfire\" — hidden when there is nothing to do\n *   Notice                   uiText          one-line messages (\"Picked up ...\"), fading\n *   Message / MessageTitle / MessageBody     the readable-message panel\n *\n * The boss bar is not here: it belongs to the boss (SoulsBossBar, inside the Hollow Warden template).\n *\n * Bars grow with their maximum (`pxPerHp`, `pxPerStamina`), so levelling Vigor visibly lengthens the bar.\n */\nexport default class SoulsHudNode extends UIRootNode {\n  @attribute\n  public pxPerHp: number = 0.75\n  @attribute\n  public pxPerStamina: number = 2.4\n  @attribute\n  public minBarWidth: number = 160\n  @attribute\n  public maxBarWidth: number = 900\n  @attribute\n  public noticeSeconds: number = 2.6\n  /** Key shown in front of the interaction prompt. */\n  @attribute\n  public interactKey: string = 'E'\n\n  private _player: Node = null\n  private _w: any = {}\n  private _barLeft: number = 48\n  private _noticeAge: number = 99\n  private _message: Node = null\n  private _messageAge: number = 0\n\n  onStart() {\n    // The owner: the nearest ancestor that is a fighter (the Player the HUD is a child of).\n    for (let n = this.parent; n; n = n.parent) if ((n as any).team) { this._player = n; break }\n    for (const name of ['Health', 'HealthLag', 'HealthBack', 'Stamina', 'StaminaBack', 'Estus', 'Weapon', 'Souls',\n      'SoulsGain', 'Prompt', 'PromptText', 'Notice', 'Message', 'MessageTitle', 'MessageBody']) {\n      this._w[name] = this._find(name)\n    }\n    const health = this._w.Health as any\n    if (health) this._barLeft = health.offsetMin[0]\n    this._show('Message', false)\n    this._show('Prompt', false)\n    this._text('Notice', '')\n    this._text('SoulsGain', '')\n  }\n\n  onUpdate(delta: number) {\n    const p = this._player as any\n    this._noticeAge += delta\n    this._messageAge += delta\n\n    if (p) {\n      this._bar('Health', p.hp, p.maxHp)\n      this._bar('HealthLag', p.hp, p.maxHp)\n      this._width(['Health', 'HealthLag', 'HealthBack'], p.maxHp * this.pxPerHp)\n      this._bar('Stamina', p.stamina, p.maxStamina)\n      this._width(['Stamina', 'StaminaBack'], p.maxStamina * this.pxPerStamina)\n      this._text('Estus', 'Estus Flask  ' + (p.estus ?? 0) + ' / ' + (p.estusMax ?? 0))\n      this._text('Weapon', p.weaponName ?? '')\n      this._text('Souls', String(Math.round(p.souls ?? 0)))\n      this._text('SoulsGain', p.soulsGainAge < 2 && p.lastSoulsGain > 0 ? '+' + p.lastSoulsGain : '')\n\n      const prompt = p.interactPrompt ?? ''\n      this._show('Prompt', !!prompt && !this._message)\n      if (prompt) this._text('PromptText', this.interactKey + '   ' + prompt)\n    }\n\n    if (this._noticeAge > this.noticeSeconds) this._text('Notice', '')\n\n    // A message closes when the player walks out of its source's zone (closeMessageFrom), or dies.\n    if (this._message && p?.isDead) this._closeMessage()\n  }\n\n  /** The character this HUD shows. */\n  public get owner(): Node { return this._player }\n\n  public showNotice(text: string): void {\n    this._text('Notice', text)\n    this._noticeAge = 0\n  }\n\n  /** Show a message; showing the SAME source again closes it (Interact toggles). */\n  /** The player left `source`'s trigger zone: close its message if it is the one showing. */\n  public closeMessageFrom(source: Node): void {\n    if (this._message && this._message === source) this._closeMessage()\n  }\n\n  public showMessage(title: string, body: string, source: Node): void {\n    if (this._message && this._message === source && this._messageAge > 0.15) { this._closeMessage(); return }\n    this._message = source\n    this._messageAge = 0\n    this._text('MessageTitle', title)\n    this._text('MessageBody', body)\n    this._show('Message', true)\n  }\n\n  private _closeMessage(): void {\n    this._message = null\n    this._show('Message', false)\n  }\n\n  private _bar(name: string, value: number, max: number): void {\n    const bar = this._w[name] as UIProgressBarNode\n    if (!bar) return\n    if (bar.max !== max) bar.max = Math.max(1, max)\n    bar.value = Math.max(0, value)\n  }\n\n  private _width(names: string[], px: number): void {\n    const width = Math.max(this.minBarWidth, Math.min(this.maxBarWidth, px))\n    for (const name of names) {\n      const node = this._w[name] as any\n      if (!node) continue\n      const right = node.offsetMin[0] + width\n      if (Math.abs(node.offsetMax[0] - right) > 0.5) node.offsetMax = [right, node.offsetMax[1]]\n    }\n  }\n\n  private _text(name: string, value: string): void {\n    const node = this._w[name] as UITextNode\n    if (node && node.text !== value) node.text = value\n  }\n\n  private _show(name: string, on: boolean): void {\n    const node = this._w[name] as any\n    if (node && node.visible !== on) node.visible = on\n  }\n\n  private _find(name: string): Node {\n    const walk = (node: Node): Node => {\n      for (const child of node.children) {\n        if (child.name === name) return child\n        const found = walk(child)\n        if (found) return found\n      }\n      return null\n    }\n    return walk(this)\n  }\n}\n",
            "scriptVars": {}
          },
          {
            "id": "1faf12939044f201388e9d6a680ae77e",
            "name": "BonfireMenu",
            "type": "uiRoot",
            "position": [0, 0, 0],
            "rotation": [0, 0, 0],
            "scale": [1, 1, 1],
            "children": [
              {
                "id": "e1477a592ee3df6bde70abbe4ee47363",
                "name": "Backdrop",
                "type": "uiPanel",
                "position": [0, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1],
                "children": [
                  {
                    "id": "f735131bb3846b9ab27e259f98104798",
                    "name": "Card",
                    "type": "uiPanel",
                    "position": [0, 0, 0],
                    "rotation": [0, 0, 0],
                    "scale": [1, 1, 1],
                    "children": [
                      {
                        "id": "b9830c28c18edf588add42a70ddd3a9f",
                        "name": "Title",
                        "type": "uiText",
                        "position": [0, 0, 0],
                        "rotation": [0, 0, 0],
                        "scale": [1, 1, 1],
                        "children": [],
                        "variables": {},
                        "spawnOnStart": true,
                        "visible": true,
                        "ui": {
                          "anchorMin": [0, 0],
                          "anchorMax": [1, 0],
                          "offsetMin": [0, 22],
                          "offsetMax": [0, 76],
                          "pivot": [0, 0],
                          "rotationDeg": 0,
                          "scale2d": [1, 1],
                          "opacity": 1,
                          "tint": [0.92, 0.78, 0.46, 1],
                          "zOrder": 0,
                          "interactive": false,
                          "clip": false,
                          "sizing": "fixed",
                          "padding": [0, 0, 0, 0],
                          "borderRadius": 0,
                          "borderWidth": 0,
                          "borderColor": [0, 0, 0, 1],
                          "text": "LEVEL UP",
                          "fontSize": 40,
                          "fontFamily": "Georgia, \"Times New Roman\", serif",
                          "fontWeight": 400,
                          "align": "center",
                          "vAlign": "middle",
                          "wrap": true,
                          "lineHeight": 1.25
                        }
                      },
                      {
                        "id": "ead1935ff1fcab4aac4a04a7a18c9243",
                        "name": "LevelText",
                        "type": "uiText",
                        "position": [0, 0, 0],
                        "rotation": [0, 0, 0],
                        "scale": [1, 1, 1],
                        "children": [],
                        "variables": {},
                        "spawnOnStart": true,
                        "visible": true,
                        "ui": {
                          "anchorMin": [0, 0],
                          "anchorMax": [1, 0],
                          "offsetMin": [44, 90],
                          "offsetMax": [-44, 124],
                          "pivot": [0, 0],
                          "rotationDeg": 0,
                          "scale2d": [1, 1],
                          "opacity": 1,
                          "tint": [0.93, 0.9, 0.84, 1],
                          "zOrder": 0,
                          "interactive": false,
                          "clip": false,
                          "sizing": "fixed",
                          "padding": [0, 0, 0, 0],
                          "borderRadius": 0,
                          "borderWidth": 0,
                          "borderColor": [0, 0, 0, 1],
                          "text": "Level 1",
                          "fontSize": 24,
                          "fontFamily": "Georgia, \"Times New Roman\", serif",
                          "fontWeight": 400,
                          "align": "left",
                          "vAlign": "middle",
                          "wrap": true,
                          "lineHeight": 1.25
                        }
                      },
                      {
                        "id": "eafe2da3b9fd12c82e2b05bbfd793825",
                        "name": "SoulsText",
                        "type": "uiText",
                        "position": [0, 0, 0],
                        "rotation": [0, 0, 0],
                        "scale": [1, 1, 1],
                        "children": [],
                        "variables": {},
                        "spawnOnStart": true,
                        "visible": true,
                        "ui": {
                          "anchorMin": [0, 0],
                          "anchorMax": [1, 0],
                          "offsetMin": [44, 124],
                          "offsetMax": [-44, 158],
                          "pivot": [0, 0],
                          "rotationDeg": 0,
                          "scale2d": [1, 1],
                          "opacity": 1,
                          "tint": [0.93, 0.9, 0.84, 1],
                          "zOrder": 0,
                          "interactive": false,
                          "clip": false,
                          "sizing": "fixed",
                          "padding": [0, 0, 0, 0],
                          "borderRadius": 0,
                          "borderWidth": 0,
                          "borderColor": [0, 0, 0, 1],
                          "text": "Souls 0",
                          "fontSize": 24,
                          "fontFamily": "Georgia, \"Times New Roman\", serif",
                          "fontWeight": 400,
                          "align": "left",
                          "vAlign": "middle",
                          "wrap": true,
                          "lineHeight": 1.25
                        }
                      },
                      {
                        "id": "6e7d32b99fa01168373307012fd3b7a5",
                        "name": "CostText",
                        "type": "uiText",
                        "position": [0, 0, 0],
                        "rotation": [0, 0, 0],
                        "scale": [1, 1, 1],
                        "children": [],
                        "variables": {},
                        "spawnOnStart": true,
                        "visible": true,
                        "ui": {
                          "anchorMin": [0, 0],
                          "anchorMax": [1, 0],
                          "offsetMin": [44, 158],
                          "offsetMax": [-44, 192],
                          "pivot": [0, 0],
                          "rotationDeg": 0,
                          "scale2d": [1, 1],
                          "opacity": 1,
                          "tint": [0.7, 0.67, 0.6, 1],
                          "zOrder": 0,
                          "interactive": false,
                          "clip": false,
                          "sizing": "fixed",
                          "padding": [0, 0, 0, 0],
                          "borderRadius": 0,
                          "borderWidth": 0,
                          "borderColor": [0, 0, 0, 1],
                          "text": "Next level",
                          "fontSize": 22,
                          "fontFamily": "Georgia, \"Times New Roman\", serif",
                          "fontWeight": 400,
                          "align": "left",
                          "vAlign": "middle",
                          "wrap": true,
                          "lineHeight": 1.25
                        }
                      },
                      {
                        "id": "c5ee2d75547e6e616282458d11ffbb35",
                        "name": "Row_Vigor",
                        "type": "uiPanel",
                        "position": [0, 0, 0],
                        "rotation": [0, 0, 0],
                        "scale": [1, 1, 1],
                        "children": [
                          {
                            "id": "f046ca5912efb9a50cd822b2f19ddb69",
                            "name": "Label",
                            "type": "uiText",
                            "position": [0, 0, 0],
                            "rotation": [0, 0, 0],
                            "scale": [1, 1, 1],
                            "children": [],
                            "variables": {},
                            "spawnOnStart": true,
                            "visible": true,
                            "ui": {
                              "anchorMin": [0, 0],
                              "anchorMax": [0, 1],
                              "offsetMin": [18, 0],
                              "offsetMax": [300, 0],
                              "pivot": [0, 0],
                              "rotationDeg": 0,
                              "scale2d": [1, 1],
                              "opacity": 1,
                              "tint": [0.93, 0.9, 0.84, 1],
                              "zOrder": 0,
                              "interactive": false,
                              "clip": false,
                              "sizing": "fixed",
                              "padding": [0, 0, 0, 0],
                              "borderRadius": 0,
                              "borderWidth": 0,
                              "borderColor": [0, 0, 0, 1],
                              "text": "Vigor",
                              "fontSize": 26,
                              "fontFamily": "Georgia, \"Times New Roman\", serif",
                              "fontWeight": 400,
                              "align": "left",
                              "vAlign": "middle",
                              "wrap": true,
                              "lineHeight": 1.25
                            }
                          },
                          {
                            "id": "4ea37f41a52788e17a078362ec6c51f9",
                            "name": "Minus",
                            "type": "uiButton",
                            "position": [0, 0, 0],
                            "rotation": [0, 0, 0],
                            "scale": [1, 1, 1],
                            "children": [],
                            "variables": {},
                            "spawnOnStart": true,
                            "visible": true,
                            "ui": {
                              "anchorMin": [1, 0.5],
                              "anchorMax": [1, 0.5],
                              "offsetMin": [-230, -18],
                              "offsetMax": [-186, 18],
                              "pivot": [0, 0],
                              "rotationDeg": 0,
                              "scale2d": [1, 1],
                              "opacity": 1,
                              "tint": [0.18, 0.15, 0.12, 1],
                              "zOrder": 0,
                              "interactive": true,
                              "clip": false,
                              "sizing": "fixed",
                              "padding": [0, 0, 0, 0],
                              "borderRadius": 4,
                              "borderWidth": 0,
                              "borderColor": [0, 0, 0, 1],
                              "label": "-",
                              "disabled": false,
                              "hoverTint": [1, 1, 1, 0.16],
                              "pressedTint": [0, 0, 0, 0.22],
                              "disabledTint": [0.5, 0.5, 0.5, 0.4]
                            }
                          },
                          {
                            "id": "57b0f7d3bf1ed2f3e2ed0c81958e3c02",
                            "name": "Value",
                            "type": "uiText",
                            "position": [0, 0, 0],
                            "rotation": [0, 0, 0],
                            "scale": [1, 1, 1],
                            "children": [],
                            "variables": {},
                            "spawnOnStart": true,
                            "visible": true,
                            "ui": {
                              "anchorMin": [1, 0],
                              "anchorMax": [1, 1],
                              "offsetMin": [-176, 0],
                              "offsetMax": [-70, 0],
                              "pivot": [0, 0],
                              "rotationDeg": 0,
                              "scale2d": [1, 1],
                              "opacity": 1,
                              "tint": [0.92, 0.78, 0.46, 1],
                              "zOrder": 0,
                              "interactive": false,
                              "clip": false,
                              "sizing": "fixed",
                              "padding": [0, 0, 0, 0],
                              "borderRadius": 0,
                              "borderWidth": 0,
                              "borderColor": [0, 0, 0, 1],
                              "text": "10",
                              "fontSize": 26,
                              "fontFamily": "Georgia, \"Times New Roman\", serif",
                              "fontWeight": 400,
                              "align": "center",
                              "vAlign": "middle",
                              "wrap": true,
                              "lineHeight": 1.25
                            }
                          },
                          {
                            "id": "e056205ff7548b9776c94dee5c6f8c71",
                            "name": "Plus",
                            "type": "uiButton",
                            "position": [0, 0, 0],
                            "rotation": [0, 0, 0],
                            "scale": [1, 1, 1],
                            "children": [],
                            "variables": {},
                            "spawnOnStart": true,
                            "visible": true,
                            "ui": {
                              "anchorMin": [1, 0.5],
                              "anchorMax": [1, 0.5],
                              "offsetMin": [-62, -18],
                              "offsetMax": [-18, 18],
                              "pivot": [0, 0],
                              "rotationDeg": 0,
                              "scale2d": [1, 1],
                              "opacity": 1,
                              "tint": [0.18, 0.15, 0.12, 1],
                              "zOrder": 0,
                              "interactive": true,
                              "clip": false,
                              "sizing": "fixed",
                              "padding": [0, 0, 0, 0],
                              "borderRadius": 4,
                              "borderWidth": 0,
                              "borderColor": [0, 0, 0, 1],
                              "label": "+",
                              "disabled": false,
                              "hoverTint": [1, 1, 1, 0.16],
                              "pressedTint": [0, 0, 0, 0.22],
                              "disabledTint": [0.5, 0.5, 0.5, 0.4]
                            }
                          }
                        ],
                        "variables": {},
                        "spawnOnStart": true,
                        "visible": true,
                        "ui": {
                          "anchorMin": [0, 0],
                          "anchorMax": [1, 0],
                          "offsetMin": [40, 210],
                          "offsetMax": [-40, 260],
                          "pivot": [0, 0],
                          "rotationDeg": 0,
                          "scale2d": [1, 1],
                          "opacity": 1,
                          "tint": [1, 1, 1, 0.04],
                          "zOrder": 0,
                          "interactive": false,
                          "clip": false,
                          "sizing": "fixed",
                          "padding": [0, 0, 0, 0],
                          "borderRadius": 4,
                          "borderWidth": 0,
                          "borderColor": [0, 0, 0, 1]
                        }
                      },
                      {
                        "id": "93cfeea046b3a3807ae81e57548f939e",
                        "name": "Row_Endurance",
                        "type": "uiPanel",
                        "position": [0, 0, 0],
                        "rotation": [0, 0, 0],
                        "scale": [1, 1, 1],
                        "children": [
                          {
                            "id": "903cb6a272055a56be1b66dba4415117",
                            "name": "Label",
                            "type": "uiText",
                            "position": [0, 0, 0],
                            "rotation": [0, 0, 0],
                            "scale": [1, 1, 1],
                            "children": [],
                            "variables": {},
                            "spawnOnStart": true,
                            "visible": true,
                            "ui": {
                              "anchorMin": [0, 0],
                              "anchorMax": [0, 1],
                              "offsetMin": [18, 0],
                              "offsetMax": [300, 0],
                              "pivot": [0, 0],
                              "rotationDeg": 0,
                              "scale2d": [1, 1],
                              "opacity": 1,
                              "tint": [0.93, 0.9, 0.84, 1],
                              "zOrder": 0,
                              "interactive": false,
                              "clip": false,
                              "sizing": "fixed",
                              "padding": [0, 0, 0, 0],
                              "borderRadius": 0,
                              "borderWidth": 0,
                              "borderColor": [0, 0, 0, 1],
                              "text": "Endurance",
                              "fontSize": 26,
                              "fontFamily": "Georgia, \"Times New Roman\", serif",
                              "fontWeight": 400,
                              "align": "left",
                              "vAlign": "middle",
                              "wrap": true,
                              "lineHeight": 1.25
                            }
                          },
                          {
                            "id": "286c706ebc8e18016a78d43831e5f808",
                            "name": "Minus",
                            "type": "uiButton",
                            "position": [0, 0, 0],
                            "rotation": [0, 0, 0],
                            "scale": [1, 1, 1],
                            "children": [],
                            "variables": {},
                            "spawnOnStart": true,
                            "visible": true,
                            "ui": {
                              "anchorMin": [1, 0.5],
                              "anchorMax": [1, 0.5],
                              "offsetMin": [-230, -18],
                              "offsetMax": [-186, 18],
                              "pivot": [0, 0],
                              "rotationDeg": 0,
                              "scale2d": [1, 1],
                              "opacity": 1,
                              "tint": [0.18, 0.15, 0.12, 1],
                              "zOrder": 0,
                              "interactive": true,
                              "clip": false,
                              "sizing": "fixed",
                              "padding": [0, 0, 0, 0],
                              "borderRadius": 4,
                              "borderWidth": 0,
                              "borderColor": [0, 0, 0, 1],
                              "label": "-",
                              "disabled": false,
                              "hoverTint": [1, 1, 1, 0.16],
                              "pressedTint": [0, 0, 0, 0.22],
                              "disabledTint": [0.5, 0.5, 0.5, 0.4]
                            }
                          },
                          {
                            "id": "2df93cfff201764e126800773b3b80ef",
                            "name": "Value",
                            "type": "uiText",
                            "position": [0, 0, 0],
                            "rotation": [0, 0, 0],
                            "scale": [1, 1, 1],
                            "children": [],
                            "variables": {},
                            "spawnOnStart": true,
                            "visible": true,
                            "ui": {
                              "anchorMin": [1, 0],
                              "anchorMax": [1, 1],
                              "offsetMin": [-176, 0],
                              "offsetMax": [-70, 0],
                              "pivot": [0, 0],
                              "rotationDeg": 0,
                              "scale2d": [1, 1],
                              "opacity": 1,
                              "tint": [0.92, 0.78, 0.46, 1],
                              "zOrder": 0,
                              "interactive": false,
                              "clip": false,
                              "sizing": "fixed",
                              "padding": [0, 0, 0, 0],
                              "borderRadius": 0,
                              "borderWidth": 0,
                              "borderColor": [0, 0, 0, 1],
                              "text": "10",
                              "fontSize": 26,
                              "fontFamily": "Georgia, \"Times New Roman\", serif",
                              "fontWeight": 400,
                              "align": "center",
                              "vAlign": "middle",
                              "wrap": true,
                              "lineHeight": 1.25
                            }
                          },
                          {
                            "id": "6d5546aa9f3c5c8ad011ade48091e4fa",
                            "name": "Plus",
                            "type": "uiButton",
                            "position": [0, 0, 0],
                            "rotation": [0, 0, 0],
                            "scale": [1, 1, 1],
                            "children": [],
                            "variables": {},
                            "spawnOnStart": true,
                            "visible": true,
                            "ui": {
                              "anchorMin": [1, 0.5],
                              "anchorMax": [1, 0.5],
                              "offsetMin": [-62, -18],
                              "offsetMax": [-18, 18],
                              "pivot": [0, 0],
                              "rotationDeg": 0,
                              "scale2d": [1, 1],
                              "opacity": 1,
                              "tint": [0.18, 0.15, 0.12, 1],
                              "zOrder": 0,
                              "interactive": true,
                              "clip": false,
                              "sizing": "fixed",
                              "padding": [0, 0, 0, 0],
                              "borderRadius": 4,
                              "borderWidth": 0,
                              "borderColor": [0, 0, 0, 1],
                              "label": "+",
                              "disabled": false,
                              "hoverTint": [1, 1, 1, 0.16],
                              "pressedTint": [0, 0, 0, 0.22],
                              "disabledTint": [0.5, 0.5, 0.5, 0.4]
                            }
                          }
                        ],
                        "variables": {},
                        "spawnOnStart": true,
                        "visible": true,
                        "ui": {
                          "anchorMin": [0, 0],
                          "anchorMax": [1, 0],
                          "offsetMin": [40, 268],
                          "offsetMax": [-40, 318],
                          "pivot": [0, 0],
                          "rotationDeg": 0,
                          "scale2d": [1, 1],
                          "opacity": 1,
                          "tint": [1, 1, 1, 0.04],
                          "zOrder": 0,
                          "interactive": false,
                          "clip": false,
                          "sizing": "fixed",
                          "padding": [0, 0, 0, 0],
                          "borderRadius": 4,
                          "borderWidth": 0,
                          "borderColor": [0, 0, 0, 1]
                        }
                      },
                      {
                        "id": "25e0b5af7d64f64b87f6497c6a8ccb20",
                        "name": "Row_Strength",
                        "type": "uiPanel",
                        "position": [0, 0, 0],
                        "rotation": [0, 0, 0],
                        "scale": [1, 1, 1],
                        "children": [
                          {
                            "id": "dd38fd77794106ec34f7978d6c2180f4",
                            "name": "Label",
                            "type": "uiText",
                            "position": [0, 0, 0],
                            "rotation": [0, 0, 0],
                            "scale": [1, 1, 1],
                            "children": [],
                            "variables": {},
                            "spawnOnStart": true,
                            "visible": true,
                            "ui": {
                              "anchorMin": [0, 0],
                              "anchorMax": [0, 1],
                              "offsetMin": [18, 0],
                              "offsetMax": [300, 0],
                              "pivot": [0, 0],
                              "rotationDeg": 0,
                              "scale2d": [1, 1],
                              "opacity": 1,
                              "tint": [0.93, 0.9, 0.84, 1],
                              "zOrder": 0,
                              "interactive": false,
                              "clip": false,
                              "sizing": "fixed",
                              "padding": [0, 0, 0, 0],
                              "borderRadius": 0,
                              "borderWidth": 0,
                              "borderColor": [0, 0, 0, 1],
                              "text": "Strength",
                              "fontSize": 26,
                              "fontFamily": "Georgia, \"Times New Roman\", serif",
                              "fontWeight": 400,
                              "align": "left",
                              "vAlign": "middle",
                              "wrap": true,
                              "lineHeight": 1.25
                            }
                          },
                          {
                            "id": "1c67d2110626ebadd7ed80a28479a293",
                            "name": "Minus",
                            "type": "uiButton",
                            "position": [0, 0, 0],
                            "rotation": [0, 0, 0],
                            "scale": [1, 1, 1],
                            "children": [],
                            "variables": {},
                            "spawnOnStart": true,
                            "visible": true,
                            "ui": {
                              "anchorMin": [1, 0.5],
                              "anchorMax": [1, 0.5],
                              "offsetMin": [-230, -18],
                              "offsetMax": [-186, 18],
                              "pivot": [0, 0],
                              "rotationDeg": 0,
                              "scale2d": [1, 1],
                              "opacity": 1,
                              "tint": [0.18, 0.15, 0.12, 1],
                              "zOrder": 0,
                              "interactive": true,
                              "clip": false,
                              "sizing": "fixed",
                              "padding": [0, 0, 0, 0],
                              "borderRadius": 4,
                              "borderWidth": 0,
                              "borderColor": [0, 0, 0, 1],
                              "label": "-",
                              "disabled": false,
                              "hoverTint": [1, 1, 1, 0.16],
                              "pressedTint": [0, 0, 0, 0.22],
                              "disabledTint": [0.5, 0.5, 0.5, 0.4]
                            }
                          },
                          {
                            "id": "c08fd7f1c45ba7bc1b53a3700e19c5b3",
                            "name": "Value",
                            "type": "uiText",
                            "position": [0, 0, 0],
                            "rotation": [0, 0, 0],
                            "scale": [1, 1, 1],
                            "children": [],
                            "variables": {},
                            "spawnOnStart": true,
                            "visible": true,
                            "ui": {
                              "anchorMin": [1, 0],
                              "anchorMax": [1, 1],
                              "offsetMin": [-176, 0],
                              "offsetMax": [-70, 0],
                              "pivot": [0, 0],
                              "rotationDeg": 0,
                              "scale2d": [1, 1],
                              "opacity": 1,
                              "tint": [0.92, 0.78, 0.46, 1],
                              "zOrder": 0,
                              "interactive": false,
                              "clip": false,
                              "sizing": "fixed",
                              "padding": [0, 0, 0, 0],
                              "borderRadius": 0,
                              "borderWidth": 0,
                              "borderColor": [0, 0, 0, 1],
                              "text": "10",
                              "fontSize": 26,
                              "fontFamily": "Georgia, \"Times New Roman\", serif",
                              "fontWeight": 400,
                              "align": "center",
                              "vAlign": "middle",
                              "wrap": true,
                              "lineHeight": 1.25
                            }
                          },
                          {
                            "id": "1c7681e69858f2c6ecade6ecff103c43",
                            "name": "Plus",
                            "type": "uiButton",
                            "position": [0, 0, 0],
                            "rotation": [0, 0, 0],
                            "scale": [1, 1, 1],
                            "children": [],
                            "variables": {},
                            "spawnOnStart": true,
                            "visible": true,
                            "ui": {
                              "anchorMin": [1, 0.5],
                              "anchorMax": [1, 0.5],
                              "offsetMin": [-62, -18],
                              "offsetMax": [-18, 18],
                              "pivot": [0, 0],
                              "rotationDeg": 0,
                              "scale2d": [1, 1],
                              "opacity": 1,
                              "tint": [0.18, 0.15, 0.12, 1],
                              "zOrder": 0,
                              "interactive": true,
                              "clip": false,
                              "sizing": "fixed",
                              "padding": [0, 0, 0, 0],
                              "borderRadius": 4,
                              "borderWidth": 0,
                              "borderColor": [0, 0, 0, 1],
                              "label": "+",
                              "disabled": false,
                              "hoverTint": [1, 1, 1, 0.16],
                              "pressedTint": [0, 0, 0, 0.22],
                              "disabledTint": [0.5, 0.5, 0.5, 0.4]
                            }
                          }
                        ],
                        "variables": {},
                        "spawnOnStart": true,
                        "visible": true,
                        "ui": {
                          "anchorMin": [0, 0],
                          "anchorMax": [1, 0],
                          "offsetMin": [40, 326],
                          "offsetMax": [-40, 376],
                          "pivot": [0, 0],
                          "rotationDeg": 0,
                          "scale2d": [1, 1],
                          "opacity": 1,
                          "tint": [1, 1, 1, 0.04],
                          "zOrder": 0,
                          "interactive": false,
                          "clip": false,
                          "sizing": "fixed",
                          "padding": [0, 0, 0, 0],
                          "borderRadius": 4,
                          "borderWidth": 0,
                          "borderColor": [0, 0, 0, 1]
                        }
                      },
                      {
                        "id": "24a48320775eafee6c2ba4beec0d5369",
                        "name": "Row_Dexterity",
                        "type": "uiPanel",
                        "position": [0, 0, 0],
                        "rotation": [0, 0, 0],
                        "scale": [1, 1, 1],
                        "children": [
                          {
                            "id": "41eb328237f99041d9e34ab469e0e59f",
                            "name": "Label",
                            "type": "uiText",
                            "position": [0, 0, 0],
                            "rotation": [0, 0, 0],
                            "scale": [1, 1, 1],
                            "children": [],
                            "variables": {},
                            "spawnOnStart": true,
                            "visible": true,
                            "ui": {
                              "anchorMin": [0, 0],
                              "anchorMax": [0, 1],
                              "offsetMin": [18, 0],
                              "offsetMax": [300, 0],
                              "pivot": [0, 0],
                              "rotationDeg": 0,
                              "scale2d": [1, 1],
                              "opacity": 1,
                              "tint": [0.93, 0.9, 0.84, 1],
                              "zOrder": 0,
                              "interactive": false,
                              "clip": false,
                              "sizing": "fixed",
                              "padding": [0, 0, 0, 0],
                              "borderRadius": 0,
                              "borderWidth": 0,
                              "borderColor": [0, 0, 0, 1],
                              "text": "Dexterity",
                              "fontSize": 26,
                              "fontFamily": "Georgia, \"Times New Roman\", serif",
                              "fontWeight": 400,
                              "align": "left",
                              "vAlign": "middle",
                              "wrap": true,
                              "lineHeight": 1.25
                            }
                          },
                          {
                            "id": "7305f794866106634cadf2ecb63e3026",
                            "name": "Minus",
                            "type": "uiButton",
                            "position": [0, 0, 0],
                            "rotation": [0, 0, 0],
                            "scale": [1, 1, 1],
                            "children": [],
                            "variables": {},
                            "spawnOnStart": true,
                            "visible": true,
                            "ui": {
                              "anchorMin": [1, 0.5],
                              "anchorMax": [1, 0.5],
                              "offsetMin": [-230, -18],
                              "offsetMax": [-186, 18],
                              "pivot": [0, 0],
                              "rotationDeg": 0,
                              "scale2d": [1, 1],
                              "opacity": 1,
                              "tint": [0.18, 0.15, 0.12, 1],
                              "zOrder": 0,
                              "interactive": true,
                              "clip": false,
                              "sizing": "fixed",
                              "padding": [0, 0, 0, 0],
                              "borderRadius": 4,
                              "borderWidth": 0,
                              "borderColor": [0, 0, 0, 1],
                              "label": "-",
                              "disabled": false,
                              "hoverTint": [1, 1, 1, 0.16],
                              "pressedTint": [0, 0, 0, 0.22],
                              "disabledTint": [0.5, 0.5, 0.5, 0.4]
                            }
                          },
                          {
                            "id": "0caa71ecbd1101182f363f83f7f7c639",
                            "name": "Value",
                            "type": "uiText",
                            "position": [0, 0, 0],
                            "rotation": [0, 0, 0],
                            "scale": [1, 1, 1],
                            "children": [],
                            "variables": {},
                            "spawnOnStart": true,
                            "visible": true,
                            "ui": {
                              "anchorMin": [1, 0],
                              "anchorMax": [1, 1],
                              "offsetMin": [-176, 0],
                              "offsetMax": [-70, 0],
                              "pivot": [0, 0],
                              "rotationDeg": 0,
                              "scale2d": [1, 1],
                              "opacity": 1,
                              "tint": [0.92, 0.78, 0.46, 1],
                              "zOrder": 0,
                              "interactive": false,
                              "clip": false,
                              "sizing": "fixed",
                              "padding": [0, 0, 0, 0],
                              "borderRadius": 0,
                              "borderWidth": 0,
                              "borderColor": [0, 0, 0, 1],
                              "text": "10",
                              "fontSize": 26,
                              "fontFamily": "Georgia, \"Times New Roman\", serif",
                              "fontWeight": 400,
                              "align": "center",
                              "vAlign": "middle",
                              "wrap": true,
                              "lineHeight": 1.25
                            }
                          },
                          {
                            "id": "bd21290651aa0c4e6324e0dde3fa9dd8",
                            "name": "Plus",
                            "type": "uiButton",
                            "position": [0, 0, 0],
                            "rotation": [0, 0, 0],
                            "scale": [1, 1, 1],
                            "children": [],
                            "variables": {},
                            "spawnOnStart": true,
                            "visible": true,
                            "ui": {
                              "anchorMin": [1, 0.5],
                              "anchorMax": [1, 0.5],
                              "offsetMin": [-62, -18],
                              "offsetMax": [-18, 18],
                              "pivot": [0, 0],
                              "rotationDeg": 0,
                              "scale2d": [1, 1],
                              "opacity": 1,
                              "tint": [0.18, 0.15, 0.12, 1],
                              "zOrder": 0,
                              "interactive": true,
                              "clip": false,
                              "sizing": "fixed",
                              "padding": [0, 0, 0, 0],
                              "borderRadius": 4,
                              "borderWidth": 0,
                              "borderColor": [0, 0, 0, 1],
                              "label": "+",
                              "disabled": false,
                              "hoverTint": [1, 1, 1, 0.16],
                              "pressedTint": [0, 0, 0, 0.22],
                              "disabledTint": [0.5, 0.5, 0.5, 0.4]
                            }
                          }
                        ],
                        "variables": {},
                        "spawnOnStart": true,
                        "visible": true,
                        "ui": {
                          "anchorMin": [0, 0],
                          "anchorMax": [1, 0],
                          "offsetMin": [40, 384],
                          "offsetMax": [-40, 434],
                          "pivot": [0, 0],
                          "rotationDeg": 0,
                          "scale2d": [1, 1],
                          "opacity": 1,
                          "tint": [1, 1, 1, 0.04],
                          "zOrder": 0,
                          "interactive": false,
                          "clip": false,
                          "sizing": "fixed",
                          "padding": [0, 0, 0, 0],
                          "borderRadius": 4,
                          "borderWidth": 0,
                          "borderColor": [0, 0, 0, 1]
                        }
                      },
                      {
                        "id": "f6d6ec255d8f4d43dbe024d7177ac092",
                        "name": "Derived",
                        "type": "uiText",
                        "position": [0, 0, 0],
                        "rotation": [0, 0, 0],
                        "scale": [1, 1, 1],
                        "children": [],
                        "variables": {},
                        "spawnOnStart": true,
                        "visible": true,
                        "ui": {
                          "anchorMin": [0, 0],
                          "anchorMax": [1, 0],
                          "offsetMin": [44, 452],
                          "offsetMax": [-44, 520],
                          "pivot": [0, 0],
                          "rotationDeg": 0,
                          "scale2d": [1, 1],
                          "opacity": 1,
                          "tint": [0.7, 0.67, 0.6, 1],
                          "zOrder": 0,
                          "interactive": false,
                          "clip": false,
                          "sizing": "fixed",
                          "padding": [0, 0, 0, 0],
                          "borderRadius": 0,
                          "borderWidth": 0,
                          "borderColor": [0, 0, 0, 1],
                          "text": "",
                          "fontSize": 20,
                          "fontFamily": "Georgia, \"Times New Roman\", serif",
                          "fontWeight": 400,
                          "align": "left",
                          "vAlign": "top",
                          "wrap": true,
                          "lineHeight": 1.25
                        }
                      },
                      {
                        "id": "6f07c009cbc3e047d46942e4386ee5d4",
                        "name": "Confirm",
                        "type": "uiButton",
                        "position": [0, 0, 0],
                        "rotation": [0, 0, 0],
                        "scale": [1, 1, 1],
                        "children": [],
                        "variables": {},
                        "spawnOnStart": true,
                        "visible": true,
                        "ui": {
                          "anchorMin": [0.5, 1],
                          "anchorMax": [0.5, 1],
                          "offsetMin": [-230, -96],
                          "offsetMax": [-20, -48],
                          "pivot": [0, 0],
                          "rotationDeg": 0,
                          "scale2d": [1, 1],
                          "opacity": 1,
                          "tint": [0.18, 0.15, 0.12, 1],
                          "zOrder": 0,
                          "interactive": true,
                          "clip": false,
                          "sizing": "fixed",
                          "padding": [0, 0, 0, 0],
                          "borderRadius": 4,
                          "borderWidth": 0,
                          "borderColor": [0, 0, 0, 1],
                          "label": "Confirm",
                          "disabled": false,
                          "hoverTint": [1, 1, 1, 0.16],
                          "pressedTint": [0, 0, 0, 0.22],
                          "disabledTint": [0.5, 0.5, 0.5, 0.4]
                        }
                      },
                      {
                        "id": "e9aa802e1c44edef8a242aa963a9fc98",
                        "name": "Leave",
                        "type": "uiButton",
                        "position": [0, 0, 0],
                        "rotation": [0, 0, 0],
                        "scale": [1, 1, 1],
                        "children": [],
                        "variables": {},
                        "spawnOnStart": true,
                        "visible": true,
                        "ui": {
                          "anchorMin": [0.5, 1],
                          "anchorMax": [0.5, 1],
                          "offsetMin": [20, -96],
                          "offsetMax": [230, -48],
                          "pivot": [0, 0],
                          "rotationDeg": 0,
                          "scale2d": [1, 1],
                          "opacity": 1,
                          "tint": [0.18, 0.15, 0.12, 1],
                          "zOrder": 0,
                          "interactive": true,
                          "clip": false,
                          "sizing": "fixed",
                          "padding": [0, 0, 0, 0],
                          "borderRadius": 4,
                          "borderWidth": 0,
                          "borderColor": [0, 0, 0, 1],
                          "label": "Leave",
                          "disabled": false,
                          "hoverTint": [1, 1, 1, 0.16],
                          "pressedTint": [0, 0, 0, 0.22],
                          "disabledTint": [0.5, 0.5, 0.5, 0.4]
                        }
                      },
                      {
                        "id": "d8ea7e0533e60a2838355742f7269390",
                        "name": "Help",
                        "type": "uiText",
                        "position": [0, 0, 0],
                        "rotation": [0, 0, 0],
                        "scale": [1, 1, 1],
                        "children": [],
                        "variables": {},
                        "spawnOnStart": true,
                        "visible": true,
                        "ui": {
                          "anchorMin": [0, 1],
                          "anchorMax": [1, 1],
                          "offsetMin": [0, -40],
                          "offsetMax": [0, -12],
                          "pivot": [0, 0],
                          "rotationDeg": 0,
                          "scale2d": [1, 1],
                          "opacity": 1,
                          "tint": [0.7, 0.67, 0.6, 1],
                          "zOrder": 0,
                          "interactive": false,
                          "clip": false,
                          "sizing": "fixed",
                          "padding": [0, 0, 0, 0],
                          "borderRadius": 0,
                          "borderWidth": 0,
                          "borderColor": [0, 0, 0, 1],
                          "text": "Up/Down select · Left/Right adjust · Enter confirm · Esc leave",
                          "fontSize": 16,
                          "fontFamily": "Georgia, \"Times New Roman\", serif",
                          "fontWeight": 400,
                          "align": "center",
                          "vAlign": "middle",
                          "wrap": true,
                          "lineHeight": 1.25
                        }
                      }
                    ],
                    "variables": {},
                    "spawnOnStart": true,
                    "visible": true,
                    "ui": {
                      "anchorMin": [0.5, 0.5],
                      "anchorMax": [0.5, 0.5],
                      "offsetMin": [-420, -330],
                      "offsetMax": [420, 330],
                      "pivot": [0, 0],
                      "rotationDeg": 0,
                      "scale2d": [1, 1],
                      "opacity": 1,
                      "tint": [0.05, 0.045, 0.04, 0.94],
                      "zOrder": 0,
                      "interactive": false,
                      "clip": false,
                      "sizing": "fixed",
                      "padding": [0, 0, 0, 0],
                      "borderRadius": 8,
                      "borderWidth": 0,
                      "borderColor": [0, 0, 0, 1]
                    }
                  }
                ],
                "variables": {},
                "spawnOnStart": true,
                "visible": true,
                "ui": {
                  "anchorMin": [0, 0],
                  "anchorMax": [1, 1],
                  "offsetMin": [0, 0],
                  "offsetMax": [0, 0],
                  "pivot": [0, 0],
                  "rotationDeg": 0,
                  "scale2d": [1, 1],
                  "opacity": 1,
                  "tint": [0, 0, 0, 0.45],
                  "zOrder": 0,
                  "interactive": true,
                  "clip": false,
                  "sizing": "fixed",
                  "padding": [0, 0, 0, 0],
                  "borderRadius": 4,
                  "borderWidth": 0,
                  "borderColor": [0, 0, 0, 1]
                }
              }
            ],
            "variables": {
              "__scriptId": {
                "type": "string",
                "value": "0da62e50296e37e710b0f071cc29b346",
                "access": "public"
              }
            },
            "spawnOnStart": true,
            "visible": false,
            "ui": {
              "anchorMin": [0, 0],
              "anchorMax": [1, 1],
              "offsetMin": [0, 0],
              "offsetMax": [0, 0],
              "pivot": [0, 0],
              "rotationDeg": 0,
              "scale2d": [1, 1],
              "opacity": 1,
              "tint": [1, 1, 1, 1],
              "zOrder": 40,
              "interactive": false,
              "clip": false,
              "sizing": "fixed",
              "padding": [0, 0, 0, 0],
              "borderRadius": 0,
              "borderWidth": 0,
              "borderColor": [0, 0, 0, 1],
              "space": "screen",
              "referenceResolution": [1920, 1080],
              "scaleMode": "scaleWithScreen",
              "matchWidthOrHeight": 0.5,
              "referenceDpr": 1,
              "uiTargetId": null,
              "referenceDistance": 10,
              "minScale": 0.1,
              "maxScale": 4,
              "billboard": true,
              "clampToScreen": false,
              "hideBehindCamera": true
            },
            "script": "import { Input, Node, UIButtonNode, UIRootNode, UITextNode } from 'cleo'\nimport type { ColorAlpha } from 'cleo'\nimport { attribute } from 'cleo/decorators'\nimport { playSound } from '@/Core/Scripts/SoulsAudio'\n\n/**\n * Hollow Keep — the level-up menu shown while resting at a bonfire. Attach to the `BonfireMenu` node, a\n * screen-space UI Root authored hidden.\n *\n *   Card\n *     Title, LevelText, SoulsText, CostText, Derived, Help       uiText\n *     Row_Vigor / Row_Endurance / Row_Strength / Row_Dexterity     uiStack rows, each with\n *        Label (uiText)  Minus (uiButton)  Value (uiText)  Plus (uiButton)\n *     Confirm, Leave                                                uiButton\n *\n * Points are allocated as PENDING and cost nothing until Confirm, so the player can try a build and back\n * out. Each point costs the souls for one more level, priced by the player's own `levelCost`, so the total\n * of several points is the sum of consecutive levels. Every number shown comes from its owner: HP and\n * stamina from the player's curves, attack rating from each weapon.\n *\n * Keyboard/gamepad (the UI map): Navigate up/down picks a stat, left/right removes/adds a point, Submit\n * confirms, Cancel leaves. The mouse can click every button. The Gameplay map is disabled while open, so\n * the same keys do not also move the character.\n */\nconst STATS = ['vigor', 'endurance', 'strength', 'dexterity']\n\nexport default class SoulsBonfireMenuNode extends UIRootNode {\n  @attribute\n  public repeatDelay: number = 0.35\n  @attribute\n  public repeatRate: number = 0.09\n  public selectedTint: ColorAlpha = [0.85, 0.65, 0.3, 0.35]\n  public rowTint: ColorAlpha = [1, 1, 1, 0.04]\n  @attribute\n  public isOpen: boolean = false\n\n  private _gm: Node = null\n  private _player: Node = null\n  private _pending: number[] = [10, 10, 10, 10]\n  private _selected: number = 0\n  private _navHeld: number = 0\n  private _navRepeat: number = 0\n  private _navLast: number[] = [0, 0]\n  private _openedAt: number = 0\n  private _clock: number = 0\n\n  onStart() {\n    this.visible = false\n    this.isOpen = false\n    const rows = ['Row_Vigor', 'Row_Endurance', 'Row_Strength', 'Row_Dexterity']\n    rows.forEach((name, i) => {\n      const row = this._find(name)\n      if (!row) return\n      const minus = this._find('Minus', row) as UIButtonNode\n      const plus = this._find('Plus', row) as UIButtonNode\n      if (minus) minus.onPress = () => { this._selected = i; this._adjust(-1) }\n      if (plus) plus.onPress = () => { this._selected = i; this._adjust(1) }\n    })\n    const confirm = this._find('Confirm') as UIButtonNode\n    if (confirm) confirm.onPress = () => this._confirm()\n    const leave = this._find('Leave') as UIButtonNode\n    if (leave) leave.onPress = () => this.close()\n  }\n\n  /** Called by the manager when the player rests. */\n  public open(gm: Node, player: Node, bonfire: Node): void {\n    this._gm = gm\n    this._player = player\n    this._resetPending()\n    this._selected = 0\n    this.isOpen = true\n    this._openedAt = this._clock\n    this.visible = true\n    Input.disableMap('Gameplay')\n    Input.releaseMouse()\n    this._refresh()\n  }\n\n  public close(): void {\n    if (!this.isOpen) return\n    this.isOpen = false\n    this.visible = false\n    Input.enableMap('Gameplay')\n    ;(this._gm as any)?.leaveBonfire?.()\n  }\n\n  onUpdate(delta: number) {\n    this._clock += delta\n    if (!this.isOpen) return\n    // Swallow the press that opened us (Interact may share a key with Submit).\n    if (this._clock - this._openedAt < 0.2) return\n\n    const nav = Input.vector('Navigate')\n    const dy = Math.abs(nav[1]) > 0.5 ? Math.sign(nav[1]) : 0\n    const dx = Math.abs(nav[0]) > 0.5 ? Math.sign(nav[0]) : 0\n    const fresh = dy !== this._navLast[1] || dx !== this._navLast[0]\n    this._navLast = [dx, dy]\n    let step = false\n    if (dx || dy) {\n      if (fresh) { step = true; this._navHeld = 0; this._navRepeat = 0 }\n      else {\n        this._navHeld += delta\n        if (this._navHeld > this.repeatDelay) {\n          this._navRepeat += delta\n          if (this._navRepeat >= this.repeatRate) { this._navRepeat = 0; step = true }\n        }\n      }\n    }\n    if (step) {\n      // Navigate Y is positive UP; rows run top to bottom.\n      if (dy) this._selected = (this._selected - dy + 4) % 4\n      if (dx) this._adjust(dx)\n      this._refresh()\n    }\n\n    if (Input.started('Submit')) this._confirm()\n    if (Input.started('Cancel')) this.close()\n  }\n\n  // ----- the maths --------------------------------------------------------------------------------\n\n  /** Souls to buy every pending point, from the player's CURRENT level. */\n  public pendingCost(): number {\n    const p = this._player as any\n    if (!p?.levelFor) return 0\n    const from = p.level\n    const to = p.levelFor(this._pending[0], this._pending[1], this._pending[2], this._pending[3])\n    let cost = 0\n    for (let l = from; l < to; l++) cost += p.levelCost(l)\n    return cost\n  }\n\n  private _adjust(delta: number): void {\n    const p = this._player as any\n    if (!p) return\n    const key = STATS[this._selected]\n    const floor = p[key]\n    const next = this._pending[this._selected] + delta\n    if (next < floor || next > 99) return\n    const before = this._pending[this._selected]\n    this._pending[this._selected] = next\n    if (delta > 0 && this.pendingCost() > (p.souls ?? 0)) {\n      this._pending[this._selected] = before\n      playSound(this, 'Menu Deny')\n      return\n    }\n    playSound(this, 'Menu Tick')\n    this._refresh()\n  }\n\n  private _confirm(): void {\n    const p = this._player as any\n    if (!p) return\n    const cost = this.pendingCost()\n    if (cost <= 0) return\n    if (p.applyLevelUp?.(this._pending[0], this._pending[1], this._pending[2], this._pending[3], cost)) {\n      playSound(this, 'Level Up')\n      ;(this._gm as any)?.notice?.('Level up!')\n    }\n    this._resetPending()\n    this._refresh()\n  }\n\n  private _resetPending(): void {\n    const p = this._player as any\n    this._pending = STATS.map(k => (p ? p[k] : 10))\n  }\n\n  private _refresh(): void {\n    const p = this._player as any\n    if (!p?.levelFor) return\n    const level = p.levelFor(this._pending[0], this._pending[1], this._pending[2], this._pending[3])\n    const cost = this.pendingCost()\n    this._set('LevelText', 'Level  ' + p.level + (level !== p.level ? '  ->  ' + level : ''))\n    this._set('SoulsText', 'Souls  ' + p.souls + (cost ? '  ->  ' + (p.souls - cost) : ''))\n    this._set('CostText', 'Next level  ' + p.levelCost(level) + ' souls')\n\n    const labels = ['Vigor', 'Endurance', 'Strength', 'Dexterity']\n    labels.forEach((label, i) => {\n      const row = this._find('Row_' + label) as any\n      if (!row) return\n      const changed = this._pending[i] !== p[STATS[i]]\n      const value = this._find('Value', row) as UITextNode\n      if (value) value.text = String(this._pending[i]) + (changed ? ' *' : '')\n      const tint = i === this._selected ? this.selectedTint : this.rowTint\n      row.tint = [tint[0], tint[1], tint[2], tint[3]]\n    })\n\n    const weapons: Node[] = p.weapons?.() ?? []\n    const ar = weapons.map(w => (w as any).displayName + ' ' + ((w as any).attackRating?.(this._pending[2], this._pending[3]) ?? 0))\n    this._set('Derived', 'HP ' + p.hpForVigor(this._pending[0]) + '    Stamina ' + p.staminaForEndurance(this._pending[1])\n      + '\\nAttack  ' + ar.join('   '))\n  }\n\n  private _set(name: string, text: string): void {\n    const node = this._find(name) as UITextNode\n    if (node && node.text !== text) node.text = text\n  }\n\n  private _find(name: string, root: Node = this): Node {\n    const walk = (node: Node): Node => {\n      for (const child of node.children) {\n        if (child.name === name) return child\n        const found = walk(child)\n        if (found) return found\n      }\n      return null\n    }\n    return walk(root)\n  }\n}\n",
            "scriptVars": {}
          },
          {
            "id": "ae2e38bdc2ad1920e39d5c3e90ef077d",
            "name": "ConfirmDialog",
            "type": "uiRoot",
            "position": [0, 0, 0],
            "rotation": [0, 0, 0],
            "scale": [1, 1, 1],
            "children": [
              {
                "id": "2d01614d22765e0a83e92ef7cebb314c",
                "name": "Backdrop",
                "type": "uiPanel",
                "position": [0, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1],
                "children": [
                  {
                    "id": "f4fc50038c12488c34dd7665cbca6a41",
                    "name": "Card",
                    "type": "uiPanel",
                    "position": [0, 0, 0],
                    "rotation": [0, 0, 0],
                    "scale": [1, 1, 1],
                    "children": [
                      {
                        "id": "04dbfff00c2aabb33dc7bec4687b0292",
                        "name": "Title",
                        "type": "uiText",
                        "position": [0, 0, 0],
                        "rotation": [0, 0, 0],
                        "scale": [1, 1, 1],
                        "children": [],
                        "variables": {},
                        "spawnOnStart": true,
                        "visible": true,
                        "ui": {
                          "anchorMin": [0, 0],
                          "anchorMax": [1, 0],
                          "offsetMin": [24, 26],
                          "offsetMax": [-24, 80],
                          "pivot": [0, 0],
                          "rotationDeg": 0,
                          "scale2d": [1, 1],
                          "opacity": 1,
                          "tint": [0.92, 0.78, 0.46, 1],
                          "zOrder": 0,
                          "interactive": false,
                          "clip": false,
                          "sizing": "fixed",
                          "padding": [0, 0, 0, 0],
                          "borderRadius": 0,
                          "borderWidth": 0,
                          "borderColor": [0, 0, 0, 1],
                          "text": "Enter?",
                          "fontSize": 36,
                          "fontFamily": "Georgia, \"Times New Roman\", serif",
                          "fontWeight": 400,
                          "align": "center",
                          "vAlign": "middle",
                          "wrap": true,
                          "lineHeight": 1.25
                        }
                      },
                      {
                        "id": "f218a272f500b6ed14d06079ccfefa33",
                        "name": "Body",
                        "type": "uiText",
                        "position": [0, 0, 0],
                        "rotation": [0, 0, 0],
                        "scale": [1, 1, 1],
                        "children": [],
                        "variables": {},
                        "spawnOnStart": true,
                        "visible": true,
                        "ui": {
                          "anchorMin": [0, 0],
                          "anchorMax": [1, 0],
                          "offsetMin": [40, 92],
                          "offsetMax": [-40, 180],
                          "pivot": [0, 0],
                          "rotationDeg": 0,
                          "scale2d": [1, 1],
                          "opacity": 1,
                          "tint": [0.7, 0.67, 0.6, 1],
                          "zOrder": 0,
                          "interactive": false,
                          "clip": false,
                          "sizing": "fixed",
                          "padding": [0, 0, 0, 0],
                          "borderRadius": 0,
                          "borderWidth": 0,
                          "borderColor": [0, 0, 0, 1],
                          "text": "",
                          "fontSize": 22,
                          "fontFamily": "Georgia, \"Times New Roman\", serif",
                          "fontWeight": 400,
                          "align": "center",
                          "vAlign": "top",
                          "wrap": true,
                          "lineHeight": 1.25
                        }
                      },
                      {
                        "id": "de20f3de1881321f3db4cf01184393ec",
                        "name": "Yes",
                        "type": "uiButton",
                        "position": [0, 0, 0],
                        "rotation": [0, 0, 0],
                        "scale": [1, 1, 1],
                        "children": [],
                        "variables": {},
                        "spawnOnStart": true,
                        "visible": true,
                        "ui": {
                          "anchorMin": [0.5, 1],
                          "anchorMax": [0.5, 1],
                          "offsetMin": [-230, -88],
                          "offsetMax": [-20, -40],
                          "pivot": [0, 0],
                          "rotationDeg": 0,
                          "scale2d": [1, 1],
                          "opacity": 1,
                          "tint": [0.18, 0.15, 0.12, 1],
                          "zOrder": 0,
                          "interactive": true,
                          "clip": false,
                          "sizing": "fixed",
                          "padding": [0, 0, 0, 0],
                          "borderRadius": 4,
                          "borderWidth": 0,
                          "borderColor": [0, 0, 0, 1],
                          "label": "Yes",
                          "disabled": false,
                          "hoverTint": [1, 1, 1, 0.16],
                          "pressedTint": [0, 0, 0, 0.22],
                          "disabledTint": [0.5, 0.5, 0.5, 0.4]
                        }
                      },
                      {
                        "id": "e97c6eefdf03dd17085d86e3c127b3f4",
                        "name": "No",
                        "type": "uiButton",
                        "position": [0, 0, 0],
                        "rotation": [0, 0, 0],
                        "scale": [1, 1, 1],
                        "children": [],
                        "variables": {},
                        "spawnOnStart": true,
                        "visible": true,
                        "ui": {
                          "anchorMin": [0.5, 1],
                          "anchorMax": [0.5, 1],
                          "offsetMin": [20, -88],
                          "offsetMax": [230, -40],
                          "pivot": [0, 0],
                          "rotationDeg": 0,
                          "scale2d": [1, 1],
                          "opacity": 1,
                          "tint": [0.18, 0.15, 0.12, 1],
                          "zOrder": 0,
                          "interactive": true,
                          "clip": false,
                          "sizing": "fixed",
                          "padding": [0, 0, 0, 0],
                          "borderRadius": 4,
                          "borderWidth": 0,
                          "borderColor": [0, 0, 0, 1],
                          "label": "No",
                          "disabled": false,
                          "hoverTint": [1, 1, 1, 0.16],
                          "pressedTint": [0, 0, 0, 0.22],
                          "disabledTint": [0.5, 0.5, 0.5, 0.4]
                        }
                      }
                    ],
                    "variables": {},
                    "spawnOnStart": true,
                    "visible": true,
                    "ui": {
                      "anchorMin": [0.5, 0.5],
                      "anchorMax": [0.5, 0.5],
                      "offsetMin": [-360, -150],
                      "offsetMax": [360, 150],
                      "pivot": [0, 0],
                      "rotationDeg": 0,
                      "scale2d": [1, 1],
                      "opacity": 1,
                      "tint": [0.05, 0.045, 0.04, 0.94],
                      "zOrder": 0,
                      "interactive": false,
                      "clip": false,
                      "sizing": "fixed",
                      "padding": [0, 0, 0, 0],
                      "borderRadius": 8,
                      "borderWidth": 0,
                      "borderColor": [0, 0, 0, 1]
                    }
                  }
                ],
                "variables": {},
                "spawnOnStart": true,
                "visible": true,
                "ui": {
                  "anchorMin": [0, 0],
                  "anchorMax": [1, 1],
                  "offsetMin": [0, 0],
                  "offsetMax": [0, 0],
                  "pivot": [0, 0],
                  "rotationDeg": 0,
                  "scale2d": [1, 1],
                  "opacity": 1,
                  "tint": [0, 0, 0, 0.45],
                  "zOrder": 0,
                  "interactive": true,
                  "clip": false,
                  "sizing": "fixed",
                  "padding": [0, 0, 0, 0],
                  "borderRadius": 4,
                  "borderWidth": 0,
                  "borderColor": [0, 0, 0, 1]
                }
              }
            ],
            "variables": {
              "__scriptId": {
                "type": "string",
                "value": "997d91558a1adf99ed717fb0c7262640",
                "access": "public"
              }
            },
            "spawnOnStart": true,
            "visible": false,
            "ui": {
              "anchorMin": [0, 0],
              "anchorMax": [1, 1],
              "offsetMin": [0, 0],
              "offsetMax": [0, 0],
              "pivot": [0, 0],
              "rotationDeg": 0,
              "scale2d": [1, 1],
              "opacity": 1,
              "tint": [1, 1, 1, 1],
              "zOrder": 45,
              "interactive": false,
              "clip": false,
              "sizing": "fixed",
              "padding": [0, 0, 0, 0],
              "borderRadius": 0,
              "borderWidth": 0,
              "borderColor": [0, 0, 0, 1],
              "space": "screen",
              "referenceResolution": [1920, 1080],
              "scaleMode": "scaleWithScreen",
              "matchWidthOrHeight": 0.5,
              "referenceDpr": 1,
              "uiTargetId": null,
              "referenceDistance": 10,
              "minScale": 0.1,
              "maxScale": 4,
              "billboard": true,
              "clampToScreen": false,
              "hideBehindCamera": true
            },
            "script": "import { Input, Node, UIButtonNode, UIRootNode, UITextNode } from 'cleo'\nimport { attribute } from 'cleo/decorators'\nimport { playSound } from '@/Core/Scripts/SoulsAudio'\n\n/**\n * A yes/no question over the game: \"Enter the skull cave?\". Attach to the `ConfirmDialog` node, a\n * screen-space UI Root authored hidden, on the player beside the bonfire menu:\n *\n *   ConfirmDialog\n *     Card\n *       Title, Body      uiText\n *       Yes, No          uiButton\n *\n * `ask(title, body, onYes)` opens it. Submit or Yes answers yes, Cancel or No answers no; the mouse can\n * click either. Gameplay input is off while it is open, and back on before `onYes` runs -- a scene\n * switch keeps the input maps as they are, so a dialog that loaded a scene while still holding Gameplay\n * off would leave the next scene unable to move.\n */\nexport default class SoulsConfirmDialogNode extends UIRootNode {\n  @attribute\n  public isOpen: boolean = false\n\n  private _onYes: () => void = null\n  private _openedAt: number = 0\n  private _clock: number = 0\n\n  onStart() {\n    this.visible = false\n    this.isOpen = false\n    const yes = this._find('Yes') as UIButtonNode\n    if (yes) yes.onPress = () => this._answer(true)\n    const no = this._find('No') as UIButtonNode\n    if (no) no.onPress = () => this._answer(false)\n  }\n\n  public ask(title: string, body: string, onYes: () => void): void {\n    this._set('Title', title)\n    this._set('Body', body)\n    this._onYes = onYes\n    this.isOpen = true\n    this._openedAt = this._clock\n    this.visible = true\n    Input.disableMap('Gameplay')\n    Input.releaseMouse()\n    playSound(this, 'Menu Tick')\n  }\n\n  onUpdate(delta: number) {\n    this._clock += delta\n    if (!this.isOpen) return\n    // Swallow the press that opened us (Interact may share a key with Submit).\n    if (this._clock - this._openedAt < 0.2) return\n    if (Input.started('Submit')) this._answer(true)\n    else if (Input.started('Cancel')) this._answer(false)\n  }\n\n  private _answer(yes: boolean): void {\n    if (!this.isOpen) return\n    this.isOpen = false\n    this.visible = false\n    Input.enableMap('Gameplay')\n    const then = this._onYes\n    this._onYes = null\n    if (yes) then?.()\n  }\n\n  private _set(name: string, text: string): void {\n    const node = this._find(name) as UITextNode\n    if (node) node.text = text\n  }\n\n  private _find(name: string, root: Node = this): Node {\n    for (const child of root.children) {\n      if (child.name === name) return child\n      const found = this._find(name, child)\n      if (found) return found\n    }\n    return null\n  }\n}\n",
            "scriptVars": {}
          },
          {
            "id": "79e73082cc662f6be41c6b9fe4d56f35",
            "name": "PauseMenu",
            "type": "uiRoot",
            "position": [0, 0, 0],
            "rotation": [0, 0, 0],
            "scale": [1, 1, 1],
            "children": [
              {
                "id": "ecb74e43009d1710f4552ef540af2f01",
                "name": "Backdrop",
                "type": "uiPanel",
                "position": [0, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1],
                "children": [
                  {
                    "id": "d10fae6f0d465679f83efe34a0f7b970",
                    "name": "Card",
                    "type": "uiPanel",
                    "position": [0, 0, 0],
                    "rotation": [0, 0, 0],
                    "scale": [1, 1, 1],
                    "children": [
                      {
                        "id": "aad4f5c1372501b400ce0b0afc031d45",
                        "name": "Title",
                        "type": "uiText",
                        "position": [0, 0, 0],
                        "rotation": [0, 0, 0],
                        "scale": [1, 1, 1],
                        "children": [],
                        "variables": {},
                        "spawnOnStart": true,
                        "visible": true,
                        "ui": {
                          "anchorMin": [0, 0],
                          "anchorMax": [1, 0],
                          "offsetMin": [0, 28],
                          "offsetMax": [0, 88],
                          "pivot": [0, 0],
                          "rotationDeg": 0,
                          "scale2d": [1, 1],
                          "opacity": 1,
                          "tint": [0.92, 0.78, 0.46, 1],
                          "zOrder": 0,
                          "interactive": false,
                          "clip": false,
                          "sizing": "fixed",
                          "padding": [0, 0, 0, 0],
                          "borderRadius": 0,
                          "borderWidth": 0,
                          "borderColor": [0, 0, 0, 1],
                          "text": "PAUSED",
                          "fontSize": 44,
                          "fontFamily": "Georgia, \"Times New Roman\", serif",
                          "fontWeight": 400,
                          "align": "center",
                          "vAlign": "middle",
                          "wrap": true,
                          "lineHeight": 1.25
                        }
                      },
                      {
                        "id": "d687a8f2982c1ac803e2e7ff38d83578",
                        "name": "Resume",
                        "type": "uiButton",
                        "position": [0, 0, 0],
                        "rotation": [0, 0, 0],
                        "scale": [1, 1, 1],
                        "children": [],
                        "variables": {},
                        "spawnOnStart": true,
                        "visible": true,
                        "ui": {
                          "anchorMin": [0.5, 0],
                          "anchorMax": [0.5, 0],
                          "offsetMin": [-180, 120],
                          "offsetMax": [180, 172],
                          "pivot": [0, 0],
                          "rotationDeg": 0,
                          "scale2d": [1, 1],
                          "opacity": 1,
                          "tint": [0.18, 0.15, 0.12, 1],
                          "zOrder": 0,
                          "interactive": true,
                          "clip": false,
                          "sizing": "fixed",
                          "padding": [0, 0, 0, 0],
                          "borderRadius": 4,
                          "borderWidth": 0,
                          "borderColor": [0, 0, 0, 1],
                          "label": "Resume",
                          "disabled": false,
                          "hoverTint": [1, 1, 1, 0.16],
                          "pressedTint": [0, 0, 0, 0.22],
                          "disabledTint": [0.5, 0.5, 0.5, 0.4]
                        }
                      },
                      {
                        "id": "06ac4ad5a07598e61473b9974d5275f6",
                        "name": "Bonfire",
                        "type": "uiButton",
                        "position": [0, 0, 0],
                        "rotation": [0, 0, 0],
                        "scale": [1, 1, 1],
                        "children": [],
                        "variables": {},
                        "spawnOnStart": true,
                        "visible": true,
                        "ui": {
                          "anchorMin": [0.5, 0],
                          "anchorMax": [0.5, 0],
                          "offsetMin": [-180, 188],
                          "offsetMax": [180, 240],
                          "pivot": [0, 0],
                          "rotationDeg": 0,
                          "scale2d": [1, 1],
                          "opacity": 1,
                          "tint": [0.18, 0.15, 0.12, 1],
                          "zOrder": 0,
                          "interactive": true,
                          "clip": false,
                          "sizing": "fixed",
                          "padding": [0, 0, 0, 0],
                          "borderRadius": 4,
                          "borderWidth": 0,
                          "borderColor": [0, 0, 0, 1],
                          "label": "Return to Bonfire",
                          "disabled": false,
                          "hoverTint": [1, 1, 1, 0.16],
                          "pressedTint": [0, 0, 0, 0.22],
                          "disabledTint": [0.5, 0.5, 0.5, 0.4]
                        }
                      },
                      {
                        "id": "2a25d0be394b49080330df06b5253d14",
                        "name": "Load",
                        "type": "uiButton",
                        "position": [0, 0, 0],
                        "rotation": [0, 0, 0],
                        "scale": [1, 1, 1],
                        "children": [],
                        "variables": {},
                        "spawnOnStart": true,
                        "visible": true,
                        "ui": {
                          "anchorMin": [0.5, 0],
                          "anchorMax": [0.5, 0],
                          "offsetMin": [-180, 256],
                          "offsetMax": [180, 308],
                          "pivot": [0, 0],
                          "rotationDeg": 0,
                          "scale2d": [1, 1],
                          "opacity": 1,
                          "tint": [0.18, 0.15, 0.12, 1],
                          "zOrder": 0,
                          "interactive": true,
                          "clip": false,
                          "sizing": "fixed",
                          "padding": [0, 0, 0, 0],
                          "borderRadius": 4,
                          "borderWidth": 0,
                          "borderColor": [0, 0, 0, 1],
                          "label": "Load Last Rest",
                          "disabled": false,
                          "hoverTint": [1, 1, 1, 0.16],
                          "pressedTint": [0, 0, 0, 0.22],
                          "disabledTint": [0.5, 0.5, 0.5, 0.4]
                        }
                      },
                      {
                        "id": "b444e119143660fb4430503ab719b3ad",
                        "name": "Hint",
                        "type": "uiText",
                        "position": [0, 0, 0],
                        "rotation": [0, 0, 0],
                        "scale": [1, 1, 1],
                        "children": [],
                        "variables": {},
                        "spawnOnStart": true,
                        "visible": true,
                        "ui": {
                          "anchorMin": [0, 1],
                          "anchorMax": [1, 1],
                          "offsetMin": [24, -96],
                          "offsetMax": [-24, -24],
                          "pivot": [0, 0],
                          "rotationDeg": 0,
                          "scale2d": [1, 1],
                          "opacity": 1,
                          "tint": [0.7, 0.67, 0.6, 1],
                          "zOrder": 0,
                          "interactive": false,
                          "clip": false,
                          "sizing": "fixed",
                          "padding": [0, 0, 0, 0],
                          "borderRadius": 0,
                          "borderWidth": 0,
                          "borderColor": [0, 0, 0, 1],
                          "text": "P / Esc / Start resume · enemies respawn when you return to the bonfire",
                          "fontSize": 17,
                          "fontFamily": "Georgia, \"Times New Roman\", serif",
                          "fontWeight": 400,
                          "align": "center",
                          "vAlign": "top",
                          "wrap": true,
                          "lineHeight": 1.25
                        }
                      }
                    ],
                    "variables": {},
                    "spawnOnStart": true,
                    "visible": true,
                    "ui": {
                      "anchorMin": [0.5, 0.5],
                      "anchorMax": [0.5, 0.5],
                      "offsetMin": [-300, -230],
                      "offsetMax": [300, 230],
                      "pivot": [0, 0],
                      "rotationDeg": 0,
                      "scale2d": [1, 1],
                      "opacity": 1,
                      "tint": [0.05, 0.045, 0.04, 0.94],
                      "zOrder": 0,
                      "interactive": false,
                      "clip": false,
                      "sizing": "fixed",
                      "padding": [0, 0, 0, 0],
                      "borderRadius": 8,
                      "borderWidth": 0,
                      "borderColor": [0, 0, 0, 1]
                    }
                  }
                ],
                "variables": {},
                "spawnOnStart": true,
                "visible": true,
                "ui": {
                  "anchorMin": [0, 0],
                  "anchorMax": [1, 1],
                  "offsetMin": [0, 0],
                  "offsetMax": [0, 0],
                  "pivot": [0, 0],
                  "rotationDeg": 0,
                  "scale2d": [1, 1],
                  "opacity": 1,
                  "tint": [0, 0, 0, 0.55],
                  "zOrder": 0,
                  "interactive": true,
                  "clip": false,
                  "sizing": "fixed",
                  "padding": [0, 0, 0, 0],
                  "borderRadius": 4,
                  "borderWidth": 0,
                  "borderColor": [0, 0, 0, 1]
                }
              }
            ],
            "variables": {
              "__scriptId": {
                "type": "string",
                "value": "cc500ba47a038aa00b7e81fd9837a023",
                "access": "public"
              }
            },
            "spawnOnStart": true,
            "visible": false,
            "ui": {
              "anchorMin": [0, 0],
              "anchorMax": [1, 1],
              "offsetMin": [0, 0],
              "offsetMax": [0, 0],
              "pivot": [0, 0],
              "rotationDeg": 0,
              "scale2d": [1, 1],
              "opacity": 1,
              "tint": [1, 1, 1, 1],
              "zOrder": 60,
              "interactive": false,
              "clip": false,
              "sizing": "fixed",
              "padding": [0, 0, 0, 0],
              "borderRadius": 0,
              "borderWidth": 0,
              "borderColor": [0, 0, 0, 1],
              "space": "screen",
              "referenceResolution": [1920, 1080],
              "scaleMode": "scaleWithScreen",
              "matchWidthOrHeight": 0.5,
              "referenceDpr": 1,
              "uiTargetId": null,
              "referenceDistance": 10,
              "minScale": 0.1,
              "maxScale": 4,
              "billboard": true,
              "clampToScreen": false,
              "hideBehindCamera": true
            },
            "script": "import { Game, Input, Logger, Node, SaveGame, UIButtonNode, UIRootNode } from 'cleo'\nimport { find, attribute } from 'cleo/decorators'\n\n/**\n * Hollow Keep — the pause menu. Attach to the `PauseMenu` node, a screen-space UI Root authored hidden,\n * a child of the Player like the HUD and the bonfire menu.\n *\n *   Card\n *     Title                \"PAUSED\"                                 uiText\n *     Resume               back to the game                          uiButton\n *     Bonfire              return to the last bonfire rested at      uiButton\n *     Load                 load the game saved at the last rest      uiButton (disabled with no save)\n *     Hint                 the controls line                         uiText\n *\n * Pause (P, Escape, or Start on a pad — the UI map) opens it: the game is paused with `Game.pause()`, so\n * physics, scripts, timers and animation all stop where they are. Pause or Cancel closes it; the mouse\n * can click either button.\n *\n * It listens in a LATE UPDATE (`scene.addLateUpdate`), not in onUpdate: while the game is paused no node's\n * onUpdate runs, so a menu that polled there could open but never close. Late updates run every frame,\n * paused or not, and input is read every frame too.\n *\n * It never opens over another menu (resting at a bonfire, a yes/no dialog) or while the player is dying,\n * nor in the moment just after one closes: Escape is also the bonfire menu's Cancel, and the press that\n * closes that menu must not open this one.\n */\nexport default class SoulsPauseMenuNode extends UIRootNode {\n  /** Real seconds after another menu closes during which Pause is ignored (see above). */\n  @attribute\n  public reopenGuard: number = 0.25\n  @attribute\n  public isOpen: boolean = false\n\n  @find('GameManager')\n  private _gm: Node = null\n  @find('Player')\n  private _player: Node = null\n  private _menus: Node[] = []\n  private _stopListening: (() => void) | null = null\n  /** Real time (seconds), counted in the late update, and when another menu was last seen open. */\n  private _clock: number = 0\n  private _otherMenuAt: number = -1\n\n  onStart() {\n    this.visible = false\n    this.isOpen = false\n    // The other menus this must not open over: the bonfire menu and the yes/no dialog.\n    this._menus = [\n      this._player?.getChildByName('BonfireMenu')[0],\n      this._player?.getChildByName('ConfirmDialog')[0],\n      this.findNode('ConfirmDialog'),\n    ].filter(n => !!n && n !== this)\n    const resume = this._find('Resume') as UIButtonNode\n    if (resume) resume.onPress = () => this.close()\n    const bonfire = this._find('Bonfire') as UIButtonNode\n    if (bonfire) bonfire.onPress = () => this._toBonfire()\n    const load = this._find('Load') as UIButtonNode\n    if (load) load.onPress = () => this._loadLastRest()\n    this._stopListening = this.scene?.addLateUpdate((_delta, unscaled) => this._listen(unscaled)) ?? null\n  }\n\n  onDespawn() {\n    this._stopListening?.()\n    this._stopListening = null\n    if (this.isOpen) this.close()\n  }\n\n  /** Pause the game and show the menu. */\n  public open(): void {\n    if (this.isOpen) return\n    this.isOpen = true\n    this.visible = true\n    Game.clearSlowMotion()\n    Game.pause()\n    Input.disableMap('Gameplay')\n    Input.releaseMouse()\n    // Load last rest only when there is a save to load.\n    const load = this._find('Load') as UIButtonNode\n    if (load) {\n      load.disabled = true\n      if (SaveGame.available) SaveGame.exists('auto').then(ok => { load.disabled = !ok }).catch(() => {})\n    }\n  }\n\n  /** Hide the menu and carry on. */\n  public close(): void {\n    if (!this.isOpen) return\n    this.isOpen = false\n    this.visible = false\n    Game.resume()\n    // Another menu may have been opened underneath by a script; it keeps the Gameplay map off.\n    if (!this._otherMenuOpen()) Input.enableMap('Gameplay')\n    this._otherMenuAt = this._clock\n  }\n\n  private _listen(unscaled: number): void {\n    this._clock += unscaled\n    if (this._otherMenuOpen()) this._otherMenuAt = this._clock\n    if (this.isOpen) {\n      if (Input.started('Pause') || Input.started('Cancel')) this.close()\n      else if (Input.started('Submit')) this.close()\n      return\n    }\n    if (!Input.started('Pause') || !this._canPause()) return\n    this.open()\n  }\n\n  private _canPause(): boolean {\n    if (Game.isPaused) return false                        // paused by someone else (the editor)\n    if (this._otherMenuOpen()) return false\n    if (this._clock - this._otherMenuAt < this.reopenGuard) return false\n    const p = this._player as any\n    if (p?.isDead) return false\n    return true\n  }\n\n  private _otherMenuOpen(): boolean {\n    return this._menus.some(m => (m as any).isOpen)\n  }\n\n  private _toBonfire(): void {\n    this.close()\n    ;(this._gm as any)?.respawnAtBonfire?.()\n  }\n\n  /** Load the game as it was saved at the last bonfire: the world, and the player at that bonfire. */\n  private _loadLastRest(): void {\n    this.close()\n    const gm = this._gm as any\n    if (!gm?.loadLastRest) return\n    gm.loadLastRest()\n      .then((loaded: boolean) => { if (!loaded) gm.notice?.('Nothing saved yet: rest at a bonfire') })\n      .catch((e: any) => Logger.warn(`Hollow Keep: the save could not be loaded: ${e?.message ?? e}`, 'Script'))\n  }\n\n  private _find(name: string, under: Node = this): Node {\n    for (const child of under.children) {\n      if (child.name === name) return child\n      const deeper = this._find(name, child)\n      if (deeper) return deeper\n    }\n    return null\n  }\n}\n",
            "scriptVars": {}
          },
          {
            "id": "5c6e3b803973759ea542ac4680a7d80e",
            "name": "LockReticle",
            "type": "uiRoot",
            "position": [0, 0, 0],
            "rotation": [0, 0, 0],
            "scale": [1, 1, 1],
            "children": [
              {
                "id": "867684bca0d32c496f4c1cc13feb2f9a",
                "name": "Dot",
                "type": "uiPanel",
                "position": [0, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1],
                "children": [],
                "variables": {},
                "spawnOnStart": true,
                "visible": true,
                "ui": {
                  "anchorMin": [0, 0],
                  "anchorMax": [1, 1],
                  "offsetMin": [0, 0],
                  "offsetMax": [0, 0],
                  "pivot": [0, 0],
                  "rotationDeg": 0,
                  "scale2d": [1, 1],
                  "opacity": 1,
                  "tint": [1, 1, 1, 0.9],
                  "zOrder": 0,
                  "interactive": false,
                  "clip": false,
                  "sizing": "fixed",
                  "padding": [0, 0, 0, 0],
                  "borderRadius": 7,
                  "borderWidth": 0,
                  "borderColor": [0, 0, 0, 1]
                }
              }
            ],
            "variables": {},
            "spawnOnStart": true,
            "visible": false,
            "ui": {
              "anchorMin": [0, 0],
              "anchorMax": [0, 0],
              "offsetMin": [0, 0],
              "offsetMax": [14, 14],
              "pivot": [0.5, 0.5],
              "rotationDeg": 0,
              "scale2d": [1, 1],
              "opacity": 1,
              "tint": [1, 1, 1, 1],
              "zOrder": 0,
              "interactive": false,
              "clip": false,
              "sizing": "fixed",
              "padding": [0, 0, 0, 0],
              "borderRadius": 0,
              "borderWidth": 0,
              "borderColor": [0, 0, 0, 1],
              "space": "world",
              "referenceResolution": [14, 14],
              "scaleMode": "constantPixel",
              "matchWidthOrHeight": 0.5,
              "referenceDpr": 1,
              "uiTargetId": null,
              "referenceDistance": 10,
              "minScale": 0.1,
              "maxScale": 4,
              "billboard": true,
              "clampToScreen": false,
              "hideBehindCamera": true
            }
          },
          {
            "id": "123b2828d316ceef740b4b6a19da8c1c",
            "name": "Sounds",
            "type": "node",
            "position": [0, 0, 0],
            "rotation": [0, 0, 0],
            "scale": [1, 1, 1],
            "children": [
              {
                "id": "09dfd439fbf39bd386d7d108f23a5e1b",
                "name": "Swing",
                "type": "sound",
                "position": [0, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1],
                "children": [],
                "variables": {},
                "spawnOnStart": true,
                "sound": {
                  "mode": "ambient",
                  "sampleId": null,
                  "volume": 1,
                  "loopMode": "inherit",
                  "playOnStart": false,
                  "distanceModel": "inverse",
                  "refDistance": 1,
                  "maxDistance": 100,
                  "rolloffFactor": 1
                }
              },
              {
                "id": "a72fd6c87affddfb4991cd9ce19e24fd",
                "name": "Swing Heavy",
                "type": "sound",
                "position": [0, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1],
                "children": [],
                "variables": {},
                "spawnOnStart": true,
                "sound": {
                  "mode": "ambient",
                  "sampleId": null,
                  "volume": 1,
                  "loopMode": "inherit",
                  "playOnStart": false,
                  "distanceModel": "inverse",
                  "refDistance": 1,
                  "maxDistance": 100,
                  "rolloffFactor": 1
                }
              },
              {
                "id": "5402df8a0e3935d32dab015d4affb455",
                "name": "Roll",
                "type": "sound",
                "position": [0, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1],
                "children": [],
                "variables": {},
                "spawnOnStart": true,
                "sound": {
                  "mode": "ambient",
                  "sampleId": null,
                  "volume": 1,
                  "loopMode": "inherit",
                  "playOnStart": false,
                  "distanceModel": "inverse",
                  "refDistance": 1,
                  "maxDistance": 100,
                  "rolloffFactor": 1
                }
              },
              {
                "id": "bc436325a5e267263a98aff2ea4591c3",
                "name": "Drink",
                "type": "sound",
                "position": [0, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1],
                "children": [],
                "variables": {},
                "spawnOnStart": true,
                "sound": {
                  "mode": "ambient",
                  "sampleId": null,
                  "volume": 1,
                  "loopMode": "inherit",
                  "playOnStart": false,
                  "distanceModel": "inverse",
                  "refDistance": 1,
                  "maxDistance": 100,
                  "rolloffFactor": 1
                }
              },
              {
                "id": "9beac22f34131696ca514f459ee5fb60",
                "name": "Player Hurt",
                "type": "sound",
                "position": [0, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1],
                "children": [],
                "variables": {},
                "spawnOnStart": true,
                "sound": {
                  "mode": "ambient",
                  "sampleId": null,
                  "volume": 1,
                  "loopMode": "inherit",
                  "playOnStart": false,
                  "distanceModel": "inverse",
                  "refDistance": 1,
                  "maxDistance": 100,
                  "rolloffFactor": 1
                }
              },
              {
                "id": "d56ca7c9b3d0d532e5d05f44b9215056",
                "name": "Souls",
                "type": "sound",
                "position": [0, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1],
                "children": [],
                "variables": {},
                "spawnOnStart": true,
                "sound": {
                  "mode": "ambient",
                  "sampleId": null,
                  "volume": 1,
                  "loopMode": "inherit",
                  "playOnStart": false,
                  "distanceModel": "inverse",
                  "refDistance": 1,
                  "maxDistance": 100,
                  "rolloffFactor": 1
                }
              },
              {
                "id": "8ae92148d4abc7eb0b6bc0c3d5f8c209",
                "name": "Recoil",
                "type": "sound",
                "position": [0, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1],
                "children": [],
                "variables": {},
                "spawnOnStart": true,
                "sound": {
                  "mode": "ambient",
                  "sampleId": null,
                  "volume": 1,
                  "loopMode": "inherit",
                  "playOnStart": false,
                  "distanceModel": "inverse",
                  "refDistance": 1,
                  "maxDistance": 100,
                  "rolloffFactor": 1
                }
              },
              {
                "id": "3fb4112b1a011892f60728fc1bd8f19b",
                "name": "Lock On",
                "type": "sound",
                "position": [0, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1],
                "children": [],
                "variables": {},
                "spawnOnStart": true,
                "sound": {
                  "mode": "ambient",
                  "sampleId": null,
                  "volume": 1,
                  "loopMode": "inherit",
                  "playOnStart": false,
                  "distanceModel": "inverse",
                  "refDistance": 1,
                  "maxDistance": 100,
                  "rolloffFactor": 1
                }
              },
              {
                "id": "8bfcd4b8e79ba389c33ba4158890c590",
                "name": "Menu Tick",
                "type": "sound",
                "position": [0, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1],
                "children": [],
                "variables": {},
                "spawnOnStart": true,
                "sound": {
                  "mode": "ambient",
                  "sampleId": null,
                  "volume": 1,
                  "loopMode": "inherit",
                  "playOnStart": false,
                  "distanceModel": "inverse",
                  "refDistance": 1,
                  "maxDistance": 100,
                  "rolloffFactor": 1
                }
              },
              {
                "id": "acb8e1b82c2ed4a154575381e050945d",
                "name": "Menu Deny",
                "type": "sound",
                "position": [0, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1],
                "children": [],
                "variables": {},
                "spawnOnStart": true,
                "sound": {
                  "mode": "ambient",
                  "sampleId": null,
                  "volume": 1,
                  "loopMode": "inherit",
                  "playOnStart": false,
                  "distanceModel": "inverse",
                  "refDistance": 1,
                  "maxDistance": 100,
                  "rolloffFactor": 1
                }
              },
              {
                "id": "a2fd4bd79151fe046c60782f72c3e5da",
                "name": "Level Up",
                "type": "sound",
                "position": [0, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1],
                "children": [],
                "variables": {},
                "spawnOnStart": true,
                "sound": {
                  "mode": "ambient",
                  "sampleId": null,
                  "volume": 1,
                  "loopMode": "inherit",
                  "playOnStart": false,
                  "distanceModel": "inverse",
                  "refDistance": 1,
                  "maxDistance": 100,
                  "rolloffFactor": 1
                }
              }
            ],
            "variables": {},
            "spawnOnStart": true
          },
          {
            "id": "7a88ffd811a8d30cc6421553bbf62e24",
            "name": "TitleMenu",
            "type": "uiRoot",
            "position": [0, 0, 0],
            "rotation": [0, 0, 0],
            "scale": [1, 1, 1],
            "children": [
              {
                "id": "c57701bda4f61d1625aa42b230109703",
                "name": "Backdrop",
                "type": "uiPanel",
                "position": [0, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1, 1, 1],
                "children": [
                  {
                    "id": "04f766a7621287b5a9fe00b91321fe09",
                    "name": "Card",
                    "type": "uiPanel",
                    "position": [0, 0, 0],
                    "rotation": [0, 0, 0],
                    "scale": [1, 1, 1],
                    "children": [
                      {
                        "id": "1c9e3a39613b1bbc0d80248bf1f98f77",
                        "name": "Title",
                        "type": "uiText",
                        "position": [0, 0, 0],
                        "rotation": [0, 0, 0],
                        "scale": [1, 1, 1],
                        "children": [],
                        "variables": {},
                        "spawnOnStart": true,
                        "visible": true,
                        "ui": {
                          "anchorMin": [0, 0],
                          "anchorMax": [1, 0],
                          "offsetMin": [0, 28],
                          "offsetMax": [0, 88],
                          "pivot": [0, 0],
                          "rotationDeg": 0,
                          "scale2d": [1, 1],
                          "opacity": 1,
                          "tint": [0.92, 0.78, 0.46, 1],
                          "zOrder": 0,
                          "interactive": false,
                          "clip": false,
                          "sizing": "fixed",
                          "padding": [0, 0, 0, 0],
                          "borderRadius": 0,
                          "borderWidth": 0,
                          "borderColor": [0, 0, 0, 1],
                          "text": "HOLLOW KEEP",
                          "fontSize": 44,
                          "fontFamily": "Georgia, \"Times New Roman\", serif",
                          "fontWeight": 400,
                          "align": "center",
                          "vAlign": "middle",
                          "wrap": true,
                          "lineHeight": 1.25
                        }
                      },
                      {
                        "id": "062ea0b315a8b038dfbb8f50070caab4",
                        "name": "Continue",
                        "type": "uiButton",
                        "position": [0, 0, 0],
                        "rotation": [0, 0, 0],
                        "scale": [1, 1, 1],
                        "children": [],
                        "variables": {},
                        "spawnOnStart": true,
                        "visible": true,
                        "ui": {
                          "anchorMin": [0.5, 0],
                          "anchorMax": [0.5, 0],
                          "offsetMin": [-180, 120],
                          "offsetMax": [180, 172],
                          "pivot": [0, 0],
                          "rotationDeg": 0,
                          "scale2d": [1, 1],
                          "opacity": 1,
                          "tint": [0.18, 0.15, 0.12, 1],
                          "zOrder": 0,
                          "interactive": true,
                          "clip": false,
                          "sizing": "fixed",
                          "padding": [0, 0, 0, 0],
                          "borderRadius": 4,
                          "borderWidth": 0,
                          "borderColor": [0, 0, 0, 1],
                          "label": "Continue",
                          "disabled": false,
                          "hoverTint": [1, 1, 1, 0.16],
                          "pressedTint": [0, 0, 0, 0.22],
                          "disabledTint": [0.5, 0.5, 0.5, 0.4]
                        }
                      },
                      {
                        "id": "b071924d98bb8ea5c1f94ad576793efa",
                        "name": "New Game",
                        "type": "uiButton",
                        "position": [0, 0, 0],
                        "rotation": [0, 0, 0],
                        "scale": [1, 1, 1],
                        "children": [],
                        "variables": {},
                        "spawnOnStart": true,
                        "visible": true,
                        "ui": {
                          "anchorMin": [0.5, 0],
                          "anchorMax": [0.5, 0],
                          "offsetMin": [-180, 188],
                          "offsetMax": [180, 240],
                          "pivot": [0, 0],
                          "rotationDeg": 0,
                          "scale2d": [1, 1],
                          "opacity": 1,
                          "tint": [0.18, 0.15, 0.12, 1],
                          "zOrder": 0,
                          "interactive": true,
                          "clip": false,
                          "sizing": "fixed",
                          "padding": [0, 0, 0, 0],
                          "borderRadius": 4,
                          "borderWidth": 0,
                          "borderColor": [0, 0, 0, 1],
                          "label": "New Game",
                          "disabled": false,
                          "hoverTint": [1, 1, 1, 0.16],
                          "pressedTint": [0, 0, 0, 0.22],
                          "disabledTint": [0.5, 0.5, 0.5, 0.4]
                        }
                      },
                      {
                        "id": "6353cbb3b9e4cf52b553713f57a0cb8b",
                        "name": "Hint",
                        "type": "uiText",
                        "position": [0, 0, 0],
                        "rotation": [0, 0, 0],
                        "scale": [1, 1, 1],
                        "children": [],
                        "variables": {},
                        "spawnOnStart": true,
                        "visible": true,
                        "ui": {
                          "anchorMin": [0, 1],
                          "anchorMax": [1, 1],
                          "offsetMin": [24, -96],
                          "offsetMax": [-24, -24],
                          "pivot": [0, 0],
                          "rotationDeg": 0,
                          "scale2d": [1, 1],
                          "opacity": 1,
                          "tint": [0.7, 0.67, 0.6, 1],
                          "zOrder": 0,
                          "interactive": false,
                          "clip": false,
                          "sizing": "fixed",
                          "padding": [0, 0, 0, 0],
                          "borderRadius": 0,
                          "borderWidth": 0,
                          "borderColor": [0, 0, 0, 1],
                          "text": "Up / Down choose · Enter or A confirm · the game saves at every bonfire",
                          "fontSize": 17,
                          "fontFamily": "Georgia, \"Times New Roman\", serif",
                          "fontWeight": 400,
                          "align": "center",
                          "vAlign": "top",
                          "wrap": true,
                          "lineHeight": 1.25
                        }
                      }
                    ],
                    "variables": {},
                    "spawnOnStart": true,
                    "visible": true,
                    "ui": {
                      "anchorMin": [0.5, 0.5],
                      "anchorMax": [0.5, 0.5],
                      "offsetMin": [-300, -190],
                      "offsetMax": [300, 190],
                      "pivot": [0, 0],
                      "rotationDeg": 0,
                      "scale2d": [1, 1],
                      "opacity": 1,
                      "tint": [0.05, 0.045, 0.04, 0.94],
                      "zOrder": 0,
                      "interactive": false,
                      "clip": false,
                      "sizing": "fixed",
                      "padding": [0, 0, 0, 0],
                      "borderRadius": 8,
                      "borderWidth": 0,
                      "borderColor": [0, 0, 0, 1]
                    }
                  }
                ],
                "variables": {},
                "spawnOnStart": true,
                "visible": true,
                "ui": {
                  "anchorMin": [0, 0],
                  "anchorMax": [1, 1],
                  "offsetMin": [0, 0],
                  "offsetMax": [0, 0],
                  "pivot": [0, 0],
                  "rotationDeg": 0,
                  "scale2d": [1, 1],
                  "opacity": 1,
                  "tint": [0, 0, 0, 0.7],
                  "zOrder": 0,
                  "interactive": true,
                  "clip": false,
                  "sizing": "fixed",
                  "padding": [0, 0, 0, 0],
                  "borderRadius": 4,
                  "borderWidth": 0,
                  "borderColor": [0, 0, 0, 1]
                }
              }
            ],
            "variables": {
              "__scriptId": {
                "type": "string",
                "value": "f0d97faad3a551c138ae65b90b1f68b5",
                "access": "public"
              }
            },
            "spawnOnStart": true,
            "visible": false,
            "ui": {
              "anchorMin": [0, 0],
              "anchorMax": [1, 1],
              "offsetMin": [0, 0],
              "offsetMax": [0, 0],
              "pivot": [0, 0],
              "rotationDeg": 0,
              "scale2d": [1, 1],
              "opacity": 1,
              "tint": [1, 1, 1, 1],
              "zOrder": 70,
              "interactive": false,
              "clip": false,
              "sizing": "fixed",
              "padding": [0, 0, 0, 0],
              "borderRadius": 0,
              "borderWidth": 0,
              "borderColor": [0, 0, 0, 1],
              "space": "screen",
              "referenceResolution": [1920, 1080],
              "scaleMode": "scaleWithScreen",
              "matchWidthOrHeight": 0.5,
              "referenceDpr": 1,
              "uiTargetId": null,
              "referenceDistance": 10,
              "minScale": 0.1,
              "maxScale": 4,
              "billboard": true,
              "clampToScreen": false,
              "hideBehindCamera": true
            },
            "script": "import { Game, Input, Logger, Node, SaveGame, UIButtonNode, UIRootNode } from 'cleo'\nimport { attribute } from 'cleo/decorators'\n\n/**\n * Hollow Keep — the title menu: Continue from the last bonfire, or start a new game. Attach to the `TitleMenu`\n * node, a screen-space UI Root authored hidden, a child of the Player like the other menus.\n *\n *   Backdrop\n *     Card\n *       Title       \"HOLLOW KEEP\"                              uiText\n *       Continue    load the game saved at the last bonfire     uiButton\n *       New Game    start again from the beginning               uiButton\n *       Hint        the controls line                            uiText\n *\n * It shows only when there is a bonfire save to go back to and this session did not begin from one: a first\n * game starts at once, and so does a game the menu already let through (the `started` global, which every\n * save carries). While it shows, the game is paused. Navigate up/down picks, Submit confirms; the mouse can\n * click either button.\n *\n * Like the pause menu it listens in a LATE UPDATE, which runs while the game is paused.\n */\nexport default class SoulsTitleMenuNode extends UIRootNode {\n  /** The slot Continue loads: the one the bonfires save to (GameManager.saveSlot). */\n  @attribute\n  public slot: string = 'auto'\n  @attribute\n  public isOpen: boolean = false\n\n  private _buttons: UIButtonNode[] = []\n  private _selected: number = 0\n  private _navLast: number = 0\n  private _stopListening: (() => void) | null = null\n\n  async onStart() {\n    this.visible = false\n    this.isOpen = false\n    const resume = this._find('Continue') as UIButtonNode\n    const fresh = this._find('New Game') as UIButtonNode\n    this._buttons = [resume, fresh].filter(b => !!b)\n    if (resume) resume.onPress = () => this._continue()\n    if (fresh) fresh.onPress = () => this._newGame()\n    this._stopListening = this.scene?.addLateUpdate(() => this._listen()) ?? null\n\n    // Loaded (Continue, Load last rest, the editor's Play from save), already let through, or nowhere to save.\n    if (!SaveGame.available || SaveGame.loadedFrom || SaveGame.has('started')) return\n    let saved = false\n    try { saved = await SaveGame.exists(this.slot) } catch { saved = false }\n    if (!saved) { SaveGame.set('started', true); return }\n    this.open()\n  }\n\n  onDespawn() {\n    this._stopListening?.()\n    this._stopListening = null\n    if (this.isOpen) this.close()\n  }\n\n  public open(): void {\n    this.isOpen = true\n    this.visible = true\n    this._selected = 0\n    this._refresh()\n    Game.pause()\n    Input.disableMap('Gameplay')\n    Input.releaseMouse()\n  }\n\n  public close(): void {\n    if (!this.isOpen) return\n    this.isOpen = false\n    this.visible = false\n    Game.resume()\n    Input.enableMap('Gameplay')\n  }\n\n  private _listen(): void {\n    if (!this.isOpen) return\n    const nav = Input.vector('Navigate')\n    const dy = Math.abs(nav[1]) > 0.5 ? Math.sign(nav[1]) : 0\n    // Navigate Y is positive UP; the buttons run top to bottom. One step per press.\n    if (dy && dy !== this._navLast && this._buttons.length) {\n      this._selected = (this._selected - dy + this._buttons.length) % this._buttons.length\n      this._refresh()\n    }\n    this._navLast = dy\n    if (Input.started('Submit')) this._buttons[this._selected]?.onPress()\n  }\n\n  /** The selected button lit, the other dim. */\n  private _refresh(): void {\n    this._buttons.forEach((b, i) => {\n      b.tint = i === this._selected ? [0.32, 0.26, 0.16, 1] : [0.18, 0.15, 0.12, 1]\n    })\n  }\n\n  private _continue(): void {\n    this.close()\n    SaveGame.load(this.slot, { loadingScreen: { title: 'Hollow Keep' } })\n      .catch(e => Logger.warn(`Hollow Keep: Continue could not load the save: ${e?.message ?? e}`, 'Script'))\n  }\n\n  private _newGame(): void {\n    // The bonfire save stays in its slot until the next bonfire saves over it.\n    SaveGame.newGame()\n    SaveGame.set('started', true)\n    this.close()\n  }\n\n  private _find(name: string, under: Node = this): Node {\n    for (const child of under.children) {\n      if (child.name === name) return child\n      const deeper = this._find(name, child)\n      if (deeper) return deeper\n    }\n    return null\n  }\n}\n",
            "scriptVars": {}
          },
          {
            "id": "99f9e591d678ea20865d6f5abd149891",
            "name": "Player Controller",
            "type": "controller",
            "position": [0, 0, 0],
            "rotation": [0, 0, 0],
            "scale": [1, 1, 1],
            "children": [],
            "variables": {},
            "spawnOnStart": true,
            "possessedId": "f569b1f64a57cd501c8bb7b31c83eba9",
            "aimSourceId": null,
            "controlSource": "player",
            "moveAction": "Move",
            "lookAction": "Look",
            "jumpAction": "",
            "sprintAction": "",
            "crouchAction": "",
            "aimSource": "possessed",
            "driveAimTarget": true
          }
        ],
        "variables": {
          "__scriptId": {
            "type": "string",
            "value": "d42708efc597b36e59bb0bf8838f131a",
            "access": "public"
          }
        },
        "scriptVars": {},
        "walkSpeed": 3.8,
        "runSpeed": 5.8,
        "turnSpeed": 720,
        "turnThreshold": 170,
        "acceleration": 24,
        "facingMode": "velocity",
        "directionSmoothing": 0.1,
        "jumpSpeed": 0,
        "coyoteSeconds": 0.1,
        "script": "import { Input, Logger, ModelNode, Node, moveWorldDirection, setMoveWorld } from 'cleo'\nimport { save, onAction, attribute, animParam, animTrigger } from 'cleo/decorators'\nimport type { AnimationTriggerInfo, ParamName, TemplateName, TriggerName } from 'cleo'\nimport { clamp, num } from '@/Core/Scripts/SoulsMath'\nimport { Swing, bladeCapsule, closeSwing, newSwing, openSwing, stepSwing, wieldedBy } from '@/Core/Scripts/SoulsHitbox'\nimport SoulsCharacterNode from '@/Core/Scripts/SoulsCharacter'\nimport { playSound } from '@/Core/Scripts/SoulsAudio'\n\n/**\n * Hollow Keep — the player. Attach to the `Player` root, which must be a Character node. Extends\n * SoulsCharacter, so its health, defence, hit handling and weapons work exactly as an enemy's do.\n *\n * Expected hierarchy (names matter where marked *):\n *\n *   Player                   Character (this script) — capsule body, friction 0\n *   ├── camera rig           CameraRigNode + SoulsLockOn — must come BEFORE the controller\n *   │   └── camera\n *   ├── <model>              the skinned model; found automatically (first Model child with an animator)\n *   ├── Weapons *            empty group; the weapons in `weaponTemplates` are spawned into it on start\n *   └── Player Controller    ControllerNode, source Player, LAST child; Jump and Sprint actions blank\n *\n * ## What the controller does, and what this does\n *\n * The controller turns Move and Look into a camera-relative intent every frame. This script runs after it\n * (a character's `onUpdate` precedes its locomotion) and PATCHES that intent: it decides the speed, the\n * facing mode and — during a roll, a lunge or a stagger — replaces the movement outright. Locomotion then\n * turns the result into velocity. Nothing here ever writes `velocity`, except the one-off zero on respawn.\n *\n * ## The action state machine\n *\n *   free ──LightAttack/HeavyAttack──▶ attack ──combo window + buffered press──▶ attack (next move)\n *     │  ──running, stick reversed─▶ runTurn (plant, turn round, run back) ──▶ free\n *     │  ──Roll (tap)──────────────▶ roll / backstep (no stick)\n *     │  ──UseItem─────────────────▶ drink\n *     │  ──SwapWeapon──────────────▶ swap\n *     │  ──Interact────────────────▶ (whatever the interactable asks for: rest, fog, gesture)\n *   any ──hit outside i-frames─────▶ hit ──▶ free\n *   any ──HP 0─────────────────────▶ dead ──respawn──▶ free\n *\n * ## Stats belong to the player\n *\n * The four attributes, and the curves that turn them into HP, stamina and a level (`hpForVigor`,\n * `staminaForEndurance`, `levelFor`, `levelCost`), are this script's own. The weapon in hand turns\n * STR/DEX into damage (SoulsWeapon.attackRating). Nothing about the player lives on the manager.\n *\n * Presses are BUFFERED for `inputBufferSeconds`, so mashing during an attack queues the next one instead\n * of being lost — the single most important thing for the controls to feel right.\n *\n * ## Animation contract\n *\n * This script plays no clip and names no animator state: every one-shot — the roll, the running turn,\n * each weapon move, the drink, the reactions — is a TRIGGER fired here by name (the `*Trigger` fields, and\n * each move's `animTrigger`). In the shipped animator each enters a state of its **Actions** layer, a\n * full-body layer over the locomotion machine; the graph owns the clip, its speed and its blends, and\n * leaves the state on its own at the clip's end. The script owns the gameplay, and asks the animator how\n * long what a trigger plays lasts and whether it still plays (`triggerInfo`, `activeTrigger`).\n * The base machine needs `Died` and `Revive`. Attack timing comes from CLIP EVENTS named `hit`, `combo`\n * and `recover` (`drink` on the drink clip, `swap` on the sheathe); a clip without them falls back to the\n * move's `hitTime`/`comboTime`/`recoverTime`. Travel is driven from here: a state that extracts its root\n * travel (the roll, the Longsword's steps) hands it over through `consumeRootMotion`.\n */\nexport default class SoulsPlayerNode extends SoulsCharacterNode {\n  @attribute\n  public displayName: string = 'Player'\n  @attribute\n  public team: string = 'player'\n  /** The weapons the player starts with, by template. F swaps between them. */\n  @attribute\n  public weaponTemplates: TemplateName[] = ['Longsword', 'Greatsword']\n\n  // ----- stats (level-up spends souls on these four) — a save keeps them, and the souls ------------\n  @save\n  @attribute('Stats')\n  public vigor: number = 10\n  @save\n  @attribute('Stats')\n  public endurance: number = 10\n  @save\n  @attribute('Stats')\n  public strength: number = 10\n  @save\n  @attribute('Stats')\n  public dexterity: number = 10\n  @save\n  @attribute('Stats')\n  public souls: number = 0\n\n  // ----- resources (runtime; the HUD reads them) --------------------------------------------------\n  public hp: number = 400\n  public maxHp: number = 400\n  @attribute('Resources')\n  public bodyRadius: number = 0.3\n  public stamina: number = 90\n  public maxStamina: number = 90\n  public estus: number = 3\n  /** Estus Shards raise it for good. */\n  @save\n  @attribute('Resources')\n  public estusMax: number = 3\n  /** HP restored per flask, spread over `estusHealSeconds`. */\n  @attribute('Resources')\n  public estusHeal: number = 250\n  @attribute('Resources')\n  public estusHealSeconds: number = 0.4\n\n  // ----- stat curves (see hpForVigor and friends) -------------------------------------------------\n  /** HP at Vigor 10. Each point to 30 adds `hpPerVigor`, then the curve flattens. */\n  @attribute('Stat curves')\n  public baseHp: number = 400\n  @attribute('Stat curves')\n  public hpPerVigor: number = 30\n  /** Stamina at Endurance 10, plus `staminaPerEndurance` per point to 40. */\n  @attribute('Stat curves')\n  public baseStamina: number = 90\n  @attribute('Stat curves')\n  public staminaPerEndurance: number = 3\n\n  // ----- movement -------------------------------------------------------------------------------\n  @attribute('Movement')\n  public jogSpeed: number = 3.8\n  /** Shown once on wading in: water slows you and stops rolls and sprints. */\n  @attribute('Movement')\n  public waterNotice: string = \"Can't roll or sprint in water\"\n  @attribute('Movement')\n  public sprintSpeed: number = 5.8\n  /** Throttle while locked on: strafing is slower than running. */\n  @attribute('Movement')\n  public lockedSpeedScale: number = 0.8\n  /** Ramp while freely moving. Actions snap (0) so a roll starts at full speed. */\n  @attribute('Movement')\n  public freeAcceleration: number = 24\n  /** Degrees per second the body turns toward a locked target while standing. */\n  @attribute('Movement')\n  public lockTurnSpeed: number = 540\n\n  // ----- stamina --------------------------------------------------------------------------------\n  @attribute('Stamina')\n  public staminaRegen: number = 45\n  @attribute('Stamina')\n  public staminaRegenDelay: number = 0.6\n  @attribute('Stamina')\n  public sprintCostPerSecond: number = 14\n  /** After sprinting to empty, sprint stays locked until stamina recovers to this. */\n  @attribute('Stamina')\n  public exhaustThreshold: number = 15\n\n  // ----- roll / backstep --------------------------------------------------------------------------\n  @attribute('Roll / backstep')\n  public rollCost: number = 20\n  @attribute('Roll / backstep')\n  public rollSeconds: number = 0.7\n  @attribute('Roll / backstep')\n  public rollInvulnStart: number = 0.06\n  @attribute('Roll / backstep')\n  public rollInvulnEnd: number = 0.42\n  @attribute('Roll / backstep')\n  public rollSpeed: number = 6.5\n  @attribute('Roll / backstep')\n  public rollFastSeconds: number = 0.45\n  @attribute('Roll / backstep')\n  public rollSlowSpeed: number = 2\n  /**\n   * Move by the roll's OWN travel (the Roll state extracts its clip's root travel) instead of the\n   * rollSpeed curve above: the body covers exactly the ground the dive does, through its own collision,\n   * for as long as the state lasts. The roll always faces the way it goes -- there is only a forward roll.\n   */\n  @attribute('Roll / backstep')\n  public rollRootMotion: boolean = true\n  // ----- running turn (see _startRunTurn) --------------------------------------------------------\n  /** Reversing at a run plays a planted 180° turn instead of spinning on the spot. Off: the plain turn. */\n  @attribute('Running turn')\n  public runTurnEnabled: boolean = true\n  /** Degrees between where the player is running and where the stick now points that count as reversing. */\n  @attribute('Running turn')\n  public runTurnAngle: number = 130\n  /** Running at least this fast (m/s); a walker just turns. */\n  @attribute('Running turn')\n  public runTurnMinSpeed: number = 3\n  /** Share of the turn spent braking to a stop before pushing off the other way. */\n  @attribute('Running turn')\n  public runTurnPlant: number = 0.45\n  /**\n   * The animator parameters the turn holds on a straight-ahead run underneath its clip (see _pinRunPose):\n   * the character's measured speed and direction, which would otherwise drop to Idle at the plant.\n   */\n  @attribute('Running turn')\n  public runTurnSpeedParam: ParamName = 'Speed'\n  @attribute('Running turn')\n  public runTurnDirectionParam: ParamName = 'Direction'\n  /** After the turn, the longest the speed parameter keeps following the body while the measured speed catches up. */\n  @attribute('Running turn')\n  public runTurnReleaseSeconds: number = 0.3\n  @attribute('Running turn')\n  public backstepCost: number = 12\n  @attribute('Running turn')\n  public backstepSeconds: number = 0.45\n  @attribute('Running turn')\n  public backstepInvulnEnd: number = 0.22\n  @attribute('Running turn')\n  public backstepSpeed: number = 4\n  @attribute('Running turn')\n  public backstepMoveSeconds: number = 0.25\n  /** Hold Roll longer than this while moving and it becomes a sprint instead of a roll. */\n  @attribute('Running turn')\n  public sprintHoldSeconds: number = 0.25\n\n  // ----- input / reactions ------------------------------------------------------------------------\n  @attribute('Input / reactions')\n  public inputBufferSeconds: number = 0.3\n  /** A hit at or above this much damage is a heavy stagger with knockback; below, a flinch. */\n  @attribute('Input / reactions')\n  public heavyHitThreshold: number = 150\n  /** Real seconds of hit-stop when a hit lands on the player (the GameManager's), light and heavy. */\n  @attribute('Input / reactions')\n  public hurtHitStop: number = 0.08\n  @attribute('Input / reactions')\n  public heavyHurtHitStop: number = 0.14\n  @attribute('Input / reactions')\n  public hitLightSeconds: number = 0.45\n  /** A swing that meets a wall (a `blocksSwings` body) before any enemy bounces off it for this long. */\n  @attribute('Input / reactions')\n  public recoilSeconds: number = 0.45\n  @attribute('Input / reactions')\n  public hitHeavySeconds: number = 0.9\n  @attribute('Input / reactions')\n  public knockbackSpeed: number = 4\n  @attribute('Input / reactions')\n  public knockbackSeconds: number = 0.15\n  /** Falling below this height is death. */\n  @attribute('Input / reactions')\n  public killY: number = -15\n\n  // ----- animator triggers: each enters a state of the Actions layer (the clips are the graph's) ------\n  @attribute('Animator triggers')\n  public rollTrigger: TriggerName = 'Roll'\n  @attribute('Animator triggers')\n  public backstepTrigger: TriggerName = 'Backstep'\n  /** The running 180° turn, turning right and turning left (Left falls back to Right when it is missing). */\n  @attribute('Animator triggers')\n  public runTurnRightTrigger: TriggerName = 'RunTurnRight'\n  @attribute('Animator triggers')\n  public runTurnLeftTrigger: TriggerName = 'RunTurnLeft'\n  @attribute('Animator triggers')\n  public drinkTrigger: TriggerName = 'Drink'\n  /** Fallback seconds into the drink clip at which the heal starts when it has no `drink` event. */\n  @attribute('Animator triggers')\n  public drinkTime: number = 0.85\n  @attribute('Animator triggers')\n  public hitLightTrigger: TriggerName = 'HitLight'\n  @attribute('Animator triggers')\n  public hitHeavyTrigger: TriggerName = 'HitHeavy'\n  /** Played when a swing bounces off a wall. */\n  @attribute('Animator triggers')\n  public recoilTrigger: TriggerName = 'Recoil'\n  /**\n   * A weapon swap: the layer sheathes the one in hand, then draws the next. The weapon changes on the\n   * sheathe clip's `swap` event (or as the draw begins, when the clip has none).\n   */\n  @attribute('Animator triggers')\n  public swapTrigger: TriggerName = 'Swap'\n  /** Sitting at a bonfire: a looping state, left on SoulsCharacter's `stopTrigger`. */\n  @attribute('Animator triggers')\n  public restTrigger: TriggerName = 'Rest'\n  @attribute('Animator triggers')\n  public fogWalkTrigger: TriggerName = 'FogWalk'\n\n  // ----- the fight -----------------------------------------------------------------------------------\n  /**\n   * Seconds the combat stance holds after the last blow given or taken (once no enemy is engaged and\n   * nothing is locked). While `inCombat`, the animator's `InCombat` swaps the idle for the Longsword's\n   * guard and keeps both hands on the hilt while moving.\n   */\n  @attribute('Fight')\n  public combatLinger: number = 5\n  /** How often the engaged enemies are looked for, seconds. */\n  @attribute('Fight')\n  public combatScanInterval: number = 0.25\n\n  // ----- derived, read by the HUD and other scripts ------------------------------------------------\n  public level: number = 1\n  /** I-frames (roll, backstep, fog, rest, death): `hurtboxActive` is its inverse. */\n  public invulnerable: boolean = false\n  public actionState: string = 'free'\n  public isSprinting: boolean = false\n  public attackRatingNow: number = 0\n  /** Locked on, an enemy engaged with us, or a blow given or taken within `combatLinger` seconds. */\n  @animParam('InCombat')\n  public inCombat: boolean = false\n  /** What pressing Interact would do right now, or '' — the HUD prompt. */\n  public interactPrompt: string = ''\n  /** The last souls gain and how long ago, for the HUD popup. */\n  public lastSoulsGain: number = 0\n  public soulsGainAge: number = 99\n  /** Where the bloodstain goes if the player falls off the world. */\n  public lastSafePosition: number[] = null\n\n  private _rig: Node = null\n  private _offEvents: (() => void) | null = null\n\n  private _stateTime: number = 0\n  private _bufferAction: string = ''\n  private _bufferAge: number = 99\n  private _rollHeld: number = -1\n  /** Seconds the current root-motion roll lasts (0: the timed roll). */\n  private _rollLength: number = 0\n  /** The running turn under way: its length, the speed it came in at, the way out, and the yaw it ends facing. */\n  private _runTurnLength: number = 0\n  private _runTurnSpeed: number = 0\n  private _runTurnOut: number[] = [0, 0, 1]\n  private _runTurnYaw: number = 0\n  private _runTurnDone: boolean = true\n  /** Seconds since a finished turn handed the speed parameter back to the body (see _settleRunPin); -1: not. */\n  private _runPinSettle: number = -1\n  private _frameDelta: number = 1 / 60\n  private _sprintedThisHold: boolean = false\n  private _sinceSpend: number = 99\n  private _sprintLocked: boolean = false\n  private _safeTimer: number = 0\n  private _sinceBlow: number = 99\n  private _combatScan: number = 0\n  private _enemyEngaged: boolean = false\n\n  // the current action\n  private _move: any = null\n  /** What the playing move's trigger plays (Animator.triggerInfo), or null. */\n  private _moveInfo: AnimationTriggerInfo | null = null\n  /** The clip of the one-shot playing, so only its own events count. */\n  private _clip: string = ''\n  private _playSpeed: number = 1\n  /** The active window has opened this attack (the swing has started connecting). */\n  private _windowOpened: boolean = false\n  private _swing: Swing = newSwing()\n  private _comboOpen: boolean = false\n  private _recovered: boolean = false\n  private _usesEvents: boolean = false\n  /** A combo move queued to continue the playing clip when the current segment ends ('' none). */\n  private _chainQueued: string = ''\n  private _motionDir: number[] = [0, 0, 1]\n  private _actionSeconds: number = 0\n  private _healLeft: number = 0\n  private _healRate: number = 0\n  private _drank: boolean = false\n  private _swapped: boolean = false\n  /** The swap's clip carries the `swap` event the weapon changes on. */\n  private _swapEvent: boolean = false\n  private _gestureSeconds: number = 0\n  private _fogSpeed: number = 0\n  private _interactTarget: Node = null\n  /** Interactables whose trigger zone the player is standing in. See onTriggerEnter. */\n  private _nearby: Node[] = []\n\n  onStart() {\n    this.hearCollider()\n    this.setVariable('isPlayer', true, 'boolean', 'public')\n    this._model = this._findModel()\n    this._rig = this.children.find(c => c.nodeType === 'cameraRig') ?? null\n    this._spawnWeapons()\n\n    this.recomputeStats()\n    this.hp = this.maxHp\n    this.stamina = this.maxStamina\n    this.estus = this.estusMax\n    const p = this.worldPosition\n    this.lastSafePosition = [p[0], p[1], p[2]]\n\n    const animator = this._model?.animator as any\n    // The character's idle/locomotion/death machine is embedded in its model node. A model swapped by\n    // deleting the node and dropping a new one in has none, and would walk around in its bind pose with\n    // nothing to say why. Linking the mannequin rig gives it the \"Souls Character\" controller.\n    const machine = animator?.getStateMachine?.()\n    if (animator && !machine?.states?.length)\n      Logger.warn('Hollow Keep: \"' + this.name + '\" has no animation controller on its model, so it will hold its bind pose. '\n        + 'Select the model node and assign \"Souls Character\" in its Animation section (or link the mannequin rig).', 'Script')\n    else if (animator && !this._hasAction(this.rollTrigger))\n      Logger.warn('Hollow Keep: \"' + this.name + '\"\\'s animator plays nothing on \"' + this.rollTrigger + '\", so it will roll, swing '\n        + 'and drink without animating. Assign \"Souls Character\" in the model\\'s Animation section.', 'Script')\n    if (animator?.onAnimationEvent) {\n      this._offEvents = animator.onAnimationEvent((name: string, clip: string) => this._onAnimEvent(name, clip))\n    }\n  }\n\n  onDespawn() {\n    this._offEvents?.()\n    this._offEvents = null\n  }\n\n  // =================================================================================================\n  // Public API (called by the manager, enemies, interactables and the menu)\n  // =================================================================================================\n\n  // ----- stat curves: pure functions of their arguments and the tuning fields above ------------------\n\n  /** Max HP for a Vigor value. Steep to 30, gentler to 40, then a trickle. */\n  public hpForVigor(vigor: number): number {\n    const v = Math.max(10, vigor)\n    return Math.round(this.baseHp + this.hpPerVigor * Math.min(v - 10, 20)\n      + 12 * clamp(v - 30, 0, 10) + 5 * Math.max(v - 40, 0))\n  }\n\n  /** Max stamina for an Endurance value. */\n  public staminaForEndurance(endurance: number): number {\n    const e = Math.max(10, endurance)\n    return Math.round(this.baseStamina + this.staminaPerEndurance * Math.min(e - 10, 30) + Math.max(e - 40, 0))\n  }\n\n  /** Souls needed to go from `level` to `level + 1`. */\n  public levelCost(level: number): number {\n    const l = Math.max(1, level) - 1\n    return Math.round(400 + 120 * l + 4 * l * l)\n  }\n\n  /** Character level from the four stats: 1 + every point spent above 10. */\n  public levelFor(vigor: number, endurance: number, strength: number, dexterity: number): number {\n    return 1 + (vigor - 10) + (endurance - 10) + (strength - 10) + (dexterity - 10)\n  }\n\n  /** Max HP / stamina / level from the four stats, and the held weapon's attack rating. */\n  public recomputeStats(): void {\n    this.maxHp = this.hpForVigor(this.vigor)\n    this.maxStamina = this.staminaForEndurance(this.endurance)\n    this.level = this.levelFor(this.vigor, this.endurance, this.strength, this.dexterity)\n    const weapon = this.currentWeapon() as any\n    this.attackRatingNow = weapon?.attackRating ? weapon.attackRating(this.strength, this.dexterity) : 0\n    this.hp = Math.min(this.hp, this.maxHp)\n    this.stamina = Math.min(this.stamina, this.maxStamina)\n  }\n\n  // ----- taking hits (SoulsCharacter.receiveHit calls these) -----------------------------------------\n\n  /** I-frames make a hit pass straight through, so a bolt keeps flying past a rolling player. */\n  protected _canBeHit(damage: number): boolean {\n    return !this.isDead && !this.invulnerable && damage > 0\n  }\n\n  protected _onHurt(dealt: number, from: Node): void {\n    playSound(this, 'Player Hurt')\n  }\n\n  /** Interrupt whatever was happening — a drink included, which is the souls tax on greedy healing. */\n  protected _onDamaged(dealt: number, poiseDamage: number, from: Node): void {\n    const heavy = dealt >= this.heavyHitThreshold\n    ;(this._gm as any)?.hitStop?.(heavy ? this.heavyHurtHitStop : this.hurtHitStop)\n    this._sinceBlow = 0\n    this._motionDir = from ? this._dirFrom(from.worldPosition) : this._forward(-1)\n    this._enter('hit')\n    this._actionSeconds = heavy ? this.hitHeavySeconds : this.hitLightSeconds\n    // From any state: the reaction cuts whatever was playing (and a queued combo swing with it).\n    this._oneShot(heavy ? this.hitHeavyTrigger : this.hitLightTrigger)\n    ;(this._gm as any)?.shake?.(heavy ? 0.35 : 0.15)\n  }\n\n  /** A flask shard: one more flask, and every flask refilled. */\n  public addEstusFlask(): void {\n    this.estusMax += 1\n    this.estus = this.estusMax\n  }\n\n  /** Refill up to `count` flasks, never past the maximum. */\n  public refillEstus(count: number): void {\n    this.estus = Math.min(this.estusMax, this.estus + Math.max(1, Math.round(count)))\n  }\n\n  public addSouls(amount: number): void {\n    if (amount <= 0) return\n    this.souls += Math.round(amount)\n    this.lastSoulsGain = Math.round(amount)\n    this.soulsGainAge = 0\n    playSound(this, 'Souls')\n  }\n\n  /** Full heal, full stamina, full flasks. Resting and respawning both do this. */\n  public restoreAll(): void {\n    this.recomputeStats()\n    this.hp = this.maxHp\n    this.stamina = this.maxStamina\n    this.estus = this.estusMax\n    this._healLeft = 0\n  }\n\n  /** Spend souls on a set of stats. The menu validates first; this re-validates. */\n  public applyLevelUp(vigor: number, endurance: number, strength: number, dexterity: number, cost: number): boolean {\n    if (cost > this.souls) return false\n    if (vigor < this.vigor || endurance < this.endurance || strength < this.strength || dexterity < this.dexterity) return false\n    this.souls -= cost\n    this.vigor = vigor\n    this.endurance = endurance\n    this.strength = strength\n    this.dexterity = dexterity\n    this.restoreAll()\n    return true\n  }\n\n  /** Back to life at a point. Called by the manager after YOU DIED. */\n  public respawnAt(at: ArrayLike<number>, yaw: number): void {\n    const wasDead = this.isDead\n    this._stopActions()\n    this.isDead = false\n    this.restoreAll()\n    // The whole body, Collider and all, standing still.\n    this.teleport(at, yaw)\n    this.lastSafePosition = [at[0], at[1], at[2]]\n    this._bufferAction = ''\n    this._enter('free')\n    this._lower('Died')\n    // Only the dead revive: raised on a living player (the pause menu's respawn), Revive would wait for the\n    // next death and stand the body straight back up.\n    if (wasDead) this._revive()\n    else this._lower('Revive')\n    const rig = this._rig as any\n    rig?.setOrbit?.(yaw, 12)\n    rig?.snapToTarget?.()\n  }\n\n  /** Called by a bonfire: sit down. The manager opens the menu; `standUp` ends it. */\n  public sitAtBonfire(): void {\n    this._enter('rest')\n    this._oneShot(this.restTrigger)\n  }\n\n  public standUp(): void {\n    if (this.actionState !== 'rest') return\n    this._stopActions()\n    this._enter('free')\n  }\n\n  /**\n   * Called by the fog gate: stand at `start` facing `yaw`, then walk `distance` metres over `seconds`\n   * with i-frames. The gate turns its own collider off for the duration.\n   */\n  public walkThroughFog(start: ArrayLike<number>, yaw: number, distance: number, seconds: number): void {\n    this.teleport(start, yaw)\n    this._motionDir = [Math.sin(yaw * Math.PI / 180), 0, Math.cos(yaw * Math.PI / 180)]\n    this._fogSpeed = distance / Math.max(0.1, seconds)\n    this._enter('fog')\n    this._actionSeconds = seconds\n    this._oneShot(this.fogWalkTrigger)\n  }\n\n  /**\n   * A short locked gesture (picking something up, pulling a lever): `gesture` is the animator trigger of\n   * its Actions state ('Pickup', 'Interact'); empty only holds still. `seconds` is how long control is held.\n   */\n  public playGesture(gesture: TriggerName, seconds: number): void {\n    if (this.isDead) return\n    this._enter('gesture')\n    this._actionSeconds = seconds\n    if (gesture) this._oneShot(gesture)\n    else this._stopActions()\n  }\n\n  /** The lock-on target's node, or null. Read off the camera rig's SoulsLockOn. */\n  public get lockTarget(): Node {\n    return (this._rig as any)?.lockTarget ?? null\n  }\n\n  // =================================================================================================\n  // The frame\n  // =================================================================================================\n\n  onUpdate(delta: number) {\n    const intent = this.drive()\n    try {\n      this._frame(intent, delta)\n    } finally {\n      this.applyWater(intent)\n      this.limitClimb(intent)\n    }\n  }\n\n  private _frame(intent: any, delta: number): void {\n    this._stateTime += delta\n    this._frameDelta = delta\n    this._bufferAge += delta\n    this._sinceSpend += delta\n    this.soulsGainAge += delta\n    this._settleRunPin(delta)\n    this._trackAction(delta)\n\n    if (this.isDead) { this._setCombat(false); this._holdStill(intent); return }\n\n    if (this.worldPosition[1] < this.killY) {\n      this.hp = 0\n      this._die()\n      this._holdStill(intent)\n      return\n    }\n\n    this._trackSafeGround(delta)\n    this._tickHeal(delta)\n    this._readInput()\n    this._findInteractable()\n\n    switch (this.actionState) {\n      case 'free': this._free(intent, delta); break\n      case 'attack': this._attack(intent, delta); break\n      case 'roll': this._roll(intent); break\n      case 'runTurn': this._runTurn(intent); break\n      case 'backstep': this._backstep(intent); break\n      case 'drink': this._drink(intent); break\n      case 'swap': this._swap(intent); break\n      case 'hit': this._hit(intent); break\n      case 'recoil': this._hit(intent); break\n      case 'rest': this._holdStill(intent); break\n      case 'gesture':\n        this._holdStill(intent)\n        if (this._stateTime >= this._actionSeconds) this._enter('free')\n        break\n      case 'fog':\n        this._driveMotion(intent, this._motionDir, this._fogSpeed)\n        if (this._stateTime >= this._actionSeconds) this._enter('free')\n        break\n      default: this._enter('free')\n    }\n\n    this.invulnerable = this._computeInvulnerable()\n    this.hurtboxActive = !this.invulnerable\n    // The hurtbox trigger follows on the same frame: a roll's i-frames are the frames it is switched off.\n    this._syncHurtbox()\n    this._tickStamina(delta)\n    this._tickCombat(delta)\n  }\n\n  /** Whether we are in a fight: what the animator's `InCombat` (the guard stance) follows. */\n  private _tickCombat(delta: number): void {\n    this._sinceBlow += delta\n    this._combatScan -= delta\n    if (this._combatScan <= 0) {\n      this._combatScan = this.combatScanInterval\n      const gm = this._gm as any\n      const enemies: any[] = gm?.liveEnemies ? gm.liveEnemies() : []\n      this._enemyEngaged = enemies.some(e => !!e?.engagedWith?.(this))\n    }\n    const resting = this.actionState === 'rest' || this.actionState === 'fog'\n    this._setCombat(!resting && (!!this.lockTarget || this._enemyEngaged || this._sinceBlow < this.combatLinger))\n  }\n\n  /** In combat or out: `inCombat` is an `@animParam`, so the animator's `InCombat` follows it. */\n  private _setCombat(on: boolean): void {\n    this.inCombat = on\n  }\n\n  /** Back on its feet: Revive, sent down to the animator. */\n  @animTrigger('Revive')\n  private _revive(): void {}\n\n  // ----- states ----------------------------------------------------------------------------------\n\n  private _free(intent: any, delta: number): void {\n    const target = this.lockTarget\n    const moving = Math.hypot(intent.move[0], intent.move[1]) > 0.15\n\n    // Sprint: Roll HELD past the threshold while moving, with stamina to burn.\n    // Not while wading: water slows you and will not let you sprint or roll (see onEnterWater).\n    const holdSprint = this._rollHeld >= this.sprintHoldSeconds && moving && !this.inWater\n    if (this.stamina <= 0) this._sprintLocked = true\n    if (this._sprintLocked && this.stamina >= this.exhaustThreshold) this._sprintLocked = false\n    this.isSprinting = holdSprint && !this._sprintLocked\n\n    this.acceleration = this.freeAcceleration\n    this.walkSpeed = this.jogSpeed\n    this.runSpeed = this.sprintSpeed\n    intent.sprint = this.isSprinting\n    if (this.isSprinting) {\n      this.stamina = Math.max(0, this.stamina - this.sprintCostPerSecond * delta)\n      this._sinceSpend = 0\n    }\n\n    // Reversing at a run: a planted turn rather than a spin on the spot. Not locked on and strafing, where\n    // pulling the stick back is a backpedal.\n    if (moving && !(target && !this.isSprinting) && this._wantsRunTurn(intent)) {\n      this._startRunTurn(intent)\n      return\n    }\n\n    if (target && !this.isSprinting) {\n      // Strafe: face the target, move relative to the camera (which is aimed at it).\n      this.facingMode = 'aim'\n      intent.speedScale = this.lockedSpeedScale\n      if (!moving) this._turnToward(target.worldPosition, this.lockTurnSpeed * delta)\n    } else {\n      this.facingMode = 'velocity'\n      intent.speedScale = 1\n    }\n\n    // Buffered actions, most recent first.\n    if (this._bufferAge > this.inputBufferSeconds) this._bufferAction = ''\n    const action = this._bufferAction\n    if (!action) return\n    if (action === 'light' || action === 'heavy') this._startAttack(action === 'light' ? 'light' : 'heavy', null)\n    else if (action === 'roll') this._startRoll(intent)\n    else if (action === 'item') this._startDrink()\n    else if (action === 'swap') this._startSwap()\n    else if (action === 'interact') this._interact()\n  }\n\n  private _attack(intent: any, delta: number): void {\n    const move = this._move\n    const t = this._stateTime * this._playSpeed   // clip seconds\n\n    // Fallback timing for clips that carry no events.\n    if (!this._usesEvents && move) {\n      const hitTime = num(move.hitTime, 0.4)\n      if (!this._windowOpened && t >= hitTime) this._openWindow()\n      if (this._swing.open && t >= hitTime + num(move.activeSeconds, 0.15)) closeSwing(this._swing)\n      if (!this._comboOpen && t >= num(move.comboTime, 0.5)) this._comboOpen = true\n      if (!this._recovered && t >= num(move.recoverTime, 0.7)) this._recovered = true\n    }\n    if (this._swing.open && this._stepSwing()) return\n\n    // Track toward the target (or the stick) only during the wind-up.\n    if (this._stateTime < num(move?.trackSeconds, 0.2)) {\n      const target = this.lockTarget\n      if (target) this._turnToward(target.worldPosition, 720 * delta)\n      else {\n        const stick = moveWorldDirection([0, 0, 0] as any, intent)\n        if (Math.hypot(stick[0], stick[2]) > 0.2) this._turnToward(\n          [this.worldPosition[0] + stick[0], 0, this.worldPosition[2] + stick[2]], 720 * delta)\n      }\n    }\n\n    if (this._moveInfo?.extractsRootMotion) {\n      // The clip's own steps (its state extracts the root travel): its hips travel this frame, along the facing.\n      const d = this._animator?.consumeRootMotion?.()\n      const fwd = this._forward(1)\n      const along = d ? d[0] * fwd[0] + d[2] * fwd[2] : 0\n      this._driveMotion(intent, along >= 0 ? fwd : this._forward(-1), this._frameDelta > 1e-5 ? Math.abs(along) / this._frameDelta : 0)\n    } else {\n      // Lunge: forward drive for a window of the clip.\n      const lungeStart = num(move?.lungeStart, 0)\n      const lunging = t >= lungeStart && t < lungeStart + num(move?.lungeSeconds, 0) * this._playSpeed\n      this._driveMotion(intent, this._forward(1), lunging ? num(move?.lungeSpeed, 0) : 0)\n    }\n\n    // Chain: inside the combo window, a buffered attack goes to the next move. Its trigger is fired now, and\n    // the animator decides when it starts: at once, or -- when that move is the next segment of this same\n    // clip -- as the clip reaches it, the animation playing straight on.\n    const buffered = this._bufferAge <= this.inputBufferSeconds ? this._bufferAction : ''\n    if (!this._chainQueued && this._comboOpen && this._windowOpened && (buffered === 'light' || buffered === 'heavy')) {\n      const next = buffered === 'light' ? (move?.next || '') : ''\n      const nextMove = next ? (this.currentWeapon() as any)?.findMove?.(next) : null\n      const nextInfo = nextMove ? this._triggerInfo(this._moveTrigger(nextMove)) : null\n      // A move entered only from certain states (a segment that follows this one) waits for its cue.\n      if (nextInfo && !nextInfo.fromAnywhere) {\n        this._consumeBuffer()\n        // The trigger waits raised for the segment's end, so the stamina for it is checked here, at the press.\n        if (this.stamina > 0) {\n          this._chainQueued = next\n          this._raise(this._moveTrigger(nextMove))\n        }\n      } else {\n        this._startAttack(buffered, next)\n        return\n      }\n    }\n    // After recovery, a roll or a drink cancels the tail (and a combo swing queued for its end).\n    if (this._recovered && (buffered === 'roll' || buffered === 'item')) {\n      this._chainQueued = ''\n      this._lowerRaised()\n      this._enter('free')\n      return\n    }\n    if (this._stateTime >= this._actionSeconds) {\n      const queued = this._chainQueued\n      this._chainQueued = ''\n      // The segment's end: the animator hands over to the queued segment on this same frame.\n      if (queued && this._startAttack('light', queued, true)) return\n      // Otherwise its exit transition blends out of it (at a segment's end, or as the clip ends).\n      this._enter('free')\n    }\n  }\n\n  /** The animator trigger that plays `move` (SoulsMove.animTrigger; its node name when that is empty). */\n  private _moveTrigger(move: any): TriggerName {\n    return (move?.animTrigger || move?.name || '') as TriggerName\n  }\n\n  private _roll(intent: any): void {\n    const t = this._stateTime\n    if (this._rollLength > 0) {\n      // The animation's own travel this frame, along the roll direction.\n      const d = this._animator?.consumeRootMotion?.()\n      const dist = d ? Math.hypot(d[0], d[2]) : 0\n      this._driveMotion(intent, this._motionDir, this._frameDelta > 1e-5 ? dist / this._frameDelta : 0)\n      if (t >= this._rollLength) this._enter('free')\n      return\n    }\n    const speed = t < this.rollFastSeconds ? this.rollSpeed : (t < this.rollSeconds * 0.85 ? this.rollSlowSpeed : 0)\n    this._driveMotion(intent, this._motionDir, speed)\n    if (t >= this.rollSeconds) this._enter('free')\n  }\n\n  /** Running fast enough, on the ground, with the stick pointed back the way the player came. */\n  private _wantsRunTurn(intent: any): boolean {\n    if (!this.runTurnEnabled || this.inWater || !this.isGrounded) return false\n    const v = this.velocity\n    const speed = Math.hypot(v[0], v[2])\n    if (speed < this.runTurnMinSpeed) return false\n    const dir = moveWorldDirection([0, 0, 0] as any, intent)\n    const len = Math.hypot(dir[0], dir[2])\n    if (len < 0.2) return false\n    const cos = (v[0] * dir[0] + v[2] * dir[2]) / (speed * len)\n    if (cos > Math.cos(this.runTurnAngle * Math.PI / 180)) return false\n    return this._hasAction(this.runTurnRightTrigger)\n  }\n\n  /**\n   * A running 180° turn: the body brakes along the way it was running, plants, and pushes off the way the\n   * stick points, while the Actions layer's turn state turns the character round. The clip turns the MESH\n   * (its hips) and the node keeps its yaw throughout; the state leaves at its clip's end with no blend, and\n   * on that same frame the node snaps round to face the new way, so the run that follows takes over from a\n   * pose that already faces that way.\n   */\n  private _startRunTurn(intent: any): void {\n    const v = this.velocity\n    const speed = Math.hypot(v[0], v[2])\n    const dir = moveWorldDirection([0, 0, 0] as any, intent)\n    const len = Math.hypot(dir[0], dir[2]) || 1\n    this._motionDir = [v[0] / speed, 0, v[2] / speed]\n    this._runTurnOut = [dir[0] / len, 0, dir[2] / len]\n    this._runTurnSpeed = speed\n    // Turn toward the side the stick went. Yaw is atan2(x, z), so turning right lowers it: the way out is to the\n    // right when this cross product is negative. Straight back turns right.\n    const cross = this._motionDir[2] * this._runTurnOut[0] - this._motionDir[0] * this._runTurnOut[2]\n    const right = cross <= 0\n    // The turn toward that side; with no left turn in the graph, the right one (a half turn either way).\n    const trigger = right || !this._hasAction(this.runTurnLeftTrigger) ? this.runTurnRightTrigger : this.runTurnLeftTrigger\n    // The clip turns the body a half turn whatever the stick's exact angle: end facing exactly round from where\n    // the run was going, and let the run's own facing turn the last few degrees toward the stick.\n    const f = this.worldForward\n    this._runTurnYaw = Math.atan2(f[0], f[2]) * 180 / Math.PI + (right ? -180 : 180)\n    this.facingMode = 'none'\n    this._enter('runTurn')\n    this._runTurnDone = false\n    // Under the clip the base machine keeps running on the measured speed, which falls to 0 at the plant:\n    // held on a run instead, so the pose the turn cuts to is already one (see _pinRunPose).\n    this._runPinSettle = -1\n    this._pinRunPose(speed)\n    const info = this._oneShot(trigger)\n    this._runTurnLength = info && info.seconds > 0 ? info.seconds : 0.5\n  }\n\n  private _runTurn(intent: any): void {\n    const t = this._stateTime, length = this._runTurnLength\n    const plant = Math.min(0.9, Math.max(0.1, this.runTurnPlant)) * length\n    // The speed the turn leaves at, up to which it pushes off the other way.\n    const out = this.isSprinting ? this.sprintSpeed : this.jogSpeed\n    if (t < plant) {\n      this._driveMotion(intent, this._motionDir, this._runTurnSpeed * (1 - t / plant))\n      this._pinRunPose(this._runTurnSpeed)\n    } else {\n      this._driveMotion(intent, this._runTurnOut, out * Math.min(1, (t - plant) / Math.max(1e-3, length - plant)))\n      this._pinRunPose(out)\n    }\n    if (this._runTurnEnded(t >= length)) { this._finishRunTurn(true); this._enter('free') }\n  }\n\n  /**\n   * Whether the turn is over. While the animator plays it, that is the frame its clip reaches the end: the\n   * state leaves on the animator's next pass -- later this same frame, after this script -- cutting to the\n   * run, so turning the node now lands on exactly that frame. The timer only answers when it never played.\n   */\n  private _runTurnEnded(timedOut: boolean): boolean {\n    if (!this._actEntered) return timedOut\n    if (!this._isPlaying(this._actTrigger)) return true\n    return this._turnClipEnded()\n  }\n\n  /** The playing turn's clip has reached its last frame. */\n  private _turnClipEnded(): boolean {\n    const length = this._actInfo?.clipLength ?? 0\n    return length > 0 && this._actTime() >= length - 1e-4\n  }\n\n  /**\n   * End the turn: face the new way if the turn got far enough to show it. Called off past halfway (a roll, a\n   * hit), the turn is cut at once as well: whatever follows must not blend from a pose drawn a half turn round.\n   */\n  private _finishRunTurn(turned: boolean): void {\n    if (this._runTurnDone) return\n    this._runTurnDone = true\n    if (turned) {\n      this.setWorldYaw(this._runTurnYaw)\n      if (this._actEntered && this._isPlaying(this._actTrigger) && !this._turnClipEnded()) this._stopActions(true)\n      // The run pose stays held while the measured speed catches up with the body's (see _settleRunPin).\n      this._runPinSettle = 0\n      this._settleRunPin(0)\n    } else this._pinRunPose(null)\n  }\n\n  /**\n   * Hold the animator's speed parameter at `speed` and its direction straight ahead, or hand both back to\n   * what they are linked to (the character's measured motion) with null. Layers share the parameter table,\n   * so the upper-body and guard layers follow too.\n   */\n  private _pinRunPose(speed: number | null): void {\n    // `animator:OverrideParam`, sent down to the animator under this character.\n    this.dispatchDown('animator:OverrideParam', this.runTurnSpeedParam, speed)\n    this.dispatchDown('animator:OverrideParam', this.runTurnDirectionParam, speed === null ? null : 0)\n  }\n\n  /**\n   * After a turn: the measured speed is smoothed, so it trails the body's for a moment and would read as a\n   * slower stride. The speed parameter follows the body's own speed until the measured one is within\n   * 0.2 m/s of it, or `runTurnReleaseSeconds` have passed, then both parameters are released.\n   */\n  private _settleRunPin(delta: number): void {\n    if (this._runPinSettle < 0) return\n    this._runPinSettle += delta\n    const v = this.velocity\n    const actual = Math.hypot(v[0], v[2])\n    if (this._runPinSettle >= this.runTurnReleaseSeconds || Math.abs(this.planarSpeed - actual) <= 0.2) {\n      this._runPinSettle = -1\n      this._pinRunPose(null)\n    } else this._pinRunPose(actual)\n  }\n\n  private _backstep(intent: any): void {\n    const t = this._stateTime\n    this._driveMotion(intent, this._motionDir, t < this.backstepMoveSeconds ? this.backstepSpeed : 0)\n    if (t >= this.backstepSeconds) this._enter('free')\n  }\n\n  private _drink(intent: any): void {\n    this._holdStill(intent)\n    const t = this._stateTime\n    if (!this._drank && !this._usesEvents && t >= this.drinkTime) this._doDrink()\n    if (t >= this._actionSeconds) this._enter('free')\n  }\n\n  private _swap(intent: any): void {\n    this._holdStill(intent)\n    // The weapon changes on the sheathe's `swap` event (_onAnimEvent); a clip without one, halfway through\n    // (where a sheathe hands over to the draw).\n    if (!this._swapped && !this._swapEvent && this._stateTime >= this._actionSeconds * 0.5) this._swapWeapon()\n    if (this._stateTime >= this._actionSeconds) {\n      this._swapWeapon()\n      this._enter('free')\n    }\n  }\n\n  /** Hold the next weapon (once per swap). */\n  private _swapWeapon(): void {\n    if (this._swapped) return\n    this._swapped = true\n    this.equipWeapon((this._weaponIndex + 1) % Math.max(1, this._weapons.length))\n    this.recomputeStats()\n  }\n\n  private _hit(intent: any): void {\n    this._driveMotion(intent, this._motionDir, this._stateTime < this.knockbackSeconds ? this.knockbackSpeed : 0)\n    if (this._stateTime >= this._actionSeconds) this._enter('free')\n  }\n\n  // ----- entering actions ------------------------------------------------------------------------\n\n  /**\n   * Start an attack. `kind` light/heavy; `named` is the next combo move, or null for the chain's start.\n   * `continuing`: the move is the next segment of the clip already playing -- its trigger was fired at the\n   * press, and the animator hands over to it as the segment ends -- so nothing is fired again. False when no\n   * attack could start (no stamina, no weapon).\n   */\n  private _startAttack(kind: string, named: string, continuing: boolean = false): boolean {\n    // A continuing segment's stamina was checked at the press (the trigger was already raised).\n    if (this.stamina <= 0 && !continuing) return false\n    const weapon = this.currentWeapon() as any\n    if (!weapon) return false\n    const name = named || (kind === 'heavy' ? weapon.heavyMove : weapon.lightMove)\n    const move = weapon.findMove?.(name) ?? weapon.findMove?.(weapon.lightMove)\n    if (!move) return false\n    this._consumeBuffer()\n    this._chainQueued = ''\n    this._spend(num(move.staminaCost, 20) * num(weapon.staminaMul, 1))\n\n    this._move = move\n    this._sinceBlow = 0\n    this._windowOpened = false\n    closeSwing(this._swing)\n    this._comboOpen = false\n    this._recovered = false\n    this._enter('attack')\n    const trigger = this._moveTrigger(move)\n    let info: AnimationTriggerInfo | null\n    if (continuing) {\n      // Its trigger was fired at the press; the animator hands over to it later this frame, and\n      // _trackAction confirms it.\n      info = this._triggerInfo(trigger)\n      this._actTrigger = trigger\n      this._actInfo = info\n      this._actEntered = false\n      this._clip = info?.clip ?? ''\n    } else {\n      // Whatever travel collected before this swing is not this swing's.\n      this._animator?.consumeRootMotion()\n      info = this._oneShot(trigger)\n    }\n    this._moveInfo = info\n    this._playSpeed = info?.speed ?? 1\n    this._usesEvents = !!info && this._clipHasEvent(info.clip, 'hit')\n    this._actionSeconds = info && info.seconds > 0 ? info.seconds : (num(move.recoverTime, 0.7) + 0.4) / this._playSpeed\n    playSound(this, kind === 'heavy' ? 'Swing Heavy' : 'Swing')\n    return true\n  }\n\n  private _startRoll(intent: any): void {\n    if (this.stamina <= 0) return\n    if (this.inWater) { this._consumeBuffer(); return }\n    this._consumeBuffer()\n    const dir = moveWorldDirection([0, 0, 0] as any, intent)\n    const len = Math.hypot(dir[0], dir[2])\n    if (len < 0.2) {\n      // No stick: a backstep, facing kept.\n      this._spend(this.backstepCost)\n      this._motionDir = this._forward(-1)\n      this._enter('backstep')\n      this._oneShot(this.backstepTrigger)\n    } else {\n      this._spend(this.rollCost)\n      this._motionDir = [dir[0] / len, 0, dir[2] / len]\n      // There is only a FORWARD roll, so the body turns to the roll's direction for its length -- even\n      // locked on and rolling backwards, toward the camera -- and lock-on turns it back to the target\n      // afterwards. 'none' from this very frame: the locked strafe's 'aim' facing set earlier in it would\n      // otherwise start pulling the body back toward the enemy before the roll's first step.\n      this.facingMode = 'none'\n      this.setWorldYaw(Math.atan2(dir[0], dir[2]) * 180 / Math.PI)\n      this._enter('roll')\n      this._rollLength = 0\n      const info = this._oneShot(this.rollTrigger)\n      if (this.rollRootMotion && info?.extractsRootMotion) {\n        // The state extracts the dive's travel for _roll to move the body by, for as long as it lasts.\n        this._animator?.consumeRootMotion()   // drop anything left from before\n        this._rollLength = info.seconds > 0 ? info.seconds : this.rollSeconds\n      }\n    }\n    playSound(this, 'Roll')\n  }\n\n  private _startDrink(): void {\n    this._consumeBuffer()\n    if (this.estus <= 0) {\n      ;(this._gm as any)?.notice?.('No Estus left')\n      return\n    }\n    this._drank = false\n    this._enter('drink')\n    const info = this._oneShot(this.drinkTrigger)\n    this._usesEvents = !!info && this._clipHasEvent(info.clip, 'drink')\n    this._actionSeconds = info && info.seconds > 0 ? info.seconds : 1.4\n  }\n\n  private _startSwap(): void {\n    this._consumeBuffer()\n    if (this._weapons.length < 2) return\n    this._swapped = false\n    this._enter('swap')\n    // The sheathe and the draw it goes on into: `seconds` covers both.\n    const info = this._oneShot(this.swapTrigger)\n    this._swapEvent = !!info && this._clipHasEvent(info.clip, 'swap')\n    this._actionSeconds = info && info.seconds > 0 ? info.seconds : 0.4\n  }\n\n  /** Fire a one-shot (see SoulsCharacter._playTrigger) and remember its clip: only its own events count. */\n  private _oneShot(trigger: TriggerName): AnimationTriggerInfo | null {\n    const info = this._playTrigger(trigger)\n    this._clip = info?.clip ?? ''\n    return info\n  }\n\n  private _interact(): void {\n    this._consumeBuffer()\n    const target = this._interactTarget as any\n    if (!target?.interact) return\n    try { target.interact(this) }\n    catch (e) { Logger.warn('Hollow Keep: interact failed on ' + (this._interactTarget?.name ?? '?') + ': ' + e, 'Script') }\n  }\n\n  protected _die(): void {\n    if (this.isDead) return\n    this.isDead = true\n    this._enter('dead')\n    // The base falls on Died, and the Actions layer leaves whatever it plays on the same trigger.\n    this._lowerRaised()\n    this._actTrigger = ''\n    this._actInfo = null\n    this._fallDead()\n    ;(this._gm as any)?.onPlayerDied?.(this)\n  }\n\n  // ----- events ----------------------------------------------------------------------------------\n\n  private _onAnimEvent(name: string, clip: string): void {\n    if (clip && this._clip && clip !== this._clip) return\n    if (this.actionState === 'attack') {\n      if (name === 'hit' && !this._windowOpened) this._openWindow()\n      else if (name === 'hitEnd') closeSwing(this._swing)\n      else if (name === 'combo') this._comboOpen = true\n      else if (name === 'recover') this._recovered = true\n    } else if (this.actionState === 'drink' && name === 'drink' && !this._drank) {\n      this._doDrink()\n    } else if (this.actionState === 'swap' && name === 'swap') {\n      this._swapWeapon()\n    }\n  }\n\n  /**\n   * The `hit` event: the blade's hitbox switches on, live until `hitEnd`. Only a weapon in this character's\n   * own hand arms (see wieldedBy): one riding someone else's socket hits nothing.\n   */\n  private _openWindow(): void {\n    this._windowOpened = true\n    const weapon = this.currentWeapon()\n    openSwing(this._swing, wieldedBy(weapon, this) ? weapon : null, 'enemy')\n  }\n\n  /**\n   * One frame of the active window: damage the hurtboxes the hitbox entered, and bounce off a wall it\n   * reached first. Returns true when the swing ended in a recoil (the state has changed).\n   */\n  private _stepSwing(): boolean {\n    const weapon = this.currentWeapon() as any\n    // Not in this character's own hand (no hand socket on its model): the blade is elsewhere, hit nothing.\n    if (!wieldedBy(weapon, this)) return false\n    const blade = bladeCapsule(weapon)\n    if (!blade) return false\n    const move = this._move as any\n    const contact = stepSwing(this.scene?.physics, this._swing, blade, this, 'enemy', move?.bounceOff !== false)\n    // The weapon turns the swing into damage; each target takes it through its own receiveHit.\n    for (const t of contact.targets) weapon?.strike?.(this, move, t.node, t.point)\n    if (contact.blockedAt && !contact.targets.length) {\n      this._recoil(contact.blockedAt)\n      return true\n    }\n    if (contact.blockedAt) closeSwing(this._swing)\n    return false\n  }\n\n  /** The blade met a wall: sparks, a jolt, and a short stagger with the swing cancelled. */\n  private _recoil(at: number[]): void {\n    closeSwing(this._swing)\n    const gm = this._gm as any\n    gm?.fx?.((this.currentWeapon() as any)?.hitSparkTemplate || 'Hit Spark', at)\n    playSound(this, 'Recoil')\n    gm?.shake?.(0.2)\n    this._motionDir = this._forward(-1)\n    this._enter('recoil')\n    this._actionSeconds = this.recoilSeconds\n    this._oneShot(this.recoilTrigger)\n  }\n\n  private _doDrink(): void {\n    this._drank = true\n    if (this.estus <= 0) return\n    this.estus--\n    this._healLeft = this.estusHeal\n    this._healRate = this.estusHeal / Math.max(0.05, this.estusHealSeconds)\n    playSound(this, 'Drink')\n  }\n\n  // ----- per-frame helpers -------------------------------------------------------------------------\n\n  // The presses that queue an action. They arrive just before this frame's onUpdate, and a dead player\n  // takes none (onUpdate would have ignored them too).\n  @onAction('LightAttack')\n  private _onLight(): void { if (!this.isDead) this._buffer('light') }\n  @onAction('HeavyAttack')\n  private _onHeavy(): void { if (!this.isDead) this._buffer('heavy') }\n  @onAction('UseItem')\n  private _onItem(): void { if (!this.isDead) this._buffer('item') }\n  @onAction('SwapWeapon')\n  private _onSwap(): void { if (!this.isDead) this._buffer('swap') }\n  @onAction('Interact')\n  private _onInteract(): void { if (!this.isDead && this._interactTarget) this._buffer('interact') }\n\n  private _readInput(): void {\n\n    // Roll is a TAP; holding it is sprint. So the roll fires on RELEASE, and only if this press never\n    // turned into a sprint. `heldSeconds` reads 0 on the release frame, hence the copy kept while held.\n    if (Input.started('Roll')) { this._rollHeld = 0; this._sprintedThisHold = false }\n    if (this._rollHeld >= 0 && Input.pressed('Roll')) this._rollHeld = Input.heldSeconds('Roll')\n    if (this.isSprinting) this._sprintedThisHold = true\n    if (Input.released('Roll') && this._rollHeld >= 0) {\n      if (!this._sprintedThisHold && !this.inWater) this._buffer('roll')\n      this._rollHeld = -1\n    }\n  }\n\n  private _buffer(action: string): void {\n    this._bufferAction = action\n    this._bufferAge = 0\n  }\n\n  private _consumeBuffer(): void {\n    this._bufferAction = ''\n    this._bufferAge = 99\n  }\n\n  private _tickStamina(delta: number): void {\n    const resting = this.actionState === 'free' || this.actionState === 'rest' || this.actionState === 'gesture'\n      || this.actionState === 'swap' || this.actionState === 'drink'\n    if (resting && !this.isSprinting && this._sinceSpend >= this.staminaRegenDelay)\n      this.stamina = Math.min(this.maxStamina, this.stamina + this.staminaRegen * delta)\n  }\n\n  private _tickHeal(delta: number): void {\n    if (this._healLeft <= 0) return\n    const step = Math.min(this._healLeft, this._healRate * delta)\n    this._healLeft -= step\n    this.hp = Math.min(this.maxHp, this.hp + step)\n  }\n\n  private _spend(amount: number): void {\n    this.stamina = Math.max(0, this.stamina - amount)\n    this._sinceSpend = 0\n  }\n\n  private _computeInvulnerable(): boolean {\n    const t = this._stateTime\n    switch (this.actionState) {\n      case 'roll': return t >= this.rollInvulnStart && t <= this.rollInvulnEnd\n      case 'backstep': return t <= this.backstepInvulnEnd\n      case 'fog': case 'rest': case 'dead': return true\n      default: return false\n    }\n  }\n\n  /**\n   * Entering an interactable's trigger zone makes it a candidate; leaving takes it off. The zones are\n   * authored as Trigger nodes: the interactable itself (a message), or one inside it (a bonfire's) — no\n   * distance is measured in script. Heard through the Collider (see hearCollider).\n   */\n  onTriggerEnter(other: Node) {\n    super.onTriggerEnter(other)   // water zones (SoulsCharacter)\n    const target = interactableOf(other)\n    if (target && !this._nearby.includes(target)) this._nearby.push(target)\n    ;(this._gm as any)?.onPlayerEnteredZone?.(other)\n  }\n\n  onTriggerExit(other: Node) {\n    super.onTriggerExit(other)\n    const target = interactableOf(other)\n    this._nearby = this._nearby.filter(n => n !== target)\n    ;(this._gm as any)?.onPlayerLeftZone?.(other)\n  }\n\n  /** Wading: no rolling and no sprinting in water — say so once, on the way in. */\n  protected onEnterWater(): void {\n    if (this._bufferAction === 'roll') this._bufferAction = ''\n    this.isSprinting = false\n    ;(this._gm as any)?.notice?.(this.waterNotice)\n  }\n\n  /** The interactables in range right now, nearest first (for tests and the HUD). */\n  public nearbyInteractables(): Node[] { return this._nearby.slice() }\n\n  private _findInteractable(): void {\n    this._interactTarget = null\n    this.interactPrompt = ''\n    if (this.actionState !== 'free' || !this._nearby.length) return\n    const me = this.worldPosition\n    let best: Node = null\n    let bestDistance = Infinity\n    for (const node of this._nearby) {\n      const n = node as any\n      if (!node || node.spawned === false || !n.interact) continue\n      if (n.canInteract && !n.canInteract(this)) continue\n      // Inside several zones at once (a lever beside a door): the nearest wins.\n      const p = node.worldPosition\n      const d = Math.hypot(p[0] - me[0], p[2] - me[2])\n      if (d < bestDistance) { best = node; bestDistance = d }\n    }\n    if (!best) return\n    this._interactTarget = best\n    const b = best as any\n    this.interactPrompt = (b.promptText ? b.promptText(this) : b.prompt) || 'Interact'\n  }\n\n  private _trackSafeGround(delta: number): void {\n    this._safeTimer += delta\n    if (this._safeTimer < 0.5) return\n    this._safeTimer = 0\n    if (this.isGrounded && this.actionState === 'free') {\n      const p = this.worldPosition\n      this.lastSafePosition = [p[0], p[1], p[2]]\n    }\n  }\n\n  /** Replace the controller's move with a world direction at a fixed speed (0 stands still). */\n  private _driveMotion(intent: any, dir: number[], speed: number): void {\n    this.acceleration = 0\n    this.facingMode = 'none'\n    intent.speedScale = 1\n    if (speed <= 0) {\n      intent.move[0] = 0\n      intent.move[1] = 0\n      intent.sprint = false\n      return\n    }\n    setMoveWorld(intent, dir[0], dir[2])\n    intent.sprint = true\n    this.runSpeed = speed\n  }\n\n  private _holdStill(intent: any): void {\n    this._driveMotion(intent, this._motionDir, 0)\n  }\n\n  private _turnToward(point: ArrayLike<number>, maxDegrees: number): void {\n    const me = this.worldPosition\n    const dx = point[0] - me[0]\n    const dz = point[2] - me[2]\n    if (Math.hypot(dx, dz) < 0.05) return\n    const want = Math.atan2(dx, dz) * 180 / Math.PI\n    const f = this.worldForward\n    const have = Math.atan2(f[0], f[2]) * 180 / Math.PI\n    let diff = (want - have) % 360\n    if (diff > 180) diff -= 360\n    else if (diff < -180) diff += 360\n    const step = Math.max(-maxDegrees, Math.min(maxDegrees, diff))\n    this.setWorldYaw(have + step)\n  }\n\n  private _forward(sign: number): number[] {\n    const f = this.worldForward\n    const len = Math.hypot(f[0], f[2]) || 1\n    return [sign * f[0] / len, 0, sign * f[2] / len]\n  }\n\n  private _dirFrom(from: ArrayLike<number>): number[] {\n    const me = this.worldPosition\n    const dx = me[0] - from[0]\n    const dz = me[2] - from[2]\n    const len = Math.hypot(dx, dz)\n    return len > 1e-4 ? [dx / len, 0, dz / len] : this._forward(-1)\n  }\n\n  private _enter(state: string): void {\n    // Leaving a running turn early (a hit, a roll): past halfway the body is drawn facing the new way already.\n    if (this.actionState === 'runTurn' && state !== 'runTurn') this._finishRunTurn(this._stateTime >= this._runTurnLength / 2)\n    if (state !== 'attack') closeSwing(this._swing)\n    this.actionState = state\n    this._stateTime = 0\n    if (state === 'free') {\n      this._move = null\n      this._moveInfo = null\n      this._clip = ''\n    }\n  }\n\n  private _findModel(): ModelNode {\n    const walk = (node: Node): ModelNode => {\n      for (const child of node.children) {\n        if (child.nodeType === 'model' && (child as any).animator) return child as ModelNode\n        if (child.nodeType === 'cameraRig' || child.nodeType === 'controller') continue\n        const found = walk(child)\n        if (found) return found\n      }\n      return null\n    }\n    return walk(this)\n  }\n\n}\n\n/** What a trigger zone belongs to: the nearest node at or above it that can be interacted with, or null. */\nfunction interactableOf(zone: Node): Node | null {\n  for (let n: Node = zone; n; n = n.parent) if (typeof (n as any).interact === 'function') return n\n  return null\n}\n",
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1]
      }
    ]
  },
  "textureIds": [
    "9483feb09d8a8b7060c57cf542762665",
    "95daea2404623cbe46eef3a4f1f96573",
    "b7822a21fc8d24e2e246aa2918442c77",
    "bdc4a42acb7790627130a4bf631dab1a",
    "9078ae2cae2bd6a78e5f3cdf8c5862e6",
    "3ba285e7e185c9fa47b494c8d4ce3b36",
    "43a40d25ade55ed3960fbc27889c8940",
    "d6a2fdab8069567256010f2a96f06a72",
    "4b80c0941c19d68a7ea1968f3098d1dd",
    "1227b61993cfe3b97568f136968a5136",
    "de486eca8338ddeceb24178d258e0903"
  ],
  "scripts": {}
}
