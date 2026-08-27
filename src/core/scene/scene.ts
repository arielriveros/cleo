import { CleoEngine, Texture, TextureManager } from "../../cleo";
import { Node } from "./nodes/node";
import { ModelNode } from "./nodes/modelNode";
import { LodGroupNode } from "./nodes/lodGroupNode";
import { CameraRigNode } from "./nodes/cameraRigNode";
import { LandscapeNode } from "./nodes/landscapeNode";
import { TilemapNode } from "./nodes/tilemapNode";
import { LightNode } from "./nodes/lightNode";
import { LightProbeNode } from "./nodes/lightProbeNode";
import { SkyboxNode } from "./nodes/skyboxNode";
import { VolumetricCloudsNode } from "./nodes/volumetricCloudsNode";
import { SkyAtmosphereNode } from "./nodes/skyAtmosphereNode";
import { SkyLightNode } from "./nodes/skyLightNode";
import { CameraNode } from "./nodes/cameraNode";
import { SpriteNode } from "./nodes/spriteNode";
import { UINode } from "./nodes/ui/uiNode";
import { UIRootNode } from "./nodes/ui/uiRoot";
import { parseNodeJson } from "./nodes/parseNodeJson";
import { mat4, vec3 } from "gl-matrix";
import { Logger } from '../logger'
import type { PhysicsSystem } from "../../physics/physicsSystem";
import { sceneStats, resetSceneStats, SceneStats } from "./sceneStats";
import { cloneNodeJson, regenerateNodeIds } from "./nodeJson";
import { getTemplate, templateNames } from "./templates";

/** Overrides applied to a freshly instantiated template root. See {@link Scene.instantiate}. */
export interface InstantiateOptions {
    /** Parent for the new node. Defaults to the scene root. */
    parent?: Node;
    /** Name for the new node. Defaults to the template's own. */
    name?: string;
    /** Local position, rotation (Euler DEGREES) and scale, each defaulting to the template's. */
    position?: number[];
    rotation?: number[];
    scale?: number[];
}

/** One scheduled `this.after`/`this.every` call. `interval === null` means one-shot. */
interface ScheduledTimer {
    node: Node;
    remaining: number;
    interval: number | null;
    cb: () => void;
    cancelled: boolean;
}

export class Scene {
    private _root: Node = new Node('root');
    private _nodes: Set<Node>;
    private _cameras: Set<CameraNode> = new Set();
    private _lights: Set<LightNode>;
    private _models: Set<ModelNode>;
    private _sprites: Set<SpriteNode>;
    private _landscapes: Set<LandscapeNode>;
    private _tilemaps: Set<TilemapNode> = new Set();
    private _lodGroups: Set<LodGroupNode> = new Set();
    private _cameraRigs: Set<CameraRigNode> = new Set();
    private _lightProbes: Set<LightProbeNode>;
    private _uiRoots: Set<UIRootNode> = new Set();
    private _uiNodes: Set<UINode> = new Set();
    // Container size for the UI layout pass, in CSS pixels; pushed in via setUIViewport.
    private _uiViewport: { width: number, height: number, dpr: number } = { width: 1920, height: 1080, dpr: 1 };
    // Reused across frames: the UI pass must not allocate a matrix per world-space root per frame.
    private readonly _uiViewProj: mat4 = mat4.create();
    // Built alongside _nodes, so getNodesByName/getNodeById are an O(1) lookup rather than a scan.
    private _nodesByName: Map<string, Node[]> = new Map();
    private _nodesById: Map<string, Node> = new Map();
    private _skybox: SkyboxNode | null;
    private _volumetricClouds: VolumetricCloudsNode | null = null;
    private _skyAtmosphere: SkyAtmosphereNode | null = null;
    private _skyLight: SkyLightNode | null = null;
    private _environmentMap: Texture | null = null;
    private _dirty: boolean = true;
    private _hasStarted: boolean = false;
    // When false, ModelNode animators are NOT driven by scene.update (skinned meshes hold their bind
    // pose). The editor sets it false on editing scenes; default true is normal playback.
    private _animationsEnabled: boolean = true;
    // When false, Node.spawnOnStart is ignored and every node starts spawned. The editor sets it false on
    // editing scenes: spawnOnStart is a RUNTIME rule, honoured only in Play mode and a published game.
    private _spawnRulesEnabled: boolean = true;
    // Nodes present in the tree but asleep (see Node.despawn). Kept out of _nodes and every type-filtered
    // list, so they reach no consumer; held here only so the removal sweep can still free one.
    private _dormant: Set<Node> = new Set();

