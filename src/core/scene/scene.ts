import { CleoEngine, Texture, TextureManager } from "../../cleo";
import { CameraNode, CameraRigNode, LandscapeNode, LightNode, LightProbeNode, LodGroupNode, ModelNode, Node, SkyboxNode, SpriteNode, VolumetricCloudsNode, SkyAtmosphereNode } from "./node";
import { vec3 } from "gl-matrix";
import { Logger } from '../logger'
import type { PhysicsSystem } from "../../physics/physicsSystem";

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
    private _lodGroups: Set<LodGroupNode> = new Set();
    private _cameraRigs: Set<CameraRigNode> = new Set();
    private _lightProbes: Set<LightProbeNode>;
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
        this._lightProbes = new Set();
        this._skybox = null;
        this._volumetricClouds = null;
        this._skyAtmosphere = null;

        // TODO: Move this to a LightManager class
        this._numPointLights = 0;
        this._numSpotlights = 0;

        CleoEngine.eventEmitter.on('SCENE_CHANGED', () => this._onChange());
    }

    public start(): void {
        if (this._hasStarted) return;
        Logger.info('Scene starting');
        
        this._root.start();
        
        this._hasStarted = true;
    }

    public stop(): void {
        this._hasStarted = false;
        Logger.info('Scene stopped');
    }

    /** When false, skinned-model animators are not driven by scene.update (they hold bind pose). */
    public get animationsEnabled(): boolean { return this._animationsEnabled; }
    public set animationsEnabled(value: boolean) { this._animationsEnabled = value; }

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
            this._root.updateTransforms();

            if (this._hasStarted && !paused)
                this._updateTimers(delta);

            for (const node of this._nodes) {
                if (node instanceof LightNode) this._asignLightIndices();

                if (node.markForRemoval) {
                    this.removeNode(node);
                    continue;
                }

                if (this._hasStarted && !paused)
                    node.update(delta, time);
            }

            // Camera rigs run LAST, after every onUpdate. A rig cannot do this work from its own
            // update(): a follow target that sorts later in the traversal would not have moved yet,
            // so the rig would trail it by a frame (visible as shimmer during fast movement). The
            // extra full-tree transform pass is what makes the targets' world positions -- and, on
            // the way back down, each rig's own camera child -- current; it is paid only when the
            // scene actually contains a rig.
            const rigs = this.cameraRigs;
            if (rigs.size > 0) {
                this._root.updateTransforms();
                // Deliberately not gated on _hasStarted/!paused: passing snap instead lets a stopped
                // editor scene still preview the rig's resting pose (instantly, with no collision or
                // shake) while its properties are being edited.
                const snap = !this._hasStarted || paused;
                for (const rig of rigs) rig.lateUpdate(delta, snap);
            }
        } catch (e) {
            Logger.error(e);
        }
    }

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
        const queue: Node[] = [];

        visited.add(this._root);
        queue.push(this._root);

        while (queue.length > 0) {
            const current = queue.shift() as Node;

            for (const child of current.children) {
                if (!visited.has(child)) {
                    visited.add(child);
                    queue.push(child);
                }
            }
        }

        this._nodes = visited;
        this._dirty = false;

        this._filterByType();
    }

    private _filterByType(): void {
        // This seems unoptimized, TODO: Fix later
        this._cameras = new Set();
        this._lights = new Set();
        this._models = new Set();
        this._sprites = new Set();
        this._landscapes = new Set();
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