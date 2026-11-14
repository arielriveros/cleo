// Loading physics saved before colliders and triggers became nodes (player contract 37). A rigid body and a
// trigger used to be properties of any node -- a `body` and a `trigger` block in its JSON -- and a 2D
// trigger was an Area 2D node. They are node types now: a Collider IS the body and carries what is under
// it, a Trigger is the sensor. So:
//
//  - a plain node (an empty holder: a wall's box, a zone, a hurtbox, a scripted prop's root) BECOMES the
//    Collider, or with only a trigger the Trigger: same name, id, transform, variables and script, so a
//    script on it still hears its own collisions and triggers;
//  - any other node (a model, a character, a placed model's root) is wrapped in a new Collider that takes
//    its place and its transform, the node going under it unmoved; and a trigger on it, or a trigger beside
//    a body, becomes a Trigger child;
//  - an Area 2D becomes a Trigger.
//
// New nodes' ids are derived from the old node's, so a project converts to the same ids on every load until
// it is saved.
//
// A pure JSON transform, so parseNodeJson (and the editor, on load) can call it with no import cycle.

const IDENTITY = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };

/** The id the Collider wrapping node `id` gets. */
export const legacyColliderId = (id: string): string => `${id}:collider`;
/** The id the Trigger child of node `id` gets. */
export const legacyTriggerId = (id: string): string => `${id}:trigger`;

/** Whether `json` still carries physics in the old form: a `body`, a `trigger` volume, or an Area 2D. */
export function hasLegacyPhysics(json: any): boolean {
    if (!json || typeof json !== 'object') return false;
    if (json.type === 'area2D') return true;
    return isLegacyBody(json.body) || isLegacyTrigger(json.trigger);
}

const isLegacyBody = (b: unknown): b is Record<string, any> => !!b && typeof b === 'object' && !Array.isArray(b);
// `trigger` is also an animation transition's field elsewhere (a string): only a volume's object counts.
const isLegacyTrigger = (t: unknown): t is Record<string, any> => !!t && typeof t === 'object' && !Array.isArray(t);

/**
 * Whether a node with physics becomes the Collider or Trigger itself (see the module comment): a plain node
 * that is not a placed model's root. A placed model is rebuilt from its asset, which knows nothing of
 * physics, so its collider has to stand outside it (`__modelId`, and `__meshId` before it, mark one).
 */
function becomesItself(json: any): boolean {
    if (json.type !== undefined && json.type !== 'node') return false;
    const vars = json.variables;
    return !(vars && typeof vars === 'object' && (vars.__modelId || vars.__meshId));
}

/** A legacy 3D trigger block as a Trigger node's `sensor` settings. */
function sensorFromTrigger(t: Record<string, any>): any {
    return {
        shapes: Array.isArray(t.shapes) ? t.shapes : [],
        layer: typeof t.group === 'number' ? t.group : 1,
        mask: typeof t.mask === 'number' ? t.mask : -1,
        detectTriggers: t.detectTriggers === true,
        continuous: t.continuous === true,
        enabled: t.enabled !== false,
    };
}

/** A legacy body block as a Collider node's `collider` settings. */
const colliderFromBody = (body: Record<string, any>): any => ({ ...body, shapes: Array.isArray(body.shapes) ? body.shapes : [] });

/** Whether `converted` is the Collider that `legacy` was wrapped in, rather than `legacy` itself converted. */
export function isLegacyWrapper(legacy: any, converted: any): boolean {
    return !!converted && converted.type === 'collider' && typeof legacy?.id === 'string' && converted.id === legacyColliderId(legacy.id);
}

/**
 * `json` with its physics in the node form (see the module comment), or `json` itself when it has none in
 * the old form. Only this node: its children are converted as they are parsed.
 */
export function migrateLegacyPhysicsJson(json: any): any {
    if (!hasLegacyPhysics(json)) return json;

    if (json.type === 'area2D') {
        const { area2D, ...rest } = json;
        const d = area2D ?? {};
        return {
            ...rest,
            type: 'trigger',
            sensor: {
                shapes: [],
                size: Array.isArray(d.size) ? d.size : [1, 1],
                offset: Array.isArray(d.offset) ? d.offset : [0, 0],
                layer: typeof d.layer === 'number' ? d.layer : 1,
                // An Area 2D's mask defaulted to layer 1, not to every layer.
                mask: typeof d.mask === 'number' ? d.mask : 1,
                detectTriggers: d.detectAreas === true,
                continuous: false,
                enabled: d.enabled !== false,
            },
        };
    }

    const { body, trigger, ...node } = json;
    const name = typeof json.name === 'string' ? json.name : 'Node';
    const id = typeof json.id === 'string' ? json.id : String(json.id ?? '');
    const children: any[] = Array.isArray(node.children) ? [...node.children] : [];

    if (becomesItself(json)) {
        // Only a trigger: the node is the Trigger.
        if (!isLegacyBody(body)) return { ...node, type: 'trigger', sensor: sensorFromTrigger(trigger!) };
    }

    if (isLegacyTrigger(trigger)) {
        children.push({
            type: 'trigger', name: `${name} Trigger`, id: legacyTriggerId(id), ...IDENTITY, children: [],
            sensor: sensorFromTrigger(trigger),
        });
    }
    if (becomesItself(json)) {
        // A body (and maybe a trigger, its child now): the node is the Collider.
        return { ...node, type: 'collider', collider: colliderFromBody(body!), children };
    }
    const inner = { ...node, children };
    if (!isLegacyBody(body)) return inner;

    // The Collider takes the node's place: its transform, and whether it wakes on start (a pooled projectile's
    // body must sleep with it). The node keeps everything else -- its name, id, script, variables, children.
    const { position, rotation, scale, spawnOnStart, ...kept } = inner;
    return {
        type: 'collider',
        name: `${name} Collider`,
        id: legacyColliderId(id),
        position: position ?? [0, 0, 0],
        rotation: rotation ?? [0, 0, 0],
        scale: scale ?? [1, 1, 1],
        ...(spawnOnStart === false ? { spawnOnStart: false } : {}),
        collider: colliderFromBody(body),
        children: [{ ...kept, ...IDENTITY }],
    };
}

/** {@link migrateLegacyPhysicsJson} over a whole subtree (the editor converts saved scenes and templates). */
export function migrateLegacyPhysicsTree(json: any): any {
    if (!json || typeof json !== 'object') return json;
    const out = migrateLegacyPhysicsJson(json);
    if (!Array.isArray(out.children)) return out;
    const children = out.children.map((c: any) => migrateLegacyPhysicsTree(c));
    return { ...out, children };
}
