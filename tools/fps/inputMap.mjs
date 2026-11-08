// The FPS input map: keyboard + mouse and a standard gamepad. Written into the bundle as
// `libraries/inputMap.json`, which the editor stores as the project's input map on import.
//
// Look has pointer-lock bindings only: Play mode captures the pointer on the first click, and a drag-to-look on
// a button the game also uses (Fire) would swing the view on every shot.

const b = (id, source, extra = {}) => ({ id, source, ...extra })
const key = (code) => ({ device: 'key', code })
const mouse = (button) => ({ device: 'mouse', button })
const pad = (button) => ({ device: 'gamepad', button })
const axis = (name) => ({ device: 'gamepadAxis', axis: name })
const STICK_DEADZONE = { kind: 'radialDeadzone', min: 0.15, max: 0.95 }
const button = (name, bindings, extra = {}) => ({ name, kind: 'button', bindings, ...extra })

export const FPS_INPUT_MAP = {
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
            b('move:padX', axis('leftStickX'), { part: 'x', processors: [{ kind: 'deadzone', min: 0.15, max: 0.95 }] }),
            b('move:padY', axis('leftStickY'), { part: 'y', processors: [{ kind: 'deadzone', min: 0.15, max: 0.95 }] }),
          ],
          processors: [{ kind: 'normalize' }],
        },
        {
          name: 'Look', kind: 'vector',
          bindings: [
            b('look:mouseX', { device: 'pointer', axis: 'deltaX' }, { part: 'x', modifiers: [{ device: 'state', flag: 'pointerLock' }] }),
            b('look:mouseY', { device: 'pointer', axis: 'deltaY' }, { part: 'y', modifiers: [{ device: 'state', flag: 'pointerLock' }] }),
            b('look:padX', axis('rightStickX'), { part: 'x', processors: [STICK_DEADZONE, { kind: 'scale', factor: 6 }] }),
            b('look:padY', axis('rightStickY'), { part: 'y', processors: [STICK_DEADZONE, { kind: 'scale', factor: -6 }] }),
          ],
        },
        button('Fire', [b('fire:mouse', mouse('left')), b('fire:pad', pad('rightTrigger'))]),
        button('Aim', [b('aim:mouse', mouse('right')), b('aim:pad', pad('leftTrigger'))]),
        button('Reload', [b('reload:r', key('KeyR')), b('reload:pad', pad('x'))]),
        button('Sprint', [b('sprint:shift', key('ShiftLeft')), b('sprint:pad', pad('leftStick'))]),
        // C only: Ctrl is the browser's (Ctrl+W closes the tab, and crouch + forward is exactly that).
        button('Crouch', [b('crouch:c', key('KeyC')), b('crouch:pad', pad('rightStick'))]),
        button('Jump', [b('jump:space', key('Space')), b('jump:pad', pad('a'))]),
        button('Slot1', [b('slot1:key', key('Digit1')), b('slot1:pad', pad('dpadUp'))]),
        button('Slot2', [b('slot2:key', key('Digit2')), b('slot2:pad', pad('dpadRight'))]),
        button('Slot3', [b('slot3:key', key('Digit3')), b('slot3:pad', pad('dpadDown'))]),
        button('NextWeapon', [b('next:e', key('KeyE')), b('next:pad', pad('rightBumper'))]),
        button('PrevWeapon', [b('prev:q', key('KeyQ')), b('prev:pad', pad('leftBumper'))]),
      ],
    },
    {
      name: 'UI',
      enabled: true,
      actions: [
        button('Submit', [b('submit:enter', key('Enter')), b('submit:pad', pad('a'))]),
        button('Cancel', [b('cancel:escape', key('Escape')), b('cancel:pad', pad('b'))]),
        button('Pause', [b('pause:p', key('KeyP')), b('pause:escape', key('Escape')), b('pause:pad', pad('start'))]),
      ],
    },
  ],
  virtualControls: [],
  touch: { tapMaxSeconds: 0.25, tapMaxPixels: 12, doubleTapMaxSeconds: 0.3, longPressSeconds: 0.5, dragMinPixels: 8, pinchMinPixels: 12 },
}

/** The controls table the docs print, kept beside the map it describes. */
export const CONTROLS = [
  ['Move', 'W A S D', 'Left stick'],
  ['Look', 'Mouse (click the game to capture it)', 'Right stick'],
  ['Fire', 'Left mouse', 'RT'],
  ['Aim down sights', 'Right mouse (hold)', 'LT'],
  ['Reload', 'R', 'X'],
  ['Sprint', 'Shift (hold)', 'L3'],
  ['Crouch', 'C (hold)', 'R3'],
  ['Jump', 'Space', 'A'],
  ['Weapons', '1 2 3, or Q / E', 'D-pad, or bumpers'],
]
