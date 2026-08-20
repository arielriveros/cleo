import { CleoEngine, Texture, TextureManager } from "../../cleo";
import { CameraNode, CameraRigNode, LandscapeNode, LightNode, LightProbeNode, LodGroupNode, ModelNode, Node, SkyboxNode, SpriteNode, TilemapNode, UINode, UIRootNode, VolumetricCloudsNode, SkyAtmosphereNode, parseNodeJson } from "./node";
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
    // Initialized here, not in the constructor — which assigns every other node set but happened to omit
    // this one. Harmless only by accident: _dirty starts true, so the sole reader (activeCamera) always
    // runs _breadthFirstTraversal -> _filterByType, which assigns it, first. Matches _lodGroups below.
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
    // Container size for the UI layout pass, in CSS pixels. See setUIViewport for why this is pushed in
    // rather than read from the canvas or from currentViewport.
    private _uiViewport: { width: number, height: number, dpr: number } = { width: 1920, height: 1080, dpr: 1 };
    // Reused across frames: the UI pass must not allocate a matrix per world-space root per frame.
    private readonly _uiViewProj: mat4 = mat4.create();
    // Built alongside _nodes so getNodesByName/getNodeById (called from scripts, sometimes per-frame)
    // are an O(1) map lookup instead of a scan over every node in the scene.
    private _nodesByName: Map<string, Node[]> = new Map();
    private _nodesById: Map<string, Node> = new Map();
    private _skybox: SkyboxNode | null;
    private _volumetricClouds: VolumetricCloudsNode | null = null;
    private _skyAtmosphere: SkyAtmosphereNode | null = null;
    private _environmentMap: Texture | null = null;
    private _dirty: boolean = true;
    private _hasStarted: boolean = false;
    // When false, ModelNode animators are NOT driven by scene.update (skinned meshes hold their bind/
    // T pose). The editor sets this false on its editing scenes so animations only play in Play mode
    // and the Animation Editor (which drives its preview clone directly). Default true = normal playback.
    private _animationsEnabled: boolean = true;
    // When false, Node.spawnOnStart is ignored and every node starts spawned. The editor sets this false on
    // its editing scenes: a node the user flagged dormant must still be visible and selectable while
    // authoring it — the flag is a RUNTIME rule, honoured in Play mode and in a published game.
    private _spawnRulesEnabled: boolean = true;
    // Nodes present in the tree but asleep (see Node.despawn). Kept out of _nodes and every type-filtered
    // list so they cost nothing and reach no consumer; kept here only so the removal sweep can still free
    // one that was despawned and then removed.
    private _dormant: Set<Node> = new Set();

    /** Back-reference to the physics system driving this scene (set by PhysicsSystem.set scene).
     *  Exposes physics to node scripts via the injected `scene` identifier (e.g. scene.physics.startRagdoll). */
    public physics!: PhysicsSystem;

    // TODO: Move this to a LightManager class
    private _numPointLights: number;
    private _numSpotlights: number;

    // this.wait/this.after/this.every. Ticked once per Scene.update (not per node), gated the same as
    // node.update so timers pause with the game; cancelled per-node on despawn (see Node.remove/removeChild).
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

        // TODO: Move this to a LightManager class
        this._numPointLights = 0;
        this._numSpotlights = 0;

        // Only STRUCTURAL changes alter which nodes exist / the type-filtered lists, so only they need a
        // re-traversal. Property edits (transform/material/variable/...) now share this event but must not
        // trigger the full re-filter — especially not per-frame during a gizmo drag. A payload-less emit
        // (defensive / legacy) is treated as structural.
        CleoEngine.eventEmitter.on('SCENE_CHANGED', (e) => {
            if (!e || e.kind === 'structure' || e.kind === 'visibility' || e.kind === 'name') this._onChange();
        });
    }

    public start(): void {
        if (this._hasStarted) return;
        Logger.info('Scene starting');

        // BEFORE the walk, not after: a script's onStart may spawn another node, and Node.spawn only runs the
        // woken node's own onStart once the scene is started. Setting this afterwards meant anything spawned
        // from an onStart never got one at all. Also makes the early return above cover re-entry.
        this._hasStarted = true;

        // Every dormant node is settled BEFORE any onStart runs, so tree order stops mattering: a script that
        // spawns a node declared later in the tree used to hit one still flagged awake (spawn() no-ops) and
        // then watch the walk put it to sleep. Scene.parse has usually done this already; it is idempotent,
        // and a scene built in code never went through parse at all.
        this._root.applySpawnRules();

        // Three passes over the finished tree, in the order a script sees them:
        //   onConstruct — EVERY node, dormant included (the only handler a dormant node gets)
        //   onSpawn     — the awake ones
        //   onStart     — the awake ones (Node.start)
        // Passes rather than one walk, so that a node's onConstruct can spawn a node declared anywhere in the
        // tree and still have it receive its own onSpawn/onStart normally.
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
     * When false, `Node.spawnOnStart` is ignored and every node starts spawned. Set false on editing scenes
     * so a node flagged dormant still shows in the editor viewport; leave true (the default) for Play mode
     * and published games, where the flag is the whole point.
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
        // Remove from the node's actual parent. Using _root unconditionally mis-splices nested nodes:
        // removeChild does _children.splice(indexOf(node), 1), and indexOf === -1 for a non-child makes
        // splice(-1, 1) delete an unrelated last child (corrupting the tree during the removal sweep).
        (node.parent ?? this._root).removeChild(node);
    }

    /**
     * Create a brand-new node subtree from a template asset, live, and add it to the scene.
     *
     * The copy is complete: its own children, materials, colliders and scripts, with fresh ids throughout so
     * nothing is shared with the template or with other instances. It spawns immediately — `onSpawn` then
     * `onStart` fire before this returns — regardless of the template's `spawnOnStart`, since asking for it
     * explicitly is the whole point.
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

        // Deep copy first: the registry entry is the shared master and must survive being instantiated a
        // thousand times, and regenerateNodeIds/the parse below both mutate what they are handed. Not via
        // JSON — a published build's geometry is typed arrays; see cloneNodeJson.
        const json = cloneNodeJson(template.node);
        regenerateNodeIds(json, new Map());

        if (options.name !== undefined) json.name = options.name;
        if (options.position) json.position = [...options.position];
        if (options.rotation) json.rotation = [...options.rotation];
        if (options.scale) json.scale = [...options.scale];
        // A template flagged dormant would otherwise be instantiated asleep, which cannot be what a caller
        // that just asked for it wants. Despawn it explicitly if that is the intent.
        json.spawnOnStart = true;

        const parent = options.parent ?? this._root;
        parseNodeJson(parent, json);

        // parseNodeJson -> _commonParse -> parent.addChild emitted the structural change, so the traversal
        // this lookup runs is already rebuilding with the new node in it.
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
            // The GETTER, so a structural change since the last frame is picked up here rather than whenever
            // something else next happens to read a node list. This loop owns the removal sweep and every
            // onUpdate: running it against a stale set silently skips a node that was just added, and leaves
            // one marked for removal in the tree until an unrelated reader triggers the re-traversal.
            // Light indices are a function of the node set, not of anything the loop does, so one
            // pass over the lights answers for the whole frame. This used to run INSIDE the loop,
            // once per LightNode, and each call walked every node in the scene — O(lights x nodes)
            // per frame, recomputing an identical result every time.
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
            // Dormant nodes are not in _nodes, so the sweep above never sees one — but `despawn()` followed by
            // `remove()` is an ordinary thing to write, and without this the node would stay in the tree
            // forever. Almost always empty, so this costs nothing in practice.
            for (const node of this._dormant)
                if (node.markForRemoval) this.removeNode(node);

            sceneStats.nodeLoopMs = performance.now() - loopStart;

            // Camera rigs run LAST, after every onUpdate. A rig cannot do this work from its own
            // update(): a follow target that sorts later in the traversal would not have moved yet,
            // so the rig would trail it by a frame (visible as shimmer during fast movement). The
            // extra full-tree transform pass is what makes the targets' world positions -- and, on
            // the way back down, each rig's own camera child -- current; it is paid only when the
            // scene actually contains a rig.
            const rigs = this.cameraRigs;
            if (rigs.size > 0) {
                // Counted as transform cost, not rig cost: it is a second full-tree pass, and knowing
                // that rigs double the transform bill is the useful signal.
                const rigTransformStart = performance.now();
                this._root.updateTransforms();
                sceneStats.transformMs += performance.now() - rigTransformStart;

                // Deliberately not gated on _hasStarted/!paused: an editing scene keeps previewing the rig's
                // resting pose (instantly, with no collision or shake) while its properties are edited.
                //
                // AUTHORING is what "not playing" actually means here. The old `!_hasStarted || paused` never
                // snapped in the editor: its scene is started AND unpaused (both required for the free-fly
                // viewport camera), so the rig ran with full damping, collision and shake while authoring —
                // and damping asymptotes rather than settling, so the camera visibly drifted.
                const rigStart = performance.now();
                const authoring = CleoEngine.authoringMode;
                const snap = authoring || !this._hasStarted || paused;
                // A rig writes its own transform and its camera child's every frame. Those are DERIVED, never
                // the user's edit, so they must not reach the editor as authoring changes or the scene would
                // read as permanently unsaved. Same intent as the editor's withoutDirty, applied at the source;
                // safe because this pass is synchronous, so no real edit can interleave and be swallowed.
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
     * Resolve every UI root's subtree into screen rects.
     *
     * Runs LAST in the update, after every onUpdate and after the camera-rig pass. Both orderings matter:
     *  - after onUpdate, because a script writing `bar.value = hp / maxHp` must land the same frame;
     *    solving from a node's own update() would leave the HUD one frame behind whatever it displays.
     *  - after the rig pass, because a world-space root projects through the active camera, and a rig
     *    writes its camera child's transform in that pass — projecting first pins world UI to the
     *    PREVIOUS frame's camera, which reads as the label swimming during fast movement.
     *
     * Deliberately not gated on `_hasStarted`/`paused`, exactly like the rig pass: the editor has to
     * preview the resting layout while it is being authored, which is what makes `ui` mode work at all.
     *
     * Cheaper than the rig pass in one important way: it needs NO extra `updateTransforms()`. Screen-space
     * UI never reads a world transform, and a world root reads `worldPosition`, which the frame's earlier
     * passes already refreshed.
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

        // The solve writes derived state on every UI node, sixty times a second. None of those writes are
        // the user's edit, so they must not reach the editor as authoring changes — the scene would read
        // as permanently unsaved and HistoryContext would record an undo entry per frame. The resolved
        // fields are plain assignments that never call _notifyChange, and this is the second line of
        // defence around that; same intent and same shape as the rig pass above.
        const authoring = CleoEngine.authoringMode;
        CleoEngine.authoringMode = false;
        try {
            for (const root of roots) {
                // A nested root is resolved by its own iteration here, not by its parent's subtree walk,
                // so its rect always comes from the viewport or its projection rather than from an
                // enclosing rect. Iterating the flat set is what makes that fall out for free.
                root.solveRoot(width, height, dpr, viewProj, orthographic, orthoVerticalExtent);
            }
        } finally {
            CleoEngine.authoringMode = authoring;
        }

        sceneStats.uiNodes = this._uiNodes.size;
        sceneStats.uiMs = performance.now() - uiStart;
    }

    /**
     * Tell the UI layout pass how large its container is, in CSS pixels.
     *
     * Deliberately NOT read from `currentViewport` or the canvas:
     *  - `currentViewport` is the INTERNAL render size (canvas x renderScale), so a HUD would shrink
     *    whenever the user dropped render scale — the one thing a UI must never do.
     *  - the canvas is the wrong box anyway: the editor's overlay is the viewport panel and the player's
     *    is `#ui-root`, neither of which is guaranteed to match the canvas element.
     *
     * Written by the DOM host from a ResizeObserver on its own container. A scene that never has one
     * (a headless test, a code-only game) falls back to whatever was last set, defaulting to 1920x1080
     * so layouts still resolve to something sane rather than collapsing to zero.
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
        // A period of 0 (or negative) would refire every tick forever; floor it to something sane instead
        // of silently spinning the frame.
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
                    // Node.spawn/despawn set the flag across the whole subtree, so a per-node test is enough —
                    // a child of a dormant node is itself dormant and needs no bookkeeping from here.
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
     * `nodes` (the type-filtered lists and the per-frame loop) holds only SPAWNED nodes — that is what makes
     * despawn reach every consumer at once, including the renderer's light loops, which never looked at
     * `visible`. The name/id indexes are built from `visited` instead, dormant nodes included: a script must
     * still be able to `findNode('Door').spawn()` something that is asleep, and that lookup is the only way
     * back for a node placed with `spawnOnStart = false`.
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
            if (node instanceof CameraNode)
                this._cameras.add(node);
            // A root is also a UINode, so it deliberately lands in both sets: _uiRoots drives the layout
            // pass, _uiNodes is what the DOM layer and the editor enumerate.
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

        // Copied out: this is the same list backing the index, and a caller mutating its own result
        // (script or engine code) must not corrupt future lookups.
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
                // Serialize 2D textures unless using cache. Guarded: toDataURL can throw (e.g. a
                // cross-origin/tainted canvas), and without this the promise would never settle and
                // any save/publish awaiting it would hang forever.
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
        // change the root node entirely not just its children
        let newScene = new Node('root');
        newScene.scene = this;
        Node.parse(newScene, json.scene);

        // Recreate environment map if present
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
        // Before anyone can read a node list: scene.start() is deferred behind a timeout by both the editor
        // and the player, and frames are rendered in between, so leaving this to start() shows every dormant
        // node for a beat before it pops away. No emit needed — _dirty above already forces the re-traversal.
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
     * one whose cameras are all inactive. Callers must handle the absence; this signature previously
     * claimed a `CameraNode` while falling through to `undefined`.
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
     * Every UI root in the scene. Drives the UI layout pass.
     *
     * A root can be nested under another root (a world-space nameplate parented into a HUD, say), so this
     * is a flat set rather than a tree — each root resolves its own rect from the viewport or a projection
     * and then walks its own subtree.
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