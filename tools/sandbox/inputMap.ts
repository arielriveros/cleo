// The Sandbox's input map: the engine's default (Move, Look, Jump, Sprint, Zoom, the UI map, the touch
// controls), without Fire, plus the actions this example adds: Walk (hold), Interact (press: get into the car by its
// door, and out of it), Drive (the car's: steer and pedals), and Day, Sunset and Night (1, 2, 3: the Game Manager's
// light setups). The camera's framing follows the sprint, so no action switches it.
//
// On a gamepad: X jumps (and holds the car's hand brake), A runs, the right stick looks at twice the engine default's
// rate (the mouse keeps its own), and in the car the left stick steers while the right trigger drives and the left
// one brakes, then reverses. The left stick's up and down do not drive: the triggers do.

import { DEFAULT_INPUT_MAP } from '../../src/input/actionMap'
import type { InputMap } from '../../src/input/actionMap'

/** How much faster the sticks turn the camera than the engine default's (scale 4). */
export const PAD_LOOK_RATE = 2

export function sandboxInputMap(): InputMap {
    const map: InputMap = JSON.parse(JSON.stringify(DEFAULT_INPUT_MAP))
    const gameplay = map.maps.find(m => m.name === 'Gameplay')!
    gameplay.actions = gameplay.actions.filter(a => a.name !== 'Fire')
    const action = (name: string) => gameplay.actions.find(a => a.name === name)!
    const padButton = (name: string, button: string) => {
        for (const b of action(name).bindings) if (b.source.device === 'gamepad') (b.source as { button: string }).button = button
    }
    padButton('Jump', 'x')
    padButton('Sprint', 'a')
    for (const b of action('Look').bindings) {
        if (b.source.device !== 'gamepadAxis') continue
        for (const p of b.processors ?? []) if (p.kind === 'scale') p.factor *= PAD_LOOK_RATE
    }
    const key = (id: string, code: string, part: string) => ({ id, source: { device: 'key', code }, part })
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
        // The car's Controller reads this instead of Move: x steers, y drives (+1 forward; against the way the car
        // rolls it brakes, then reverses). The keys as Move's; on a pad the left stick steers and the triggers are
        // the pedals, analog. No `normalize` (Move's): full steer with the throttle down must stay full steer.
        {
            name: 'Drive', kind: 'vector',
            bindings: [
                key('drive:w', 'KeyW', 'up'), key('drive:s', 'KeyS', 'down'),
                key('drive:a', 'KeyA', 'left'), key('drive:d', 'KeyD', 'right'),
                key('drive:up', 'ArrowUp', 'up'), key('drive:down', 'ArrowDown', 'down'),
                key('drive:left', 'ArrowLeft', 'left'), key('drive:right', 'ArrowRight', 'right'),
                { id: 'drive:steer', source: { device: 'gamepadAxis', axis: 'leftStickX' }, part: 'x', processors: [{ kind: 'deadzone', min: 0.15, max: 0.95 }] },
                { id: 'drive:throttle', source: { device: 'gamepad', button: 'rightTrigger' }, part: 'up', processors: [{ kind: 'deadzone', min: 0.05, max: 0.98 }] },
                { id: 'drive:brake', source: { device: 'gamepad', button: 'leftTrigger' }, part: 'down', processors: [{ kind: 'deadzone', min: 0.05, max: 0.98 }] },
                { id: 'drive:stick', source: { device: 'virtual', control: 'moveStick' } },
            ],
        } as any,
        // The Game Manager's light setups (SandboxGameManager): 1 day, 2 sunset, 3 night.
        ...([['Day', 'Digit1', 'dpadLeft'], ['Sunset', 'Digit2', 'dpadUp'], ['Night', 'Digit3', 'dpadRight']] as const).map(([name, code, button]) => ({
            name, kind: 'button',
            bindings: [
                { id: `${name.toLowerCase()}:key`, source: { device: 'key', code } },
                { id: `${name.toLowerCase()}:pad`, source: { device: 'gamepad', button } },
            ],
        }) as any),
    )
    return map
}
