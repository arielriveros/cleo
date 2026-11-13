// The Duskwell input map: platformer bindings for keyboard and a standard gamepad. Written into the bundle as
// `libraries/inputMap.json`, which the editor installs as the project's input map on import.

const b = (id: string, source: object, extra: object = {}) => ({ id, source, ...extra })
const key = (code: string) => ({ device: 'key', code })
const mouse = (button: string) => ({ device: 'mouse', button })
const pad = (button: string) => ({ device: 'gamepad', button })
const axis = (name: string) => ({ device: 'gamepadAxis', axis: name })
const button = (name: string, bindings: object[]) => ({ name, kind: 'button', bindings })

export const DUSK_INPUT_MAP = {
    version: 1,
    maps: [
        {
            name: 'Gameplay',
            enabled: true,
            actions: [
                {
                    name: 'Move', kind: 'vector',
                    bindings: [
                        b('move:w', key('KeyW'), { part: 'up' }), b('move:s', key('KeyS'), { part: 'down' }),
                        b('move:a', key('KeyA'), { part: 'left' }), b('move:d', key('KeyD'), { part: 'right' }),
                        b('move:up', key('ArrowUp'), { part: 'up' }), b('move:down', key('ArrowDown'), { part: 'down' }),
                        b('move:left', key('ArrowLeft'), { part: 'left' }), b('move:right', key('ArrowRight'), { part: 'right' }),
                        b('move:padX', axis('leftStickX'), { part: 'x', processors: [{ kind: 'deadzone', min: 0.2, max: 0.95 }] }),
                        b('move:padY', axis('leftStickY'), { part: 'y', processors: [{ kind: 'deadzone', min: 0.2, max: 0.95 }] }),
                        b('move:dpadUp', pad('dpadUp'), { part: 'up' }), b('move:dpadDown', pad('dpadDown'), { part: 'down' }),
                        b('move:dpadLeft', pad('dpadLeft'), { part: 'left' }), b('move:dpadRight', pad('dpadRight'), { part: 'right' }),
                    ],
                    processors: [{ kind: 'normalize' }],
                },
                button('Jump', [b('jump:space', key('Space')), b('jump:k', key('KeyK')), b('jump:pad', pad('a'))]),
                button('Attack', [b('attack:j', key('KeyJ')), b('attack:mouse', mouse('left')), b('attack:pad', pad('x'))]),
                button('Dash', [b('dash:shift', key('ShiftLeft')), b('dash:l', key('KeyL')), b('dash:pad', pad('rightBumper')), b('dash:padB', pad('b'))]),
            ],
        },
    ],
    virtualControls: [],
    touch: { tapMaxSeconds: 0.25, tapMaxPixels: 12, doubleTapMaxSeconds: 0.3, longPressSeconds: 0.5, dragMinPixels: 8, pinchMinPixels: 12 },
}
