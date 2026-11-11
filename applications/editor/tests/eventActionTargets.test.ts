import { describe, it, expect } from 'vitest'
import { Node } from 'cleo'
import { eventNamesOf, targetPaths } from '../src/utils/eventActionTargets'

// What the Event Actions panel offers: event names the clips carry, and the node paths the engine would resolve.

describe('targetPaths', () => {
  const tree = () => {
    const character = new Node('Character')
    const weapon = new Node('Weapon')
    const sounds = new Node('Sounds')
    const shot = new Node('Shot', 'sound' as any)
    const reload = new Node('Reload', 'sound' as any)
    const flash = new Node('Flash', 'particleSystem' as any)
    sounds.addChild(shot)
    sounds.addChild(reload)
    weapon.addChild(sounds)
    weapon.addChild(flash)
    const outer = new Node('Hurt', 'sound' as any)
    const outerSounds = new Node('Sounds')
    outerSounds.addChild(outer)
    outerSounds.addChild(new Node('Death', 'sound' as any))
    character.addChild(outerSounds)
    character.addChild(weapon)
    const root = new Node('root')
    root.addChild(character)
    return { weapon, character }
  }

  it('lists the nodes of a kind below the owner first, then below its parents, as paths', () => {
    const { weapon } = tree()
    expect(targetPaths(weapon, 'sound')).toEqual(['Shot', 'Reload', 'Hurt', 'Death'])
  })

  it('qualifies a name with its group only when two nodes share it', () => {
    const owner = new Node('Owner')
    for (const group of ['Muzzle', 'Eject']) {
      const g = new Node(group)
      g.addChild(new Node('Light', 'light' as any))
      g.addChild(new Node('Spark', 'particleSystem' as any))
      owner.addChild(g)
    }
    const root = new Node('root')
    root.addChild(owner)
    expect(targetPaths(owner, 'light')).toEqual(['Muzzle/Light', 'Eject/Light'])
    expect(targetPaths(owner, 'particleSystem')).toEqual(['Muzzle/Spark', 'Eject/Spark'])
  })

  it('filters by kind', () => {
    const { weapon } = tree()
    expect(targetPaths(weapon, 'particleSystem')).toEqual(['Flash'])
    expect(targetPaths(weapon, 'light')).toEqual([])
    expect(targetPaths(null, 'any')).toEqual([])
  })

  it('skips editor helper nodes', () => {
    const owner = new Node('Owner')
    owner.addChild(new Node('__debug__SoundRadius', 'sound' as any))
    expect(targetPaths(owner, 'sound')).toEqual([])
  })
})

describe('eventNamesOf', () => {
  it('merges clip markers, machine markers and bound names, sorted and unique', () => {
    expect(eventNamesOf(
      [{ name: 'Fire', events: [{ name: 'shot' }, { name: 'mid' }] }, { name: 'Idle' }],
      [{ eventName: 'legacy' }, { eventName: 'shot' }],
      [{ event: 'reload' }],
    )).toEqual(['legacy', 'mid', 'reload', 'shot'])
  })
})
