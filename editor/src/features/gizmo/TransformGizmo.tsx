import { useEffect, useRef, useState } from 'react';
import { vec3, mat4, quat } from 'gl-matrix';
import { Raycaster, type Node } from 'cleo';
import { useCleoEngine } from '../EngineContext';
import { useSelection } from '../SelectionContext';
import { captureViewport, releaseViewport, isViewportCaptured } from '../../utils/pointerCapture';
import { gizmoWorldScale, effectiveGizmoSpace } from '../../utils/gizmoMath';
import { buildPickShapes, pickHandle, type GizmoFrame, type HandleId } from './gizmoPick';
import { buildHandles, placeHandles, tintHandles, thickenHandles, type GizmoHandle } from './gizmoHandles';
import {
    beginDrag,
    solveDrag,
    frameAxes,
    type DragSession,
    type DragViewContext,
    type TransformPatch,
    type GizmoOverlayModel,
} from './gizmoDrag';
import GizmoDragOverlay, { type GizmoOverlayHandle } from './GizmoDragOverlay';

/**
 * The transform gizmo: the move/rotate/scale handles drawn over the selection, and the drag that turns
 * cursor motion into a transform.
 *
 * Three structural rules worth knowing before editing this file.
 *
 * **The handles are children of the SCENE ROOT, never of the selection.** They copy the selected node's
 * world position each frame instead. Parenting them to the selection would inherit its rotation and
 * scale, so a handle on a node scaled 0.01 would be invisible and one on a node scaled 100 would fill
 * the screen — and every handle placement would land inside the user's own subtree, where the history
 * recorder snapshots it.
 *
 * **Nothing here re-renders during a drag.** All drag state lives in refs and a single rAF loop drives
 * placement, tinting and the readout. The previous implementation kept drag state in `useState`, so its
 * listener effect tore down and rebuilt four DOM listeners on every mouse move.
 *
 * **The drag ends on every exit path, including unmount.** `GIZMO_DRAG_START` disables the EditorCamera
 * input map and takes the pointer lock; if the matching END is ever missed — a tab switch mid-drag used
 * to do it — the editor camera stays dead for the rest of the session.
 */

interface TransformGizmoProps {
    selectedNodeId: string | null;
    onTransformChange: (nodeId: string, patch: TransformPatch) => void;
    viewportRef: React.RefObject<HTMLDivElement>;
}

/** Fraction of the viewport's height the gizmo spans, whatever the camera or the distance. */
const GIZMO_SCREEN_SIZE = 0.18;

