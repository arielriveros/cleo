import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    CleoEngine, Scene, UINode, UIRootNode, UIImageNode, UIButtonNode, UIProgressBarNode,
    UISliderNode, UIToggleNode, UITextInputNode, UITextNode,
} from 'cleo';
import type { SceneChange } from 'cleo';
import { UIBinding, UIRegistry, syncUI } from './uiSync';

/**
 * The game UI, rendered as DOM over the WebGL canvas.
 *
 * Shared VERBATIM between the editor viewport and the published player, which is why it takes everything
 * as props and reads no React context: the player bundle has no `EngineContext`, and
 * `webpack.player.config.js` forbids anything editor-only from being reachable from its entry.
 *
 * Structure comes from the scene's UI nodes and re-renders only when the scene tree changes. Geometry and
 * content are written imperatively once per frame by {@link syncUI} — see that file for why.
 */

export interface UILayerProps {
    /**
     * The scene to render UI from.
     *
     * A FUNCTION, not a `Scene`: `Game.loadScene` replaces `engine.scene` wholesale, so a captured
     * reference would keep painting a scene that is no longer running.
     */
    getScene: () => Scene | null;
    /** Whether widgets accept input. False in the editor while authoring. */
    interactive: boolean;
    /**
     * Editor hook: called when an element is clicked while not interactive. Its presence is also what
     * makes every element clickable for selection.
     */
    onSelect?: (nodeId: string | null) => void;
    /** Editor hook: ids that must be shown even when hidden — the selection and its ancestors. */
    forceVisibleIds?: ReadonlySet<string>;
    /** Editor hook: the currently selected node, outlined. */
    selectedId?: string | null;
}

/** Base style every UI box starts from. Everything else is written by the sync pass. */
const BOX_STYLE: React.CSSProperties = {
    position: 'absolute',
    boxSizing: 'border-box',
    margin: 0,
    // Everything below is overwritten on the first sync; these are only so a fresh element cannot flash
    // at the wrong size before the first frame lands.
    left: 0, top: 0, width: 0, height: 0,
};

/** One UI node's element, plus its children. Registers itself in the binding registry for the sync pass. */
function UIElementView({ node, registry, onSelect, interactive, selectedId, forceVisibleIds }: {
    node: UINode;
    registry: UIRegistry;
    onSelect?: (nodeId: string | null) => void;
    interactive: boolean;
    selectedId?: string | null;
    forceVisibleIds?: ReadonlySet<string>;
}) {
    const boxRef = useRef<HTMLDivElement | null>(null);
    const labelRef = useRef<HTMLSpanElement | null>(null);
    const imageRef = useRef<HTMLImageElement | null>(null);
    const fillRef = useRef<HTMLDivElement | null>(null);
    const knobRef = useRef<HTMLDivElement | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        if (!boxRef.current) return;
        const binding: UIBinding = {
            node,
            box: boxRef.current,
            label: labelRef.current,
            image: imageRef.current,
            fill: fillRef.current,
            knob: knobRef.current,
            input: inputRef.current,
            // -1 so the first sync always writes: a fresh element has no styles yet, and the node's
            // versions may well already be past 0 by the time React commits.
            lastLayout: -1,
            lastRevision: -1,
        };
        registry.set(node.id, binding);
        return () => { registry.delete(node.id); };
    }, [node, registry]);

    const selected = selectedId === node.id;
    const forced = forceVisibleIds?.has(node.id) ?? false;

    // In the editor a click selects rather than activates. stopPropagation so the click lands on the
    // innermost element rather than every ancestor selecting in turn.
    const handleClick = useCallback((e: React.MouseEvent) => {
        if (onSelect && !interactive) {
            e.stopPropagation();
            e.preventDefault();
            onSelect(node.id);
            return;
        }
        if (!interactive) return;
        if (node instanceof UIButtonNode) { e.stopPropagation(); node.press(); }
        else if (node instanceof UIToggleNode) { e.stopPropagation(); node.toggle(); }
    }, [node, onSelect, interactive]);

    // A slider drags on the element itself: pointer capture means the drag keeps tracking even when the
    // cursor leaves the (often very thin) track.
    const handlePointerDown = useCallback((e: React.PointerEvent) => {
        if (!interactive || !(node instanceof UISliderNode)) return;
        e.stopPropagation();
        const el = e.currentTarget as HTMLElement;
        el.setPointerCapture(e.pointerId);
        const apply = (clientX: number, clientY: number) => {
            const box = el.getBoundingClientRect();
            const f = node.vertical
                ? 1 - (clientY - box.top) / Math.max(1, box.height)
                : (clientX - box.left) / Math.max(1, box.width);
            node.setValueFromFraction(f);
        };
        apply(e.clientX, e.clientY);
        const move = (ev: PointerEvent) => apply(ev.clientX, ev.clientY);
        const up = (ev: PointerEvent) => {
            el.releasePointerCapture(ev.pointerId);
            el.removeEventListener('pointermove', move);
            el.removeEventListener('pointerup', up);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
    }, [node, interactive]);

    const editorOutline: React.CSSProperties = selected
        ? { outline: '1px solid #fff', outlineOffset: 0 }
        : forced
            ? { outline: '1px dashed rgba(255,255,255,0.6)', outlineOffset: 0 }
            : {};

    // A forced-visible node is one the editor is showing despite `visible === false`. The sync pass writes
    // `display: none` from the node's own flag, so the override has to win here in the inline style.
    const forceStyle: React.CSSProperties = forced && !node.visible
        ? { display: 'block', opacity: 0.4 }
        : {};

    const children = node.uiChildren.map(child => (
        <UIElementView key={child.id} node={child} registry={registry} onSelect={onSelect}
            interactive={interactive} selectedId={selectedId} forceVisibleIds={forceVisibleIds} />
    ));

    const common = {
        ref: boxRef,
        'data-ui-id': node.id,
        style: { ...BOX_STYLE, ...editorOutline, ...forceStyle },
        onClick: handleClick,
        onPointerDown: handlePointerDown,
    } as any;

    if (node instanceof UIImageNode)
        return <div {...common}><img ref={imageRef} alt='' draggable={false} />{children}</div>;

    if (node instanceof UITextNode || node instanceof UIButtonNode)
        return <div {...common}><span ref={labelRef} />{children}</div>;

    if (node instanceof UIToggleNode)
        return <div {...common}><div ref={knobRef} /><span ref={labelRef} />{children}</div>;

    if (node instanceof UISliderNode)
        return <div {...common}><div ref={fillRef} /><div ref={knobRef} />{children}</div>;

    if (node instanceof UITextInputNode)
        return (
            <div {...common}>
                <input
                    ref={inputRef}
                    onChange={e => interactive && node.setValueFromInput(e.target.value)}
                    onKeyDown={e => { if (interactive && e.key === 'Enter') node.submit(); }}
                    // The engine owns the value; React must not also control it, or the caret jumps.
                    defaultValue={node.value}
                />
                {children}
            </div>
        );

    if (node instanceof UIProgressBarNode)
        return <div {...common}><div ref={fillRef} />{children}</div>;

    // Root, panel, stack, spacer: the box IS the element.
    return <div {...common}>{children}</div>;
}

