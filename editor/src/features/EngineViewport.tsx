import { useEffect, useRef } from "react";
import { useCleoEngine } from "./EngineContext";
import { Raycaster } from "cleo";

export default function EngineViewport() {
    const { instance, editorScene, eventEmitter } = useCleoEngine();
    const viewportRef = useRef<HTMLDivElement>(null);
 
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

        const handleClick = (event: MouseEvent) => {
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
            }
        };

        const viewport = viewportRef.current;
        viewport.addEventListener('click', handleClick);

        return () => {
            viewport.removeEventListener('click', handleClick);
        };
    }, [instance, editorScene, eventEmitter]);

    return <div ref={viewportRef} />;
}