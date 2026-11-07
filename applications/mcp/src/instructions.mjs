// @ts-check
// The server instructions every client loads up front. Claude Code truncates them at 4,096 characters, so
// this stays well under that (a test asserts it): the workflow plus the conventions an agent otherwise gets
// wrong. The long-form knowledge is in the docs resources.

export const INSTRUCTIONS = `Cleo MCP drives a RUNNING Cleo editor (a TypeScript WebGL2/WebGPU game engine). Every tool acts live on the project open in that editor.

Workflow
1. editor_status first: is an editor connected, which project, scene and tab are open, play state.
2. Look before you change: scene_tree (outline), node_get (one node: transform, settable props, script fields, body, trigger), asset_list (templates, models, materials, scripts).
3. Change with scene_edit (batch many ops per call; each call is ONE undo step), script_write (class scripts, returns type errors), material_write.
4. Verify: view_capture (screenshot), play_control (run the game, returns new log lines), logs_read. Fix and repeat.
5. scene_save when the work should be kept. history undoes whole calls.

Nodes are addressed by "/Parent/Child" path from the scene root, "#<id>", or a unique bare name. A create op can set as:"$name" for later ops in the same call.

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
- Physics: a node collides only once it has a body (scene_edit update body). mass 0 = static; a moving player body usually locks rotation: angularConstraints [0,0,0]. Move a body-driven node through this.velocity, not setPosition. Triggers detect overlap without collision.
- Animation one-shots play by action NAME (animator.playAction('Attack')); scripts never play clips directly.
- Prefer existing templates and models (asset_list) over primitives when they fit.

Docs: resources under cleo://docs/ (start with scripting/getting-started.md, scripting/node-api.md, scripting/patterns.md, reference/node-types.md) and working examples under cleo://examples/scripts/. Read them before writing non-trivial scripts.`;
