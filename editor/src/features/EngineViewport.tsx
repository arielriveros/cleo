import React, { useEffect, useRef, useState } from "react";
import { useCleoEngine } from "./EngineContext";
import { Raycaster } from "cleo";
import PositionGizmo from "./PositionGizmo";
import LandscapeBrush from "./landscape/LandscapeBrush";
import LandscapeInspector from "./landscape/LandscapeInspector";
import RendererOptions from "./renderer/RendererOptions";
import RendererStats from "./renderer/RendererStats";
import { instantiateTemplate, templateInstanceRootOf } from "../utils/templates";
import { instantiateMeshAsset } from "../utils/meshes";
import { GizmoMode } from "./EngineContext";

// One segment of the Move/Rotate/Scale toggle, styled to match the top-toolbar ModeSelector.
function GizmoSeg({ active, title, onClick, children }: { active: boolean; title: string; onClick: () => void; children: React.ReactNode }) {
    return (
        <button
            data-cleo-overlay
            className={`flex items-center justify-center w-[26px] h-[25px] border-r border-[#555] last:border-r-0 transition-colors cursor-pointer
                ${active ? 'bg-[#2c2cff] text-white' : 'bg-[#3b3b3b] text-[#ccc] hover:bg-[#4a4a4a]'}`}
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
            gizmoMode, setGizmoMode, templateRootId, templates, meshes, scripts, bodies, triggers } = useCleoEngine();
    const viewportRef = useRef<HTMLDivElement>(null);
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

    useEffect(() => {
        if (!viewportRef.current || !instance) return;

        // Clicks on floating viewport overlays (e.g. the 2D/3D control) bubble to these div-level
        // listeners; ignore them so they don't deselect nodes or start a drag.
        const inOverlay = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('[data-cleo-overlay]');

        const handleMouseDown = (event: MouseEvent) => {
            if (inOverlay(event.target)) return;
            if (event.button === 0) { // Left mouse button
                const rect = viewportRef.current!.getBoundingClientRect();
                const x = event.clientX - rect.left;
                const y = event.clientY - rect.top;
                setDragStartPos({ x, y });
                setIsDragging(false);
                wasDraggingRef.current = false;
            }
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
                }
            }
        };

        const handleMouseUp = () => {
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
            if (editorMode === 'landscape' || editorMode === 'renderer' || editorMode === 'material') return;
            
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
        viewport.addEventListener('mouseup', handleMouseUp, false);
        viewport.addEventListener('click', handleClick, false);

        return () => {
            viewport.removeEventListener('mousedown', handleMouseDown);
            viewport.removeEventListener('mousemove', handleMouseMove);
            viewport.removeEventListener('mouseup', handleMouseUp);
            viewport.removeEventListener('click', handleClick);
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

    // Drop a template (Templates panel) or a mesh (Meshes panel) into the viewport to instantiate a copy.
    const onViewportDragOver = (e: React.DragEvent) => {
        const types = Array.from(e.dataTransfer.types);
        if (types.includes('text/cleo-template') || types.includes('text/cleo-mesh')) e.preventDefault();
    };
    const onViewportDrop = (e: React.DragEvent) => {
        if (!editorScene) return;

        // In a template tab the editable subtree is rooted at the template root (a child of the scene
        // root); drops must parent there so they show in the hierarchy and save with the template.
        const dropParent = (editorMode === 'template' && templateRootId)
            ? (editorScene.getNodeById(templateRootId) ?? editorScene.root)
            : editorScene.root;

        const meshId = e.dataTransfer.getData('text/cleo-mesh');
        if (meshId) {
            e.preventDefault();
            const mesh = meshes.find(m => m.id === meshId);
            if (!mesh) return;
            try {
                const newId = instantiateMeshAsset(mesh, dropParent);
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
            const newId = instantiateTemplate(template, dropParent, { scripts, bodies, triggers });
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
                {editorMode !== 'landscape' && editorMode !== 'renderer' && editorMode !== 'material' && !isPlayMode && (
                    <div className='flex items-center rounded overflow-hidden border border-[#555]'>
                        <GizmoSeg active={gizmoMode === 'position'} title='Move (position)' onClick={() => setGizmoMode('position')}><MoveIcon /></GizmoSeg>
                        <GizmoSeg active={gizmoMode === 'rotation'} title='Rotate' onClick={() => setGizmoMode('rotation')}><RotateIcon /></GizmoSeg>
                        <GizmoSeg active={gizmoMode === 'scale'} title='Scale' onClick={() => setGizmoMode('scale')}><ScaleIcon /></GizmoSeg>
                    </div>
                )}
                {editorMode !== 'template' && editorMode !== 'material' && editorMode !== 'renderer' && !isPlayMode && (
                    <select
                        data-cleo-overlay
                        value={dimension}
                        onChange={(e) => eventEmitter.emit('CHANGE_DIMENSION', e.target.value as '2D' | '3D')}
                        title='Viewport dimension'
                        className='bg-[#252525]/80 hover:bg-[#252525] text-white text-xs rounded px-1.5 py-1 border border-white/10 cursor-pointer focus:outline-none'
                    >
                        <option value='3D'>3D</option>
                        <option value='2D'>2D</option>
                    </select>
                )}
            </div>
            {editorMode !== 'landscape' && editorMode !== 'renderer' && editorMode !== 'material' && <PositionGizmo
                selectedNodeId={selectedNode}
                onTransformChange={handleTransformChange}
                viewportRef={viewportRef}
            />}
            {editorMode === 'landscape' && <>
                <LandscapeBrush viewportRef={viewportRef} />
                <LandscapeInspector />
            </>}
            {editorMode === 'renderer' && <RendererOptions />}
            {editorMode === 'renderer' && <RendererStats />}
        </div>
    );
}