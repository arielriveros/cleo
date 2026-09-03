import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Scene } from '../src/core/scene/scene';
import { Node } from '../src/core/scene/nodes/node';
import { CharacterNode } from '../src/core/scene/nodes/characterNode';
import { ControllerNode } from '../src/core/scene/nodes/controllerNode';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';
import { regenerateNodeIds } from '../src/core/scene/nodeJson';
import { SCRIPT_HANDLERS } from '../src/core/scripting/scriptRuntime';
import { attachScriptFactory } from '../src/core/scene/nodes/nodeScripting';
import { compileScript } from '../src/core/scripting/scriptRuntime';
import '../src/cleo';   // registers the 'cleo' module a script's `import ... from 'cleo'` resolves to

// The two node classes are deliberately thin — every decision lives in the pure `stepLocomotion`, which
// `tests/locomotion.test.ts` covers. What is left here is the plumbing, and it is the plumbing that fails
// in ways nothing reports: a possession that survives a duplicate and points at the ORIGINAL character,
// a controller that runs after its pawn and writes intent a frame late, or an animator binding broken by
// turning a field into a getter.

let warnings: string[] = [];
let restore: (() => void) | null = null;

beforeEach(async () => {
    warnings = [];
    const { Logger } = await import('../src/core/logger');
    const warn = Logger.warn;
    Logger.warn = ((message: unknown) => { warnings.push(String(message)); }) as typeof Logger.warn;
    restore = () => { Logger.warn = warn; };
});

afterEach(() => restore?.());

/** A started scene holding a controller and the character it drives. */
function possessedPair() {
    const scene = new Scene();
    const character = new CharacterNode('pawn');
    const controller = new ControllerNode('brain');
    scene.addNode(character);
    scene.addNode(controller);
    controller.possess(character);
    scene.start();
    return { scene, character, controller };
}

describe('the animator binding', () => {
    it('keeps the three outputs as OWN properties', () => {
        // `Animator._refreshVariableParams` reads a bound node property through `hasOwnProperty`, which a
        // prototype getter fails. Turning any of these into an accessor — which the house class style
        // otherwise pushes toward — silently breaks the animation of every scene that binds to it, with
        // no error anywhere. This assertion is the only thing standing between that and a shipped build.
        const character = new CharacterNode('pawn');
        for (const name of ['moveDir', 'isJumping', 'turnRequest'])
            expect(Object.prototype.hasOwnProperty.call(character, name), name).toBe(true);
    });

    it('starts them at the values an idle character should report', () => {
        const character = new CharacterNode('pawn');
        expect(character.moveDir).toBe(0);
        expect(character.isJumping).toBe(false);
        expect(character.turnRequest).toBe(0);
    });
});

describe('an unpossessed character', () => {
    it('is inert — it never touches its own velocity', () => {
        // What makes introducing this node type safe: a Character dropped into an existing scene with
        // nothing driving it behaves exactly like the plain Node it replaced.
        const scene = new Scene();
        const character = new CharacterNode('pawn');
        scene.addNode(character);
        scene.start();
        expect(() => scene.update(1 / 60, 0, false)).not.toThrow();
        expect(character.controller).toBeNull();
        expect(character.isControlled).toBe(false);
    });

    it('warns once about a missing body only when something actually drives it', () => {
        const scene = new Scene();
        const character = new CharacterNode('pawn');
        character.driveWhenUnpossessed = true;
        scene.addNode(character);
        scene.start();
        scene.update(1 / 60, 0, false);
        scene.update(1 / 60, 0, false);
        expect(warnings.filter(w => w.includes('no rigid body'))).toHaveLength(1);
    });
});