    /** The physics system driving this scene (set by PhysicsSystem.set scene). Reachable from a script
     *  as `scene.physics`. */
    public physics!: PhysicsSystem;

    // TODO: Move this to a LightManager class
    private _numPointLights: number;
    private _numSpotlights: number;

    // Backs this.wait/after/every. Ticked once per Scene.update and gated like node.update, so timers
    // pause with the game; cancelled per-node on despawn.
    private _timers: ScheduledTimer[] = [];

    constructor() {
        this._root.scene = this;
        this._nodes = new Set();
        this._lights = new Set();
        this._models = new Set();
        this._sprites = new Set();
        this._landscapes = new Set();
        this._tilemaps = new Set();
        this._lightProbes = new Set();
        this._skybox = null;
        this._volumetricClouds = null;
        this._skyAtmosphere = null;
        this._skyLight = null;

        // TODO: Move this to a LightManager class
        this._numPointLights = 0;
        this._numSpotlights = 0;

        // Only STRUCTURAL changes alter which nodes exist, so only they force a re-traversal; property
        // edits share this event and must not. A payload-less emit is treated as structural.
        CleoEngine.eventEmitter.on('SCENE_CHANGED', (e) => {
            if (!e || e.kind === 'structure' || e.kind === 'visibility' || e.kind === 'name') this._onChange();
        });
    }

    public start(): void {
        if (this._hasStarted) return;
        Logger.info('Scene starting');

        // BEFORE the walk: a script's onStart may spawn another node, and Node.spawn runs the woken node's
        // onStart only once the scene is started. Also makes the early return above cover re-entry.
        this._hasStarted = true;

        // Every dormant node must be settled BEFORE any onStart runs, so tree order stops mattering.
        // Idempotent: Scene.parse has usually done it, but a scene built in code never went through parse.
        this._root.applySpawnRules();

        // Three separate passes over the finished tree, in the order a script sees them, so a node's
        // onConstruct can spawn a node declared anywhere and still have it get its own onSpawn/onStart:
        //   onConstruct — EVERY node, dormant included (the only handler a dormant node gets)
        //   onSpawn     — the awake ones
        //   onStart     — the awake ones (Node.start)
        this._root.runConstructHandlers();
        this._root.runSpawnHandlers();
        this._root.start();
    }

    public stop(): void {
        this._hasStarted = false;
        Logger.info('Scene stopped');
    }

    /** When false, skinned-model animators are not driven by scene.update (they hold bind pose). */
    public get animationsEnabled(): boolean { return this._animationsEnabled; }
    public set animationsEnabled(value: boolean) { this._animationsEnabled = value; }

    /**
     * When false, `Node.spawnOnStart` is ignored and every node starts spawned — set false on editing
     * scenes. True (the default) for Play mode and published games.
     */
    public get spawnRulesEnabled(): boolean { return this._spawnRulesEnabled; }
    public set spawnRulesEnabled(value: boolean) { this._spawnRulesEnabled = value; }

    /** Whether {@link start} has run. Read by Node.spawn to decide if a freshly woken node should start. */
    public get hasStarted(): boolean { return this._hasStarted; }

    public addNode(node: Node): void {
        node.scene = this;
        this._root.addChild(node);
    }

    public addNodes(...nodes: Node[]): void {
        for (const node of nodes)
            this.addNode(node);
    }

    public removeNode(node: Node): void {
        // Must be the node's actual parent: removeChild splices at indexOf(node), and indexOf === -1 for a
        // non-child makes splice(-1, 1) delete an unrelated last child.
        (node.parent ?? this._root).removeChild(node);
    }

