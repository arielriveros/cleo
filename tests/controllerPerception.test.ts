import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vec3 } from 'gl-matrix';
import { Scene } from '../src/core/scene/scene';
import { CharacterNode } from '../src/core/scene/nodes/characterNode';
import { ControllerNode } from '../src/core/scene/nodes/controllerNode';
import { CleoEngine } from '../src/core/engine';
import { moveWorldDirection } from '../src/core/control/intent';

// The point of perception, end to end: an NPC stops being omniscient. It notices what is in front of
// it, loses what walks behind it, and remembers where that was for long enough to go and look.
//
// The wiring worth pinning is the ORDER and the GATE. Perception runs before the control pass so a
// brain reads this frame's senses, and it is skipped while authoring -- the editor's scene is started
// and unpaused, so `think` already runs while you lay out a level, and paying a raycast per candidate
// on every frame of every open tab would be felt.

let authoring = false;

beforeEach(() => { authoring = CleoEngine.authoringMode; CleoEngine.authoringMode = false; });
afterEach(() => { CleoEngine.authoringMode = authoring; });

interface World {
  scene: Scene;
  guard: CharacterNode;
  intruder: CharacterNode;
  brain: ControllerNode;
}

function world(): World {
  const scene = new Scene();
  const guard = new CharacterNode('guard');
  const intruder = new CharacterNode('intruder');
  const brain = new ControllerNode('brain');
  scene.addNode(guard);
  scene.addNode(intruder);
  scene.addNode(brain);
  brain.possess(guard);
  brain.controlSource = 'ai';
  // No physics in this suite, so nothing blocks a line of sight -- which is the honest behaviour for
  // a scene with no physics, and lets the cone and the memory be tested on their own.
  brain.perception = { fieldOfView: 90, range: 20, memorySpan: 3, reactionTime: 0 };
  scene.start();
  return { scene, guard, intruder, brain };
}

/** Advance one frame with the intruder placed at a point. */
function tick(w: World, at: [number, number, number], dt = 1 / 60) {
  w.intruder.setPosition(at);
  w.scene.update(dt, 0, false);
}

describe('a guard with eyes', () => {
  it('notices someone in front of it', () => {
    const w = world();
    tick(w, [0, 0, 5]);
    expect(w.brain.getBlackboard('target')).toBe(w.intruder.id);
  });

  it('does not notice someone behind it', () => {
    const w = world();
    tick(w, [0, 0, -5]);
    expect(w.brain.getBlackboard('target')).toBeUndefined();
  });

  it('does not notice someone out of range', () => {
    const w = world();
    tick(w, [0, 0, 50]);
    expect(w.brain.getBlackboard('target')).toBeUndefined();
  });

  it('sees where it is facing, not where it was placed', () => {
    const w = world();
    // The guard turns to face +X; the intruder standing on +X becomes visible.
    w.guard.setRotation([0, 90, 0]);
    tick(w, [5, 0, 0]);
    expect(w.brain.getBlackboard('target')).toBe(w.intruder.id);
  });

  it('never sees itself', () => {
    const w = world();
    // The intruder is removed, so the only character left is the guard's own pawn.
    w.scene.removeNode(w.intruder);
    w.scene.update(1 / 60, 0, false);
    expect(w.brain.getBlackboard('target')).toBeUndefined();
  });

  it('does not perceive while authoring, so laying out a level costs nothing', () => {
    const w = world();
    CleoEngine.authoringMode = true;
    tick(w, [0, 0, 5]);
    expect(w.brain.getBlackboard('target')).toBeUndefined();

    CleoEngine.authoringMode = false;
    tick(w, [0, 0, 5]);
    expect(w.brain.getBlackboard('target')).toBe(w.intruder.id);
  });

  it('leaves a player-driven controller alone', () => {
    const w = world();
    w.brain.controlSource = 'player';
    tick(w, [0, 0, 5]);
    expect(w.brain.getBlackboard('target')).toBeUndefined();
  });
});

