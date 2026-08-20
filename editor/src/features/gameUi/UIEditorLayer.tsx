import { useEffect, useMemo, useRef } from 'react';
import { Node, UINode, isUINodeType } from 'cleo';
import { useCleoEngine } from '../EngineContext';
import UILayer from './UILayer';
import UIEditorTools from './UIEditorTools';

/**
 * The editor's wrapper around the shared {@link UILayer}.
 *
 * Everything editor-only lives here and nowhere else, so the layer the published player renders carries no
 * selection state, no force-show rules and no authoring affordances.
 *
 * Two behaviours it adds:
 *  - clicks SELECT instead of activating, and every element is hit-testable (so a non-interactive panel is
 *    still selectable);
 *  - a selected element is shown even when hidden, along with its ancestors.
 */
export default function UIEditorLayer() {
    const { instance, editorScene, eventEmitter, isPlayMode, editorMode, selectedNode } = useCleoEngine();
    const viewportRef = useRef<HTMLDivElement | null>(null);

    /**
     * The selected UI node plus every UI ancestor.
     *
     * The ancestor chain is required, not belt-and-braces: the DOM is NESTED, so a hidden ancestor's
     * `display: none` hides the selected descendant no matter what is written on the descendant itself.
     * Showing the selection without its chain would silently do nothing in exactly the case the feature
     * exists for — a child of a hidden Game Over panel.
     */
    const forceVisibleIds = useMemo(() => {
        const ids = new Set<string>();
        if (isPlayMode || !selectedNode || !editorScene) return ids;
        const node = editorScene.getNodeById(selectedNode);
        if (!node || !isUINodeType(node.nodeType)) return ids;
        for (let n: Node | null = node; n && isUINodeType(n.nodeType); n = n.parent) ids.add(n.id);
        return ids;
    }, [selectedNode, editorScene, isPlayMode]);

    // Read from the ENGINE's current scene, through a function, not from `editorScene`. Entering Play
    // calls `instance.setScene(playScene)`, so the tab's authoring scene is no longer the one rendering —
    // reading it would paint the editing HUD over the running game. A function rather than a value for the
    // same reason the player needs one: `Game.loadScene` swaps the scene out from under us.
    const getScene = useMemo(() => () => instance?.scene ?? null, [instance]);

    // In play mode the UI is live and owns its own input; while authoring, clicks select.
    const authoring = !isPlayMode;

    // Selection round-trips through the same event every other editor surface uses, so picking an element
    // in the viewport highlights its row in the scene tree and fills the inspector.
    const onSelect = useMemo(
        () => (id: string | null) => eventEmitter.emit('SELECT_NODE', id),
        [eventEmitter]);

    // Push the overlay's own box into the scene, so the layout solve anchors to what the user actually
    // sees. Deliberately measured here rather than taken from the canvas: in the editor the UI's container
    // is the viewport panel, and `currentViewport` would be the render-scaled internal size.
    useEffect(() => {
        const el = viewportRef.current;
        if (!el || !instance) return;
        const push = () => {
            const rect = el.getBoundingClientRect();
            // Written to whichever scene is live, so entering Play does not leave the play scene laying
            // out against a stale (or default) viewport.
            instance.scene?.setUIViewport(rect.width, rect.height, window.devicePixelRatio || 1);
        };
        push();
        const observer = new ResizeObserver(push);
        observer.observe(el);
        return () => observer.disconnect();
    }, [instance, isPlayMode]);

    // Authoring affordances are for `ui` mode only; in every other mode the UI still RENDERS (a HUD is part
    // of the scene and hiding it while placing geometry would be misleading) but is inert.
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