    /**
     * Create a brand-new node subtree from a template asset, live, and add it to the scene.
     *
     * The copy is complete — children, materials, colliders and scripts, with fresh ids throughout, so
     * nothing is shared with the template or other instances. It spawns immediately (`onSpawn` then
     * `onStart` fire before this returns) regardless of the template's `spawnOnStart`.
     *
     *   const bullet = this.scene.instantiate('Bullet', { position: this.worldPosition });
     *   bullet.body.velocity.set(...);
     *
     * @param nameOrId Template name (what you called it in the editor) or its id.
     * @param options  Parent/name/transform overrides for the new root.
     * @returns The new node, or `null` if there is no such template — which is also logged.
     */
    public instantiate(nameOrId: string, options: InstantiateOptions = {}): Node | null {
        const template = getTemplate(nameOrId);
        if (!template) {
            Logger.error(`instantiate: no template "${nameOrId}". Available: ${templateNames().map(n => `'${n}'`).join(', ') || 'none'}`, 'Scene');
            return null;
        }

        // Deep copy first: the registry entry is the shared master, and regenerateNodeIds and the parse
        // below both mutate what they are handed. Not via JSON — geometry is typed arrays, see cloneNodeJson.
        const json = cloneNodeJson(template.node);
        regenerateNodeIds(json, new Map());

        if (options.name !== undefined) json.name = options.name;
        if (options.position) json.position = [...options.position];
        if (options.rotation) json.rotation = [...options.rotation];
        if (options.scale) json.scale = [...options.scale];
        // An explicit instantiate always spawns, even from a template flagged dormant.
        json.spawnOnStart = true;

        const parent = options.parent ?? this._root;
        parseNodeJson(parent, json);

        // The parse above emitted the structural change, so this lookup's traversal already sees the node.
        return this.getNodeById(json.id) ?? null;
    }

    public removeNodesByName(name: string): void {
        const nodesToRemove = this.getNodesByName(name);
        if (nodesToRemove.length > 0) {
            for (const node of nodesToRemove)
                this.removeNode(node);
        }
    }

    public removeNodeById(id: string): void {
        const nodeToRemove = this.getNodeById(id);
        if (nodeToRemove)
            this.removeNode(nodeToRemove);
    }

    public update(delta: number, time: number, paused: boolean): void {
        try {
            const frameStart = performance.now();
            resetSceneStats();

            const transformStart = performance.now();
            this._root.updateTransforms();
            sceneStats.transformMs = performance.now() - transformStart;

            if (this._hasStarted && !paused) {
                const timerStart = performance.now();
                this._updateTimers(delta);
                sceneStats.timerMs = performance.now() - timerStart;
            }

            const loopStart = performance.now();
            // Must read the GETTER: this loop owns the removal sweep and every onUpdate, so running it
            // against a stale set would skip a just-added node. Light indices are a function of the node
            // set alone, so one pass over the lights answers for the whole frame.
            let assignedLightIndices = false;
            for (const node of this.nodes) {
                if (!assignedLightIndices && node instanceof LightNode) {
                    this._asignLightIndices();
                    assignedLightIndices = true;
                }

                if (node.markForRemoval) {
                    this.removeNode(node);
                    continue;
                }

                if (this._hasStarted && !paused)
                    node.update(delta, time);
            }
            // Dormant nodes are not in _nodes, so the sweep above never sees one — but `despawn()` then
            // `remove()` is ordinary, and the node would otherwise stay in the tree forever.
            for (const node of this._dormant)
                if (node.markForRemoval) this.removeNode(node);

            sceneStats.nodeLoopMs = performance.now() - loopStart;

            // Camera rigs must run LAST, after every onUpdate: a follow target sorting later in the
            // traversal would not have moved yet, and the rig would trail it by a frame. The extra
            // full-tree transform pass is what makes the targets' world positions current.
            const rigs = this.cameraRigs;
            if (rigs.size > 0) {
                // Counted as transform cost, not rig cost: it is a second full-tree pass.
                const rigTransformStart = performance.now();
                this._root.updateTransforms();
                sceneStats.transformMs += performance.now() - rigTransformStart;

                // Not gated on _hasStarted/!paused: an editing scene is started AND unpaused (the free-fly
                // viewport camera needs both), so AUTHORING is what "not playing" means here. It previews
                // the rig's resting pose instantly, with no damping, collision or shake.
                const rigStart = performance.now();
                const authoring = CleoEngine.authoringMode;
                const snap = authoring || !this._hasStarted || paused;
                // A rig writes its own transform and its camera child's every frame. Those are DERIVED, so
                // they must not reach the editor as authoring changes. Safe to suppress around the whole
                // pass because it is synchronous: no real edit can interleave and be swallowed.
                CleoEngine.authoringMode = false;
                try {
                    for (const rig of rigs) rig.lateUpdate(delta, snap);
                } finally {
                    CleoEngine.authoringMode = authoring;
                }
                sceneStats.rigMs = performance.now() - rigStart;
            }

            this._solveUI();

            sceneStats.nodes = this._nodes.size;
            sceneStats.frameMs = performance.now() - frameStart;
        } catch (e) {
            Logger.error(e);
        }
    }

