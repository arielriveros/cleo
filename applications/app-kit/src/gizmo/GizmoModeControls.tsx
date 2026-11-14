import { SegmentedControl } from '../ui';
import { effectiveGizmoSpace } from './gizmoMath';
import type { GizmoMode, GizmoSpace } from './types';

// The floating gizmo controls every Cleo viewport shows top-right, as two joined strips: move / rotate /
// scale as icons, then the world / local axes toggle. The editor's EngineViewport and Cleo Creator's FX
// viewport both draw this one.

// Compact glyphs (stroke currentColor) for the gizmo-mode toggle.
export const MoveIcon = () => (
  <svg viewBox='0 0 24 24' width='15' height='15' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round'>
    <path d='M12 3v18M3 12h18M12 3 9 6M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3' />
  </svg>
);
export const RotateIcon = () => (
  <svg viewBox='0 0 24 24' width='15' height='15' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round'>
    <path d='M20 12a8 8 0 1 1-2.3-5.6' /><path d='M20 4v4h-4' />
  </svg>
);
export const ScaleIcon = () => (
  <svg viewBox='0 0 24 24' width='15' height='15' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round'>
    <rect x='4' y='4' width='10' height='10' rx='1' /><path d='M14 14l6 6M20 15v5h-5' />
  </svg>
);

// The axes the gizmo works in: the world's (a globe) or the node's own (a box with its own axes).
export const WorldIcon = () => (
  <svg viewBox='0 0 24 24' width='15' height='15' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round'>
    <circle cx='12' cy='12' r='8.5' /><path d='M3.5 12h17' /><path d='M12 3.5c-2.6 2.4-3.8 5.2-3.8 8.5s1.2 6.1 3.8 8.5c2.6-2.4 3.8-5.2 3.8-8.5S14.6 5.9 12 3.5Z' />
  </svg>
);
export const LocalIcon = () => (
  <svg viewBox='0 0 24 24' width='15' height='15' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round'>
    <path d='M12 3.5 19.5 7.75v8.5L12 20.5 4.5 16.25v-8.5Z' strokeOpacity='0.55' />
    <path d='M12 12V4.8M12 12l6.2 3.6M12 12l-6.2 3.6' />
  </svg>
);

export interface GizmoModeControlsProps {
  mode: GizmoMode;
  space: GizmoSpace;
  onMode: (mode: GizmoMode) => void;
  onSpace: (space: GizmoSpace) => void;
}

export function GizmoModeControls({ mode, space, onMode, onSpace }: GizmoModeControlsProps) {
  return <>
    <SegmentedControl<GizmoMode>
      joined size='sm'
      options={[
        { value: 'position', label: <MoveIcon />, title: 'Move (W)' },
        { value: 'rotation', label: <RotateIcon />, title: 'Rotate (E)' },
        { value: 'scale', label: <ScaleIcon />, title: 'Scale (R)' },
      ]}
      value={mode}
      onChange={onMode} />
    {/* Scale has no world frame to offer — scaling a rotated node along a world axis is a shear, which no
        TRS transform can hold — so the toggle greys out rather than lying. The stored preference is
        untouched and comes back with move or rotate. */}
    <SegmentedControl<GizmoSpace>
      joined size='sm'
      options={[
        { value: 'world', label: <WorldIcon />, title: 'World axes (X)', disabled: mode === 'scale' },
        { value: 'local', label: <LocalIcon />, title: "The node's own axes (X)", disabled: mode === 'scale' },
      ]}
      value={effectiveGizmoSpace(mode, space)}
      onChange={onSpace} />
  </>;
}

export default GizmoModeControls;
