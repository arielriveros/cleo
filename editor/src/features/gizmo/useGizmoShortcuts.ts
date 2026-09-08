import { useEffect } from 'react';
import { useSelection } from '../SelectionContext';

/**
 * W / E / R switch the gizmo mode and X flips local/world — the bindings every 3D editor uses.
 *
 * Guarded like `useUndoShortcuts` in `Editor.tsx`: bare letters, so anything typed into a field or the
 * code editor must be left alone, and any modifier means the key belongs to some other shortcut. The
 * caller is responsible for mounting this only where the gizmo itself is mounted — during play the
 * running game binds these same letters through `InputSystem`.
 *
 * @param enabled False while the gizmo is not interactive (play mode, a mode that owns the whole panel).
 */
export function useGizmoShortcuts(enabled: boolean): void {
    const { gizmoMode, setGizmoMode, gizmoSpace, setGizmoSpace } = useSelection();

    useEffect(() => {
        if (!enabled) return;

        const onKey = (e: KeyboardEvent) => {
            if (e.ctrlKey || e.metaKey || e.altKey) return;

            const target = e.target as HTMLElement | null;
            if (target && (target.isContentEditable
                || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
                || target.closest('.monaco-editor'))) return;

            switch (e.key.toLowerCase()) {
                case 'w': setGizmoMode('position'); break;
                case 'e': setGizmoMode('rotation'); break;
                case 'r': setGizmoMode('scale'); break;
                // A no-op in scale mode, which has no world frame to offer — but silently, because
                // refusing the key would be more confusing than a toggle that simply does not show.
                case 'x': setGizmoSpace(gizmoSpace === 'world' ? 'local' : 'world'); break;
                default: return;
            }
            e.preventDefault();
        };

        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [enabled, gizmoMode, setGizmoMode, gizmoSpace, setGizmoSpace]);
}

export default useGizmoShortcuts;