    /**
     * Resolve every UI root's subtree into screen rects. Must run LAST in the update:
     *  - after onUpdate, so a script writing `bar.value = hp / maxHp` lands the same frame;
     *  - after the rig pass, because a world-space root projects through the active camera, whose
     *    transform a rig writes in that pass.
     *
     * Not gated on `_hasStarted`/`paused`, like the rig pass, so the editor can preview the layout.
     * Needs no extra `updateTransforms()`: the frame's earlier passes already refreshed `worldPosition`.
     */
    private _solveUI(): void {
        const roots = this.uiRoots;
        if (roots.size === 0) return;

        const uiStart = performance.now();
        const { width, height, dpr } = this._uiViewport;

        const camera = this.activeCamera?.camera ?? null;
        let viewProj: mat4 | null = null;
        let orthographic = false;
        let orthoVerticalExtent = 0;
        if (camera) {
            mat4.multiply(this._uiViewProj, camera.projectionMatrix, camera.viewMatrix);
            viewProj = this._uiViewProj;
            orthographic = camera.type === 'orthographic';
            orthoVerticalExtent = camera.top - camera.bottom;
        }

        // The solve writes derived state on every UI node each frame; none of it is the user's edit, so it
        // must not reach the editor as authoring changes. Second line of defence — the resolved fields are
        // plain assignments that never call _notifyChange.
        const authoring = CleoEngine.authoringMode;
        CleoEngine.authoringMode = false;
        try {
            for (const root of roots) {
                // A nested root is resolved by its own iteration here, not by its parent's subtree walk, so
                // its rect always comes from the viewport or its projection, never from an enclosing rect.
                root.solveRoot(width, height, dpr, viewProj, orthographic, orthoVerticalExtent);
            }
        } finally {
            CleoEngine.authoringMode = authoring;
        }

        sceneStats.uiNodes = this._uiNodes.size;
        sceneStats.uiMs = performance.now() - uiStart;
    }

    /**
     * Tell the UI layout pass how large its container is, in CSS pixels. Must NOT come from
     * `currentViewport` (that is the internal render size, so a HUD would shrink with render scale) nor
     * from the canvas (the host's overlay box is the editor viewport panel or `#ui-root`, not the canvas).
     *
     * Written by the DOM host from a ResizeObserver on its own container. Without one the last value
     * stands, defaulting to 1920x1080 rather than collapsing to zero.
     */
    public setUIViewport(width: number, height: number, dpr: number = 1): void {
        this._uiViewport.width = Math.max(0, width);
        this._uiViewport.height = Math.max(0, height);
        this._uiViewport.dpr = dpr > 0 ? dpr : 1;
    }

    /** The container size the UI pass lays out against. See {@link setUIViewport}. */
    public get uiViewport(): { width: number, height: number, dpr: number } { return this._uiViewport; }

    /**
     * Per-frame timings for the last completed update. Mirrors `renderer.stats` / `physics.stats`;
     * read by the editor's performance HUD.
     */
    public get stats(): SceneStats { return sceneStats; }

    /** Backs `this.after(seconds, cb)`. Returns a function that cancels this one timer. */
    public scheduleAfter(node: Node, seconds: number, cb: () => void): () => void {
        const timer: ScheduledTimer = { node, remaining: Math.max(0, seconds), interval: null, cb, cancelled: false };
        this._timers.push(timer);
        return () => { timer.cancelled = true; };
    }

    /** Backs `this.every(seconds, cb)`. Returns a function that cancels this one repeat. */
    public scheduleEvery(node: Node, seconds: number, cb: () => void): () => void {
        // A period of 0 or less would refire every tick forever, so it is floored.
        const timer: ScheduledTimer = { node, remaining: Math.max(0.0001, seconds), interval: Math.max(0.0001, seconds), cb, cancelled: false };
        this._timers.push(timer);
        return () => { timer.cancelled = true; };
    }

    /** Cancels every pending timer scheduled by `node` — called on despawn so a removed node's
     *  this.after/this.every callbacks never fire against a node no longer in the scene. */
    public cancelTimers(node: Node): void {
        for (const timer of this._timers)
            if (timer.node === node) timer.cancelled = true;
    }

