import { useEffect, useRef, useState } from "react";
import { useCleoEngine } from "./EngineContext";
import { Model, ModelNode, Material, Geometry } from "cleo";
import { GizmoGeometry } from "../utils/GizmoGeometry";
import { Raycaster } from "cleo";

interface PositionGizmoProps {
    selectedNodeId: string | null;
    onPositionChange: (nodeId: string, newPosition: [number, number, number]) => void;
    viewportRef: React.RefObject<HTMLDivElement>;
}

type GizmoAxis = 'x' | 'y' | 'z' | null;

export default function PositionGizmo({ selectedNodeId, onPositionChange, viewportRef }: PositionGizmoProps) {
    const { instance, editorScene, eventEmitter } = useCleoEngine();
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
    const [initialNodePos, setInitialNodePos] = useState<[number, number, number] | null>(null);
    const [isPlayMode, setIsPlayMode] = useState(false);

    // Create gizmo geometry and materials
    const createGizmoNodes = () => {
        if (!instance || !editorScene) return;

        // Create materials for each axis with front rendering
        const xMaterial = Material.Basic({ color: [1, 0, 0] }, { 
            wireframe: false,
            transparent: false,
            castShadow: false
        });
        const yMaterial = Material.Basic({ color: [0, 1, 0] }, { 
            wireframe: false,
            transparent: false,
            castShadow: false
        });
        const zMaterial = Material.Basic({ color: [0, 0, 1] }, { 
            wireframe: false,
            transparent: false,
            castShadow: false
        });

        // Create arrow geometries
        const xArrowGeometry = GizmoGeometry.ArrowX(1, 0.2);
        const yArrowGeometry = GizmoGeometry.ArrowY(1, 0.2);
        const zArrowGeometry = GizmoGeometry.ArrowZ(1, 0.2);

        // Create line geometries using thin cubes
        const xLineGeometry = Geometry.Cube(0.8, 0.02, 0.02);
        const yLineGeometry = Geometry.Cube(0.02, 0.8, 0.02);
        const zLineGeometry = Geometry.Cube(0.02, 0.02, 0.8);

        // Create models
        const xArrowModel = new Model(xArrowGeometry, xMaterial);
        const yArrowModel = new Model(yArrowGeometry, yMaterial);
        const zArrowModel = new Model(zArrowGeometry, zMaterial);

        const xLineModel = new Model(xLineGeometry, xMaterial);
        const yLineModel = new Model(yLineGeometry, yMaterial);
        const zLineModel = new Model(zLineGeometry, zMaterial);

        // Create nodes
        const xAxisNode = new ModelNode('__editor__gizmo__x_axis', xArrowModel);
        const yAxisNode = new ModelNode('__editor__gizmo__y_axis', yArrowModel);
        const zAxisNode = new ModelNode('__editor__gizmo__z_axis', zArrowModel);

        const xLineNode = new ModelNode('__editor__gizmo__x_line', xLineModel);
        const yLineNode = new ModelNode('__editor__gizmo__y_line', yLineModel);
        const zLineNode = new ModelNode('__editor__gizmo__z_line', zLineModel);

        // Mark gizmo nodes for front rendering
        (xAxisNode as any).isGizmo = true;
        (yAxisNode as any).isGizmo = true;
        (zAxisNode as any).isGizmo = true;
        (xLineNode as any).isGizmo = true;
        (yLineNode as any).isGizmo = true;
        (zLineNode as any).isGizmo = true;

        // Set up arrow positions
        xAxisNode.setPosition([0.5, 0, 0]);
        yAxisNode.setPosition([0, 0.5, 0]);
        zAxisNode.setPosition([0, 0, 0.5]);

        // Add to scene
        editorScene.addNodes(xAxisNode, yAxisNode, zAxisNode, xLineNode, yLineNode, zLineNode);

        setGizmoNodes({
            xAxis: xAxisNode,
            yAxis: yAxisNode,
            zAxis: zAxisNode,
            xLine: xLineNode,
            yLine: yLineNode,
            zLine: zLineNode
        });
    };

    // Update gizmo position to follow selected node
    const updateGizmoPosition = () => {
        if (!selectedNodeId || !editorScene) return;

        const selectedNode = editorScene.getNodeById(selectedNodeId);
        if (!selectedNode) return;

        const worldPos = selectedNode.worldPosition;
        
        // Update gizmo position to match selected node
        if (gizmoNodes.xAxis) gizmoNodes.xAxis.setPosition([worldPos[0] + 0.5, worldPos[1], worldPos[2]]);
        if (gizmoNodes.yAxis) gizmoNodes.yAxis.setPosition([worldPos[0], worldPos[1] + 0.5, worldPos[2]]);
        if (gizmoNodes.zAxis) gizmoNodes.zAxis.setPosition([worldPos[0], worldPos[1], worldPos[2] + 0.5]);
        
        if (gizmoNodes.xLine) gizmoNodes.xLine.setPosition([worldPos[0], worldPos[1], worldPos[2]]);
        if (gizmoNodes.yLine) gizmoNodes.yLine.setPosition([worldPos[0], worldPos[1], worldPos[2]]);
        if (gizmoNodes.zLine) gizmoNodes.zLine.setPosition([worldPos[0], worldPos[1], worldPos[2]]);
    };

    // Handle mouse interactions
    const handleMouseDown = (event: MouseEvent) => {
        if (!selectedNodeId || !instance || !instance.scene || !editorScene || !viewportRef.current) return;

        // Only handle left mouse button
        if (event.button !== 0) return;

        const rect = viewportRef.current.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;

        // Create ray from mouse position
        const ray = Raycaster.screenToRay(
            x, 
            y, 
            rect.width, 
            rect.height, 
            instance.scene.activeCamera.camera
        );

        // Check for gizmo axis hits
        const gizmoNodesList = [gizmoNodes.xAxis, gizmoNodes.yAxis, gizmoNodes.zAxis].filter(
            (node): node is ModelNode => node !== null
        );
        const hits = Raycaster.raycast(ray, gizmoNodesList);

        if (hits.length > 0) {
            const hitNode = hits[0].node;
            let axis: GizmoAxis = null;

            if (hitNode === gizmoNodes.xAxis) axis = 'x';
            else if (hitNode === gizmoNodes.yAxis) axis = 'y';
            else if (hitNode === gizmoNodes.zAxis) axis = 'z';

            if (axis) {
                event.preventDefault(); // Prevent default mouse behavior
                event.stopPropagation(); // Stop event bubbling
                setIsDragging(true);
                setDraggedAxis(axis);
                setInitialMousePos({ x, y });
                setDragStartPos({ x, y });
                
                // Emit event to disable camera controls
                eventEmitter.emit('GIZMO_DRAG_START', { axis, nodeId: selectedNodeId });
                
                const selectedNode = editorScene.getNodeById(selectedNodeId);
                if (selectedNode) {
                    setInitialNodePos([selectedNode.position[0], selectedNode.position[1], selectedNode.position[2]]);
                }
            }
        }
    };

    const handleMouseMove = (event: MouseEvent) => {
        if (!isDragging || !draggedAxis || !selectedNodeId || !editorScene || !viewportRef.current || !initialMousePos || !initialNodePos || !dragStartPos) return;

        event.preventDefault(); // Prevent default mouse behavior

        const rect = viewportRef.current.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;

        // Check if we've moved enough to consider it a drag
        const deltaX = x - dragStartPos.x;
        const deltaY = y - dragStartPos.y;
        const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
        
        // Only start actual dragging if moved more than 5 pixels
        if (distance < 5) {
            return;
        }

        const moveDeltaX = x - initialMousePos.x;
        const moveDeltaY = y - initialMousePos.y;

        // Calculate movement based on camera orientation
        const camera = instance?.scene.activeCamera;
        if (!camera) return;

        const sensitivity = 0.01;
        let deltaPosition: [number, number, number] = [0, 0, 0];

        // Get camera's right and up vectors in world space
        const viewMatrix = camera.camera.viewMatrix;
        const cameraRight = [viewMatrix[0], viewMatrix[4], viewMatrix[8]];
        const cameraUp = [viewMatrix[1], viewMatrix[5], viewMatrix[9]];

        // Define the gizmo axis directions in world space
        const axisX = [1, 0, 0]; // World X axis
        const axisY = [0, 1, 0]; // World Y axis  
        const axisZ = [0, 0, 1]; // World Z axis

        switch (draggedAxis) {
            case 'x':
                // Project both mouse X and Y movement onto X axis relative to camera
                // Use camera's right vector for X movement and camera's up vector for Y movement
                const xProjectionX = cameraRight[0] * moveDeltaX * sensitivity;
                const xProjectionY = cameraUp[0] * (-moveDeltaY) * sensitivity;
                deltaPosition = [xProjectionX + xProjectionY, 0, 0];
                break;
            case 'y':
                // Y axis works correctly as is
                deltaPosition = [0, -moveDeltaY * sensitivity, 0];
                break;
            case 'z':
                // Project both mouse X and Y movement onto Z axis relative to camera
                // Use camera's right vector for X movement and camera's up vector for Y movement
                const zProjectionX = cameraRight[2] * moveDeltaX * sensitivity;
                const zProjectionY = cameraUp[2] * (-moveDeltaY) * sensitivity;
                deltaPosition = [0, 0, zProjectionX + zProjectionY];
                break;
        }

        const newPosition: [number, number, number] = [
            initialNodePos[0] + deltaPosition[0],
            initialNodePos[1] + deltaPosition[1],
            initialNodePos[2] + deltaPosition[2]
        ];

        onPositionChange(selectedNodeId, newPosition);
        
        // Update gizmo position to follow the object
        updateGizmoPosition();
    };

    const handleMouseUp = () => {
        if (isDragging) {
            // Emit event to re-enable camera controls
            eventEmitter.emit('GIZMO_DRAG_END', { axis: draggedAxis, nodeId: selectedNodeId });
        }
        
        setIsDragging(false);
        setDraggedAxis(null);
        setInitialMousePos(null);
        setInitialNodePos(null);
        setDragStartPos(null);
    };

    // Initialize gizmo
    useEffect(() => {
        if (instance && editorScene) {
            createGizmoNodes();
        }
    }, [instance, editorScene]);

    // Update gizmo visibility and position
    useEffect(() => {
        if (!gizmoNodes.xAxis || !gizmoNodes.yAxis || !gizmoNodes.zAxis) return;

        // Check if selected node is root node
        const isRootNode = selectedNodeId === 'root' || selectedNodeId === editorScene?.root?.id;

        if (selectedNodeId && !isPlayMode && !isRootNode) {
            // Show gizmo only when not in play mode and not root node
            gizmoNodes.xAxis.visible = true;
            gizmoNodes.yAxis.visible = true;
            gizmoNodes.zAxis.visible = true;
            if (gizmoNodes.xLine) gizmoNodes.xLine.visible = true;
            if (gizmoNodes.yLine) gizmoNodes.yLine.visible = true;
            if (gizmoNodes.zLine) gizmoNodes.zLine.visible = true;
            
            updateGizmoPosition();
        } else {
            // Hide gizmo when no selection, in play mode, or root node selected
            gizmoNodes.xAxis.visible = false;
            gizmoNodes.yAxis.visible = false;
            gizmoNodes.zAxis.visible = false;
            if (gizmoNodes.xLine) gizmoNodes.xLine.visible = false;
            if (gizmoNodes.yLine) gizmoNodes.yLine.visible = false;
            if (gizmoNodes.zLine) gizmoNodes.zLine.visible = false;
        }
    }, [selectedNodeId, gizmoNodes, isPlayMode, editorScene]);

    // Update gizmo position continuously when dragging
    useEffect(() => {
        if (isDragging && selectedNodeId) {
            updateGizmoPosition();
        }
    }, [isDragging, selectedNodeId]);


    // Set up mouse event listeners
    useEffect(() => {
        if (!viewportRef.current) return;

        const viewport = viewportRef.current;
        viewport.addEventListener('mousedown', handleMouseDown);
        viewport.addEventListener('mousemove', handleMouseMove);
        viewport.addEventListener('mouseup', handleMouseUp);

        return () => {
            viewport.removeEventListener('mousedown', handleMouseDown);
            viewport.removeEventListener('mousemove', handleMouseMove);
            viewport.removeEventListener('mouseup', handleMouseUp);
        };
    }, [selectedNodeId, isDragging, draggedAxis, initialMousePos, initialNodePos, gizmoNodes]);

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

    // Clean up gizmo nodes when component unmounts
    useEffect(() => {
        return () => {
            if (editorScene && gizmoNodes.xAxis) {
                editorScene.removeNode(gizmoNodes.xAxis);
                editorScene.removeNode(gizmoNodes.yAxis!);
                editorScene.removeNode(gizmoNodes.zAxis!);
                editorScene.removeNode(gizmoNodes.xLine!);
                editorScene.removeNode(gizmoNodes.yLine!);
                editorScene.removeNode(gizmoNodes.zLine!);
            }
        };
    }, []);

    return null; // This component doesn't render anything visible
}