describe('possession', () => {
    it('stores the id and the handle, and back-points the pawn', () => {
        const { character, controller } = possessedPair();
        expect(controller.possessedId).toBe(character.id);
        expect(controller.possessed).toBe(character);
        expect(character.controller).toBe(controller);
        expect(character.isControlled).toBe(true);
    });

    it('releases cleanly', () => {
        const { character, controller } = possessedPair();
        controller.release();
        expect(controller.possessed).toBeNull();
        expect(controller.possessedId).toBeNull();
        expect(character.controller).toBeNull();
    });

    it('invalidates the cached handle when the id is assigned directly', () => {
        const { scene, character, controller } = possessedPair();
        const other = new CharacterNode('other');
        scene.addNode(other);
        controller.possessedId = other.id;
        expect(controller.possessed).toBe(other);
        expect(character.controller).toBeNull();
    });

    it('resolves a dangling id to null and warns once, naming it', () => {
        const { scene, controller } = possessedPair();
        controller.possessedId = 'no-such-node';
        scene.start();
        scene.update(1 / 60, 0, false);
        scene.update(1 / 60, 0, false);
        expect(controller.possessed).toBeNull();
        const complaints = warnings.filter(w => w.includes('no-such-node'));
        expect(complaints).toHaveLength(1);
    });

    it('refuses to drive a node that is not a Character', () => {
        // A stale id pointing at some other node type resolves to null rather than to something that
        // cannot be driven — a controller quietly steering a light is harder to diagnose than one doing
        // nothing at all.
        const { scene, controller } = possessedPair();
        const light = new Node('not-a-pawn');
        scene.addNode(light);
        controller.possessedId = light.id;
        expect(controller.possessed).toBeNull();
    });

    it('lets a second controller take over, warning and naming both', () => {
        // Last-possess-wins is Unreal's rule, and it is what makes "the player takes over this NPC" one
        // call rather than a handshake with the AI controller.
        const { scene, character, controller } = possessedPair();
        const player = new ControllerNode('player');
        scene.addNode(player);
        player.possess(character);

        expect(character.controller).toBe(player);
        expect(player.possessed).toBe(character);
        const stolen = warnings.filter(w => w.includes('took') && w.includes('brain'));
        expect(stolen).toHaveLength(1);
        // The loser keeps its id, so re-possessing is a single call away.
        expect(controller.possessedId).toBe(character.id);
    });

    it('drops the back-pointer when the controller despawns', () => {
        // Without this the pawn keeps pointing at a controller that no longer runs, and its
        // `driveWhenUnpossessed` gate never re-opens — the character freezes with nothing to explain it.
        const { character, controller } = possessedPair();
        controller.despawn();
        expect(character.controller).toBeNull();
    });

    it('does not clear the back-pointer of a pawn it no longer owns', () => {
        const { scene, character, controller } = possessedPair();
        const player = new ControllerNode('player');
        scene.addNode(player);
        player.possess(character);
        controller.release();
        expect(character.controller).toBe(player);
    });
});

describe('possession survives duplication', () => {
    it('lists possessedId and aimSourceId in NODE_REF_KEYS', () => {
        // Without this, duplicating a controller+character pair leaves the COPY driving the ORIGINAL
        // character — which looks correct until a second one is spawned and every NPC moves as one body.
        const source = readFileSync(join(__dirname, '..', 'src', 'core', 'scene', 'nodeJson.ts'), 'utf-8');
        const keys = source.match(/const NODE_REF_KEYS = \[([^\]]*)\]/)?.[1] ?? '';
        expect(keys).toContain("'possessedId'");
        expect(keys).toContain("'aimSourceId'");
    });

    it('repoints a duplicated pair at its own character', async () => {
        const { scene, character, controller } = possessedPair();
        const actor = new Node('actor');
        scene.addNode(actor);
        character.parent?.removeChild?.(character);
        actor.addChild(character);
        actor.addChild(controller);

        const json = await actor.serialize();
        regenerateNodeIds(json, new Map());

        const copyParent = new Node('copies');
        scene.addNode(copyParent);
        parseNodeJson(copyParent, json);

        const copiedController = [...scene.controllers].find(c => c !== controller)!;
        expect(copiedController).toBeDefined();
        expect(copiedController.possessedId).not.toBe(character.id);
        expect(copiedController.possessed).not.toBe(character);
        expect(copiedController.possessed).toBeInstanceOf(CharacterNode);
    });
});