    private _updateTimers(delta: number): void {
        if (this._timers.length === 0) return;

        const surviving: ScheduledTimer[] = [];
        for (const timer of this._timers) {
            if (timer.cancelled) continue;

            timer.remaining -= delta;
            if (timer.remaining > 0) { surviving.push(timer); continue; }

            try { timer.cb(); }
            catch (e) { Logger.error(`Error in a scheduled timer for node ${timer.node.name}: ${e}`, 'Script'); }

            // The callback may have cancelled its own repeat (or the node may have despawned from
            // inside it) — re-check before deciding whether it keeps its slot.
            if (timer.cancelled) continue;
            if (timer.interval !== null) {
                timer.remaining += timer.interval;
                surviving.push(timer);
            }
        }
        this._timers = surviving;
    }
    
    private _breadthFirstTraversal(): void {
        const visited: Set<Node> = new Set();
        const active: Set<Node> = new Set();
        const dormant: Set<Node> = new Set();
        const queue: Node[] = [];

        visited.add(this._root);
        active.add(this._root);
        queue.push(this._root);

        while (queue.length > 0) {
            const current = queue.shift() as Node;

            for (const child of current.children) {
                if (!visited.has(child)) {
                    visited.add(child);
                    // Node.spawn/despawn set the flag across the whole subtree, so a per-node test is enough.
                    (child.spawned ? active : dormant).add(child);
                    queue.push(child);
                }
            }
        }

        this._nodes = active;
        this._dormant = dormant;
        this._dirty = false;

        this._filterByType(visited);
    }

    /**
     * `nodes` — the type-filtered lists and the per-frame loop — holds only SPAWNED nodes, which is what
     * makes despawn reach every consumer at once. The name/id indexes are built from `visited` instead,
     * dormant nodes included: `findNode('Door').spawn()` is the only way back for a dormant node.
     */
    private _filterByType(visited: Set<Node> = this._nodes): void {
        // This seems unoptimized, TODO: Fix later
        this._uiRoots = new Set();
        this._uiNodes = new Set();
        this._cameras = new Set();
        this._lights = new Set();
        this._models = new Set();
        this._sprites = new Set();
        this._landscapes = new Set();
        this._tilemaps = new Set();
        this._lodGroups = new Set();
        this._cameraRigs = new Set();
        this._lightProbes = new Set();
        this._skybox = null;
        this._volumetricClouds = null;
        this._skyAtmosphere = null;
        this._skyLight = null;
        this._nodesByName = new Map();
        this._nodesById = new Map();
        for (const node of this._nodes) {
            if (node instanceof LightNode)
                this._lights.add(node);
            if (node instanceof ModelNode)
                this._models.add(node);
            if (node instanceof SpriteNode)
                this._sprites.add(node);
            if (node instanceof LandscapeNode)
                this._landscapes.add(node);
            if (node instanceof TilemapNode)
                this._tilemaps.add(node);
            if (node instanceof LodGroupNode)
                this._lodGroups.add(node);
            if (node instanceof CameraRigNode)
                this._cameraRigs.add(node);
            if (node instanceof LightProbeNode)
                this._lightProbes.add(node);
            if (node instanceof SkyboxNode)
                this._skybox = node;
            if (node instanceof VolumetricCloudsNode)
                this._volumetricClouds = node;
            if (node instanceof SkyAtmosphereNode)
                this._skyAtmosphere = node;
            if (node instanceof SkyLightNode)
                this._skyLight = node;
            if (node instanceof CameraNode)
                this._cameras.add(node);
            // A root is also a UINode and lands in both sets: _uiRoots drives the layout pass, _uiNodes is
            // what the DOM layer and the editor enumerate.
            if (node instanceof UINode)
                this._uiNodes.add(node);
            if (node instanceof UIRootNode)
                this._uiRoots.add(node);
        }

        for (const node of visited) {
            const byName = this._nodesByName.get(node.name);
            if (byName) byName.push(node); else this._nodesByName.set(node.name, [node]);
            this._nodesById.set(node.id, node);
        }
    }

    public getNodesByName(name: string): Node[] {
        if (this._dirty)
            this._breadthFirstTraversal();

        // Copied out: this is the list backing the index, and a caller may mutate its own result.
        const nodes = this._nodesByName.get(name);
        return nodes ? [...nodes] : [];
    }

    /** First node with this name, or undefined. The scripting shorthand for getNodesByName(name)[0]. */
    public findNode(name: string): Node | undefined {
        if (this._dirty)
            this._breadthFirstTraversal();
        return this._nodesByName.get(name)?.[0];
    }

