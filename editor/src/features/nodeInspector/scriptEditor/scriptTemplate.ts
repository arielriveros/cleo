// Inserted verbatim by "Add Script" in both CodeEditor.tsx (CodeMirror) and MonacoCodeEditor.tsx. It is
// live code rather than one big comment block, so a new script does something the moment it is created —
// and it doubles as the documentation for the contract. Shared so the two editors can never drift apart
// on what a first-time script author sees.
export const DEFAULT_SCRIPT_TEMPLATE = `// Import what you need from the engine. The whole public API is available:
// Logger, InputManager, Vec (gl-matrix), Geometry, Material, Body, Shape, Raycaster, Game...
import { Logger, InputManager, Game } from 'cleo';

// \`this\` IS the node: its methods (this.addZ), its properties (this.name), and the custom Variables
// you declare in the panel above (this.HealthPoints). Variables are type-checked as you type.
//
// Handlers are assigned to \`this\`, and always take their node as the first argument. They may be
// \`async\` — a rejected/thrown async handler is caught and logged, same as a synchronous one:
//   this.onStart / onSpawn / onDespawn = (node) => {}
//   this.onUpdate = (node, delta, time) => {}
//   this.onCollision / onTrigger = (node, other) => {}

// Top-level state is per-node: this body runs once for each node the script is attached to.
let jumpsUsed = 0;

this.onStart = (node) => {
  // Logger writes to the editor Console panel — a plain console.log only reaches the browser devtools.
  Logger.log('Started: ' + this.name, 'Script');

  InputManager.instance.registerKeyPress('Space', () => {
    if (this.body) { this.body.impulse([0, 8, 0]); jumpsUsed++; }
  });

  // this.wait/this.after/this.every schedule against game time (they pause with Game.pause(), and a
  // pending one is cancelled automatically if this node despawns first):
  //   this.after(2, () => Logger.log('2 unpaused seconds later', 'Script'));
  //   const stop = this.every(1, () => { ... });  // call stop() to cancel a repeat early
  //   await this.wait(0.5);                       // inside an async handler
};

this.onUpdate = (node, delta, time) => {
  if (InputManager.instance.isKeyPressed('KeyW')) this.addZ(2 * delta);

  // Declare a Variable in the panel above, then read and write it straight off \`this\`:
  // if (this.HealthPoints <= 0) this.remove();

  // Logger.log(this.position, 'Script', { flush: true }) rewrites its own row, for per-frame values.
};

this.onCollision = (node, other) => {
  // Other nodes are the same deal — their Variables are properties too, subject to access level:
  // other.HealthPoints -= 1;
  Logger.log(this.name + ' hit ' + other.name, 'Script');
};

// Reaching other nodes: this.parent, this.children, this.findNode('Player')
// Session control from any script: Game.pause()/resume(), Game.loadScene('Menu'), Game.gravity, ...
`
