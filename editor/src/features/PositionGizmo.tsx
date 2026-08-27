import { useEffect, useRef, useState } from "react";
import { useCleoEngine, GizmoMode } from "./EngineContext";
import { useSelection } from "./SelectionContext";
import { Model, ModelNode, Material, Geometry, Vec } from "cleo";
import { GizmoGeometry } from "../utils/GizmoGeometry";
import { Raycaster } from "cleo";
import { captureViewport, releaseViewport, isViewportCaptured } from "../utils/pointerCapture";

interface TransformGizmoProps {
    selectedNodeId: string | null;
    onTransformChange: (nodeId: string, mode: GizmoMode, value: [number, number, number]) => void;
    viewportRef: React.RefObject<HTMLDivElement>;
}

type GizmoAxis = 'x' | 'y' | 'z' | null;
type Transform = { pos: [number, number, number]; rot: [number, number, number]; scale: [number, number, number]; rotQuat: number[] };

export default function PositionGizmo({ selectedNodeId, onTransformChange, viewportRef }: TransformGizmoProps) {
    const { instance, editorScene, eventEmitter, withoutDirty } = useCleoEngine();
    const { gizmoMode } = useSelection();
    const [isDragging, setIsDragging] = useState(false);
    const [draggedAxis, setDraggedAxis] = useState<GizmoAxis>(null);
    const [dragStartPos, setDragStartPos] = useState<{ x: number; y: number } | null>(null);
    const [gizmoNodes, setGizmoNodes] = useState<{
        xAxis: ModelNode | null;
        yAxis: ModelNode | null;
        zAxis: ModelNode | null;
        xLine: ModelNode | null;
        yLine: ModelNode | null;
        zLine: ModelNode | null;
    }>({
        xAxis: null,
        yAxis: null,
        zAxis: null,
        xLine: null,
        yLine: null,
        zLine: null
    });
    const [initialMousePos, setInitialMousePos] = useState<{ x: number; y: number } | null>(null);
    const [initialTransform, setInitialTransform] = useState<Transform | null>(null);
    const [isPlayMode, setIsPlayMode] = useState(false);
    // While the mouse is captured `clientX/clientY` stop moving, so the drag tracks its own cursor,
    // advanced by the raw movement deltas. Seeded at the grab point so the maths below is unchanged.
    const cursor = useRef<{ x: number; y: number } | null>(null);

    // Create the gizmo node set for the given mode: position = arrows + shaft lines, scale = cube tips +
    // shaft lines, rotation = a ring per axis. Returns every created node for cleanup. All are tagged
    // `isGizmo` so the renderer draws them on top (depth test off) and the selection raycast skips them.
    const createGizmoNodes = (mode: GizmoMode): ModelNode[] => {
        if (!instance || !editorScene) return [];

        const basic = (color: [number, number, number]) =>
            Material.Basic({ color }, { wireframe: false, transparent: false, castShadow: false });
        const xMaterial = basic([1, 0, 0]);
        const yMaterial = basic([0, 1, 0]);
        const zMaterial = basic([0, 0, 1]);

        let xGeo: Geometry, yGeo: Geometry, zGeo: Geometry;
        let hasLines = true;
        if (mode === 'rotation') {
            xGeo = GizmoGeometry.RingX(); yGeo = GizmoGeometry.RingY(); zGeo = GizmoGeometry.RingZ();
            hasLines = false;
        } else if (mode === 'scale') {
            xGeo = Geometry.Cube(0.15, 0.15, 0.15); yGeo = Geometry.Cube(0.15, 0.15, 0.15); zGeo = Geometry.Cube(0.15, 0.15, 0.15);
        } else {
            xGeo = GizmoGeometry.ArrowX(1, 0.2); yGeo = GizmoGeometry.ArrowY(1, 0.2); zGeo = GizmoGeometry.ArrowZ(1, 0.2);
        }

        const xAxisNode = new ModelNode('__editor__gizmo__x_axis', new Model(xGeo, xMaterial));
        const yAxisNode = new ModelNode('__editor__gizmo__y_axis', new Model(yGeo, yMaterial));
        const zAxisNode = new ModelNode('__editor__gizmo__z_axis', new Model(zGeo, zMaterial));
        (xAxisNode as any).isGizmo = true;
        (yAxisNode as any).isGizmo = true;
        (zAxisNode as any).isGizmo = true;

        const created: ModelNode[] = [xAxisNode, yAxisNode, zAxisNode];
        let xLineNode: ModelNode | null = null, yLineNode: ModelNode | null = null, zLineNode: ModelNode | null = null;
        if (hasLines) {
            xLineNode = new ModelNode('__editor__gizmo__x_line', new Model(Geometry.Cube(0.8, 0.02, 0.02), xMaterial));
            yLineNode = new ModelNode('__editor__gizmo__y_line', new Model(Geometry.Cube(0.02, 0.8, 0.02), yMaterial));
            zLineNode = new ModelNode('__editor__gizmo__z_line', new Model(Geometry.Cube(0.02, 0.02, 0.8), zMaterial));
            (xLineNode as any).isGizmo = true;
            (yLineNode as any).isGizmo = true;
            (zLineNode as any).isGizmo = true;
            created.push(xLineNode, yLineNode, zLineNode);
        }

        editorScene.addNodes(...created);
        setGizmoNodes({ xAxis: xAxisNode, yAxis: yAxisNode, zAxis: zAxisNode, xLine: xLineNode, yLine: yLineNode, zLine: zLineNode });
        return created;
    };

    // Screen-space size factor: keep the gizmo a constant apparent size regardless of camera distance.
    // Perspective — the world size covering a fixed fraction of the viewport grows with distance and with
    // tan(fov/2). Orthographic — apparent size is distance-independent, so it comes from the vertical extent.
    const GIZMO_SCREEN_SIZE = 0.15;
    const computeGizmoScale = (worldPos: ArrayLike<number>): number => {
        const cam = instance?.scene?.activeCamera?.camera;
        if (!cam) return 1;
        if (cam.type === 'orthographic') {
            return Math.max((cam.top - cam.bottom) * GIZMO_SCREEN_SIZE, 1e-3);
        }
        const camPos = cam.position;
        const dx = camPos[0] - worldPos[0];
        const dy = camPos[1] - worldPos[1];
        const dz = camPos[2] - worldPos[2];
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const halfFov = (cam.fov * Math.PI / 180) / 2;
        return Math.max(dist * Math.tan(halfFov) * GIZMO_SCREEN_SIZE, 1e-3);
    };

    const updateGizmoPosition = () => {
        if (!selectedNodeId || !editorScene) return;

        const selectedNode = editorScene.getNodeById(selectedNodeId);
        if (!selectedNode) return;

        const worldPos = selectedNode.worldPosition;
        const s = computeGizmoScale(worldPos);
        // Rings sit centered on the node; arrows/scale-handles sit half a unit out along their axis.
        const off = gizmoMode === 'rotation' ? 0 : 0.5;
        // Rotation/scale handles follow the node's rotation (they operate in its local frame); the
        // position gizmo stays world-aligned (translation is applied in world/parent space).
        const oriented = gizmoMode !== 'position';
        const q = selectedNode.worldQuaternion;
        const identity: [number, number, number, number] = [0, 0, 0, 1];

        const place = (node: ModelNode | null, dir: [number, number, number]) => {
            if (!node) return;
            node.setScale([s, s, s]);
            node.setQuaternion(oriented ? q : identity);
            // Offset the handle along its axis, rotated into the node's local frame when oriented.
            const d = oriented ? (Vec.vec3.transformQuat(Vec.vec3.create(), dir, q) as unknown as [number, number, number]) : dir;
            node.setPosition([worldPos[0] + d[0] * off * s, worldPos[1] + d[1] * off * s, worldPos[2] + d[2] * off * s]);
        };
        place(gizmoNodes.xAxis, [1, 0, 0]);
        place(gizmoNodes.yAxis, [0, 1, 0]);
        place(gizmoNodes.zAxis, [0, 0, 1]);

        const placeLine = (node: ModelNode | null) => {
            if (!node) return;
            node.setScale([s, s, s]);
            node.setQuaternion(oriented ? q : identity);
            node.setPosition([worldPos[0], worldPos[1], worldPos[2]]);
        };
        placeLine(gizmoNodes.xLine); placeLine(gizmoNodes.yLine); placeLine(gizmoNodes.zLine);
    };

    const handleMouseDown = (event: MouseEvent) => {
        if (!selectedNodeId || !instance || !instance.scene || !editorScene || !viewportRef.current) return;

        if (event.button !== 0) return;

        const rect = viewportRef.current.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;

        const activeCamera = instance.scene.activeCamera;
        if (!activeCamera) return;

        const ray = Raycaster.screenToRay(
            x,
            y,
            rect.width,
            rect.height,
            activeCamera.camera
        );

        // Check for gizmo handle hits. Include the shaft lines and use AABB-only picking (precise=false)
        // so the whole axis is an easy, occlusion-independent grab target — the gizmo always wins.
        const gizmoNodesList = [
            gizmoNodes.xAxis, gizmoNodes.yAxis, gizmoNodes.zAxis,
            gizmoNodes.xLine, gizmoNodes.yLine, gizmoNodes.zLine,
        ].filter((node): node is ModelNode => node !== null);
        const hits = Raycaster.raycast(ray, gizmoNodesList, Infinity, false);

        if (hits.length > 0) {
            const hitNode = hits[0].node;
            let axis: GizmoAxis = null;

            if (hitNode === gizmoNodes.xAxis || hitNode === gizmoNodes.xLine) axis = 'x';
            else if (hitNode === gizmoNodes.yAxis || hitNode === gizmoNodes.yLine) axis = 'y';
            else if (hitNode === gizmoNodes.zAxis || hitNode === gizmoNodes.zLine) axis = 'z';

            if (axis) {
                event.preventDefault(); // Prevent default mouse behavior
                event.stopPropagation(); // Stop event bubbling
                setIsDragging(true);
                setDraggedAxis(axis);
                setInitialMousePos({ x, y });
                setDragStartPos({ x, y });

                // Grabbing a handle is unambiguous drag intent, so capture straight away — the drag can
                // then run past the edge of the viewport (or the screen) without stalling.
                cursor.current = { x, y };
                captureViewport(instance);

                eventEmitter.emit('GIZMO_DRAG_START', { axis, nodeId: selectedNodeId });

                const selectedNode = editorScene.getNodeById(selectedNodeId);
                if (selectedNode) {
                    setInitialTransform({
                        pos: Array.from(selectedNode.position) as [number, number, number],
                        rot: Array.from(selectedNode.rotation) as [number, number, number],
                        scale: Array.from(selectedNode.scale) as [number, number, number],
                        rotQuat: Array.from(selectedNode.worldQuaternion),
                    });
                }
            }
        }
    };

    const handleMouseMove = (event: MouseEvent) => {
        if (!isDragging || !draggedAxis || !selectedNodeId || !editorScene || !viewportRef.current || !initialMousePos || !initialTransform || !dragStartPos) return;

        event.preventDefault(); // Prevent default mouse behavior

        // Advance the drag cursor: by raw movement while captured (client coords are frozen), otherwise
        // straight from the event.
        const c = cursor.current ?? { x: initialMousePos.x, y: initialMousePos.y };
        if (isViewportCaptured()) {
            c.x += event.movementX;
            c.y += event.movementY;
        } else {
            const rect = viewportRef.current.getBoundingClientRect();
            c.x = event.clientX - rect.left;
            c.y = event.clientY - rect.top;
        }
        cursor.current = c;
        const x = c.x;
        const y = c.y;

        const deltaX = x - dragStartPos.x;
        const deltaY = y - dragStartPos.y;
        const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

        if (distance < 5) {
            return;
        }

        const moveDeltaX = x - initialMousePos.x;
        const moveDeltaY = y - initialMousePos.y;

        const camera = instance?.scene.activeCamera;
        if (!camera) return;

        const viewMatrix = camera.camera.viewMatrix;
        const cameraRight = [viewMatrix[0], viewMatrix[4], viewMatrix[8]];
        const cameraUp = [viewMatrix[1], viewMatrix[5], viewMatrix[9]];
        const axisIndex = draggedAxis === 'x' ? 0 : draggedAxis === 'y' ? 1 : 2;

        // Signed amount the mouse dragged along the given world axis (screen right/up projected onto it).
        const projectOntoAxis = (component: number): number => {
            const sensitivity = 0.01;
            switch (draggedAxis) {
                case 'x': return cameraRight[0] * moveDeltaX * sensitivity + cameraUp[0] * (-moveDeltaY) * sensitivity;
                case 'y': return -moveDeltaY * sensitivity; // Y reads cleanly off vertical mouse motion
                case 'z': return cameraRight[2] * moveDeltaX * sensitivity + cameraUp[2] * (-moveDeltaY) * sensitivity;
            }
            return component;
        };

        if (gizmoMode === 'rotation') {
            const ROT_SENSITIVITY = 0.5; // degrees per pixel (euler is in degrees)
            const newRotation: [number, number, number] = [...initialTransform.rot];
            newRotation[axisIndex] = initialTransform.rot[axisIndex] + moveDeltaX * ROT_SENSITIVITY;
            onTransformChange(selectedNodeId, 'rotation', newRotation);
        } else if (gizmoMode === 'scale') {
            // Scale handles point along the node's local axes, so project the mouse onto the local axis
            // direction (world axis rotated by the node's rotation captured at drag start).
            const sensitivity = 0.01;
            const axisUnit: [number, number, number] = [axisIndex === 0 ? 1 : 0, axisIndex === 1 ? 1 : 0, axisIndex === 2 ? 1 : 0];
            const a = Vec.vec3.transformQuat(Vec.vec3.create(), axisUnit, initialTransform.rotQuat as any);
            Vec.vec3.normalize(a, a);
            const delta = (Vec.vec3.dot(a as any, cameraRight as any) * moveDeltaX + Vec.vec3.dot(a as any, cameraUp as any) * (-moveDeltaY)) * sensitivity;
            const newScale: [number, number, number] = [...initialTransform.scale];
            newScale[axisIndex] = Math.max(0.01, initialTransform.scale[axisIndex] + delta);
            onTransformChange(selectedNodeId, 'scale', newScale);
        } else {
            const delta = projectOntoAxis(0);
            const newPosition: [number, number, number] = [...initialTransform.pos];
            newPosition[axisIndex] = initialTransform.pos[axisIndex] + delta;
            onTransformChange(selectedNodeId, 'position', newPosition);
        }

        updateGizmoPosition();
    };

    const endDrag = () => {
        if (isDragging) {
            eventEmitter.emit('GIZMO_DRAG_END', { axis: draggedAxis, nodeId: selectedNodeId });
        }

        setIsDragging(false);
        setDraggedAxis(null);
        setInitialMousePos(null);
        setInitialTransform(null);
        setDragStartPos(null);
        cursor.current = null;
    };

    const handleMouseUp = () => {
        if (isDragging) releaseViewport();
        endDrag();
    };

    // Build (and rebuild on mode change) the gizmo node set; remove the previous set on cleanup. Both
    // halves must run with dirty-marking suppressed: the gizmo's nodes live in the scene, and on a tab
    // switch this cleanup runs before EngineContext has re-pointed activeTabIdRef at the incoming tab.
    useEffect(() => {
        if (!instance || !editorScene) return;
        const created = withoutDirty(() => createGizmoNodes(gizmoMode));
        return () => {
            withoutDirty(() => { for (const n of created) editorScene.removeNode(n); });
            setGizmoNodes({ xAxis: null, yAxis: null, zAxis: null, xLine: null, yLine: null, zLine: null });
        };
    }, [instance, editorScene, gizmoMode]);

    // Update gizmo visibility and position
    useEffect(() => {
        if (!gizmoNodes.xAxis || !gizmoNodes.yAxis || !gizmoNodes.zAxis) return;

        const isRootNode = selectedNodeId === 'root' || selectedNodeId === editorScene?.root?.id;
        const show = !!selectedNodeId && !isPlayMode && !isRootNode;

        // The gizmo's nodes live in the editor scene, so `visible` emits SCENE_CHANGED exactly like a real
        // node edit — and merely SELECTING something would then mark the scene unsaved. It is chrome, not
        // the user's work, so the toggle runs with dirty-marking suppressed.
        withoutDirty(() => {
            const setVisible = (node: ModelNode | null) => { if (node) node.visible = show; };
            setVisible(gizmoNodes.xAxis); setVisible(gizmoNodes.yAxis); setVisible(gizmoNodes.zAxis);
            setVisible(gizmoNodes.xLine); setVisible(gizmoNodes.yLine); setVisible(gizmoNodes.zLine);
        });

        if (show) updateGizmoPosition();
    }, [selectedNodeId, gizmoNodes, isPlayMode, editorScene]);

    // Update gizmo position continuously when dragging
    useEffect(() => {
        if (isDragging && selectedNodeId) {
            updateGizmoPosition();
        }
    }, [isDragging, selectedNodeId]);

    // Keep the gizmo at a constant screen size every frame. The camera can orbit/zoom without a
    // selection change (which the selection-driven effects wouldn't catch), so recompute the
    // distance-based scale each animation frame while a node is selected and not in play mode.
    useEffect(() => {
        if (!gizmoNodes.xAxis) return;
        const isRootNode = selectedNodeId === 'root' || selectedNodeId === editorScene?.root?.id;
        if (!selectedNodeId || isPlayMode || isRootNode) return;

        let raf = 0;
        const tick = () => {
            updateGizmoPosition();
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [selectedNodeId, gizmoNodes, isPlayMode, editorScene, gizmoMode]);


    // Set up mouse event listeners. The grab is picked up from the viewport, but the drag itself lives
    // on the document: a captured pointer delivers its events to the locked element, and even without
    // capture a release outside the viewport must still end the drag rather than strand it.
    useEffect(() => {
        if (!viewportRef.current) return;

        const viewport = viewportRef.current;
        // The browser drops the lock on Escape (or a tab switch); treat that as the end of the drag so
        // the gizmo can't stay glued to the cursor.
        const handleLockChange = () => { if (isDragging && !isViewportCaptured()) endDrag(); };

        viewport.addEventListener('mousedown', handleMouseDown);
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
        document.addEventListener('pointerlockchange', handleLockChange);

        return () => {
            viewport.removeEventListener('mousedown', handleMouseDown);
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
            document.removeEventListener('pointerlockchange', handleLockChange);
        };
    }, [selectedNodeId, isDragging, draggedAxis, initialMousePos, initialTransform, dragStartPos, gizmoNodes, gizmoMode]);

    // Listen for play state changes
    useEffect(() => {
        const handlePlayState = (state: 'play' | 'pause' | 'stop') => {
            setIsPlayMode(state === 'play');
        };

        eventEmitter.on('SET_PLAY_STATE', handlePlayState);

        return () => {
            eventEmitter.off('SET_PLAY_STATE', handlePlayState);
        };
    }, [eventEmitter]);

    return null; // This component doesn't render anything visible
}