describe('serialization', () => {
    it('round-trips every tuning field', async () => {
        const scene = new Scene();
        const character = new CharacterNode('pawn');
        Object.assign(character, {
            walkSpeed: 2.5, runSpeed: 7, jumpSpeed: 6, turnSpeed: 300, turnThreshold: 75,
            turnReleaseAngle: 5, directionSmoothing: 0.2, acceleration: 30, airControl: 0.4,
            coyoteSeconds: 0.2, jumpBufferSeconds: 0.25, jumpLockoutSeconds: 0.1,
            facingMode: 'velocity', driveWhenUnpossessed: true,
        });
        scene.addNode(character);

        const json = await character.serialize();
        const parent = new Node('parent');
        scene.addNode(parent);
        parseNodeJson(parent, json);

        const copy = parent.children[0] as CharacterNode;
        expect(copy).toBeInstanceOf(CharacterNode);
        for (const key of Object.keys(await character.serialize()))
            expect((copy as any)[key] ?? null, key).toEqual((character as any)[key] ?? null);
    });

    it('round-trips the controller, including its action names', async () => {
        const scene = new Scene();
        const controller = new ControllerNode('brain');
        controller.controlSource = 'ai';
        controller.moveAction = 'Drive';
        controller.jumpAction = '';
        controller.aimSource = 'world';
        controller.driveAimTarget = false;
        scene.addNode(controller);

        const json = await controller.serialize();
        const parent = new Node('parent');
        scene.addNode(parent);
        parseNodeJson(parent, json);

        const copy = parent.children[0] as ControllerNode;
        expect(copy).toBeInstanceOf(ControllerNode);
        expect(copy.controlSource).toBe('ai');
        expect(copy.moveAction).toBe('Drive');
        expect(copy.jumpAction).toBe('');
        expect(copy.aimSource).toBe('world');
        expect(copy.driveAimTarget).toBe(false);
    });

    it('repairs a junk or stale record rather than throwing', async () => {
        const scene = new Scene();
        const parent = new Node('parent');
        scene.addNode(parent);
        parseNodeJson(parent, {
            id: 'x', name: 'odd', type: 'character', children: [],
            walkSpeed: 'fast', facingMode: 'sideways', airControl: null,
        });
        const copy = parent.children[0] as CharacterNode;
        expect(copy.walkSpeed).toBe(1.5);
        expect(copy.facingMode).toBe('aim');
        expect(copy.airControl).toBe(1);
    });

    it('never serializes the runtime intent', async () => {
        // It is this frame's wish, not authored state. A serialized one would restore a character
        // mid-stride on load.
        const { character, controller } = possessedPair();
        character.drive().sprint = true;
        expect(Object.keys(await character.serialize())).not.toContain('intent');
        expect(Object.keys(await controller.serialize())).not.toContain('intent');
    });
});

