import React, { useEffect, useRef, useState } from "react";
import { useCleoEngine } from "./EngineContext";
import { Raycaster } from "cleo";
import PositionGizmo from "./PositionGizmo";
import LandscapeBrush from "./landscape/LandscapeBrush";
import LandscapeInspector from "./landscape/LandscapeInspector";
import RendererOptions from "./renderer/RendererOptions";
import { instantiateTemplate } from "../utils/templates";

export default function EngineViewport() {
    const { instance, editorScene, eventEmitter, selectedNode, isGizmoDragging, isPlayMode, editorMode,
            templates, scripts, bodies, triggers } = useCleoEngine();
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
            // In landscape/renderer modes the viewport is not a selection surface.
            if (editorMode === 'landscape' || editorMode === 'renderer') return;
            
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

                // Get all nodes from the scene
                const allNodes = Array.from(editorScene.nodes);
                console.log('Total nodes in scene:', allNodes.length);
                console.log('Nodes:', allNodes.map(n => ({ id: n.id, name: n.name, type: n.nodeType, visible: n.visible })));
                
                // Perform raycast
                const hits = Raycaster.raycast(ray, allNodes);
                console.log('Raycast hits:', hits.length);
                
                if (hits.length > 0) {
                    // Select the closest hit
                    const selectedNode = hits[0].node;
                    console.log('Selected node:', { id: selectedNode.id, name: selectedNode.name, type: selectedNode.nodeType });
                    eventEmitter.emit('SELECT_NODE', selectedNode.id);
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

    const handlePositionChange = (nodeId: string, newPosition: [number, number, number]) => {
        if (!editorScene) return;

        const node = editorScene.getNodeById(nodeId);
        if (node) {
            node.setPosition(newPosition);
        }
    };

    // Drop a template from the Templates panel to instantiate an independent copy.
    const onViewportDragOver = (e: React.DragEvent) => {
        if (Array.from(e.dataTransfer.types).includes('text/cleo-template')) e.preventDefault();
    };
    const onViewportDrop = (e: React.DragEvent) => {
        const templateId = e.dataTransfer.getData('text/cleo-template');
        if (!templateId || !editorScene) return;
        e.preventDefault();
        const template = templates.find(t => t.id === templateId);
        if (!template) return;
        try {
            const newId = instantiateTemplate(template, editorScene.root, { scripts, bodies, triggers });
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
            {/* Minimal floating 2D/3D switch, top-right of the viewport (Main tab only, not during play). */}
            {editorMode !== 'template' && editorMode !== 'material' && !isPlayMode && (
                <select
                    data-cleo-overlay
                    value={dimension}
                    onChange={(e) => eventEmitter.emit('CHANGE_DIMENSION', e.target.value as '2D' | '3D')}
                    title='Viewport dimension'
                    className='absolute top-2 right-2 z-20 bg-[#252525]/80 hover:bg-[#252525] text-white text-xs rounded px-1.5 py-1 border border-white/10 cursor-pointer focus:outline-none'
                >
                    <option value='3D'>3D</option>
                    <option value='2D'>2D</option>
                </select>
            )}
            {editorMode !== 'landscape' && editorMode !== 'renderer' && editorMode !== 'material' && <PositionGizmo
                selectedNodeId={selectedNode}
                onPositionChange={handlePositionChange}
                viewportRef={viewportRef}
            />}
            {editorMode === 'landscape' && <>
                <LandscapeBrush viewportRef={viewportRef} />
                <LandscapeInspector />
            </>}
            {editorMode === 'renderer' && <RendererOptions />}
        </div>
    );
}