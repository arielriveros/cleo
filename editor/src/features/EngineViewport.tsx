import React, { useEffect, useRef, useState } from "react";
import { useCleoEngine } from "./EngineContext";
import { Raycaster, Node, Vec, Logger } from "cleo";
import PositionGizmo from "./PositionGizmo";
import LandscapeBrush from "./landscape/LandscapeBrush";
import LandscapeInspector from "./landscape/LandscapeInspector";
import TilemapBrush from "./tilemap/TilemapBrush";
import TilemapInspector from "./tilemap/TilemapInspector";
import DebugOverlay from "./logger/DebugOverlay";
import AnimationSkeletonTool from "./animation/AnimationSkeletonTool";
import AnimationPlayer from "./animation/AnimationPlayer";
import AnimationFieldPlayer from "./animationField/AnimationFieldPlayer";
import DebugVisibilityMenu from "./DebugVisibilityMenu";
import DebugSkeletonOverlay from "./DebugSkeletonOverlay";
import DebugAnimationOverlay from "./DebugAnimationOverlay";
import { useStateMachine } from "./animation/StateMachineContext";
import { SegmentedControl } from "../components/ui";
import { instantiateTemplate, templateInstanceRootOf } from "../utils/templates";
import { instantiateModelAsset, adoptModelMaterial } from "../utils/models";
import { NEW_NODE_MIME, addItemTo, findAddItem } from "./sceneInspector/addCatalog";
import { captureViewport, releaseViewport } from "../utils/pointerCapture";
import { GizmoMode, MODE_RENDERS_VIEWPORT } from "./EngineContext";
import { useSelection } from "./SelectionContext";
import { usePlayback } from "./PlaybackContext";

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
    const { instance, editorScene, eventEmitter, editorMode, viewDimension, setViewDimension, isSceneReady,
            templateRootId, modelEditTargetId, templates, models, materials, animations, scripts, bodies, triggers } = useCleoEngine();
    const { selectedNode, isGizmoDragging, gizmoMode, setGizmoMode } = useSelection();
    const { isPlayMode } = usePlayback();
    const { graphView, setGraphView } = useStateMachine();

    // The node graph covers the canvas, so viewport chrome (gizmo modes, 2D/3D) has nothing to act on.
    const hideForGraph = editorMode === 'animation' && graphView;
    // Viewport chrome only means something over a render: modes that replace the canvas with their own
    // full-panel editor (script, tileset) get none of it, and neither does the loading splash.
    const overRender = MODE_RENDERS_VIEWPORT[editorMode] && isSceneReady && !hideForGraph;
    const viewportRef = useRef<HTMLDivElement>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [dragStartPos, setDragStartPos] = useState<{ x: number; y: number } | null>(null);
    const wasDraggingRef = useRef(false);
    const isGizmoDraggingRef = useRef(false);
    const justFinishedGizmoDragRef = useRef(false);
    // The floating control is a VIEW toggle: it swaps the camera rig and nothing else. The scene's
    // authored dimension is edited in its own settings panel.
    const dimension = viewDimension;
 
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

        /**
         * The landscape or tilemap under a ray, or null — the click-selection fallback for the two node
         * types the generic raycaster skips. A tilemap only counts when the cell under the cursor holds a
         * tile: its plane is infinite, so any plane hit would make deselecting impossible in a 2D scene.
         */
        const pickGroundNode = (ray: { origin: Vec.vec3; direction: Vec.vec3 }): Node | null => {
            let best: Node | null = null;
            let bestDistance = Infinity;

            for (const landscape of Array.from(editorScene.landscapes) as any[]) {
                if (!landscape.visible) continue;
                const point = landscape.terrain?.raycast(ray.origin, ray.direction);
                if (!point) continue;
                const distance = Vec.vec3.distance(ray.origin as Vec.vec3, point);
                if (distance < bestDistance) { bestDistance = distance; best = landscape; }
            }

            for (const node of Array.from(editorScene.tilemaps) as any[]) {
                if (!node.visible) continue;
                const dz = ray.direction[2];
                if (Math.abs(dz) < 1e-6) continue;
                const t = (node.worldPosition[2] - ray.origin[2]) / dz;
                if (t <= 0 || t >= bestDistance) continue;
                const x = ray.origin[0] + ray.direction[0] * t;
                const y = ray.origin[1] + ray.direction[1] * t;
                node.tilemap.setOrigin(node.worldPosition);
                const [col, row] = node.tilemap.worldToCell(x, y);
                const painted = node.tilemap.layers.some((_: unknown, i: number) =>
                    node.tilemap.getTile(i, col, row) !== null);
                if (painted) { bestDistance = t; best = node; }
            }

            return best;
        };

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

                if (deltaX > 5 || deltaY > 5) {
                    setIsDragging(true);
                    wasDraggingRef.current = true;
                    // Capture the mouse so the orbit/pan can run without the cursor escaping the viewport.
                    // Capturing only once the 5px threshold trips means a plain click-to-select never hides
                    // the cursor. Client coordinates freeze here; `wasDraggingRef` still gates the click.
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
            if (isPlayMode) return;
            // In landscape/tilemap/renderer modes the viewport is not a selection surface. In material mode
            // the preview sphere stays selected (it drives the material inspector), so clicks must not change
            // it. Animation mode picks joints (see AnimationSkeletonTool), not the mesh, so mesh selection is off.
            if (editorMode === 'landscape' || editorMode === 'tilemap' || editorMode === 'ui' || editorMode === 'renderer' || editorMode === 'material' || editorMode === 'terrainMaterial' || editorMode === 'animation' || editorMode === 'animationField') return;
            
            if (wasDraggingRef.current || isGizmoDraggingRef.current || justFinishedGizmoDragRef.current) {
                setIsDragging(false);
                wasDraggingRef.current = false;
                return;
            }

            try {
                if (!instance.scene || !instance.scene.activeCamera) {
                    return;
                }

                const rect = viewportRef.current!.getBoundingClientRect();
                const x = event.clientX - rect.left;
                const y = event.clientY - rect.top;
                
                const ray = Raycaster.screenToRay(
                    x, 
                    y, 
                    rect.width, 
                    rect.height, 
                    instance.scene.activeCamera.camera
                );

                // Get all selectable nodes from the scene. Exclude gizmo nodes so a stray ray can never
                // select the transform gizmo itself (the gizmo has its own grab raycast in PositionGizmo).
                const allNodes = Array.from(editorScene.nodes).filter(n => !(n as any).isGizmo);

                const hits = Raycaster.raycast(ray, allNodes);

                if (hits.length > 0) {
                    // Select the closest hit. In scene mode, a placed template instance behaves as one
                    // object: redirect a hit on any instance child up to the instance root.
                    const hit = hits[0].node;
                    const target = editorMode === 'scene' ? (templateInstanceRootOf(hit) ?? hit) : hit;
                    eventEmitter.emit('SELECT_NODE', target.id);
                } else {
                    // Nothing ordinary was hit. Terrain and tilemaps are deliberately skipped by
                    // Raycaster.raycast (a terrain has its own analytic picker; a tilemap's box spans
                    // everything it has ever painted), so they get their own pass here.
                    const analytic = pickGroundNode(ray);
                    // A click on genuinely empty space still deselects, which is how a selection is cleared.
                    eventEmitter.emit('SELECT_NODE', analytic?.id ?? null);
                }
            } catch (error) {
                console.error('Error during node selection:', error);
            } finally {
                setIsDragging(false);
                wasDraggingRef.current = false;
            }
        };

        const viewport = viewportRef.current;
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

        // A tilemap's plane is the drop surface in a 2D scene, the way terrain is in a 3D one.
        for (const tn of Array.from(editorScene.tilemaps) as any[]) {
            const planeZ = tn.worldPosition[2];
            const dz = ray.direction[2];
            if (Math.abs(dz) < 1e-6) continue;
            const t = (planeZ - ray.origin[2]) / dz;
            if (t <= 0) continue;
            return Vec.vec3.scaleAndAdd(Vec.vec3.create(), ray.origin, ray.direction, t);
        }

        // Raycaster already skips the __editor__/__debug__ helpers; drop the gizmo too, as click-select does.
        const hits = Raycaster.raycast(ray, Array.from(editorScene.nodes).filter(n => !(n as any).isGizmo));
        if (hits.length > 0) return hits[0].point as Vec.vec3;

        // The fallback plane follows the RIG IN USE, not how the scene is authored: under the 2D camera
        // the world you are looking at lies on z = 0, so intersecting y = 0 would put every drop behind
        // the viewer — and that is true whether or not the scene calls itself 2D.
        const axis = viewDimension === '2D' ? 2 : 1;
        const t = -ray.origin[axis] / ray.direction[axis];
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

    // Drop a template (Templates panel), a model (Assets panel) or a new node (the Scene panel's Add
    // section) into the viewport; it is instantiated under the cursor.
    const onViewportDragOver = (e: React.DragEvent) => {
        const types = Array.from(e.dataTransfer.types);
        if (types.includes('text/cleo-template') || types.includes('text/cleo-model') || types.includes(NEW_NODE_MIME))
            e.preventDefault();
    };
    const onViewportDrop = (e: React.DragEvent) => {
        if (!editorScene) return;

        // In a template tab the editable subtree is rooted at the template root (a child of the scene
        // root); drops must parent there so they show in the hierarchy and save with the template. A
        // model tab likewise parents drops under the ACTIVE LOD level's root, so they save with that level.
        const dropParent = (editorMode === 'template' && templateRootId)
            ? (editorScene.getNodeById(templateRootId) ?? editorScene.root)
            : (editorMode === 'model' && modelEditTargetId)
                ? (editorScene.getNodeById(modelEditTargetId) ?? editorScene.root)
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

        const modelId = e.dataTransfer.getData('text/cleo-model');
        if (modelId) {
            e.preventDefault();
            const asset = models.find(m => m.id === modelId);
            if (!asset) return;
            // A LOD-bearing asset instantiates as a LodGroupNode; nesting one inside a model being edited
            // would bake a renderer-driven group into the asset. Keep model assets LodGroup-free inside.
            if (editorMode === 'model' && (asset.lods?.length || (asset.cullDistance ?? 0) > 0)) {
                Logger.warn('Models with LOD levels or a cull distance cannot be added as parts of another model', 'Editor');
                return;
            }
            try {
                const newId = instantiateModelAsset(asset, dropParent, materials, models, animations);
                const node = editorScene.getNodeById(newId);
                if (node && point) placeAt(node, point, dropParent);
                // A model is one Geometry + one Material, and the renderer draws in material batches — so
                // every part of a model must share its material for the whole asset to batch as one. In the
                // model editor the edited model's material therefore wins: the dropped part adopts it.
                if (editorMode === 'model' && node) {
                    const adopted = adoptModelMaterial(node, dropParent, materials);
                    if (adopted)
                        Logger.info(`"${asset.name}" adopted the model's material ("${adopted}") so the model stays a single material batch`, 'Editor');
                }
                eventEmitter.emit('TEXTURES_CHANGED');
                eventEmitter.emit('SCENE_CHANGED');
                eventEmitter.emit('SELECT_NODE', newId);
            } catch (err) {
                console.error('Failed to instantiate model:', err);
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
            {/* Logger.debug(...) toasts, bottom-left, in every editor mode. Self-expires after 10s. */}
            <DebugOverlay />
            {/* Drives the renderer's skeleton overlay from every skinned model in the scene when the
                Skeletons debug toggle is on (self-gates off in animation mode, where AnimationSkeletonTool
                owns the overlay). Renders nothing itself. */}
            <DebugSkeletonOverlay />
            {/* Live blend readout, bottom-right, behind the Animation blend toggle. Self-gates. Unlike the
                State Machine inspector's copy this one runs in Play, which is the only place a blend driven
                by measured motion has real inputs. */}
            <DebugAnimationOverlay />
            {/* Floating top-right overlays: the debug-visibility menu + gizmo-mode toggle sit to the
                left of the 2D/3D switch. Hidden during play; renderer mode holds the perf HUD instead.
                The container is gated on `overRender`, so a mode that owns the whole panel shows none of
                it — each control below only states what is true of IT beyond that. */}
            {overRender && <div data-cleo-overlay className='absolute top-2 right-2 z-20 flex items-center gap-2'>
                {/* The debug menu stays available during play so Runtime toggles can be flipped live. */}
                {editorMode !== 'renderer' && editorMode !== 'material' && editorMode !== 'terrainMaterial' && (
                    <DebugVisibilityMenu />
                )}
                {editorMode !== 'landscape' && editorMode !== 'tilemap' && editorMode !== 'renderer' && editorMode !== 'material' && editorMode !== 'terrainMaterial' && !isPlayMode && (
                    <div className='flex items-center rounded overflow-hidden border border-control-hover'>
                        <GizmoSeg active={gizmoMode === 'position'} title='Move (position)' onClick={() => setGizmoMode('position')}><MoveIcon /></GizmoSeg>
                        <GizmoSeg active={gizmoMode === 'rotation'} title='Rotate' onClick={() => setGizmoMode('rotation')}><RotateIcon /></GizmoSeg>
                        <GizmoSeg active={gizmoMode === 'scale'} title='Scale' onClick={() => setGizmoMode('scale')}><ScaleIcon /></GizmoSeg>
                    </div>
                )}
                {editorMode !== 'template' && editorMode !== 'material' && editorMode !== 'terrainMaterial' && editorMode !== 'renderer' && !isPlayMode && (
                    <select
                        data-cleo-overlay
                        value={dimension}
                        onChange={(e) => setViewDimension(e.target.value as '2D' | '3D')}
                        title='Viewport camera — view only. The scene’s 2D/3D type is in its settings.'
                        className='bg-surface-raised/80 hover:bg-surface-raised text-white text-xs rounded px-1.5 py-1 border border-white/10 cursor-pointer focus:outline-none'
                    >
                        <option value='3D'>3D</option>
                        <option value='2D'>2D</option>
                    </select>
                )}
            </div>}
            {overRender && editorMode !== 'landscape' && editorMode !== 'tilemap' && editorMode !== 'ui' && editorMode !== 'renderer' && editorMode !== 'material' && editorMode !== 'terrainMaterial' && editorMode !== 'animation' && <PositionGizmo
                selectedNodeId={selectedNode}
                onTransformChange={handleTransformChange}
                viewportRef={viewportRef}
            />}
            {editorMode === 'tilemap' && <>
                <TilemapBrush viewportRef={viewportRef} />
                <TilemapInspector />
            </>}
            {editorMode === 'landscape' && <>
                <LandscapeBrush viewportRef={viewportRef} />
                <LandscapeInspector />
            </>}
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
            {/* The blend-space plot (FieldGraph, z-10) leaves the bottom strip clear for this, so unlike the
                animation graph there is nothing to step aside for — you author and preview at the same time. */}
            {editorMode === 'animationField' && <AnimationFieldPlayer />}
        </div>
    );
}