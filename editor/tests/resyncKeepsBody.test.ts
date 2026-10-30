import { describe, it, expect } from 'vitest'
import { Scene, Node } from 'cleo'
import { reinstantiate } from '../src/utils/sceneResync'

// A model asset carries no physics, so a body on a placed copy's root (the Valley's walled houses) is
// per-placement state. The editor keeps bodies in side maps keyed by node id, and a rebuild mints new ids
// — so a rebuild that did not carry the body over left the copy with no collision at all.
describe('reinstantiate', () => {
    it('carries the placed root\'s body and trigger over to the rebuilt copy', () => {
        const scene = new Scene()
        const old = new Node('House')
        scene.root.addChild(old)
        const body = { mass: 0, shapes: [{ type: 'box', width: 1, height: 2, depth: 3, offset: [0, 1, 0], rotation: [0, 0, 0] }] }
        const trigger = { shapes: [{ type: 'sphere', radius: 2, offset: [0, 0, 0], rotation: [0, 0, 0] }] }
        const maps = { scripts: new Map<string, string>(), bodies: new Map<string, any>([[old.id, body]]), triggers: new Map<string, any>([[old.id, trigger]]) }
        const rebuilt = reinstantiate(scene, old, maps, parent => {
            const n = new Node('House')
            parent.addChild(n)
            return n.id
        })
        expect(rebuilt).not.toBeNull()
        expect(rebuilt!.id).not.toBe(old.id)
        expect(maps.bodies.get(rebuilt!.id)).toBe(body)
        expect(maps.triggers.get(rebuilt!.id)).toBe(trigger)
        expect(maps.bodies.has(old.id)).toBe(false)
    })
})