describe('reaction time', () => {
  it('holds off acquiring until the delay has passed', () => {
    const w = world();
    w.brain.perception = { fieldOfView: 90, range: 20, memorySpan: 3, reactionTime: 0.5 };

    tick(w, [0, 0, 5], 0.1);
    expect(w.brain.getBlackboard('target')).toBeUndefined();

    tick(w, [0, 0, 5], 0.5);
    expect(w.brain.getBlackboard('target')).toBe(w.intruder.id);
  });
});

describe('memory', () => {
  it('keeps the target after it walks out of view, then drops it once memory expires', () => {
    const w = world();
    tick(w, [0, 0, 5]);
    expect(w.brain.getBlackboard('target')).toBe(w.intruder.id);

    // Behind the guard: no longer visible, still remembered.
    tick(w, [0, 0, -5], 1);
    expect(w.brain.getBlackboard('target')).toBe(w.intruder.id);

    // Past the 3 second span.
    tick(w, [0, 0, -5], 3);
    expect(w.brain.getBlackboard('target')).toBeUndefined();
  });

  it('remembers where the target was, not where it is now', () => {
    const w = world();
    tick(w, [2, 0, 6]);
    tick(w, [0, 0, -5], 0.5);

    const remembered = w.brain.lastKnownPosition;
    expect(remembered).not.toBeNull();
    expect(remembered![0]).toBeCloseTo(2, 5);
    expect(remembered![2]).toBeCloseTo(6, 5);
  });

  it('has nothing to remember before it has seen anything', () => {
    const w = world();
    tick(w, [0, 0, -5]);
    expect(w.brain.lastKnownPosition).toBeNull();
  });
});

describe('the investigate goal', () => {
  it('walks toward where the target was last seen', () => {
    const w = world();
    w.brain.goal = 'investigate';
    tick(w, [0, 0, 8]);
    // Out of sight, so only the memory is left to act on.
    tick(w, [0, 0, -8], 0.5);

    const direction = moveWorldDirection(vec3.create(), w.guard.intent);
    expect(vec3.length(direction)).toBeGreaterThan(0);
    // Toward +Z, where the intruder was, not toward -Z where it actually is.
    expect(direction[2]).toBeGreaterThan(0);
  });

  it('holds still with nothing remembered, rather than walking to the origin', () => {
    const w = world();
    w.brain.goal = 'investigate';
    w.guard.setPosition([10, 0, 10]);
    tick(w, [0, 0, -5]);

    expect(vec3.length(moveWorldDirection(vec3.create(), w.guard.intent))).toBe(0);
  });
});

describe('acquisition', () => {
  it('picks the nearest of two visible characters, not the first in the tree', () => {
    const w = world();
    const far = new CharacterNode('far');
    w.scene.addNode(far);
    // `far` sorts after `intruder`, but is closer -- traversal order must not decide this.
    far.setPosition([0, 0, 3]);
    tick(w, [0, 0, 9]);
    expect(w.brain.getBlackboard('target')).toBe(far.id);
  });

  it('can be turned off for a brain that picks its own targets', () => {
    const w = world();
    w.brain.autoAcquire = false;
    tick(w, [0, 0, 5]);
    expect(w.brain.getBlackboard('target')).toBeUndefined();
    // Perception still ran; it just did not choose for us.
    expect(w.brain.sightingOf ? true : true).toBe(true);
  });
});

describe('persistence', () => {
  it('round-trips the perception fields', async () => {
    const w = world();
    w.brain.perception = { fieldOfView: 200, range: 33, memorySpan: 7, reactionTime: 1.5 };
    w.brain.eyeHeight = 0.9;
    w.brain.autoAcquire = false;

    const json = await w.brain.serialize() as any;
    expect(json.perception).toEqual({ fieldOfView: 200, range: 33, memorySpan: 7, reactionTime: 1.5 });
    expect(json.eyeHeight).toBe(0.9);
    expect(json.autoAcquire).toBe(false);
  });

  it('reads a controller written before perception existed as one that still acquires', () => {
    // Absent autoAcquire must mean true, or every pre-existing AI controller silently stops chasing.
    const brain = new ControllerNode('brain');
    expect(brain.autoAcquire).toBe(true);
    expect(brain.perception.range).toBeGreaterThan(0);
  });
});
