import { SegmentedControl } from '../ui';
import { effectiveGizmoSpace } from './gizmoMath';
import type { GizmoMode, GizmoSpace } from './types';

// The floating gizmo controls every Cleo viewport shows top-right: move / rotate / scale as icons, and the
// world / local axes toggle. The editor's EngineViewport and Cleo Creator's FX viewport both draw this one.

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

export interface GizmoModeControlsProps {
  mode: GizmoMode;
  space: GizmoSpace;
  onMode: (mode: GizmoMode) => void;
  onSpace: (space: GizmoSpace) => void;
}

export function GizmoModeControls({ mode, space, onMode, onSpace }: GizmoModeControlsProps) {
  return <>
    <SegmentedControl<GizmoMode>
      size='sm'
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
      size='sm'
      options={[
        { value: 'world', label: 'W', title: 'World axes (X)', disabled: mode === 'scale' },
        { value: 'local', label: 'L', title: "The node's own axes (X)", disabled: mode === 'scale' },
      ]}
      value={effectiveGizmoSpace(mode, space)}
      onChange={onSpace} />
  </>;
}

export default GizmoModeControls;
