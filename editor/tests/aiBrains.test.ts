import { describe, it, expect } from 'vitest'
import { ControllerNode, Node, Scene } from 'cleo'
import {
  brainIdsInScene, buildAiBrainAsset, detachBrain, isEmptyBrain, reembedBrains, toRuntimeBrain,
} from '../src/utils/aiBrains'

/**
 * The AI Brain asset: a named, reusable behaviour machine or goal graph, linked from a Controller.
 *
 * The persistence shape is the tileset's, not the material's — the controller keeps a full EMBEDDED
 * copy of what it runs and `brainId` only records where that came from. Two consequences carry most of
 * the risk, and both are pinned below:
 *
 *  - an edited asset has to be pushed back out to controllers already holding a stale copy, and
 *  - deleting an asset must NOT lobotomise the agents that used it.
 */

function controllerScene(...controllers: ControllerNode[]): Scene {
  const scene = new Scene()
  for (const c of controllers) scene.addNode(c)
  return scene
}

function machineAsset(name = 'guard') {
  const asset = buildAiBrainAsset(name, 'behavior')
  asset.machine = {
    parameters: [],
    states: [{ name: 'patrol', goal: 'patrol', isEntry: true }, { name: 'chase', goal: 'seek' }],
    transitions: [],
  }
  return asset
}

describe('buildAiBrainAsset', () => {
  it('allocates BOTH halves even though only one is live', () => {
    // So every reader can take `asset.machine` without a guard, and switching kind loses nothing.
    const asset = buildAiBrainAsset('b', 'behavior')
    expect(asset.machine).toBeTruthy()
    expect(asset.graph).toBeTruthy()
    expect(asset.fuzzy).toBeTruthy()
  })

  it('starts empty, so a freshly added brain mints nothing on migration', () => {
    expect(isEmptyBrain(buildAiBrainAsset('b', 'behavior'))).toBe(true)
    expect(isEmptyBrain(machineAsset())).toBe(false)
  })
})

describe('toRuntimeBrain', () => {
  it('selects the half matching the kind and leaves the other empty', () => {
    const asset = machineAsset()
    asset.graph = { goals: [{ name: 'ignored', goal: 'idle' }], evaluators: [], arbitrationInterval: 0.5 }

    const runtime = toRuntimeBrain(asset)
    expect(runtime.brain).toBe('machine')
    expect(runtime.behavior.states.map(s => s.name)).toEqual(['patrol', 'chase'])
    // The goal graph is NOT carried across on a behaviour brain: `brain: 'machine'` means the runtime
    // never reads it, and copying it would leave a controller claiming goals it does not run.
    expect(runtime.goals.goals).toEqual([])
  })

  it('reports a goal brain as the runtime kind the control pass switches on', () => {
    const asset = buildAiBrainAsset('boss', 'goals')
    asset.graph = { goals: [{ name: 'fight', goal: 'seek' }], evaluators: [], arbitrationInterval: 0.5 }
    const runtime = toRuntimeBrain(asset)
    expect(runtime.brain).toBe('goal')
    expect(runtime.goals.goals.map(g => g.name)).toEqual(['fight'])
  })

  it('reads through the tolerant parsers, so a malformed asset cannot wedge a controller', () => {
    // A subgoal naming a goal that does not exist is exactly what parseGoalGraph drops. Assigning raw
    // would leave the runtime stepping a plan with a dangling child.
    const asset = buildAiBrainAsset('bad', 'goals')
    asset.graph = {
      goals: [{ name: 'attack', goal: 'seek', subgoals: ['ghost'] }],
      evaluators: [], arbitrationInterval: 0.5,
    }
    expect(toRuntimeBrain(asset).goals.goals[0].subgoals).toBeUndefined()
  })
})

