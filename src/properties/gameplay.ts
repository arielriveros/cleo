// The character's, the controller's, the navmesh's and the sequence's declared properties (see declare.ts). The
// character's rows are documented with its tuning (docs/scripting/characters-and-controllers.md), the controller's
// and the navmesh's on the AI agents page (docs/editor/ai-agents.md).

import { ActionName, CollisionMask, Vec3 } from '../core/scripting/fieldTypes';
import { Choice, Integer } from '../core/properties/types';
import { Node } from '../core/scene/nodes/node';
import { CharacterNode } from '../core/scene/nodes/characterNode';
import { CharacterBody2DNode } from '../core/scene/nodes/characterBody2DNode';
import { ControllerNode, CONTROL_SOURCES } from '../core/scene/nodes/controllerNode';
import { FACING_MODES, MOVE_DIR_SOURCES } from '../core/control/locomotion';
import { AI_GOALS } from '../core/control/behavior';
import { isVehicle } from '../core/scene/nodes/nodeType';
import { perceptionTuning, type PerceptionTuning } from '../ai/perceptionTuning';
import { NavMeshNode } from '../core/scene/nodes/navMeshNode';
import { SequenceNode } from '../core/scene/nodes/sequenceNode';
import { navBakeSettings, type NavBakeSettings } from '../ai/navBake';
import { declareProperties, nodeIdAccess, type PropertyDeclaration } from './declare';

const whole = (v: number) => v.toFixed(0);
const tenths = (v: number) => v.toFixed(1);
/** 'velocity': Velocity. */
const capitalised = (values: readonly string[]) => values.map(v => v[0].toUpperCase() + v.slice(1));

declareProperties(CharacterNode, 'Character', [
    { title: 'Speed', props: [
        { key: 'walkSpeed', label: 'Walk', type: Number, min: 0, max: 20, step: 0.1 },
        { key: 'runSpeed', label: 'Run', type: Number, min: 0, max: 30, step: 0.1 },
        { key: 'acceleration', type: Number, min: 0, max: 100, step: 0.5, readout: tenths },
        { key: 'turnFriction', label: 'Turn Friction', type: Number, min: 0, max: 30, step: 0.5, readout: tenths },
        { key: 'airControl', label: 'Air Control', type: Number, min: 0, max: 1, step: 0.01 },
        { key: 'slopeLimit', label: 'Slope Limit', type: Number, min: 0, max: 89, step: 1, readout: whole },
    ] },
    { title: 'Facing', props: [
        { key: 'facingMode', label: 'Face', type: Choice(FACING_MODES, capitalised(FACING_MODES)) },
        { key: 'turnSpeed', label: 'Turn Speed', type: Number, min: 0, max: 1440, step: 10, readout: whole },
        { key: 'directionSmoothing', label: 'Direction Smooth', type: Number, min: 0, max: 1, step: 0.01 },
        { key: 'moveDirSource', label: 'Direction From', type: Choice(MOVE_DIR_SOURCES, capitalised(MOVE_DIR_SOURCES)) },
    ] },
    { title: 'Turn in place', props: [
        { key: 'turnThreshold', label: 'Threshold', type: Number, min: 1, max: 180, step: 1, readout: whole },
        // Release is a deadzone inside the threshold, so it stops one degree short of it.
        { key: 'turnReleaseAngle', label: 'Release', type: Number, min: 0, max: n => Math.max(1, n.turnThreshold - 1), step: 1, readout: whole },
        { key: 'turnSettleSeconds', label: 'Settle', type: Number, min: 0, max: 3, step: 0.01 },
        { key: 'turnSettleFarSeconds', label: 'Settle past 135', type: Number, min: 0, max: 3, step: 0.01 },
    ] },
    { title: 'Jump', props: [
        { key: 'jumpSpeed', label: 'Speed', type: Number, min: 0, max: 20, step: 0.1 },
        { key: 'coyoteSeconds', label: 'Coyote', type: Number, min: 0, max: 0.5, step: 0.01 },
        { key: 'jumpBufferSeconds', label: 'Buffer', type: Number, min: 0, max: 0.5, step: 0.01 },
        { key: 'jumpLockoutSeconds', label: 'Lockout', type: Number, min: 0, max: 1, step: 0.01 },
    ] },
    { title: 'Crouch', props: [
        { key: 'crouchCapsuleHeight', label: 'Height', type: Number, min: 0, max: 3, step: 0.01 },
        { key: 'crouchSpeed', label: 'Crouch speed', type: Number, min: 0, max: 1, step: 0.01, when: n => n.crouchCapsuleHeight > 0 },
    ] },
    { title: 'Advanced', props: [
        { key: 'driveWhenUnpossessed', label: 'Drive without a Controller', type: Boolean },
    ] },
], { docs: 'scripting/characters-and-controllers', section: 'character-tuning' });

