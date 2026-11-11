// The Valley's input map: a free-flying camera (examples/scripts/ValleyFlyCamera.ts), keyboard + mouse and a
// standard gamepad. Written into the example as `libraries/inputMap.json`, which the editor installs as the
// project's input map on import.
//
// Look works under pointer lock (Play captures the pointer on the first click) and as a left-button drag,
// as in the engine's default map: nothing else is on the left button here.

const b = (id, source, extra = {}) => ({ id, source, ...extra })
const key = (code) => ({ device: 'key', code })
const pad = (button) => ({ device: 'gamepad', button })
const axis = (name) => ({ device: 'gamepadAxis', axis: name })
const STICK = { kind: 'deadzone', min: 0.15, max: 0.95 }
const STICK_RADIAL = { kind: 'radialDeadzone', min: 0.15, max: 0.95 }

export const FLY_INPUT_MAP = {
  version: 1,
  maps: [
    {
      name: 'Gameplay',
      enabled: true,
      actions: [
        {
          name: 'Move', kind: 'vector',
          bindings: [
            b('move:w', key('KeyW'), { part: 'up' }),
            b('move:s', key('KeyS'), { part: 'down' }),
            b('move:a', key('KeyA'), { part: 'left' }),
            b('move:d', key('KeyD'), { part: 'right' }),
            b('move:up', key('ArrowUp'), { part: 'up' }),
            b('move:down', key('ArrowDown'), { part: 'down' }),
            b('move:left', key('ArrowLeft'), { part: 'left' }),
            b('move:right', key('ArrowRight'), { part: 'right' }),
            b('move:padX', axis('leftStickX'), { part: 'x', processors: [STICK] }),
            b('move:padY', axis('leftStickY'), { part: 'y', processors: [STICK] }),
          ],
          processors: [{ kind: 'normalize' }],
        },
        {
          name: 'Look', kind: 'vector',
          bindings: [
            b('look:mouseX', { device: 'pointer', axis: 'deltaX' }, { part: 'x', modifiers: [{ device: 'state', flag: 'pointerLock' }] }),
            b('look:mouseY', { device: 'pointer', axis: 'deltaY' }, { part: 'y', modifiers: [{ device: 'state', flag: 'pointerLock' }] }),
            b('look:dragX', { device: 'pointer', axis: 'deltaX' }, { part: 'x', modifiers: [{ device: 'mouse', button: 'left' }] }),
            b('look:dragY', { device: 'pointer', axis: 'deltaY' }, { part: 'y', modifiers: [{ device: 'mouse', button: 'left' }] }),
            b('look:padX', axis('rightStickX'), { part: 'x', processors: [STICK_RADIAL, { kind: 'scale', factor: 4 }] }),
            b('look:padY', axis('rightStickY'), { part: 'y', processors: [STICK_RADIAL, { kind: 'scale', factor: -4 }] }),
          ],
        },
        {
          name: 'Ascend', kind: 'button',
          bindings: [b('ascend:space', key('Space')), b('ascend:e', key('KeyE')), b('ascend:pad', pad('rightBumper'))],
        },
        {
          name: 'Descend', kind: 'button',
          bindings: [b('descend:c', key('KeyC')), b('descend:q', key('KeyQ')), b('descend:pad', pad('leftBumper'))],
        },
        {
          name: 'Sprint', kind: 'button',
          bindings: [b('sprint:shift', key('ShiftLeft')), b('sprint:pad', pad('leftStick'))],
        },
        {
          name: 'Fly Speed', kind: 'axis',
          bindings: [b('speed:wheel', { device: 'pointer', axis: 'wheelY' })],
        },
      ],
    },
  ],
}
