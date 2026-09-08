# Node API

Everything on the base `Node` that is not physics (see [Motion and physics](motion-and-physics.md))
or lifecycle (see [Lifecycle](lifecycle.md)). Every node type inherits all of it.

## Identity

```ts
get id: string
get name: string ; set name(v: string)
get nodeType: string
editorOnly: boolean          // never serialized; keeps a node out of the G-buffer, shadows and post
```

## Transform

Local space unless a member says `world`. **Rotations are in degrees.**

```ts
setPosition(pos: vec3): Node
setX(v: number): Node ; setY(v) ; setZ(v)
addX(v: number): Node  ; addY(v) ; addZ(v)
addForward(v: number): Node ; addRight(v) ; addUp(v)

setRotation(euler: vec3): Node          // Rz(roll) · Ry(yaw) · Rx(pitch)
rotateX(deg: number): Node ; rotateY(deg) ; rotateZ(deg)
setQuaternion(q: quat): Node

setScale(s: vec3): Node ; setUniformScale(n: number): Node
setXScale(v: number): Node ; setYScale(v) ; setZScale(v)
addXScale(v: number): Node ; addYScale(v) ; addZScale(v)
```

Every setter returns the node, so they chain:

```ts
this.setPosition([0, 1, 0]).setUniformScale(2).rotateY(45)
```

### Reading a transform

```ts
get position / rotation / quaternion / scale        // LIVE internal references
get localTransform / worldTransform : mat4
get worldPosition / worldQuaternion / worldScale / worldForward   // LIVE cached values
get forward : vec3                                  // local +Z, allocates a fresh vector
updateTransforms(parentWorldTransform?: mat4 | null): void
```

> ### The live-reference rule
>
> `position`, `rotation`, `quaternion`, `scale`, `worldPosition`, `worldQuaternion`, `worldScale`
> and `worldForward` all return **live objects that are rewritten in place**. Two consequences:
>
> ```ts
> const start = this.worldPosition            // ✗ will change under you next frame
> const start = [...this.worldPosition]       // ✓ a copy
> ```
>
> ```ts
> this.position[1] += 1                       // ✗ skips the setter's bookkeeping
> this.addY(1)                                // ✓ recomposes the matrix, updates the body
> ```
>
> Writing straight through a transform getter does not recompose the local matrix and does not push
> the change into the physics body, so the node and its collider drift apart.

### Euler versus quaternion

`setRotation` takes degrees and composes `Rz · Ry · Rx`, so the singularity is at **yaw ±90°**, not
pitch — which is the opposite of most engines and surprises people building turrets.

`setQuaternion` is gimbal-free and **deliberately does not push into the physics body**. Use
`setRotation` when a body should follow; use `setQuaternion` for visual-only orientation.

## Hierarchy

```ts
addChild(node: Node, index?: number): void
removeChild(node: Node, reparent?: boolean): void
moveChildTo(node: Node, index: number): void
get children: Node[]                    // LIVE array — treat as read-only
get parent: Node | null ; set parent
isDescendantOf(ancestor: Node): boolean
```

`addChild` detaches the node from its previous parent first, and fires `onStart` immediately if the
scene is already running.

> The `parent` **setter only moves the pointer**. To actually re-parent, call `addChild` on the new
> parent.

## Finding nodes

```ts
findNode(name: string): Node | undefined        // whole scene
getNodesByName(name: string): Node[]            // whole scene
getNodeById(id: string): Node | undefined       // whole scene
getChildByName(name: string): Node[]            // DIRECT CHILDREN ONLY
getChildById(id: string): Node | null           // DIRECT CHILDREN ONLY
get scene: Scene | null
```

These are real methods on `Node`, which is what makes them available inside a class script.

To search your own subtree, walk it:

```ts
private _find(name: string): Node | null {
  const walk = (node: Node): Node | null => {
    for (const child of node.children) {
      if (child.name === name) return child
      const found = walk(child)
      if (found) return found
    }
    return null
  }
  return walk(this)
}
```

## Visibility

```ts
get visible: boolean ; set visible(v: boolean)   // recurses to children, emits a scene change
setLodVisible(v: boolean): void                  // event-less, for LOD and culling
```

> Do not use `visible` for LOD or culling. LOD switching uses the separate `_lodVisible` channel,
> and a script that writes `visible` on a LOD child fights the LOD system every frame.

UI nodes are the only family that persists `visible` — for everything else it is runtime state.

## Bounds

```ts
getBoundingBox(): { min: vec3, max: vec3 }               // LIVE cached world AABB
getBoundingSphere(): { center: vec3, radius: number }
getBVH(): BVH | null
invalidateWorldBounds(): void
```

`getBoundingBox` returns a **cached world AABB**, refreshed when the transform changes. It is cheap
to call. It is also a live reference — copy it if you keep it.

A skinned model inflates its bounds by 1.75× and returns `null` from `getBVH()`: you cannot
raycast a skinned mesh per-triangle.

## Variables

Named values on a node, with a type and an access modifier. Unlike script fields, they can be
created at runtime and read by other scripts.

```ts
type NodeVariableType   = 'number' | 'string' | 'boolean' | 'vec3'
type NodeVariableAccess = 'public' | 'private' | 'protected'    // missing means 'public'

get variables: Map<string, NodeVariable>
getVariable(name: string): any
setVariable(name: string, value: any, type?: NodeVariableType, access?: NodeVariableAccess): void
removeVariable(name: string): void
```

```ts
onStart() {
  this.setVariable('isPlayer', true, 'boolean', 'public')
  this.setVariable('secret', 42, 'number', 'private')
}
```

### Access modifiers

| Access | Who may read and write |
|---|---|
| `public` | Anything. |
| `protected` | The owner and its descendants. |
| `private` | The owner only. |

Enforcement happens at the **script boundary**, through `getData` / `setData`:

```ts
getData(node: Node, requester?: Node): Record<string, any>   // blocked reads are omitted
setData(node: Node, name: string, ...params: any[]): void    // vec3: setData(n, 'pos', x, y, z)
canAccessVariable(target: Node, requester: Node, name: string): boolean
```

A blocked write warns and does nothing; a blocked read comes back `undefined`. Inside a script,
`getData` and `setData` are already bound to the running node, so the requester is filled in for
you.

`getVariable` / `setVariable` themselves are **not** access-checked — they are the engine-level
accessors. The access model is about what one script may do to another node's data.

## Motion blur

```ts
get motionBlur: MotionBlurMode ; set motionBlur(v)   // 'full' | 'objectOnly' | 'none'
```

The setter fans out to children. Use `'none'` on things that should not smear — a first-person
weapon model, a UI-adjacent prop.

## Serialization

```ts
serialize(): Promise<any>
static parse(parent: Node, json: any)
```

Treat `serialize()` as final; a node subclass adds its own data by overriding the protected
`_serializePayload()`. On the parse side, `finishParse` is what actually attaches the node — never
call `addChild` after it.

## See also

[Lifecycle](lifecycle.md) · [Motion and physics](motion-and-physics.md) · [Node types](../reference/node-types.md)
