import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PANE_PRESETS, MAX_PANES, defaultPaneState, layoutGrid, paneCount, panesAllowed, sanitizePaneState,
} from '../src/features/viewportPanes/paneState';
import { lookRotation } from '../src/features/viewportPanes/paneCameras';

// The split viewport's saved state (features/viewportPanes/paneState.ts): what a stored blob becomes, and
// where splitting is allowed. The cameras and the per-frame wiring need an engine and a DOM.

describe('pane layouts', () => {
  it('maps each layout to its grid and pane count', () => {
    expect(layoutGrid('single')).toEqual({ cols: 1, rows: 1 });
    expect(layoutGrid('columns')).toEqual({ cols: 2, rows: 1 });
    expect(layoutGrid('rows')).toEqual({ cols: 1, rows: 2 });
    expect(layoutGrid('grid')).toEqual({ cols: 2, rows: 2 });
    expect([paneCount('single'), paneCount('columns'), paneCount('rows'), paneCount('grid')]).toEqual([1, 2, 2, 4]);
  });
});

describe('sanitizePaneState', () => {
  it('starts as one view, the main camera first and three orthographic views after it', () => {
    const s = defaultPaneState();
    expect(s.layout).toBe('single');
    expect(s.focused).toBe(0);
    expect(s.panes.map(p => p.preset)).toEqual([...DEFAULT_PANE_PRESETS]);
    expect(s.panes).toHaveLength(MAX_PANES);
  });

  it('degrades anything malformed to the default for it', () => {
    expect(sanitizePaneState(null)).toEqual(defaultPaneState());
    expect(sanitizePaneState('nope')).toEqual(defaultPaneState());
    const s = sanitizePaneState({ layout: 'hexagons', focused: 9, panes: [{ preset: 'sideways' }, 3] });
    expect(s.layout).toBe('single');
    expect(s.focused).toBe(0);
    expect(s.panes[0].preset).toBe('perspective');
  });

  it('keeps a valid layout, focus, presets and realtime flags', () => {
    const s = sanitizePaneState({
      layout: 'grid', focused: 3,
      panes: [{ preset: 'perspective' }, { preset: 'bottom', realtime: true }, { preset: 'back' }, { preset: 'left' }],
    });
    expect(s.layout).toBe('grid');
    expect(s.focused).toBe(3);
    expect(s.panes.map(p => p.preset)).toEqual(['perspective', 'bottom', 'back', 'left']);
    expect(s.panes[1].realtime).toBe(true);
  });

  it('never makes pane 0 anything but the perspective main camera', () => {
    expect(sanitizePaneState({ panes: [{ preset: 'top' }] }).panes[0].preset).toBe('perspective');
  });

  it('clamps the focus into the layout', () => {
    expect(sanitizePaneState({ layout: 'columns', focused: 3 }).focused).toBe(0);
    expect(sanitizePaneState({ layout: 'columns', focused: 1 }).focused).toBe(1);
  });

  it('keeps only well-formed poses, per scene, never for pane 0', () => {
    const s = sanitizePaneState({
      poses: {
        sceneA: [
          { position: [1, 2, 3], rotation: [0, 0, 0] },
          { position: [1, 2, 3], rotation: [90, 0, 0], ortho: 12 },
          { position: [1, 2], rotation: [0, 0, 0] },
          { position: [1, 2, 3], rotation: [0, 0, 0], ortho: -4 },
        ],
        sceneB: 'broken',
      },
    });
    expect(s.poses.sceneA[0]).toBeNull();
    expect(s.poses.sceneA[1]).toEqual({ position: [1, 2, 3], rotation: [90, 0, 0], ortho: 12 });
    expect(s.poses.sceneA[2]).toBeNull();
    expect(s.poses.sceneA[3]).toEqual({ position: [1, 2, 3], rotation: [0, 0, 0] });
    expect('sceneB' in s.poses).toBe(false);
  });
});

describe('panesAllowed', () => {
  const base = { editorMode: 'scene', isPlayMode: false, viewDimension: '3D' as const, isSceneReady: true };
  it('splits only the scene mode, viewed in 3D, outside Play, once loaded', () => {
    expect(panesAllowed(base)).toBe(true);
    for (const editorMode of ['landscape', 'tilemap', 'ui', 'options', 'sequence', 'template', 'material', 'model'])
      expect(panesAllowed({ ...base, editorMode })).toBe(false);
    expect(panesAllowed({ ...base, isPlayMode: true })).toBe(false);
    expect(panesAllowed({ ...base, viewDimension: '2D' })).toBe(false);
    expect(panesAllowed({ ...base, isSceneReady: false })).toBe(false);
  });
});

describe('lookRotation', () => {
  it('matches the editor camera\'s own pose: [30,-135,0] at (4,4,4) looks at the origin', () => {
    const [pitch, yaw, roll] = lookRotation([4, 4, 4], [0, 0, 0]);
    expect(yaw).toBeCloseTo(-135, 5);
    expect(pitch).toBeCloseTo(35.264, 2);
    expect(roll).toBe(0);
  });
  it('turns toward +X with a positive yaw and down with a positive pitch', () => {
    expect(lookRotation([0, 0, 0], [1, 0, 0])[1]).toBeCloseTo(90, 5);
    expect(lookRotation([0, 1, 0], [0, 0, 0])[0]).toBeCloseTo(90, 5);
  });
});
