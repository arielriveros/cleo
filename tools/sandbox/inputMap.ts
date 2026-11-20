// The Sandbox's input map: the engine's default (Move, Look, Jump, Sprint, Zoom, the UI map, the touch
// controls), without Fire, plus the two actions this example adds: Walk (hold), and Interact (press: get into the car
// by its door, and out of it). The camera's framing follows the sprint, so no action switches it.

import { DEFAULT_INPUT_MAP } from '../../src/input/actionMap'
import type { InputMap } from '../../src/input/actionMap'

export function sandboxInputMap(): InputMap {
    const map: InputMap = JSON.parse(JSON.stringify(DEFAULT_INPUT_MAP))
    const gameplay = map.maps.find(m => m.name === 'Gameplay')!
    gameplay.actions = gameplay.actions.filter(a => a.name !== 'Fire')
    gameplay.actions.push(
        {
            name: 'Walk', kind: 'button',
            bindings: [
                { id: 'walk:ctrl', source: { device: 'key', code: 'ControlLeft' } },
                { id: 'walk:pad', source: { device: 'gamepad', button: 'leftBumper' } },
            ],
        } as any,
        {
            name: 'Interact', kind: 'button',
            bindings: [
                { id: 'interact:e', source: { device: 'key', code: 'KeyE' } },
                { id: 'interact:pad', source: { device: 'gamepad', button: 'y' } },
            ],
        } as any,
    )
    return map
}
