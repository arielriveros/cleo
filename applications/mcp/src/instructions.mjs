// @ts-check
// The server instructions every client loads up front. Claude Code truncates them at 4,096 characters, so
// this stays under that (a test asserts it): how to get a request done in few calls, the node-ref grammar
// (stated once here instead of in every schema) and the conventions an agent otherwise gets wrong. The
// long-form knowledge is in the docs resources.

export const INSTRUCTIONS = `Cleo MCP drives a RUNNING Cleo editor (a TypeScript WebGL2/WebGPU game engine). Every tool acts live on the project open in that editor, and the user watches the viewport.

Fewest calls
- Act directly: scene_tree when you need to know what exists (its header names the selection), node_get for one node's props and world bounds. No status call needed first; tools say when no editor is connected.
- scene_edit does a whole build in one call (each call = ONE undo step). A create op takes everything update does, so make whole objects at once, and add capture to see them:
  {"ops":[{"op":"create","type":"cube","as":"$c","position":[0,0.5,0],"material":{"baseColor":[0.8,0.1,0.1]},"body":{"mass":1}}],"capture":{"focus":"$c"}}
- Scripts: script_write (with attach) returns compile and type errors; then play_control {"action":"simulate","runSeconds":2,"capture":true,"stopAfter":true} runs it, returns new logs (early on the first error) and shows it.
- Big outputs cost time: use scene_tree root/depth/name filters rather than the whole scene.
- scene_save only when asked to keep the work. history undoes whole calls.

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
- Physics: a node collides only once it has a body. mass 0 = static; a moving player body usually locks rotation: angularConstraints [0,0,0]. Move a body-driven node through this.velocity, not setPosition. Triggers detect overlap without collision.
- Animation one-shots play by action NAME (animator.playAction('Attack')); scripts never play clips directly.
- Prefer existing templates and models (asset_list) over primitives when they fit.

Engine API: before writing a script, look the API up with engine_api instead of reading whole doc files: {"query":"play animation action"} finds classes, members and doc sections; {"symbol":"Animator"} lists members; {"symbol":"Animator.playAction"} gives the signature and doc; {"doc":"scripting/node-api.md#transform"} reads one docs section. Whole docs are resources under cleo://docs/, working examples under cleo://examples/scripts/.`;
