import { describe, it, expect } from 'vitest'
import { Scene, Node, ColliderNode, TriggerNode } from 'cleo'
import { reinstantiate } from '../src/utils/sceneResync'

// A model asset carries no physics, so a placed copy that collides (the Valley's walled houses) stands in a
// Collider of its own, and a Trigger the user put inside the copy is a child the asset does not make. A
// rebuild of the copy from its asset must keep both: the Collider is outside what is rebuilt, and the
// Trigger is carried over as a foreign child.
describe('reinstantiate', () => {
    it('rebuilds a copy inside its Collider and keeps the Trigger put inside it', () => {
        const scene = new Scene()
        const collider = new ColliderNode('House Collider')
        collider.shapes = [{ type: 'box', width: 1, height: 2, depth: 3, offset: [0, 1, 0], rotation: [0, 0, 0] }]
        scene.root.addChild(collider)
        const old = new Node('House')
        collider.addChild(old)
        const trigger = new TriggerNode('Door Trigger')
        old.addChild(trigger)

        const maps = { scripts: new Map<string, string>() }
        const rebuilt = reinstantiate(scene, old, maps, parent => {
            const n = new Node('House')
            parent.addChild(n)
            return n.id
        }, undefined, { name: 'House', children: [] } as any)

        expect(rebuilt).not.toBeNull()
        expect(rebuilt!.id).not.toBe(old.id)
        // Still in the same Collider, which kept its shapes.
        expect(rebuilt!.parent).toBe(collider)
        expect(collider.shapes).toHaveLength(1)
        // The Trigger came along.
        expect(rebuilt!.children.some(c => c === trigger)).toBe(true)
    })
})