export default function TransformGizmo({ selectedNodeId, onTransformChange, viewportRef }: TransformGizmoProps) {
    const { instance, editorScene, eventEmitter, withoutDirty } = useCleoEngine();
    const { gizmoMode, gizmoSpace } = useSelection();
    const [isPlayMode, setIsPlayMode] = useState(false);

    // Render-time ref mirrors, so the stable listener effect below never needs these in its deps.
    const selectedIdRef = useRef(selectedNodeId); selectedIdRef.current = selectedNodeId;
    const modeRef = useRef(gizmoMode); modeRef.current = gizmoMode;
    const spaceRef = useRef(gizmoSpace); spaceRef.current = gizmoSpace;
    const playRef = useRef(isPlayMode); playRef.current = isPlayMode;
    const applyRef = useRef(onTransformChange); applyRef.current = onTransformChange;

    const handlesRef = useRef<GizmoHandle[]>([]);
    const dragRef = useRef<DragSession | null>(null);
    const hoverRef = useRef<HandleId | null>(null);
    const overlayRef = useRef<GizmoOverlayHandle>(null);
    /** Under pointer lock `clientX/Y` freeze, so the drag advances its own cursor from raw movement. */
    const cursorRef = useRef<{ x: number; y: number } | null>(null);
    /**
     * Whether THIS drag ever actually held the pointer lock.
     *
     * `pointerlockchange` fires on entering a lock, on leaving one, and — the case that matters — with no
     * lock element at all when a request is refused, which happens wherever the lock is unavailable:
     * another element holds it, the gesture was not accepted, a browser or OS policy blocks it. Reading
     * that first event as "the user let go" ended the drag on its opening frame and left the gizmo
     * completely unusable. So a lockchange only ends a drag that HAD the lock; one that never got it stays
     * alive and ends on mouseup like any ordinary drag.
     */
    const lockedRef = useRef(false);
    /** Last solved readout, handed to the overlay by the rAF loop rather than drawn from the event. */
    const overlayModelRef = useRef<GizmoOverlayModel | null>(null);
    /** Handle-set identity, bumped whenever the nodes are rebuilt, so the rAF loop re-binds to them. */
    const [handleGeneration, setHandleGeneration] = useState(0);

    // ------------------------------------------------------------------------------------------------
    // Frame + ray helpers
    // ------------------------------------------------------------------------------------------------

    const selectedNode = (): Node | null => {
        const id = selectedIdRef.current;
        if (!id || !editorScene) return null;
        if (id === 'root' || id === editorScene.root?.id) return null;
        return editorScene.getNodeById(id) ?? null;
    };

    /** Where the gizmo sits and which way its handles point, for the live camera and selection. */
    const computeFrame = (node: Node): GizmoFrame | null => {
        const cam = instance?.scene?.activeCamera?.camera;
        if (!cam) return null;

        const origin = vec3.clone(node.worldPosition);
        const scale = gizmoWorldScale(
            { type: cam.type, fovDeg: cam.fov, top: cam.top, bottom: cam.bottom },
            cam.viewMatrix, origin, GIZMO_SCREEN_SIZE,
        );
        const axes = frameAxes(effectiveGizmoSpace(modeRef.current, spaceRef.current), node.worldQuaternion);

        // An orthographic camera's rays are all parallel, so "toward the camera" is its view axis rather
        // than a direction aimed at its position — those differ everywhere but the centre of the screen.
        const view = cam.viewMatrix;
        const toCamera = cam.type === 'orthographic'
            ? vec3.fromValues(view[2], view[6], view[10])
            : vec3.subtract(vec3.create(), cam.position, origin);
        vec3.normalize(toCamera, toCamera);

        return { origin, axes, scale, toCamera };
    };

    const viewContext = (cursor: { x: number; y: number }, delta: { x: number; y: number }): DragViewContext | null => {
        const cam = instance?.scene?.activeCamera?.camera;
        const rect = viewportRef.current?.getBoundingClientRect();
        if (!cam || !rect) return null;
        return {
            viewProj: mat4.multiply(mat4.create(), cam.projectionMatrix, cam.viewMatrix),
            viewportWidth: rect.width,
            viewportHeight: rect.height,
            cursor,
            cursorDelta: delta,
        };
    };

    const rayAt = (cursor: { x: number; y: number }) => {
        const cam = instance?.scene?.activeCamera?.camera;
        const rect = viewportRef.current?.getBoundingClientRect();
        if (!cam || !rect) return null;
        return Raycaster.screenToRay(cursor.x, cursor.y, rect.width, rect.height, cam);
    };

    const cursorFromEvent = (event: MouseEvent) => {
        const rect = viewportRef.current!.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    // ------------------------------------------------------------------------------------------------
    // Handle lifecycle
    // ------------------------------------------------------------------------------------------------

    // Rebuild on a mode change; each mode has its own handle set. Both halves run with dirty-marking
    // suppressed: these nodes live in the user's scene, and on a tab switch this cleanup runs before
    // EngineContext has re-pointed at the incoming tab.
    useEffect(() => {
        if (!instance || !editorScene) return;

        const handles = withoutDirty(() => {
            const built = buildHandles(gizmoMode);
            // addNodes puts them under the scene ROOT — see the note at the top of this file.
            editorScene.addNodes(...built.map(h => h.node));
            for (const h of built) h.node.visible = false;
            return built;
        });
        handlesRef.current = handles;
        setHandleGeneration(g => g + 1);

        return () => {
            withoutDirty(() => { for (const h of handles) editorScene.removeNode(h.node); });
            handlesRef.current = [];
        };
    }, [instance, editorScene, gizmoMode]);

    // ------------------------------------------------------------------------------------------------
    // The single per-frame loop: placement, tint and readout
    // ------------------------------------------------------------------------------------------------

    useEffect(() => {
        if (!instance || !editorScene) return;
        let raf = 0;

        const tick = () => {
            raf = requestAnimationFrame(tick);
            const handles = handlesRef.current;
            if (!handles.length) return;

            const node = selectedNode();
            const drag = dragRef.current;
            const frame = node && !playRef.current ? computeFrame(node) : null;

            if (!frame) {
                withoutDirty(() => placeHandles(handles, EMPTY_FRAME, true));
                overlayRef.current?.draw(null, null);
                return;
            }

            // Mid-drag the handle set is FROZEN at its grab-time size and orientation: a handle that
            // resized or re-aimed under the cursor would change the very lengths and axes the solver is
            // measuring against. Only a translate drag lets the body follow the node it is moving.
            const placement: GizmoFrame = drag
                ? { origin: drag.mode === 'position' ? frame.origin : drag.origin, axes: drag.axes, scale: drag.gizmoScale, toCamera: frame.toCamera }
                : frame;

            withoutDirty(() => placeHandles(handles, placement, false));
            tintHandles(handles, hoverRef.current, drag?.handle ?? null);
            thickenHandles(handles, hoverRef.current, drag?.handle ?? null);

            const rect = viewportRef.current?.getBoundingClientRect();
            const cam = instance.scene?.activeCamera?.camera;
            if (drag && rect && cam) {
                overlayRef.current?.draw(overlayModelRef.current, {
                    viewProj: mat4.multiply(mat4.create(), cam.projectionMatrix, cam.viewMatrix),
                    width: rect.width,
                    height: rect.height,
                });
            } else {
                overlayRef.current?.draw(null, null);
            }
        };

        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [instance, editorScene, handleGeneration]);

    // ------------------------------------------------------------------------------------------------
    // Input
    // ------------------------------------------------------------------------------------------------

    useEffect(() => {
        if (!instance || !editorScene || !viewportRef.current) return;
        const viewport = viewportRef.current;

        const inOverlay = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('[data-cleo-overlay]');

        const endDrag = () => {
            const drag = dragRef.current;
            if (!drag) return;
            dragRef.current = null;
            overlayModelRef.current = null;
            cursorRef.current = null;
            lockedRef.current = false;
            if (isViewportCaptured()) releaseViewport();
            // Re-enables the EditorCamera input map and closes the undo interaction. Every exit path
            // below funnels through here so neither can be left dangling.
            eventEmitter.emit('GIZMO_DRAG_END', { axis: drag.handle, nodeId: selectedIdRef.current });
        };

        const onMouseDown = (event: MouseEvent) => {
            if (event.button !== 0 || playRef.current) return;
            // The floating viewport chrome sits over the canvas; a click on it is not a click in the world.
            if (inOverlay(event.target)) return;

            const node = selectedNode();
            if (!node) return;
            const frame = computeFrame(node);
            if (!frame) return;

            const cursor = cursorFromEvent(event);
            const ray = rayAt(cursor);
            const view = viewContext(cursor, { x: 0, y: 0 });
            if (!ray || !view) return;

            const hit = pickHandle(ray.origin, ray.direction, buildPickShapes(modeRef.current, frame));
            if (!hit) return;

            event.preventDefault();
            event.stopPropagation();

            const parent = node.parent;
            dragRef.current = beginDrag(
                hit.id, modeRef.current, effectiveGizmoSpace(modeRef.current, spaceRef.current), frame,
                {
                    worldPosition: node.worldPosition,
                    worldQuaternion: node.worldQuaternion,
                    localPosition: node.position,
                    localScale: node.scale,
                    // The scene root's transform is the identity; passing null skips a matrix inversion
                    // per drag and keeps the common case exact.
                    parentWorldTransform: parent && parent !== editorScene.root ? parent.worldTransform : null,
                    parentWorldQuaternion: parent ? parent.worldQuaternion : IDENTITY_QUAT,
                },
                ray.origin, ray.direction, view,
            );

            // Grabbing a handle is unambiguous drag intent, so capture straight away — the drag can then
            // run past the edge of the viewport without stalling.
            cursorRef.current = { ...cursor };
            lockedRef.current = false;
            captureViewport(instance);
            eventEmitter.emit('GIZMO_DRAG_START', { axis: hit.id, nodeId: node.id });
        };

        const onDragMove = (event: MouseEvent) => {
            const drag = dragRef.current;
            if (!drag) return;
            event.preventDefault();

            const previous = cursorRef.current ?? { x: 0, y: 0 };
            const cursor = isViewportCaptured()
                ? { x: previous.x + event.movementX, y: previous.y + event.movementY }
                : cursorFromEvent(event);
            const delta = { x: cursor.x - previous.x, y: cursor.y - previous.y };
            cursorRef.current = cursor;

            const ray = rayAt(cursor);
            const view = viewContext(cursor, delta);
            const nodeId = selectedIdRef.current;
            if (!ray || !view || !nodeId) return;

            // Read the modifier off the event, not from state, so it can be pressed and released mid-drag.
            const result = solveDrag(drag, ray.origin, ray.direction, view, event.ctrlKey || event.metaKey);
            overlayModelRef.current = result.degenerate ? null : result.overlay;
            if (!result.degenerate) applyRef.current(nodeId, result.patch);
        };

        const onHoverMove = (event: MouseEvent) => {
            if (dragRef.current || playRef.current) return;
            if (inOverlay(event.target)) { hoverRef.current = null; return; }

            const node = selectedNode();
            const frame = node ? computeFrame(node) : null;
            if (!frame) { hoverRef.current = null; return; }

            const ray = rayAt(cursorFromEvent(event));
            const hit = ray ? pickHandle(ray.origin, ray.direction, buildPickShapes(modeRef.current, frame)) : null;
            hoverRef.current = hit?.id ?? null;
            viewport.style.cursor = hit ? 'pointer' : '';
        };

        const onMouseUp = () => endDrag();
        // The browser drops the lock on Escape or a tab switch; treat either as the end of the drag so
        // the gizmo cannot stay glued to a cursor that is no longer there.
        const onLockChange = () => {
            if (isViewportCaptured()) { lockedRef.current = true; return; }
            if (lockedRef.current) endDrag();
        };
        const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') endDrag(); };
        const onBlur = () => endDrag();

        viewport.addEventListener('mousedown', onMouseDown);
        viewport.addEventListener('mousemove', onHoverMove);
        document.addEventListener('mousemove', onDragMove);
        document.addEventListener('mouseup', onMouseUp);
        document.addEventListener('pointerlockchange', onLockChange);
        document.addEventListener('keydown', onKeyDown);
        window.addEventListener('blur', onBlur);

        return () => {
            viewport.removeEventListener('mousedown', onMouseDown);
            viewport.removeEventListener('mousemove', onHoverMove);
            document.removeEventListener('mousemove', onDragMove);
            document.removeEventListener('mouseup', onMouseUp);
            document.removeEventListener('pointerlockchange', onLockChange);
            document.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('blur', onBlur);
            viewport.style.cursor = '';
            // Unmounting mid-drag must still release the pointer and re-enable the editor camera.
            endDrag();
        };
    }, [instance, editorScene, eventEmitter]);

    useEffect(() => {
        const onPlayState = (state: 'play' | 'pause' | 'stop') => setIsPlayMode(state === 'play');
        eventEmitter.on('SET_PLAY_STATE', onPlayState);
        return () => { eventEmitter.off('SET_PLAY_STATE', onPlayState); };
    }, [eventEmitter]);

    return <GizmoDragOverlay ref={overlayRef} />;
}

const IDENTITY_QUAT = quat.create();
/** Placeholder frame for the hidden case; `placeHandles` reads nothing from it when `hidden` is set. */
const EMPTY_FRAME: GizmoFrame = {
    origin: vec3.create(),
    axes: [vec3.fromValues(1, 0, 0), vec3.fromValues(0, 1, 0), vec3.fromValues(0, 0, 1)],
    scale: 1,
    toCamera: vec3.fromValues(0, 0, 1),
};
