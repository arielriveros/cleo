import React, { useEffect, useRef, useState } from "react";
import { useCleoEngine } from "./EngineContext";
import { Raycaster, Node, Vec, Logger } from "cleo";
import PositionGizmo from "./PositionGizmo";
import LandscapeBrush from "./landscape/LandscapeBrush";
import LandscapeInspector from "./landscape/LandscapeInspector";
import RendererOptions from "./renderer/RendererOptions";
import RendererStats from "./renderer/RendererStats";
import AnimationSkeletonTool from "./animation/AnimationSkeletonTool";
import AnimationPlayer from "./animation/AnimationPlayer";
import { useStateMachine } from "./animation/StateMachineContext";
import { SegmentedControl } from "../components/ui";
import { instantiateTemplate, templateInstanceRootOf } from "../utils/templates";
import { instantiateMeshAsset } from "../utils/meshes";
import { NEW_NODE_MIME, addItemTo, findAddItem } from "./sceneInspector/addCatalog";
import { captureViewport, releaseViewport } from "../utils/pointerCapture";
import { GizmoMode } from "./EngineContext";

// One segment of the Move/Rotate/Scale toggle, styled to match the top-toolbar ModeSelector.
function GizmoSeg({ active, title, onClick, children }: { active: boolean; title: string; onClick: () => void; children: React.ReactNode }) {
    return (
        <button
            data-cleo-overlay
            className={`flex items-center justify-center w-[26px] h-[25px] border-r border-control-hover last:border-r-0 transition-colors cursor-pointer
                ${active ? 'bg-selected text-white' : 'bg-control text-muted hover:bg-control-hover'}`}
            title={title}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

// Compact glyphs (stroke currentColor) for the gizmo-mode toggle.
const MoveIcon = () => (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3v18M3 12h18M12 3 9 6M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3" />
    </svg>
);
const RotateIcon = () => (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 12a8 8 0 1 1-2.3-5.6" /><path d="M20 4v4h-4" />
    </svg>
);
const ScaleIcon = () => (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="4" width="10" height="10" rx="1" /><path d="M14 14l6 6M20 15v5h-5" />
    </svg>
);

export default function EngineViewport() {
    const { instance, editorScene, eventEmitter, selectedNode, isGizmoDragging, isPlayMode, editorMode,
            gizmoMode, setGizmoMode, templateRootId, meshEditTargetId, templates, meshes, materials, scripts, bodies, triggers, terrainBrush } = useCleoEngine();
    const { graphView, setGraphView } = useStateMachine();
    // The node graph covers the canvas, so viewport chrome (gizmo modes, 2D/3D) has nothing to act on.
    const hideForGraph = editorMode === 'animation' && graphView;
    const viewportRef = useRef<HTMLDivElement>(null);
    // The landscape brush mode is a ref (not reactive); mirror it so the terrain move-gizmo mounts on demand.
    const [terrainMode, setTerrainMode] = useState(terrainBrush.current.mode);
    useEffect(() => {
        const onChange = () => setTerrainMode(terrainBrush.current.mode);
        eventEmitter.on('TERRAIN_BRUSH_CHANGED', onChange);
        return () => { eventEmitter.off('TERRAIN_BRUSH_CHANGED', onChange); };
    }, [eventEmitter, terrainBrush]);
    const [isDragging, setIsDragging] = useState(false);
    const [dragStartPos, setDragStartPos] = useState<{ x: number; y: number } | null>(null);
    const wasDraggingRef = useRef(false);
    const isGizmoDraggingRef = useRef(false);
    const justFinishedGizmoDragRef = useRef(false);
    // Mirror the viewport dimension so the floating 2D/3D control reflects the current state.
    const [dimension, setDimension] = useState<'2D' | '3D'>('3D');
    useEffect(() => {
        const onDim = (d: '2D' | '3D') => setDimension(d);
        eventEmitter.on('CHANGE_DIMENSION', onDim);
        return () => { eventEmitter.off('CHANGE_DIMENSION', onDim); };
    }, [eventEmitter]);
 
    useEffect(() => {
        if (viewportRef.current && instance) {
            viewportRef.current.style.height = "100%";
            viewportRef.current.style.backgroundColor = "black";
            instance.setViewport(viewportRef.current);
            instance.renderer.resize();
        }
    }, [instance, viewportRef]);

    // The canvas is sized from this div's clientWidth/Height (renderer.resize measures the parent),
    // and under dockview nothing else reacts to panel geometry — sash drags, docking, floating and
    // per-mode panel changes all land here. rAF-throttled because resize() reallocates the FBOs.
    useEffect(() => {
        const el = viewportRef.current;
        if (!el || !instance) return;
        let raf = 0;
        const observer = new ResizeObserver(() => {
            cancelAnimationFrame(raf);
            raf = requestAnimationFrame(() => instance.renderer.resize());
        });
        observer.observe(el);
        return () => { cancelAnimationFrame(raf); observer.disconnect(); };
    }, [instance]);

    useEffect(() => {
        if (!viewportRef.current || !instance) return;

        // Clicks on floating viewport overlays (e.g. the 2D/3D control) bubble to these div-level
        // listeners; ignore them so they don't deselect nodes or start a drag.
        const inOverlay = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('[data-cleo-overlay]');

        // Any button starts a potential drag: left orbits the camera, right pans, and both should end up
        // captured (see handleMouseMove).
        const handleMouseDown = (event: MouseEvent) => {
            if (inOverlay(event.target)) return;
            const rect = viewportRef.current!.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;
            setDragStartPos({ x, y });
            setIsDragging(false);
            wasDraggingRef.current = false;
        };

        const handleMouseMove = (event: MouseEvent) => {
            if (dragStartPos && !isGizmoDragging) {
                const rect = viewportRef.current!.getBoundingClientRect();
                const x = event.clientX - rect.left;
                const y = event.clientY - rect.top;

                const deltaX = Math.abs(x - dragStartPos.x);
                const deltaY = Math.abs(y - dragStartPos.y);

                // If mouse moved more than 5 pixels, consider it a drag
                if (deltaX > 5 || deltaY > 5) {
                    setIsDragging(true);
                    wasDraggingRef.current = true;
                    // The camera is being dragged, so capture the mouse: the orbit/pan can then run
                    // indefinitely without the cursor escaping the viewport. Capturing only once the
                    // threshold trips means a plain click-to-select never hides the cursor. From here on
                    // client coordinates are frozen, but `wasDraggingRef` is already set so the click
                    // handler below still knows to skip selection.
                    captureViewport(instance);
                }
            }
        };

        const handleMouseUp = () => {
            if (wasDraggingRef.current) releaseViewport();
            setDragStartPos(null);
            // Don't reset isDragging immediately - let click handler check it first
        };

        const handleClick = (event: MouseEvent) => {
            // Ignore clicks that land on a floating overlay (2D/3D control, etc.).
            if (inOverlay(event.target)) return;
            // Don't allow selection during play mode
            if (isPlayMode) return;
            // In landscape/renderer modes the viewport is not a selection surface. In material mode the
            // preview sphere stays selected (it drives the material inspector), so clicks must not change it.
            // Animation mode picks joints (see AnimationSkeletonTool), not the mesh, so mesh selection is off.
            if (editorMode === 'landscape' || editorMode === 'renderer' || editorMode === 'material' || editorMode === 'terrainMaterial' || editorMode === 'animation') return;
            
            // Only allow selection on single clicks, not drags
            if (wasDraggingRef.current || isGizmoDraggingRef.current || justFinishedGizmoDragRef.current) {
                // Reset dragging state after checking
                setIsDragging(false);
                wasDraggingRef.current = false;
                return;
            }

            try {
                console.log('Click detected in viewport');
                
                if (!instance.scene || !instance.scene.activeCamera) {
                    console.log('No scene or active camera');
                    return;
                }

                const rect = viewportRef.current!.getBoundingClientRect();
                const x = event.clientX - rect.left;
                const y = event.clientY - rect.top;
                
                console.log('Mouse position:', { x, y, rectWidth: rect.width, rectHeight: rect.height });
                
                // Create ray from mouse position
                const ray = Raycaster.screenToRay(
                    x, 
                    y, 
                    rect.width, 
                    rect.height, 
                    instance.scene.activeCamera.camera
                );

                console.log('Ray created:', { origin: ray.origin, direction: ray.direction });

                // Get all selectable nodes from the scene. Exclude gizmo nodes so a stray ray can never
                // select the transform gizmo itself (the gizmo has its own grab raycast in PositionGizmo).
                const allNodes = Array.from(editorScene.nodes).filter(n => !(n as any).isGizmo);
                console.log('Total nodes in scene:', allNodes.length);
                console.log('Nodes:', allNodes.map(n => ({ id: n.id, name: n.name, type: n.nodeType, visible: n.visible })));

                // Perform raycast
                const hits = Raycaster.raycast(ray, allNodes);
                console.log('Raycast hits:', hits.length);

                if (hits.length > 0) {
                    // Select the closest hit. In scene mode, a placed template instance behaves as one
                    // object: redirect a hit on any instance child up to the instance root.
                    const hit = hits[0].node;
                    const target = editorMode === 'scene' ? (templateInstanceRootOf(hit) ?? hit) : hit;
                    console.log('Selected node:', { id: target.id, name: target.name, type: target.nodeType });
                    eventEmitter.emit('SELECT_NODE', target.id);
                } else {
                    // Deselect if clicking on empty space
                    console.log('No hits, deselecting');
                    eventEmitter.emit('SELECT_NODE', null);
                }
            } catch (error) {
                console.error('Error during node selection:', error);
            } finally {
                // Reset dragging state after click handling
                setIsDragging(false);
                wasDraggingRef.current = false;
            }
        };

        const viewport = viewportRef.current;
        // Use capture: false to allow events to bubble to the canvas
        viewport.addEventListener('mousedown', handleMouseDown, false);
        viewport.addEventListener('mousemove', handleMouseMove, false);
        viewport.addEventListener('click', handleClick, false);
        // On the window, so a button released outside the viewport still ends the drag and releases the
        // mouse capture instead of leaving the camera spinning.
        window.addEventListener('mouseup', handleMouseUp);

        return () => {
            viewport.removeEventListener('mousedown', handleMouseDown);
            viewport.removeEventListener('mousemove', handleMouseMove);
            viewport.removeEventListener('click', handleClick);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [instance, editorScene, eventEmitter, isDragging, isGizmoDragging, dragStartPos, isPlayMode, editorMode]);

    // Listen for gizmo drag events
    useEffect(() => {
        const handleGizmoDragStart = () => {
            isGizmoDraggingRef.current = true;
        };

        const handleGizmoDragEnd = () => {
            isGizmoDraggingRef.current = false;
            justFinishedGizmoDragRef.current = true;
            // Reset the flag after a short delay to allow the click event to be blocked
            setTimeout(() => {
                justFinishedGizmoDragRef.current = false;
            }, 100);
        };

        eventEmitter.on('GIZMO_DRAG_START', handleGizmoDragStart);
        eventEmitter.on('GIZMO_DRAG_END', handleGizmoDragEnd);

        return () => {
            eventEmitter.off('GIZMO_DRAG_START', handleGizmoDragStart);
            eventEmitter.off('GIZMO_DRAG_END', handleGizmoDragEnd);
        };
    }, [eventEmitter]);

    const handleTransformChange = (nodeId: string, mode: GizmoMode, value: [number, number, number]) => {
        if (!editorScene) return;

        const node = editorScene.getNodeById(nodeId);
        if (!node) return;
        if (mode === 'rotation') node.setRotation(value);
        else if (mode === 'scale') node.setScale(value);
        else node.setPosition(value);
    };

    // The world-space point under the cursor, used to place anything dropped into the viewport:
    // terrain → scene geometry → the ground plane → a fixed distance ahead when the ray hits the sky.
    const dropPointAt = (clientX: number, clientY: number): Vec.vec3 | null => {
        const cam = instance?.scene?.activeCamera?.camera;
        if (!cam || !viewportRef.current) return null;
        const rect = viewportRef.current.getBoundingClientRect();
        const ray = Raycaster.screenToRay(clientX - rect.left, clientY - rect.top, rect.width, rect.height, cam);

        for (const landscape of Array.from(editorScene.landscapes) as any[]) {
            const p = landscape.terrain?.raycast(ray.origin, ray.direction);
            if (p) return p as Vec.vec3;
        }

        // Raycaster already skips the __editor__/__debug__ helpers; drop the gizmo too, as click-select does.
        const hits = Raycaster.raycast(ray, Array.from(editorScene.nodes).filter(n => !(n as any).isGizmo));
        if (hits.length > 0) return hits[0].point as Vec.vec3;

        const t = -ray.origin[1] / ray.direction[1]; // ground plane y = 0
        const distance = (Number.isFinite(t) && t > 0) ? t : 10;
        return Vec.vec3.scaleAndAdd(Vec.vec3.create(), ray.origin, ray.direction, distance);
    };

    // setPosition is parent-local, and a template drop parent can carry a transform of its own.
    const placeAt = (node: Node, worldPoint: Vec.vec3, parent: Node) => {
        const toLocal = Vec.mat4.invert(Vec.mat4.create(), parent.worldTransform);
        const local = toLocal
            ? Vec.vec3.transformMat4(Vec.vec3.create(), worldPoint, toLocal)
            : worldPoint;
        node.setPosition([local[0], local[1], local[2]]);
    };

    // Drop a template (Templates panel), a mesh (Meshes panel) or a new node (the Scene panel's Add
    // section) into the viewport; it is instantiated under the cursor.
    const onViewportDragOver = (e: React.DragEvent) => {
        const types = Array.from(e.dataTransfer.types);
        if (types.includes('text/cleo-template') || types.includes('text/cleo-mesh') || types.includes(NEW_NODE_MIME))
            e.preventDefault();
    };
    const onViewportDrop = (e: React.DragEvent) => {
        if (!editorScene) return;

        // In a template tab the editable subtree is rooted at the template root (a child of the scene
        // root); drops must parent there so they show in the hierarchy and save with the template. A mesh
        // tab likewise parents drops under the ACTIVE LOD level's root, so they save with that level.
        const dropParent = (editorMode === 'template' && templateRootId)
            ? (editorScene.getNodeById(templateRootId) ?? editorScene.root)
            : (editorMode === 'mesh' && meshEditTargetId)
                ? (editorScene.getNodeById(meshEditTargetId) ?? editorScene.root)
                : editorScene.root;
        const point = dropPointAt(e.clientX, e.clientY);

        const newNodeId = e.dataTransfer.getData(NEW_NODE_MIME);
        if (newNodeId) {
            e.preventDefault();
            const item = findAddItem(newNodeId);
            if (!item) return;
            addItemTo(item, dropParent, { editorScene, eventEmitter, triggers })
                .then(node => {
                    // Sky/clouds fill the scene — a world position is meaningless for them.
                    if (point && item.placeable !== false) placeAt(node, point, dropParent);
                })
                .catch(err => console.error('Failed to add node:', err));
            return;
        }

        const meshId = e.dataTransfer.getData('text/cleo-mesh');
        if (meshId) {
            e.preventDefault();
            const mesh = meshes.find(m => m.id === meshId);
            if (!mesh) return;
            // A LOD-bearing asset instantiates as a LodGroupNode; nesting one inside a mesh being edited
            // would bake a renderer-driven group into the asset. Keep mesh assets LodGroup-free inside.
            if (editorMode === 'mesh' && (mesh.lods?.length || (mesh.cullDistance ?? 0) > 0)) {
                Logger.warn('Meshes with LOD levels or a cull distance cannot be added as sub-meshes of another mesh', 'Editor');
                return;
            }
            try {
                const newId = instantiateMeshAsset(mesh, dropParent, materials);
                const node = editorScene.getNodeById(newId);
                if (node && point) placeAt(node, point, dropParent);
                eventEmitter.emit('TEXTURES_CHANGED');
                eventEmitter.emit('SCENE_CHANGED');
                eventEmitter.emit('SELECT_NODE', newId);
            } catch (err) {
                console.error('Failed to instantiate mesh:', err);
            }
            return;
        }

        const templateId = e.dataTransfer.getData('text/cleo-template');
        if (!templateId) return;
        e.preventDefault();
        const template = templates.find(t => t.id === templateId);
        if (!template) return;
        try {
            const newId = instantiateTemplate(template, dropParent, { scripts, bodies, triggers }, materials);
            const node = editorScene.getNodeById(newId);
            if (node && point) placeAt(node, point, dropParent);
            eventEmitter.emit('TEXTURES_CHANGED');
            eventEmitter.emit('SCENE_CHANGED');
            eventEmitter.emit('SELECT_NODE', newId);
        } catch (err) {
            console.error('Failed to instantiate template:', err);
        }
    };

    return (
        <div ref={viewportRef} onDragOver={onViewportDragOver} onDrop={onViewportDrop}
             onContextMenu={(e) => e.preventDefault()}>
            {/* Floating top-right overlays: the gizmo-mode toggle (where the gizmo is active) sits to the
                left of the 2D/3D switch. Hidden during play; renderer mode holds the perf HUD instead. */}
            <div data-cleo-overlay className='absolute top-2 right-2 z-20 flex items-center gap-2'>
                {editorMode !== 'landscape' && editorMode !== 'renderer' && editorMode !== 'material' && editorMode !== 'terrainMaterial' && !isPlayMode && !hideForGraph && (
                    <div className='flex items-center rounded overflow-hidden border border-control-hover'>
                        <GizmoSeg active={gizmoMode === 'position'} title='Move (position)' onClick={() => setGizmoMode('position')}><MoveIcon /></GizmoSeg>
                        <GizmoSeg active={gizmoMode === 'rotation'} title='Rotate' onClick={() => setGizmoMode('rotation')}><RotateIcon /></GizmoSeg>
                        <GizmoSeg active={gizmoMode === 'scale'} title='Scale' onClick={() => setGizmoMode('scale')}><ScaleIcon /></GizmoSeg>
                    </div>
                )}
                {editorMode !== 'template' && editorMode !== 'material' && editorMode !== 'terrainMaterial' && editorMode !== 'renderer' && !isPlayMode && !hideForGraph && (
                    <select
                        data-cleo-overlay
                        value={dimension}
                        onChange={(e) => eventEmitter.emit('CHANGE_DIMENSION', e.target.value as '2D' | '3D')}
                        title='Viewport dimension'
                        className='bg-surface-raised/80 hover:bg-surface-raised text-white text-xs rounded px-1.5 py-1 border border-white/10 cursor-pointer focus:outline-none'
                    >
                        <option value='3D'>3D</option>
                        <option value='2D'>2D</option>
                    </select>
                )}
            </div>
            {editorMode !== 'landscape' && editorMode !== 'renderer' && editorMode !== 'material' && editorMode !== 'terrainMaterial' && editorMode !== 'animation' && <PositionGizmo
                selectedNodeId={selectedNode}
                onTransformChange={handleTransformChange}
                viewportRef={viewportRef}
            />}
            {editorMode === 'landscape' && <>
                <LandscapeBrush viewportRef={viewportRef} />
                <LandscapeInspector />
                {/* "Move" tool: a transform gizmo on the terrain node; its Y arrow sets the global height. */}
                {terrainMode === 'move' && terrainBrush.current.activeLandscapeId && <PositionGizmo
                    selectedNodeId={terrainBrush.current.activeLandscapeId}
                    onTransformChange={handleTransformChange}
                    viewportRef={viewportRef}
                />}
            </>}
            {editorMode === 'renderer' && <RendererOptions />}
            {editorMode === 'renderer' && <RendererStats />}
            {/* The graph is a full-canvas view, so everything that belongs to the 3D preview steps aside for
                it — including the transport, which sits at z-20 against the graph's z-10 and would otherwise
                float on top of it. The Animations|Graph switch is the way back and lives on the graph's own
                toolbar while it is up. */}
            {editorMode === 'animation' && !graphView && <>
                <div data-cleo-overlay className='absolute top-2 left-2 z-20' onMouseDown={e => e.stopPropagation()}>
                    <SegmentedControl<'3d' | 'graph'>
                        options={[{ value: '3d', label: 'Animations' }, { value: 'graph', label: 'Graph' }]}
                        value='3d'
                        onChange={v => setGraphView(v === 'graph')} />
                </div>
                <AnimationSkeletonTool viewportRef={viewportRef} />
                <AnimationPlayer />
            </>}
        </div>
    );
}