// ----- Controller -----

const ai = (n: ControllerNode) => n.controlSource === 'ai';
const steers = (n: ControllerNode) => ai(n) && n.goal !== 'script';
/** The goals that name a thing to go to (or from), through the target key. */
const targeted = (n: ControllerNode) => n.goal !== 'idle' && n.goal !== 'wander' && n.goal !== 'script';
const avoiding = (n: ControllerNode) => n.steering.avoidDistance > 0;

/** A sense of the perception tuning: replaced whole through its clamp, as the engine keeps it. */
const sense = <K extends keyof PerceptionTuning>(key: K, decl: Omit<PropertyDeclaration<ControllerNode>, 'key' | 'get' | 'set'>): PropertyDeclaration<ControllerNode> => ({
    key: `perception.${String(key)}`, ...decl,
    set: (n, v) => { n.perception = perceptionTuning({ ...n.perception, [key]: Number(v) }); },
});

/** A controller possesses a Character (3D), a Character Body 2D or a Vehicle. */
const possessable = (_n: ControllerNode, candidate: unknown) =>
    candidate instanceof CharacterNode || candidate instanceof CharacterBody2DNode || isVehicle(candidate);

declareProperties(ControllerNode, 'Controller', [
    { title: 'Possession', props: [
        { key: 'possessedId', label: 'Pawn', type: Node, accepts: possessable, ...nodeIdAccess('possessedId') },
    ] },
    { title: 'Source', props: [
        { key: 'controlSource', label: 'Driven by', type: Choice(CONTROL_SOURCES, CONTROL_SOURCES.map(s => (s === 'ai' ? 'AI' : capitalised([s])[0]))) },
    ] },
    { title: 'Actions', when: n => n.controlSource === 'player', props: [
        { key: 'moveAction', label: 'Move', type: ActionName },
        { key: 'lookAction', label: 'Look', type: ActionName },
        { key: 'jumpAction', label: 'Jump', type: ActionName },
        { key: 'sprintAction', label: 'Sprint', type: ActionName },
        { key: 'crouchAction', label: 'Crouch', type: ActionName },
        { key: 'crouchToggle', label: 'Crouch toggles', type: Boolean, when: n => !!n.crouchAction },
    ] },
    { title: 'Aim', props: [
        { key: 'aimSource', label: 'Basis', type: Choice(['possessed', 'node', 'world'], ['Camera rig under the pawn', 'A specific node', 'World']) },
        { key: 'aimSourceId', label: 'Node', type: Node, when: n => n.aimSource === 'node', ...nodeIdAccess('aimSourceId') },
        { key: 'driveAimTarget', label: 'Drive the camera rig', type: Boolean, when: n => n.aimSource !== 'world' },
    ] },
    { title: 'Goal', when: ai, props: [
        { key: 'goal', label: 'Behaviour', type: Choice(AI_GOALS) },
        { key: 'targetKey', label: 'Target key', type: String, when: targeted },
        { key: 'goalPoint', label: 'Fallback point', type: Vec3, step: 0.1, when: targeted },
    ] },
    { title: 'Steering', when: steers, props: [
        { key: 'steering.maxSpeed', label: 'Max speed', type: Number, min: 0, max: 20, step: 0.1 },
        { key: 'steering.arriveRadius', label: 'Arrive radius', type: Number, min: 0, max: 10, step: 0.1, when: n => n.goal === 'arrive' || n.goal === 'follow' },
        { key: 'steering.slowRadius', label: 'Slow radius', type: Number, min: 0.1, max: 20, step: 0.1, when: n => n.goal === 'arrive' || n.goal === 'follow' },
        { key: 'steering.standoff', label: 'Standoff', type: Number, min: 0, max: 20, step: 0.1, when: n => n.goal === 'follow' },
        { key: 'steering.wanderRadius', label: 'Wander radius', type: Number, min: 0.05, max: 10, step: 0.05, when: n => n.goal === 'wander' },
        { key: 'steering.wanderDistance', label: 'Wander distance', type: Number, min: 0, max: 20, step: 0.1, when: n => n.goal === 'wander' },
        { key: 'steering.wanderJitter', label: 'Wander jitter', type: Number, min: 0, max: 720, step: 5, readout: whole, when: n => n.goal === 'wander' },
    ] },
    { title: 'Obstacle avoidance', when: steers, props: [
        { key: 'steering.avoidDistance', label: 'Look ahead', type: Number, min: 0, max: 20, step: 0.1 },
        { key: 'steering.avoidStrength', label: 'Strength', type: Number, min: 0, max: 5, step: 0.1, when: avoiding },
        { key: 'whiskerCount', label: 'Whiskers', type: Integer, min: 1, max: 9, step: 1, readout: whole, when: avoiding },
        { key: 'whiskerSpread', label: 'Spread', type: Number, min: 0, max: 180, step: 5, readout: whole, when: avoiding },
    ] },
    { title: 'Perception', when: ai, props: [
        sense('fieldOfView', { label: 'Field of view', type: Number, min: 0, max: 360, step: 5, readout: v => `${v.toFixed(0)}°` }),
        sense('range', { type: Number, min: 0, max: 100, step: 0.5, readout: tenths }),
        // 2D only: a 3D agent finds its targets by faction. Every layer reads as the mask of all of them.
        { key: 'perceptionLayers', label: 'Sees layers', type: CollisionMask, when: n => !!n.scene && n.scene.dimension === '2D',
          get: n => (n.perceptionLayers === ControllerNode.ALL_LAYERS ? -1 : n.perceptionLayers),
          set: (n, v) => { n.perceptionLayers = v === -1 ? ControllerNode.ALL_LAYERS : Number(v); } },
        { key: 'eyeHeight', label: 'Eye height', type: Number, min: 0, max: 4, step: 0.05, divider: true },
        sense('memorySpan', { label: 'Memory span', type: Number, min: 0, max: 30, step: 0.5, readout: v => `${v.toFixed(1)}s` }),
        sense('reactionTime', { label: 'Reaction time', type: Number, min: 0, max: 3, step: 0.05, readout: v => `${v.toFixed(2)}s`, divider: true }),
        { key: 'autoAcquire', label: 'Acquire targets automatically', type: Boolean },
    ] },
    { title: 'Flocking', when: ai, props: [
        { key: 'flockRadius', label: 'Neighbour radius', type: Number, min: 0, max: 40, step: 0.5, readout: tenths },
        { key: 'separationWeight', label: 'Separation', type: Number, min: 0, max: 5, step: 0.05, when: n => n.flockRadius > 0 },
        { key: 'alignmentWeight', label: 'Alignment', type: Number, min: 0, max: 5, step: 0.05, when: n => n.flockRadius > 0 },
        { key: 'cohesionWeight', label: 'Cohesion', type: Number, min: 0, max: 5, step: 0.05, when: n => n.flockRadius > 0 },
    ] },
], { docs: 'editor/ai-agents', section: 'the-controller-inspector' });