    public getNodeById(id: string): Node | undefined {
        if (this._dirty)
            this._breadthFirstTraversal();
        return this._nodesById.get(id);
    }

    public serialize(useCache: boolean = false): Promise<any> {
        const output: {scene: any, textures: any} = {scene: {}, textures: {}};
        return new Promise((resolve, reject) => {
            this._root.serialize().then((json: any) => {
                output.scene = json;
                if (this._environmentMap) {
                    try {
                        output.scene.environmentMap = TextureManager.Instance.serializeCubeMap(this._environmentMap);
                    } catch (e) {
                        Logger.error('Failed to serialize environment map');
                    }
                }
                // toDataURL can throw (a cross-origin/tainted canvas); unguarded, the promise would never
                // settle and any save/publish awaiting it would hang forever.
                if (!useCache) {
                    try {
                        output.textures = TextureManager.Instance.serializeTextureData();
                    } catch (e) {
                        Logger.error('Failed to serialize textures');
                        output.textures = [];
                    }
                }
                resolve(output);
            // Surface a rejected node serialize instead of hanging the whole chain.
            }).catch(reject);
        });
    }

    public parse(json: any, useCache: boolean = false): void {
        let newScene = new Node('root');
        newScene.scene = this;
        Node.parse(newScene, json.scene);

        const env = json.scene?.environmentMap;
        if (env) {
            const createImage = (src: string): Promise<HTMLImageElement> => {
                return new Promise((resolve) => { const img = new Image(); img.src = src; img.onload = () => resolve(img); });
            }
            Promise.all([
                createImage(env.positiveX),
                createImage(env.negativeX),
                createImage(env.positiveY),
                createImage(env.negativeY),
                createImage(env.positiveZ),
                createImage(env.negativeZ)
            ]).then(images => {
                const tex = new Texture({ target: 'cubemap', flipY: true });
                tex.create({
                    posX: images[0], negX: images[1], posY: images[2], negY: images[3], posZ: images[4], negZ: images[5]
                }, images[0].width, images[0].height);
                this._environmentMap = tex;
            }).catch(err => Logger.error(err));
        }

        if (!useCache)
            for (const texture of json.textures)
                TextureManager.Instance.addTextureFromBase64(texture.data, texture.config, texture.id);
        this._dirty = true;
        this._root = newScene.getChildByName('root')[0] as Node;
        // Must happen before anyone can read a node list: scene.start() is deferred behind a timeout by both
        // hosts and frames render in between, so dormant nodes would show for a beat. _dirty is already set.
        this._root.applySpawnRules();
    }

    // TODO: Move this to a LightManager class
    private _asignLightIndices(): void {
        const nodes = this.nodes;
        let pointLights = 0;
        let spotlights = 0;
        for (const node of nodes) {
            if (node instanceof LightNode) {
                if (node.type === 'point') {
                    node.index = pointLights;
                    pointLights++;
                }

                if (node.type === 'spotlight') {
                    node.index = spotlights;
                    spotlights++;
                }
            }
        }
        this._numPointLights = pointLights;
        this._numSpotlights = spotlights;
    }

    private _onChange() {
        this._dirty = true;
    }

    public get root(): Node { return this._root; }

    public get nodes(): Set<Node> {
        if (this._dirty)
            this._breadthFirstTraversal();
        return this._nodes;
    }

    /**
     * The first camera in the scene marked active, or `undefined` if there is none — an empty scene, or
     * one whose cameras are all inactive. Callers must handle the absence.
     */
    public get activeCamera(): CameraNode | undefined {
        if (this._dirty)
            this._breadthFirstTraversal();
        for (const camera of this._cameras)
            if (camera.active)
                return camera;
        return undefined;
    }

    public get lights(): Set<LightNode> {
        if (this._dirty)
            this._breadthFirstTraversal();
        return this._lights;
    }

    public get models(): Set<ModelNode> {
        if (this._dirty)
            this._breadthFirstTraversal();
        return this._models;
    }

    public get lodGroups(): Set<LodGroupNode> {
        if (this._dirty)
            this._breadthFirstTraversal();
        return this._lodGroups;
    }

    public get cameraRigs(): Set<CameraRigNode> {
        if (this._dirty)
            this._breadthFirstTraversal();
        return this._cameraRigs;
    }

