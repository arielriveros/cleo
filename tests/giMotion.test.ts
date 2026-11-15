import { describe, it, expect } from 'vitest';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';
import { ColliderNode } from '../src/core/scene/nodes/colliderNode';
import { Node } from '../src/core/scene/nodes/node';
import { Scene } from '../src/core/scene/scene';
import { giMoves } from '../src/graphics/render/gi/giMotion';

// What a GI volume leaves out of its capture and its bake's geometry signature as "moving". The signature
// must be the same in Edit (the editor's scene builds no bodies) as in Play (it does), or every Play finds
// the bake stale and captures again: the Valley's Hamlet GI did, over the pond's floating crates.

const IDENT = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
const box = { type: 'box', width: 1, height: 1, depth: 1, offset: [0, 0, 0], rotation: [0, 0, 0] };
const SCRIPT = { __scriptId: { type: 'string', value: 'lever' } };

/** A Collider of `mass` holding a node that holds a "Mesh" node. */
const prop = (mass: number, variables?: object) => ({
  type: 'collider', name: 'Crate Collider', id: `c${mass}`, ...IDENT, collider: { mass, shapes: [box] },
  children: [{ type: 'node', name: 'Crate', id: `n${mass}`, ...IDENT, ...(variables ? { variables } : {}),
    children: [{ type: 'node', name: 'Mesh', id: `m${mass}`, ...IDENT, children: [] }] }],
});

/** The prop parsed into a scene that authors (the editor's) or one that runs (Play). */
function sceneWith(json: object, running: boolean): Scene {
  const scene = new Scene();
  scene.spawnRulesEnabled = running;
  parseNodeJson(scene.root, json);
  return scene;
}
const mesh = (scene: Scene) => scene.root.getChildByName('Crate Collider')[0].getChildByName('Crate')[0].getChildByName('Mesh')[0];
const collider = (scene: Scene) => scene.root.getChildByName('Crate Collider')[0] as ColliderNode;

describe('what a GI volume counts as moving', () => {
  it('a dynamic Collider carries everything under it, with a body or without', () => {
    const editing = sceneWith(prop(120), false);
    const running = sceneWith(prop(120), true);
    expect(collider(editing).ownBody).toBeNull();
    expect(collider(running).ownBody?.isDynamic).toBe(true);
    for (const scene of [editing, running])
      for (const linked of [false, true]) expect(giMoves(mesh(scene), linked)).toBe(true);
  });

  it('gives the signature the same answer in Edit and in Play', () => {
    for (const json of [prop(0), prop(120), prop(0, SCRIPT)])
      expect(giMoves(mesh(sceneWith(json, false)), true)).toBe(giMoves(mesh(sceneWith(json, true)), true));
  });

  it('leaves a static Collider and what it holds in', () => {
    for (const running of [false, true]) {
      const scene = sceneWith(prop(0), running);
      expect(collider(scene).isDynamic).toBe(false);
      expect(giMoves(mesh(scene), false)).toBe(false);
      expect(giMoves(mesh(scene), true)).toBe(false);
    }
  });

  it('counts a linked script for the signature only, and an own onUpdate always', () => {
    const scene = sceneWith(prop(0, SCRIPT), false);
    expect(giMoves(mesh(scene), true)).toBe(true);
    expect(giMoves(mesh(scene), false)).toBe(false);
    const sail = new Node('Sail');
    const hub = new Node('Hub');
    (hub as any).onUpdate = () => {};
    hub.addChild(sail);
    expect(giMoves(sail, false)).toBe(true);
    expect(giMoves(sail, true)).toBe(true);
  });

  it('leaves a body made in code at runtime out of the capture, never out of the signature', () => {
    const node = new Node('Made');
    (node as any)._body = { isDynamic: true };
    expect(giMoves(node, false)).toBe(true);
    expect(giMoves(node, true)).toBe(false);
  });
});
