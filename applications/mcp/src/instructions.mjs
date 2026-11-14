// @ts-check
// The server instructions every client loads up front. Claude Code truncates them at 4,096 characters, so
// this stays under that (a test asserts it): how to get a request done in few calls, the node-ref grammar
// (stated once here instead of in every schema) and the conventions an agent otherwise gets wrong. Worked
// examples live in the tool descriptions they belong to; the long-form knowledge is in the docs resources.

export const INSTRUCTIONS = `Cleo MCP drives a RUNNING Cleo editor (a TypeScript WebGL2/WebGPU game engine). Every tool acts live on the project open in that editor, and the user watches the viewport.

Fewest calls
- Act directly: scene_tree when you need to know what exists (header: selection, 2D/3D), node_get for props and world bounds (nodes:[...] for several). No status call first; tools say when no editor is connected.
- scene_edit does a whole build in one call: ONE undo step, all or nothing. A create op takes everything update does (material, shapes, script, props), and capture shows the result.
- Scripts: script_write (attach, or edits to patch) returns compile and type errors. Then test with play_control: {"action":"play","input":[{"at":0.2,"key":"KeyW","hold":1.5}],"watch":["/Player"],"stopAfter":true} drives the player and answers with numbers (position, speed, grounded) and logs; simulate runs physics and scripts with no player.
- workspace opens or makes scenes and asset tabs (in a template tab scene_edit edits the template). scene_save only when asked to keep the work; history undoes whole calls.

Node refs: "/Parent/Child" path from the scene root, "#<id>", a unique bare name, "$alias" (set by a create op's "as" earlier in the same call), or "@selected" (the user's selection: "make this spin" means @selected).

Engine conventions
- Metres; +Y is up; a node faces +Z. Rotations are Euler DEGREES [x, y, z]; positive x pitch tilts the view down.
- Lights are physical: directional in lux (sun about 100000), point/spot in lumens (about 1500 for a lamp). Exposure is the art control, so do not dim the sun to fix a bright image.
- A script is one TypeScript class, default-exported, extending the type of the node it sits on:
  import { Node, Logger } from 'cleo'
  export default class SpinnerNode extends Node {
    public speed = 90            // public fields = per-node inspector values
    private _t = 0               // _fields are internal
    onUpdate(delta: number, time: number) { this.rotateY(this.speed * delta) }
  }
  Handlers: onStart, onUpdate(delta, time), onCollision(other), onTriggerEnter(other), onTriggerExit(other), onSpawn, onDespawn. Import everything from 'cleo' (Input, Logger, Game, Vec...); there is no global object. Other scripts are imported by their asset path ('@/Shared/Math').
- Physics: a Collider node is the rigid body, its shapes are what collides, and everything under it moves with it (mass 0 = static). A Character goes under a Collider holding its capsule (angularConstraints [0,0,0]). Move a body through its velocity, not setPosition; face a world heading with setWorldYaw. A Trigger detects overlap; events fire on the Collider or Trigger itself. layer/mask filter what collides.
- 2D scenes (dimension 2D): units, not metres (16 art pixels each), on the XY plane, +Y up. Build with camera2D, sprite/animatedSprite (assets:{tileset}), tilemap, body2D (props size), characterBody2D, room2D, parallaxLayer; a Trigger is a props size/offset box. 3D meshes and lights are not drawn there. Tilemaps collide on layer 1. Details: engine_api {"doc":"editor/tilemap-2d.md"}.
- Animation one-shots play by action NAME (animator.playAction('Attack')); scripts never play clips directly.
- Prefer existing templates and models (asset_list) over primitives; makeTemplate turns a built object into a reusable one.
- play_control always plays in the editor; a game in its own window is only stopped or paused from here.

Engine API: before writing a script, look the API up with engine_api instead of reading whole doc files: {"query":"play animation action"} finds classes, members and doc sections; {"symbol":"Animator.playAction"} gives the signature and doc; {"doc":"scripting/node-api.md#transform"} reads one docs section. Whole docs are resources under cleo://docs/, working examples under cleo://examples/scripts/.`;
