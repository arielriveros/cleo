import { useEffect, useRef, useState } from "react";
import { useCleoEngine } from "./EngineContext";
import { Raycaster } from "cleo";
import PositionGizmo from "./PositionGizmo";

export default function EngineViewport() {
    const { instance, editorScene, eventEmitter, selectedNode, isGizmoDragging, isPlayMode } = useCleoEngine();
    const viewportRef = useRef<HTMLDivElement>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [dragStartPos, setDragStartPos] = useState<{ x: number; y: number } | null>(null);
    const wasDraggingRef = useRef(false);
    const isGizmoDraggingRef = useRef(false);
    const justFinishedGizmoDragRef = useRef(false);
 
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

        const handleMouseDown = (event: MouseEvent) => {
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
            // Don't allow selection during play mode
            if (isPlayMode) return;
            
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
        viewport.addEventListener('mousedown', handleMouseDown);
        viewport.addEventListener('mousemove', handleMouseMove);
        viewport.addEventListener('mouseup', handleMouseUp);
        viewport.addEventListener('click', handleClick);

        return () => {
            viewport.removeEventListener('mousedown', handleMouseDown);
            viewport.removeEventListener('mousemove', handleMouseMove);
            viewport.removeEventListener('mouseup', handleMouseUp);
            viewport.removeEventListener('click', handleClick);
        };
    }, [instance, editorScene, eventEmitter, isDragging, isGizmoDragging, dragStartPos, isPlayMode]);

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

    return (
        <div ref={viewportRef}>
            <PositionGizmo 
                selectedNodeId={selectedNode} 
                onPositionChange={handlePositionChange}
                viewportRef={viewportRef}
            />
        </div>
    );
}