describe('reembedBrains', () => {
  it('pushes an edited asset into a controller holding an older copy', () => {
    const controller = new ControllerNode('zombie')
    const asset = machineAsset()
    controller.brainId = asset.id
    expect(controller.behavior.states).toHaveLength(0)

    expect(reembedBrains(controllerScene(controller), [asset])).toBe(true)
    expect(controller.behavior.states.map(s => s.name)).toEqual(['patrol', 'chase'])
    expect(controller.brain).toBe('machine')
  })

  it('reports no change when the copy already matches, so a save is not forced every pass', () => {
    const controller = new ControllerNode('zombie')
    const asset = machineAsset()
    controller.brainId = asset.id
    const scene = controllerScene(controller)

    expect(reembedBrains(scene, [asset])).toBe(true)
    expect(reembedBrains(scene, [asset])).toBe(false)
  })

  it('leaves an UNLINKED controller alone', () => {
    // A controller with a brain authored inline must not be overwritten by an unrelated asset.
    const controller = new ControllerNode('scripted')
    controller.behavior = { parameters: [], states: [{ name: 'only', goal: 'idle' }], transitions: [] }

    expect(reembedBrains(controllerScene(controller), [machineAsset()])).toBe(false)
    expect(controller.behavior.states.map(s => s.name)).toEqual(['only'])
  })

  it('leaves a controller whose asset is missing from the library alone', () => {
    const controller = new ControllerNode('orphan')
    controller.brainId = 'gone'
    controller.behavior = { parameters: [], states: [{ name: 'kept', goal: 'idle' }], transitions: [] }

    expect(reembedBrains(controllerScene(controller), [machineAsset()])).toBe(false)
    expect(controller.behavior.states.map(s => s.name)).toEqual(['kept'])
  })

  it('reaches every controller sharing one brain', () => {
    const a = new ControllerNode('a')
    const b = new ControllerNode('b')
    const asset = machineAsset()
    a.brainId = asset.id
    b.brainId = asset.id

    reembedBrains(controllerScene(a, b), [asset])
    expect(a.behavior.states).toHaveLength(2)
    expect(b.behavior.states).toHaveLength(2)
  })
})

describe('detachBrain', () => {
  it('drops the LINK but keeps the brain, so deleting an asset does not lobotomise agents', () => {
    const controller = new ControllerNode('zombie')
    const asset = machineAsset()
    controller.brainId = asset.id
    const scene = controllerScene(controller)
    reembedBrains(scene, [asset])

    expect(detachBrain(scene, asset.id)).toBe(true)
    expect(controller.brainId).toBeNull()
    // Still thinking exactly as it was.
    expect(controller.behavior.states.map(s => s.name)).toEqual(['patrol', 'chase'])
  })

  it('ignores controllers linked to a different brain', () => {
    const controller = new ControllerNode('other')
    controller.brainId = 'keep-me'
    expect(detachBrain(controllerScene(controller), 'delete-me')).toBe(false)
    expect(controller.brainId).toBe('keep-me')
  })
})

describe('brainIdsInScene', () => {
  it('collects each linked id once', () => {
    const a = new ControllerNode('a')
    const b = new ControllerNode('b')
    const c = new ControllerNode('c')
    a.brainId = 'x'
    b.brainId = 'x'
    c.brainId = 'y'
    expect(brainIdsInScene(controllerScene(a, b, c)).sort()).toEqual(['x', 'y'])
  })

  it('answers an empty or absent scene', () => {
    expect(brainIdsInScene(null)).toEqual([])
    expect(brainIdsInScene(controllerScene())).toEqual([])
  })
})

describe('the link survives serialization', () => {
  it('writes brainId only when linked, so an inline brain is byte-identical to before', async () => {
    const plain = new ControllerNode('plain')
    expect(JSON.parse(JSON.stringify(await plain.serialize())).brainId).toBeUndefined()

    const linked = new ControllerNode('linked')
    linked.brainId = 'brain-1'
    expect(JSON.parse(JSON.stringify(await linked.serialize())).brainId).toBe('brain-1')
  })

  it('round-trips through parse', async () => {
    const controller = new ControllerNode('zombie')
    controller.brainId = 'brain-1'
    const parent = new Node('parent')
    const json = JSON.parse(JSON.stringify(await controller.serialize()))

    ControllerNode.parse(parent, json)
    expect((parent.children[0] as ControllerNode).brainId).toBe('brain-1')
  })
})
