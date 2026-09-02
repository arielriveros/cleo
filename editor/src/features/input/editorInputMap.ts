import type { InputActionMap } from 'cleo'

/**
 * The editor's own viewport controls, expressed as an action map.
 *
 * Installed through `InputSystem.setOverlayMaps`, which keeps it structurally separate from the
 * project's map: overlays live in a different field and are never serialized, so there is no path by
 * which an editor binding could end up in a published game. That is the whole reason overlays exist as a
 * concept rather than the editor simply appending to the project's maps.
 *
 * The map is disabled in two situations, and both used to be `if` statements scattered through the
 * camera callbacks: while a gizmo is being dragged (GIZMO_DRAG_START/END), and while the game is
 * playing. Expressing them as "the map is off" rather than as a guard per read means a held key gets a
 * proper cancel instead of the camera simply freezing mid-motion.
 *
 * Bindings are deliberately conservative — the same chords the editor has always used — because this is
 * muscle memory, not a feature.
 */
export const EDITOR_CAMERA_MAP: InputActionMap = {
  name: 'EditorCamera',
  enabled: true,
  actions: [
    // WASD, live only while a mouse button is held, which is what keeps typing in a panel from flying
    // the camera across the scene.
    {
      name: 'Fly',
      kind: 'vector',
      bindings: [
        { id: 'fly:w', source: { device: 'key', code: 'KeyW' }, part: 'up', modifiers: [{ device: 'mouse', button: 'left' }] },
        { id: 'fly:s', source: { device: 'key', code: 'KeyS' }, part: 'down', modifiers: [{ device: 'mouse', button: 'left' }] },
        { id: 'fly:a', source: { device: 'key', code: 'KeyA' }, part: 'left', modifiers: [{ device: 'mouse', button: 'left' }] },
        { id: 'fly:d', source: { device: 'key', code: 'KeyD' }, part: 'right', modifiers: [{ device: 'mouse', button: 'left' }] },
      ],
    },
    // Q/E vertical, same gate.
    {
      name: 'Lift',
      kind: 'axis',
      bindings: [
        { id: 'lift:e', source: { device: 'key', code: 'KeyE' }, part: 'positive', modifiers: [{ device: 'mouse', button: 'left' }] },
        { id: 'lift:q', source: { device: 'key', code: 'KeyQ' }, part: 'negative', modifiers: [{ device: 'mouse', button: 'left' }] },
      ],
    },
    // Left-drag orbit.
    {
      name: 'Look',
      kind: 'vector',
      bindings: [
        { id: 'look:x', source: { device: 'pointer', axis: 'deltaX' }, part: 'x', modifiers: [{ device: 'mouse', button: 'left' }] },
        { id: 'look:y', source: { device: 'pointer', axis: 'deltaY' }, part: 'y', modifiers: [{ device: 'mouse', button: 'left' }] },
      ],
    },
    // Right-drag pan.
    {
      name: 'Pan',
      kind: 'vector',
      bindings: [
        { id: 'pan:x', source: { device: 'pointer', axis: 'deltaX' }, part: 'x', modifiers: [{ device: 'mouse', button: 'right' }] },
        { id: 'pan:y', source: { device: 'pointer', axis: 'deltaY' }, part: 'y', modifiers: [{ device: 'mouse', button: 'right' }] },
      ],
    },
    // 2D pans with EITHER button, so the ortho view needs no separate chord. Two bindings per axis
    // rather than one with two modifiers: a modifier list is an AND, and this is an OR.
    {
      name: 'Pan2D',
      kind: 'vector',
      bindings: [
        { id: 'pan2d:lx', source: { device: 'pointer', axis: 'deltaX' }, part: 'x', modifiers: [{ device: 'mouse', button: 'left' }] },
        { id: 'pan2d:ly', source: { device: 'pointer', axis: 'deltaY' }, part: 'y', modifiers: [{ device: 'mouse', button: 'left' }] },
        { id: 'pan2d:rx', source: { device: 'pointer', axis: 'deltaX' }, part: 'x', modifiers: [{ device: 'mouse', button: 'right' }] },
        { id: 'pan2d:ry', source: { device: 'pointer', axis: 'deltaY' }, part: 'y', modifiers: [{ device: 'mouse', button: 'right' }] },
      ],
    },
    // The wheel needs no modifier — but it does need the pointer to be over the viewport, which used to
    // be an `isMouseOverCanvas()` call at every read site. The listener is on the canvas, so an event
    // the canvas never received never reaches the snapshot; the modifier covers the pointer-lock case.
    {
      name: 'Zoom',
      kind: 'axis',
      bindings: [
        { id: 'zoom:wheel', source: { device: 'pointer', axis: 'wheelY' } },
      ],
    },
  ],
}