export default function UILayer({ getScene, interactive, onSelect, forceVisibleIds, selectedId }: UILayerProps) {
    const registry = useMemo<UIRegistry>(() => new Map(), []);
    // "The editor is picking": clicks select instead of activating, and every element becomes hit-testable.
    const editorPick = !!onSelect && !interactive;
    // Bumped to force React to rebuild the element tree; the actual tree is read from the scene.
    const [structureTick, setStructureTick] = useState(0);

    const scene = getScene();

    // Structure only. The same filter SceneInspector and Scene itself use — a transform or component
    // change must NOT re-render here, or the whole point of the imperative sync is lost.
    useEffect(() => {
        const onChanged = (e?: SceneChange) => {
            if (e && e.kind !== 'structure' && e.kind !== 'visibility' && e.kind !== 'name') return;
            setStructureTick(t => t + 1);
        };
        CleoEngine.eventEmitter.on('SCENE_CHANGED', onChanged);
        return () => { CleoEngine.eventEmitter.off('SCENE_CHANGED', onChanged); };
    }, []);

    // Top-level roots only: a root nested under another root is rendered by its parent's subtree walk, so
    // rendering every root here as well would draw it twice.
    const roots = useMemo(() => {
        if (!scene) return [];
        const all = Array.from(scene.uiRoots);
        return all.filter(root => {
            for (let p = root.parent; p; p = p.parent) if (p instanceof UIRootNode) return false;
            return true;
        });
        // structureTick is the dependency that matters — the set is rebuilt from the scene each time.
    }, [scene, structureTick]);

    // The per-frame sync. Registered after mount, so it runs after the engine's own rAF (scheduled first
    // each frame) has already solved the layout for this frame.
    useEffect(() => {
        let raf = 0;
        let forceNext = true;
        const tick = () => {
            syncUI(registry, interactive, forceNext, editorPick);
            forceNext = false;
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [registry, interactive, editorPick]);

    // A structural change produces brand-new elements with no styles; force one full write immediately so
    // they are never visible at their placeholder size.
    useEffect(() => { syncUI(registry, interactive, true, editorPick); }, [structureTick, registry, interactive, editorPick, roots]);

    return (
        <div
            data-cleo-overlay
            style={{
                position: 'absolute', inset: 0, overflow: 'hidden',
                // Click-through while playing so the HUD never blocks the viewport; in the editor the
                // backdrop itself has to be hittable so clicking empty space can clear the selection.
                pointerEvents: editorPick ? 'auto' : 'none',
            }}
            // Clicking empty space clears the selection, which is what every other editor surface does.
            onClick={editorPick ? () => onSelect!(null) : undefined}
        >
            {roots.map(root => (
                <UIElementView key={root.id} node={root} registry={registry} onSelect={onSelect}
                    interactive={interactive} selectedId={selectedId} forceVisibleIds={forceVisibleIds} />
            ))}
        </div>
    );
}