describe('the control pass ordering', () => {
    /** A controller that records the frame on which it thought. */
    class Recorder extends ControllerNode {
        public thoughtAt: number[] = [];
        public frame = 0;
        public think(delta: number): void {
            this.thoughtAt.push(this.frame);
            super.think(delta);
        }
    }

    it('runs every controller BEFORE the node loop, whatever the authoring order', () => {
        // The guarantee that regresses silently: in `onUpdate` a controller authored after its pawn
        // writes intent one frame late, and the character trails the camera by a frame forever.
        const scene = new Scene();
        const order: string[] = [];

        class Pawn extends CharacterNode {
            public update(delta: number, time: number): void {
                order.push('pawn.update');
                super.update(delta, time);
            }
        }
        class Brain extends ControllerNode {
            public think(delta: number): void {
                order.push('brain.think');
                super.think(delta);
            }
        }

        const pawn = new Pawn('pawn');
        const brain = new Brain('brain');
        // Pawn FIRST, so a breadth-first node loop would reach it before the controller.
        scene.addNode(pawn);
        scene.addNode(brain);
        brain.possess(pawn);
        scene.start();
        scene.update(1 / 60, 0, false);

        expect(order.indexOf('brain.think')).toBeLessThan(order.indexOf('pawn.update'));
    });

    it('does not run while paused', () => {
        const scene = new Scene();
        const brain = new Recorder('brain');
        scene.addNode(brain);
        scene.start();
        scene.update(1 / 60, 0, true);
        expect(brain.thoughtAt).toHaveLength(0);
    });

    it('survives a controller whose think throws, and keeps going', () => {
        const scene = new Scene();
        class Exploding extends ControllerNode {
            public think(): void { throw new Error('brain exploded'); }
        }
        const after = new Recorder('after');
        scene.addNode(new Exploding('boom'));
        scene.addNode(after);
        scene.start();
        expect(() => scene.update(1 / 60, 0, false)).not.toThrow();
        expect(after.thoughtAt).toHaveLength(1);
    });

    it('delivers the controller\'s intent to the pawn within the same frame', () => {
        const { scene, character, controller } = possessedPair();
        controller.controlSource = 'none';
        // A script-shaped driver: patch the intent in onThink, which runs last in the control pass.
        (controller as ControllerNode).onThink = () => {
            const intent = character.drive();
            intent.move[0] = 0;
            intent.move[1] = 1;
            intent.sprint = true;
        };
        scene.update(1 / 60, 0, false);
        expect(character.intent.move).toEqual([0, 1]);
        expect(character.intent.sprint).toBe(true);
    });
});

describe('onThink', () => {
    it('is listed in SCRIPT_HANDLERS, so it gets the throw guard', () => {
        expect(SCRIPT_HANDLERS).toContain('onThink');
    });

    it('exists on every Node as a no-op', () => {
        expect(typeof new Node('n').onThink).toBe('function');
        expect(new Node('n').onThink(1 / 60)).toBeUndefined();
    });

    it('is bound by the class-script path and runs in the control pass', () => {
        const { scene, controller } = possessedPair();
        controller.controlSource = 'none';
        attachScriptFactory(controller, compileScript(`
            import { ControllerNode } from 'cleo'
            export default class Brain extends ControllerNode {
              onThink(delta) { this.name = 'thought' }
            }
        `));
        scene.update(1 / 60, 0, false);
        expect(controller.name).toBe('thought');
    });

    it('does not escape the frame when it throws', () => {
        const { scene, controller } = possessedPair();
        controller.onThink = () => { throw new Error('bad brain'); };
        expect(() => scene.update(1 / 60, 0, false)).not.toThrow();
    });
});

describe('intent publication', () => {
    it('copies rather than aliasing, so the pawn owns its own record', () => {
        // Two controllers briefly naming one pawn would otherwise share an object, and the pawn's jump
        // consumption would reach back into a controller's state.
        const { scene, character, controller } = possessedPair();
        controller.controlSource = 'none';
        scene.update(1 / 60, 0, false);
        expect(character.intent).not.toBe(controller['_intent']);
    });

    it('hands a raised request to the pawn and does not re-raise it every frame', () => {
        // The pawn owns the countdown. Copying the controller's zero over it each frame would cancel a
        // buffered jump before it could ever fire.
        const { scene, character, controller } = possessedPair();
        controller.controlSource = 'none';
        controller.onThink = () => { /* nothing */ };
        character.drive().requests.jump = 0.15;
        scene.update(1 / 60, 0, false);
        expect(character.intent.requests.jump).toBeGreaterThan(0);
    });
});
