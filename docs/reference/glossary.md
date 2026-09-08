# Reference — glossary

Terms used throughout the documentation and in the editor's own labels.

| Term | Meaning |
|---|---|
| **Action** | A named input verb (`Jump`, `Move`). Scripts read actions; players rebind what drives them. See [Input](../scripting/input.md). |
| **AI brain** | A `.brain` asset holding either a behaviour machine or a goal graph, plus the fuzzy model both read. See [AI brains](../editor/ai-brains.md). |
| **Animation field** | A blend space: several clips placed on a 1D or 2D plot, blended by where a probe sits. Stored as `.afield`. |
| **Asset** | Reusable content stored in the project library rather than inside a scene. 14 kinds. |
| **Bake** | To precompute something and store the result: a navmesh from colliders, a sky cubemap from a sun direction, an impostor from a mesh, a light probe from its surroundings. |
| **Behaviour machine** | A state machine whose states are AI goals and whose transitions are gated by condition trees. |
| **Blackboard** | A controller's runtime key/value store. Never serialized — authored values belong in node variables. |
| **Blend space** | See *animation field*. |
| **Cascade** | One slice of the directional-light shadow map, covering a distance band. |
| **Character** | A pawn node: turns a control intent into velocity and facing. Does not read input. |
| **Composite** | An action assembled from several bindings that each drive one slot — `W`/`A`/`S`/`D` into one vector. |
| **Condition band** | Hysteresis on a `>` / `<` condition, centred on the threshold. Not optional on anything measured. |
| **Control intent** | What a driver asks a character to do this frame: a move direction, an aim, requests like jump. |
| **Controller** | The driver node. Possesses a character and writes its intent, from player input or from a brain. |
| **Control pass** | The stage of the frame where controllers think — after perception, before any `onUpdate`. |
| **Coyote time** | A short grace after walking off a ledge during which a jump still works. Falls out of `isGrounded`'s grace period. |
| **Cutout** | Alpha-tested transparency: a pixel is drawn or discarded, never blended. Casts correct shadows. |
| **Deferred** | The rendering path that writes surface properties to a G-buffer and lights them in a second pass. |
| **Dormant** | A node that has despawned: not drawn, not updated, still findable by name or id. |
| **Editor-only node** | A helper node (grid, gizmo, wireframe) that is never serialized and is structurally absent from a build. |
| **EV100** | Exposure value at ISO 100. Higher EV means a **darker** image. |
| **Foliage** | Instanced scattered geometry on terrain: grass, rocks, trees. Density is instances per m². |
| **Forward** | The rendering path that lights each surface as it is drawn. Used for transparency, cel shading and screen materials. |
| **Fuzzy model** | Variables, membership sets and rules that turn crisp numbers into graded outputs an AI can act on. |
| **G-buffer** | The set of textures the deferred path writes surface data into. |
| **Goal graph** | A goal-driven brain: goals with desirability evaluators, arbitrated periodically, composites made of subgoals. |
| **Heightfield** | Terrain collision: a grid of heights registered directly with the physics world, with no owning node. |
| **IK** | Inverse kinematics. Here: a two-bone foot solver that plants feet on uneven ground. |
| **Impostor** | A billboard baked from a mesh, drawn at distances where the real mesh is not worth the triangles. |
| **Intent** | See *control intent*. |
| **Latching band** | See *condition band*. |
| **LOD** | Level of detail. A ladder of progressively simpler models with takeover distances. |
| **Main scene** | The scene a published game starts in. |
| **Measured motion** | Speeds and angles derived from where a body actually went, as opposed to what was commanded. |
| **Mode** | What the editor is currently for. Decides the viewport's purpose and which panels are visible. |
| **Navmesh** | A baked walkable surface used for pathfinding. Baked from **colliders and terrain**, not render meshes. |
| **Node** | One thing in a scene: a transform, children, and optionally a body, an animator or a script. |
| **Node variable** | A named value on a node, with a type and an access modifier, editable in the inspector. |
| **Off-mesh link** | An authored connection between two navmesh points that are not walkably adjacent — a jump or a ladder. |
| **Pawn** | See *character*. |
| **Perception** | An agent's senses: a vision cone with a range, a reaction delay and a memory span. |
| **Player contract** | The version number guarding whether a published player understands a packed game. |
| **POM** | Parallax occlusion mapping: faking depth by marching a height map in the fragment shader. Off by default. |
| **Possession** | The link from a controller to the character it drives. |
| **Probe** | A light probe: captured local reflections and irradiance inside a volume. |
| **Ragdoll** | Per-bone physics bodies driving a skeleton, replacing animation. |
| **Retargeting** | Playing a clip authored for one skeleton on a different one, by matching bones and correcting for bind-pose differences. |
| **Root motion** | Letting an animation clip physically move the character, instead of returning it to where it started. |
| **Screen material** | A custom material used as a fullscreen post-processing pass, ordered within a camera's chain. |
| **Sighting** | One perception record: whether a candidate is visible, whether it has been *noticed*, and how long since. |
| **Soup** | An untidy pile of triangles, in world space, with no shared structure — what a navmesh bake starts from. |
| **Splat** | The per-texel weights that blend terrain paint layers. Four layers. |
| **Spring arm** | See *camera rig*. |
| **State machine** | Animation: states play clips or fields, transitions blend between them. AI: states name goals. |
| **Steering** | The library of movement urges — seek, flee, arrive, wander, separate, align, cohere, avoid. |
| **Submesh** | One material's slice of a model's index range. |
| **TAA** | Temporal antialiasing: resolving jitter across frames. |
| **Template** | A prefab. A saved node subtree, instanced into scenes and spawned at runtime. |
| **Terrain material** | A material authored as a terrain paint layer, carrying blend settings and foliage rules. |
| **Tileset** | A sliced atlas plus per-tile metadata: solidity, animation, variant sets, auto-tile terrain sets. |
| **Trigger** | A body that detects overlap without responding to collision. |
| **Whisker** | One of the rays an agent casts ahead of itself to avoid obstacles. |

## See also

[Core concepts](../concepts.md) · [Node types](node-types.md) · [API index](api-index.md)
