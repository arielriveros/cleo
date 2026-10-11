// The Hollow Keep input map — souls-style bindings for keyboard + mouse and a standard gamepad.
//
// Written into the bundle as `libraries/inputMap.json`, which the editor stores as the project's input
// map on import (see BundleLibraries.inputMap). Every action has at least one keyboard/mouse binding and
// one gamepad binding; tests/soulsDemoProject.test.ts holds the example to that.
//
// Two deliberate differences from the engine's default map:
//
//   * Look has NO left-mouse-drag bindings. The left button is the light attack, and a drag-to-look on
//     the same button would swing the camera on every swing. Look is pointer-lock only — Play mode locks
//     the pointer on the first click.
//   * Move has no arrow keys, so the UI map can use them for menu navigation while Gameplay is disabled
//     without any overlap when it is enabled.

const b = (id, source, extra = {}) => ({ id, source, ...extra })
const key = (code) => ({ device: 'key', code })
const mouse = (button) => ({ device: 'mouse', button })
const pad = (button) => ({ device: 'gamepad', button })
const axis = (name) => ({ device: 'gamepadAxis', axis: name })
const STICK_DEADZONE = { kind: 'radialDeadzone', min: 0.15, max: 0.95 }

const button = (name, bindings, extra = {}) => ({ name, kind: 'button', bindings, ...extra })

export const SOULS_INPUT_MAP = {
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
            b('look:padX', axis('rightStickX'), { part: 'x', processors: [STICK_DEADZONE, { kind: 'scale', factor: 4 }] }),
            b('look:padY', axis('rightStickY'), { part: 'y', processors: [STICK_DEADZONE, { kind: 'scale', factor: -4 }] }),
          ],
        },
        button('LightAttack', [b('light:mouse', mouse('left')), b('light:pad', pad('rightBumper'))]),
        button('HeavyAttack', [b('heavy:mouse', mouse('right')), b('heavy:pad', pad('rightTrigger'))]),
        // Tap to roll, hold to sprint — SoulsPlayer tells the two apart.
        button('Roll', [b('roll:space', key('Space')), b('roll:pad', pad('b'))]),
        button('LockOn', [b('lock:q', key('KeyQ')), b('lock:middle', mouse('middle')), b('lock:pad', pad('rightStick'))]),
        button('SwitchTargetLeft', [b('switchL:z', key('KeyZ')), b('switchL:pad', pad('dpadLeft'))]),
        button('SwitchTargetRight', [b('switchR:c', key('KeyC')), b('switchR:pad', pad('dpadRight'))]),
        button('UseItem', [b('item:r', key('KeyR')), b('item:pad', pad('x'))]),
        button('SwapWeapon', [b('swap:f', key('KeyF')), b('swap:pad', pad('dpadUp'))]),
        button('Interact', [b('interact:e', key('KeyE')), b('interact:pad', pad('a'))]),
      ],
    },
    {
      name: 'UI',
      enabled: true,
      actions: [
        {
          name: 'Navigate', kind: 'vector',
          bindings: [
            b('nav:up', key('ArrowUp'), { part: 'up' }),
            b('nav:down', key('ArrowDown'), { part: 'down' }),
            b('nav:left', key('ArrowLeft'), { part: 'left' }),
            b('nav:right', key('ArrowRight'), { part: 'right' }),
            b('nav:w', key('KeyW'), { part: 'up' }),
            b('nav:s', key('KeyS'), { part: 'down' }),
            b('nav:a', key('KeyA'), { part: 'left' }),
            b('nav:d', key('KeyD'), { part: 'right' }),
            b('nav:dpadUp', pad('dpadUp'), { part: 'up' }),
            b('nav:dpadDown', pad('dpadDown'), { part: 'down' }),
            b('nav:dpadLeft', pad('dpadLeft'), { part: 'left' }),
            b('nav:dpadRight', pad('dpadRight'), { part: 'right' }),
            b('nav:padX', axis('leftStickX'), { part: 'x', processors: [{ kind: 'deadzone', min: 0.5, max: 0.95 }] }),
            b('nav:padY', axis('leftStickY'), { part: 'y', processors: [{ kind: 'deadzone', min: 0.5, max: 0.95 }] }),
          ],
        },
        button('Submit', [b('submit:enter', key('Enter')), b('submit:pad', pad('a'))]),
        button('Cancel', [b('cancel:escape', key('Escape')), b('cancel:backspace', key('Backspace')), b('cancel:pad', pad('b'))]),
        button('Pause', [b('pause:p', key('KeyP')), b('pause:pad', pad('start'))]),
      ],
    },
  ],
  virtualControls: [],
  touch: { tapMaxSeconds: 0.25, tapMaxPixels: 12, doubleTapMaxSeconds: 0.3, longPressSeconds: 0.5, dragMinPixels: 8, pinchMinPixels: 12 },
}

/** The controls table SOULS_DEMO.md prints, kept beside the map it describes. */
export const CONTROLS = [
  ['Move', 'W A S D', 'Left stick'],
  ['Camera', 'Mouse (click the game to capture it)', 'Right stick'],
  ['Light attack', 'Left mouse', 'RB'],
  ['Heavy attack', 'Right mouse', 'RT'],
  ['Roll / backstep (tap), sprint (hold)', 'Space', 'B'],
  ['Lock on / off', 'Q or middle mouse', 'R3'],
  ['Switch target', 'Z / C, or flick the mouse', 'D-pad left / right, or flick the right stick'],
  ['Drink Estus', 'R', 'X'],
  ['Swap weapon', 'F', 'D-pad up'],
  ['Interact', 'E', 'A'],
  ['Menu: select / adjust / confirm / leave', 'Arrows or WASD / Enter / Esc', 'D-pad or stick / A / B'],
]
