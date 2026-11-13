// Duskwell's enemy brains: behaviour machines (src/core/control/behavior.ts) the enemies' AI controllers
// run, written into the bundle as AI Brain assets (libraries/aiBrains.json) the editor's AI tab opens.
// The machines decide WHAT the enemy does -- patrol, chase along the 2D navigation, attack, search,
// return home -- by goal; the enemy's script (DuskGuard, DuskBat) does the moves a goal cannot say (a
// sword swing, a swoop) and publishes the facts a machine reads (`attackReady`, `isHurt`...) as fields.

import { stableId } from '../exampleKit/bundle.mjs'

const id = (key: string) => stableId('duskwell:' + key)

type Condition = { op: 'and' | 'or', children: (Condition | Leaf)[] }
type Leaf = { param: string, op: string, value?: number }
const leaf = (param: string, op: string, value?: number): Leaf => (value === undefined ? { param, op } : { param, op, value })
const all = (...c: (Condition | Leaf)[]): Condition => ({ op: 'and', children: c })
const any = (...c: (Condition | Leaf)[]): Condition => ({ op: 'or', children: c })
const builtin = (name: string, field: string, type: 'boolean' | 'number' = 'boolean', dflt: number | boolean = false) =>
    ({ name, type, default: dflt, source: { kind: 'builtin', name: field } })
const sense = (name: string, senseName: string, type: 'boolean' | 'number', dflt: number | boolean) =>
    ({ name, type, default: dflt, source: { kind: 'sense', name: senseName } })

/**
 * The Ruin Guard: walks its route until it sees the player; chases on the walker graph, jumping between
 * platforms; swings when close and level; after losing sight, searches where it last saw the player, then
 * walks home. A hit staggers it; death ends everything.
 */
export function guardMachine() {
    const sight = all(leaf('In Sight', 'true'), leaf('Target Dead', 'false'))
    const transitions = [
        { from: '*', to: 'Dead', condition: all(leaf('Dead', 'true')) },
        ...['Patrol', 'Chase', 'Attack', 'Search', 'Return'].map(from => ({ from, to: 'Hurt', condition: all(leaf('Hurt', 'true')) })),
        { from: 'Hurt', to: 'Chase', condition: all(leaf('Hurt', 'false')), minDwell: 0.1 },
        { from: 'Patrol', to: 'Chase', condition: sight },
        { from: 'Search', to: 'Chase', condition: sight },
        { from: 'Return', to: 'Chase', condition: sight },
        // Close and level: a swing reaches. Above or below, it keeps chasing (up the planks, by jumping).
        { from: 'Chase', to: 'Attack', condition: all(leaf('Distance', 'lt', 1.6), leaf('Height', 'lt', 1), leaf('Height', 'gt', -1), leaf('Attack Ready', 'true')) },
        { from: 'Attack', to: 'Chase', condition: all(leaf('Attacking', 'false')), minDwell: 0.2 },
        { from: 'Chase', to: 'Return', condition: any(leaf('Target Dead', 'true'), leaf('From Home', 'gt', 24)) },
        { from: 'Chase', to: 'Search', condition: all(leaf('In Sight', 'false'), leaf('Since Seen', 'gt', 1)), minDwell: 0.5 },
        { from: 'Search', to: 'Return', condition: all(leaf('State Time', 'gt', 4)) },
        // Leashing latches: nothing but reaching home ends Return.
        { from: 'Return', to: 'Patrol', condition: all(leaf('From Home', 'lt', 1)) },
    ]
    const states = [
        { name: 'Patrol', goal: 'patrol', speedScale: 0.45, isEntry: true, x: 40, y: 160 },
        { name: 'Chase', goal: 'path', speedScale: 1, x: 280, y: 160 },
        { name: 'Attack', goal: 'script', speedScale: 1, x: 520, y: 60 },
        { name: 'Hurt', goal: 'script', speedScale: 0, x: 520, y: 260 },
        { name: 'Search', goal: 'investigate', speedScale: 0.7, x: 280, y: 20 },
        { name: 'Return', goal: 'path', targetKey: 'point', speedScale: 0.6, x: 280, y: 320 },
        { name: 'Dead', goal: 'idle', speedScale: 0, x: 40, y: 320 },
    ]
    return {
        parameters: [
            builtin('Dead', 'isDead'),
            builtin('Hurt', 'isHurt'),
            sense('In Sight', 'targetInSight', 'boolean', false),
            sense('Since Seen', 'timeSinceSeen', 'number', 0),
            // Planar (|dx| in 2D) and the height: a swing reaches along the floor, not up to a plank.
            sense('Distance', 'planarDistanceToTarget', 'number', 99),
            sense('Height', 'heightToTarget', 'number', 0),
            sense('State Time', 'stateTime', 'number', 0),
            builtin('Attack Ready', 'attackReady'),
            builtin('Attacking', 'isAttacking'),
            builtin('Target Dead', 'targetDead'),
            builtin('From Home', 'distanceFromHome', 'number', 0),
        ],
        states,
        transitions,
    }
}

