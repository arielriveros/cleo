import { useEffect, useRef } from 'react';
import { isTextEntryEvent } from 'cleo';
import { useSelection } from '../SelectionContext';

/**
 * W / E / R switch the gizmo mode and X flips local/world — the bindings every 3D editor uses.
 *
 * Bare letters, so anything typed into a field, a dropdown or the code editor must be left alone
 * (`isTextEntryEvent`, shared with the engine's input sampler), and any modifier means the key belongs to
 * some other shortcut. Nor while a mouse button is held: W and E are also the editor camera's fly keys
 * (forward and up, gated on the left button — see EDITOR_CAMERA_MAP), and flying forward used to drop
 * the gizmo into Move, flying up into Rotate. LandscapeBrush gates its Q / W / E the same way.
 *
 * The caller is responsible for mounting this only where the gizmo itself is mounted — during play the
 * running game binds these same letters through `InputSystem`.
 *
 * @param enabled False while the gizmo is not interactive (play mode, a mode that owns the whole panel).
 */
export function useGizmoShortcuts(enabled: boolean): void {
    const { gizmoMode, setGizmoMode, gizmoSpace, setGizmoSpace } = useSelection();
    const buttonsRef = useRef(0);

    useEffect(() => {
        if (!enabled) return;

        const onKey = (e: KeyboardEvent) => {
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            if (isTextEntryEvent(e) || buttonsRef.current) return;

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
        // Capture phase, so a press the camera or a gizmo stops propagating is still counted.
        const trackButtons = (e: MouseEvent) => { buttonsRef.current = e.buttons; };
        // A release the page never sees (alt-tab mid-drag) would otherwise leave the letters dead.
        const onBlur = () => { buttonsRef.current = 0; };

        window.addEventListener('keydown', onKey);
        window.addEventListener('mousedown', trackButtons, true);
        window.addEventListener('mouseup', trackButtons, true);
        window.addEventListener('blur', onBlur);
        return () => {
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('mousedown', trackButtons, true);
            window.removeEventListener('mouseup', trackButtons, true);
            window.removeEventListener('blur', onBlur);
        };
    }, [enabled, gizmoMode, setGizmoMode, gizmoSpace, setGizmoSpace]);
}

export default useGizmoShortcuts;