// ----- Nav Mesh -----

/** A bake setting: replaced whole through its clamp, as the engine keeps them. */
const bakeSetting = <K extends keyof NavBakeSettings>(key: K, decl: Omit<PropertyDeclaration<NavMeshNode>, 'key' | 'get' | 'set'>): PropertyDeclaration<NavMeshNode> => ({
    key: `bake.${String(key)}`, ...decl,
    set: (n, v) => { n.bake = navBakeSettings({ ...n.bake, [key]: v }); },
});

// The bake itself, the fit and the terrain sampling (not saved with the node) are the card's own rows.
declareProperties(NavMeshNode, 'Nav Mesh', [
    { title: '', props: [
        { key: 'size', type: Vec3, min: 0, step: 0.5 },
        bakeSetting('maxSlope', { label: 'Max slope', type: Number, min: 0, max: 89, step: 1, readout: v => `${v.toFixed(0)}°` }),
        bakeSetting('weldTolerance', { label: 'Weld', type: Number, min: 0.001, max: 0.5, step: 0.001, readout: v => v.toFixed(3) }),
        bakeSetting('simplifyTolerance', { label: 'Simplify', type: Number, min: 0, max: 0.5, step: 0.001, readout: v => v.toFixed(3) }),
        { key: 'agentRadius', label: 'Agent radius', type: Number, min: 0, max: 5, step: 0.05 },
        bakeSetting('carve', { label: 'Carve obstacles', type: Boolean }),
        bakeSetting('agentHeight', { label: 'Agent height', type: Number, min: 0.5, max: 5, step: 0.05, when: n => n.bake.carve }),
    ] },
], { docs: 'editor/ai-agents', section: 'navigation-meshes' });

// ----- Sequence -----

// The timeline it plays and its slots' nodes are the card's own: a slot row per slot of the sequence.
declareProperties(SequenceNode, 'Sequence', [
    { title: '', props: [{ key: 'autoplay', type: Boolean }] },
]);