/**
 * A bat: hangs asleep until it sees the player, wakes, flies at the player on the air grid -- round the
 * pillar, not through it -- and swoops when close; loses interest when it forgets the player and flies
 * home to roost.
 */
export function batMachine() {
    const transitions = [
        { from: '*', to: 'Dead', condition: all(leaf('Dead', 'true')) },
        ...['Chase', 'Swoop', 'Roost'].map(from => ({ from, to: 'Hurt', condition: all(leaf('Hurt', 'true')) })),
        { from: 'Hurt', to: 'Chase', condition: all(leaf('Hurt', 'false')), minDwell: 0.1 },
        { from: 'Sleep', to: 'Wake', condition: all(leaf('In Sight', 'true')) },
        { from: 'Wake', to: 'Chase', condition: all(leaf('Awake', 'true')) },
        { from: 'Chase', to: 'Swoop', condition: all(leaf('Distance', 'lt', 3), leaf('Swoop Ready', 'true')), minDwell: 0.6 },
        { from: 'Swoop', to: 'Chase', condition: all(leaf('Swooping', 'false')), minDwell: 0.2 },
        { from: 'Chase', to: 'Roost', condition: all(leaf('Has Target', 'false')), minDwell: 1 },
        { from: 'Roost', to: 'Chase', condition: all(leaf('In Sight', 'true')) },
        { from: 'Roost', to: 'Sleep', condition: all(leaf('From Home', 'lt', 0.6)) },
    ]
    const states = [
        { name: 'Sleep', goal: 'idle', speedScale: 0, isEntry: true, x: 40, y: 160 },
        { name: 'Wake', goal: 'script', speedScale: 0, x: 240, y: 160 },
        { name: 'Chase', goal: 'path', speedScale: 1, x: 440, y: 160 },
        { name: 'Swoop', goal: 'script', speedScale: 1, x: 640, y: 60 },
        { name: 'Hurt', goal: 'script', speedScale: 0, x: 640, y: 260 },
        { name: 'Roost', goal: 'path', targetKey: 'point', speedScale: 0.6, x: 440, y: 320 },
        { name: 'Dead', goal: 'idle', speedScale: 0, x: 40, y: 320 },
    ]
    return {
        parameters: [
            builtin('Dead', 'isDead'),
            builtin('Hurt', 'isHurt'),
            builtin('Awake', 'isAwake'),
            builtin('Swoop Ready', 'swoopReady'),
            builtin('Swooping', 'isSwooping'),
            builtin('From Home', 'distanceFromHome', 'number', 0),
            sense('In Sight', 'targetInSight', 'boolean', false),
            sense('Has Target', 'hasTarget', 'boolean', false),
            sense('Distance', 'distanceToTarget', 'number', 99),
        ],
        states,
        transitions,
    }
}

/** The brains as library assets: what each controller's `brainId` links and the AI editor opens. */
export const GUARD_BRAIN = {
    id: id('brain:guard'), name: 'Guard Brain', kind: 'behavior', machine: guardMachine(),
    graph: { goals: [], evaluators: [], arbitrationInterval: 0.5 }, fuzzy: { variables: [], rules: [], defuzzification: 'maxav' },
}
export const BAT_BRAIN = {
    id: id('brain:bat'), name: 'Bat Brain', kind: 'behavior', machine: batMachine(),
    graph: { goals: [], evaluators: [], arbitrationInterval: 0.5 }, fuzzy: { variables: [], rules: [], defuzzification: 'maxav' },
}
