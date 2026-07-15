// Insertable script examples, offered by Monaco as completion-list snippets (nodeCompletionProvider.ts
// registers them). Adapted from the demo scene's reference scripts (editor/src/features/demoScene/
// createDemoScene.ts) — condensed and de-hardcoded so they drop into any node instead of assuming that
// exact scene's hierarchy and Variable names, while keeping the same patterns.
export interface ScriptSnippet {
  /** What shows in the completion list. */
  label: string
  /** One line shown as the completion's detail. */
  detail: string
  body: string
}

export const SCRIPT_SNIPPETS: ScriptSnippet[] = [
  {
    label: 'Example: WASD movement + jump',
    detail: 'script snippet',
    body: `import { InputManager } from 'cleo';

const SPEED = 3;

this.onUpdate = (node, delta, time) => {
  const input = InputManager.instance;
  let x = 0, z = 0;
  if (input.isKeyPressed('KeyW')) z -= 1;
  if (input.isKeyPressed('KeyS')) z += 1;
  if (input.isKeyPressed('KeyA')) x -= 1;
  if (input.isKeyPressed('KeyD')) x += 1;

  const length = Math.hypot(x, z);
  if (length > 0) {
    this.addX(x / length * SPEED * delta);
    this.addZ(z / length * SPEED * delta);
  }
};

this.onStart = (node) => {
  InputManager.instance.registerKeyPress('Space', () => {
    if (this.body) this.body.impulse([0, 8, 0]);
  });
};
`,
  },
  {
    label: 'Example: mouse-orbit camera',
    detail: 'script snippet',
    body: `import { InputManager } from 'cleo';

const LOOK_SPEED = 0.15;
const MIN_PITCH = -80, MAX_PITCH = 85;

let yaw = 0;
let pitch = 20;

// Attach to a pivot node with the camera as its child, offset back along -Z.
this.onUpdate = (node, delta, time) => {
  const mouse = InputManager.instance.mouse;
  yaw -= mouse.velocity[0] * LOOK_SPEED;
  pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, pitch + mouse.velocity[1] * LOOK_SPEED));
  this.setRotation([pitch, yaw, 0]);
};
`,
  },
  {
    label: 'Example: log collisions',
    detail: 'script snippet',
    body: `import { Logger } from 'cleo';

this.onCollision = (node, other) => {
  Logger.log(this.name + ' collided with ' + other.name, 'Script');
};
`,
  },
  {
    label: 'Example: collectible trigger',
    detail: 'script snippet',
    body: `import { Logger } from 'cleo';

// Needs a public 'Score' Variable on whichever node walks through this trigger.
this.onTrigger = (node, other) => {
  if (!this.visible) return;
  other.Score += 1;
  this.visible = false;
  Logger.log(other.name + ' picked up ' + this.name + ' — score: ' + other.Score, 'Script');
};
`,
  },
  {
    label: 'Example: damage-on-touch hazard',
    detail: 'script snippet',
    body: `import { Logger } from 'cleo';

const IFRAME_SECONDS = 1;

let invulnerable = false;

// Needs a numeric 'HealthPoints' Variable on whichever node walks through this trigger.
this.onTrigger = (node, other) => {
  if (invulnerable || other.HealthPoints === undefined) return;
  other.HealthPoints -= 1;
  Logger.log(other.name + ' hit! Health: ' + other.HealthPoints, 'Script');

  // Grace period: ignore further hits from this hazard for a bit (per-node state, not a Variable).
  invulnerable = true;
  this.after(IFRAME_SECONDS, () => { invulnerable = false; });
};
`,
  },
]
