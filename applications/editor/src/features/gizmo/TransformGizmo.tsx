import { useEffect, useState } from 'react';
import TransformGizmoView from '@cleo/app-kit/gizmo/TransformGizmo';
import type { TransformPatch } from '@cleo/app-kit/gizmo/gizmoDrag';
import { useCleoEngine } from '../EngineContext';
import { useSelection } from '../SelectionContext';

/**
 * The editor's transform gizmo: app-kit's context-free one (see its header for how the handles and the
 * drag work), fed the editor's engine, open scene, event bus, gizmo mode and space, and hidden in Play.
 */

interface TransformGizmoProps {
    selectedNodeId: string | null;
    onTransformChange: (nodeId: string, patch: TransformPatch) => void;
    viewportRef: React.RefObject<HTMLDivElement>;
}

export default function TransformGizmo({ selectedNodeId, onTransformChange, viewportRef }: TransformGizmoProps) {
    const { instance, editorScene, eventEmitter, withoutDirty } = useCleoEngine();
    const { gizmoMode, gizmoSpace } = useSelection();
    const [isPlayMode, setIsPlayMode] = useState(false);

    useEffect(() => {
        const onPlayState = (state: 'play' | 'simulate' | 'pause' | 'stop') => setIsPlayMode(state === 'play' || state === 'simulate');
        eventEmitter.on('SET_PLAY_STATE', onPlayState);
        return () => { eventEmitter.off('SET_PLAY_STATE', onPlayState); };
    }, [eventEmitter]);

    return <TransformGizmoView instance={instance} scene={editorScene} bus={eventEmitter}
                               selectedNodeId={selectedNodeId} mode={gizmoMode} space={gizmoSpace}
                               disabled={isPlayMode} wrap={withoutDirty}
                               onTransformChange={onTransformChange} viewportRef={viewportRef} />;
}
