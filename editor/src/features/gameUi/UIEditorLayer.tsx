import { useEffect, useMemo, useRef } from 'react';
import { Node, UINode, isUINodeType } from 'cleo';
import { useCleoEngine } from '../EngineContext';
import UILayer from './UILayer';
import UIEditorTools from './UIEditorTools';

/**
 * The editor's wrapper around the shared {@link UILayer}. Everything editor-only must stay here, so the
 * layer the published player renders carries no selection state or authoring affordances. It adds two
 * behaviours: clicks select instead of activating (every element hit-testable), and a selected element is
 * shown even when hidden, along with its ancestors.
 */
export default function UIEditorLayer() {
    const { instance, editorScene, eventEmitter, isPlayMode, editorMode, selectedNode } = useCleoEngine();
    const viewportRef = useRef<HTMLDivElement | null>(null);

    /**
     * The selected UI node plus every UI ancestor. The chain is required: the DOM is nested, so a hidden
     * ancestor's `display: none` hides the selected descendant whatever is written on the descendant.
     */
    const forceVisibleIds = useMemo(() => {
        const ids = new Set<string>();
        if (isPlayMode || !selectedNode || !editorScene) return ids;
        const node = editorScene.getNodeById(selectedNode);
        if (!node || !isUINodeType(node.nodeType)) return ids;
        for (let n: Node | null = node; n && isUINodeType(n.nodeType); n = n.parent) ids.add(n.id);
        return ids;
    }, [selectedNode, editorScene, isPlayMode]);

    // Must read the engine's current scene through a function, not `editorScene`: entering Play and
    // `Game.loadScene` both swap the scene out from under us.
    const getScene = useMemo(() => () => instance?.scene ?? null, [instance]);

    const authoring = !isPlayMode;

    const onSelect = useMemo(
        () => (id: string | null) => eventEmitter.emit('SELECT_NODE', id),
        [eventEmitter]);

    // The overlay's box must be measured here, not taken from the canvas: the UI's container is the
    // viewport panel, while `currentViewport` is the render-scaled internal size.
    useEffect(() => {
        const el = viewportRef.current;
        if (!el || !instance) return;
        const push = () => {
            const rect = el.getBoundingClientRect();
            // Written to whichever scene is live, so Play does not lay out against a stale viewport.
            instance.scene?.setUIViewport(rect.width, rect.height, window.devicePixelRatio || 1);
        };
        push();
        const observer = new ResizeObserver(push);
        observer.observe(el);
        return () => observer.disconnect();
    }, [instance, isPlayMode]);

    // Authoring affordances are `ui` mode only; other modes still render the UI, but inert.
    const picking = authoring && editorMode === 'ui';

    return (
        <div ref={viewportRef} className='absolute inset-0 pointer-events-none'>
            <UILayer
                getScene={getScene}
                interactive={isPlayMode}
                onSelect={picking ? onSelect : undefined}
                forceVisibleIds={picking ? forceVisibleIds : undefined}
                selectedId={picking ? selectedNode : null}
            />
            {/* Above the layer, so a grip wins the pointer over the element underneath it. */}
            {picking && <UIEditorTools />}
        </div>
    );
}