    /**
     * Every UI root in the scene; drives the UI layout pass. A root can be nested under another root, so
     * this is a flat set — each root resolves its own rect and then walks its own subtree.
     */
    public get uiRoots(): Set<UIRootNode> {
        if (this._dirty)
            this._breadthFirstTraversal();
        return this._uiRoots;
    }

    /** Every UI element in the scene, roots included. What the DOM layer enumerates. */
    public get uiNodes(): Set<UINode> {
        if (this._dirty)
            this._breadthFirstTraversal();
        return this._uiNodes;
    }

    public get sprites(): Set<SpriteNode> {
        if (this._dirty)
            this._breadthFirstTraversal();
        return this._sprites;
    }

    public get landscapes(): Set<LandscapeNode> {
        if (this._dirty)
            this._breadthFirstTraversal();
        return this._landscapes;
    }

    public get tilemaps(): Set<TilemapNode> {
        if (this._dirty)
            this._breadthFirstTraversal();
        return this._tilemaps;
    }

    public get skybox(): SkyboxNode | null {
        if (this._dirty)
            this._breadthFirstTraversal();
        return this._skybox;
    }

    public get volumetricClouds(): VolumetricCloudsNode | null {
        if (this._dirty)
            this._breadthFirstTraversal();
        return this._volumetricClouds;
    }

    public get skyAtmosphere(): SkyAtmosphereNode | null {
        if (this._dirty)
            this._breadthFirstTraversal();
        return this._skyAtmosphere;
    }

    public get skyLight(): SkyLightNode | null {
        if (this._dirty)
            this._breadthFirstTraversal();
        return this._skyLight;
    }

    public get lightProbes(): Set<LightProbeNode> {
        if (this._dirty)
            this._breadthFirstTraversal();
        return this._lightProbes;
    }

    /** The light probe nearest the given world position that has baked maps, or null. */
    public activeProbe(position: vec3): LightProbeNode | null {
        let nearest: LightProbeNode | null = null;
        let nearestDist = Infinity;
        for (const probe of this.lightProbes) {
            if (!probe.hasBakedMaps) continue;
            const d = vec3.squaredDistance(position, probe.worldPosition);
            if (d < nearestDist) { nearestDist = d; nearest = probe; }
        }
        return nearest;
    }

    /**
     * The baked probe with the highest feathered containment weight at `position` (bounded volumes
     * first — an unbounded probe only wins when no volume contains the point), else null.
     * Used for per-mesh probe selection on the forward path.
     */
    public probeForPoint(position: vec3): LightProbeNode | null {
        let best: LightProbeNode | null = null;
        let bestWeight = 0;
        let nearestUnbounded: LightProbeNode | null = null;
        let nearestDist = Infinity;
        for (const probe of this.lightProbes) {
            if (!probe.hasBakedMaps) continue;
            if (probe.bounded) {
                const w = probe.probeWeight(position);
                if (w > bestWeight) { bestWeight = w; best = probe; }
            } else {
                const d = vec3.squaredDistance(position, probe.worldPosition);
                if (d < nearestDist) { nearestDist = d; nearestUnbounded = probe; }
            }
        }
        return best ?? nearestUnbounded;
    }

    /**
     * Up to `max` baked probes for the deferred lighting pass's per-pixel volume selection:
     * bounded probes (nearest volume centre to the camera first), then unbounded probes (nearest
     * first) as the tail fallback slot(s).
     */
    public probesForFrame(cameraPos: vec3, max: number): LightProbeNode[] {
        const bounded: LightProbeNode[] = [];
        const unbounded: LightProbeNode[] = [];
        for (const probe of this.lightProbes) {
            if (!probe.hasBakedMaps) continue;
            (probe.bounded ? bounded : unbounded).push(probe);
        }
        const byDist = (a: LightProbeNode, b: LightProbeNode) =>
            vec3.squaredDistance(cameraPos, a.worldPosition) - vec3.squaredDistance(cameraPos, b.worldPosition);
        bounded.sort(byDist);
        unbounded.sort(byDist);
        return [...bounded, ...unbounded].slice(0, max);
    }

    public get environmentMap(): Texture | null { return this._environmentMap; }
    public set environmentMap(envMapTex: Texture | null) { this._environmentMap = envMapTex; }

    // TODO: Move this to a LightManager class
    public get numPointLights(): number { return this._numPointLights; }
    public get numSpotlights(): number { return this._numSpotlights; }
}