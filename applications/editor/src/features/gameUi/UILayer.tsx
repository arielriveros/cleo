import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CleoEngine } from 'cleo';
import type { Scene, SceneChange, UINode } from 'cleo';
import { UIBinding, UIRegistry, syncUI } from './uiSync';
import { isUI } from './uiTypes';

/**
 * The game UI, rendered as DOM over the WebGL canvas.
 *
 * Shared verbatim between the editor viewport and the published player, so it must take everything as
 * props and read no React context: the player bundle has no `EngineContext`, and
 * `vite.player.config.ts` forbids anything editor-only from being reachable from its entry.
 *
 * Structure comes from the scene's UI nodes; geometry and content are written imperatively once per frame
 * by {@link syncUI}.
 */

export interface UILayerProps {
    /**
     * The scene to render UI from. A function, not a `Scene`: `Game.loadScene` replaces `engine.scene`
     * wholesale, so a captured reference would paint a scene that is no longer running.
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
    // Overwritten on the first sync; present so a fresh element cannot flash at the wrong size.
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
            // -1 so the first sync always writes: the node's versions may be past 0 by the time React
            // commits.
            lastLayout: -1,
            lastRevision: -1,
        };
        registry.set(node.id, binding);
        return () => { registry.delete(node.id); };
    }, [node, registry]);

    const selected = selectedId === node.id;
    const forced = forceVisibleIds?.has(node.id) ?? false;

    // stopPropagation so the click lands on the innermost element, not every ancestor in turn.
    const handleClick = useCallback((e: React.MouseEvent) => {
        if (onSelect && !interactive) {
            e.stopPropagation();
            e.preventDefault();
            onSelect(node.id);
            return;
        }
        if (!interactive) return;
        if (isUI(node, 'uiButton')) { e.stopPropagation(); node.press(); }
        else if (isUI(node, 'uiToggle')) { e.stopPropagation(); node.toggle(); }
    }, [node, onSelect, interactive]);

    // Pointer capture keeps a slider drag tracking when the cursor leaves the thin track.
    const handlePointerDown = useCallback((e: React.PointerEvent) => {
        if (!interactive || !(isUI(node, 'uiSlider'))) return;
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

    // The sync pass writes `display: none` from the node's own flag, so a forced-visible override has to
    // win here in the inline style.
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

    if (isUI(node, 'uiImage'))
        return <div {...common}><img ref={imageRef} alt='' draggable={false} />{children}</div>;

    if (isUI(node, 'uiText') || isUI(node, 'uiButton'))
        return <div {...common}><span ref={labelRef} />{children}</div>;

    if (isUI(node, 'uiToggle'))
        return <div {...common}><div ref={knobRef} /><span ref={labelRef} />{children}</div>;

    if (isUI(node, 'uiSlider'))
        return <div {...common}><div ref={fillRef} /><div ref={knobRef} />{children}</div>;

    if (isUI(node, 'uiTextInput'))
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

    if (isUI(node, 'uiProgressBar'))
        return <div {...common}><div ref={fillRef} />{children}</div>;

    return <div {...common}>{children}</div>;
}

/**
 * A number per scene, for keys and effect dependencies that must change when the scene does. Not the scene:
 * React keeps a render's hook dependencies, its effect closures and its previous fiber (the alternate) after
 * the render, so a Scene held in any of them outlives a `Game.loadScene` — and with it every mesh array of
 * the scene that was left. A WeakMap holds no scene.
 */
const sceneSerials = new WeakMap<Scene, number>();
let nextSceneSerial = 1;
function sceneSerial(scene: Scene | null): number {
    if (!scene) return 0;
    let serial = sceneSerials.get(scene);
    if (serial === undefined) { serial = nextSceneSerial++; sceneSerials.set(scene, serial); }
    return serial;
}

/** The scene's top-level UI roots (a nested root is already rendered by its parent's subtree walk). */
function topLevelRoots(scene: Scene | null): UINode[] {
    if (!scene) return [];
    return Array.from(scene.uiRoots).filter(root => {
        for (let p = root.parent; p; p = p.parent) if (isUI(p, 'uiRoot')) return false;
        return true;
    });
}

/**
 * The per-frame sync, registered after mount so it runs after the engine's own rAF has solved this frame's
 * layout. A hook of its own, not inline in UILayer: the loop's closure lives as long as the layer does, and
 * V8 gives every closure made in one call the same scope — inline, it kept whatever scene UILayer's FIRST
 * render saw for the rest of the session.
 */
function useSyncLoop(registry: UIRegistry, interactive: boolean, editorPick: boolean): void {
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
}

export default function UILayer({ getScene, interactive, onSelect, forceVisibleIds, selectedId }: UILayerProps) {
    const registry = useMemo<UIRegistry>(() => new Map(), []);
    // Editor picking: clicks select instead of activating, and every element becomes hit-testable.
    const editorPick = !!onSelect && !interactive;
    // Bumped to force React to rebuild the element tree; the actual tree is read from the scene.
    const [structureTick, setStructureTick] = useState(0);

    // Read afresh every render and held by nothing React keeps: no closure here may name the scene or its
    // roots (see sceneSerial). The roots are computed per render rather than memoized, since a memo keeps
    // its dependencies — the scene — and the scan is a handful of nodes.
    const serial = sceneSerial(getScene());
    const roots = topLevelRoots(getScene());
    const rootsKey = roots.map(root => root.id).join('|');

    // Structure only: a transform or component change must not re-render here, or the imperative sync
    // is pointless.
    useEffect(() => {
        // One re-render per frame at most, however many nodes a frame adds or removes.
        let frame = 0;
        const onChanged = (e?: SceneChange) => {
            if (e && e.kind !== 'structure' && e.kind !== 'visibility' && e.kind !== 'name') return;
            if (frame) return;
            frame = requestAnimationFrame(() => { frame = 0; setStructureTick(t => t + 1); });
        };
        CleoEngine.eventEmitter.on('SCENE_CHANGED', onChanged);
        return () => { cancelAnimationFrame(frame); CleoEngine.eventEmitter.off('SCENE_CHANGED', onChanged); };
    }, []);

    useSyncLoop(registry, interactive, editorPick);

    // A structural change produces elements with no styles; force one full write immediately.
    useEffect(() => { syncUI(registry, interactive, true, editorPick); }, [structureTick, registry, interactive, editorPick, serial, rootsKey]);

    return (
        <div
            data-cleo-overlay
            style={{
                position: 'absolute', inset: 0, overflow: 'hidden',
                // Click-through while playing; hittable in the editor so empty space clears the selection.
                pointerEvents: editorPick ? 'auto' : 'none',
            }}
            onClick={editorPick ? () => onSelect!(null) : undefined}
        >
            {/* Keyed by scene too: a new scene's root with an old one's id must mount afresh, not update the old
                element, whose previous fiber would keep the old node (and its scene) a render longer. */}
            {roots.map(root => (
                <UIElementView key={`${serial}:${root.id}`} node={root} registry={registry} onSelect={onSelect}
                    interactive={interactive} selectedId={selectedId} forceVisibleIds={forceVisibleIds} />
            ))}
        </div>
    );
}
