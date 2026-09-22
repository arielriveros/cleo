import { describe, it, expect, afterEach, vi } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import { DecalNode, decalLocalToUV, radialDecalWeight, radialDecalT, DECAL_RADIAL_CURVES } from '../src/core/scene/nodes/decalNode';
import type { DecalOptions } from '../src/core/scene/nodes/decalNode';
import { Node } from '../src/core/scene/nodes/node';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';
import { markEditorOnly } from '../src/core/scene/editorNodes';
import { Scene } from '../src/core/scene/scene';
import { Raycaster } from '../src/core/raycaster';
import { Material } from '../src/graphics/material';
import { Logger } from '../src/core/logger';
import { brushFalloffExponent, brushFalloffWeight } from '../src/terrain/brushFalloff';
import { brushWeight, curveWeight } from '../src/terrain/sculpt';

// A decal is almost entirely renderer, and the renderer cannot run here. What CAN be pinned is everything
// the shaders take on trust from this node: the volume matrix they reconstruct positions against, the
// bounds the frustum test culls with, the uv orientation and falloff curve they transcribe, and the
// persistence contract. Every one of those fails silently -- a decal drawn somewhere else, a decal culled
// while on screen, a brush cursor whose gradient disagrees with the stroke it previews, or a decal that
// is simply not there after a reload.

afterEach(() => vi.restoreAllMocks());

/** Serialize through real JSON, re-parse under a fresh parent, and hand back both ends. */
async function roundTrip(node: DecalNode): Promise<{ copy: DecalNode, json: any }> {
    // Through JSON, not just the object: that is what reaches a scene file, and it is where an undefined
    // disappears and a NaN turns into null.
    const json = JSON.parse(JSON.stringify(await node.serialize()));
    const parent = new Node('parent');
    parseNodeJson(parent, json);
    return { copy: parent.children[0] as DecalNode, json };
}

/** Parse a hand-written payload, the way a hand-edited (or damaged) scene file would arrive. */
function parseDecal(decal: unknown): DecalNode {
    const parent = new Node('parent');
    parseNodeJson(parent, { type: 'decal', name: 'decal', id: 'decal-1', decal });
    return parent.children[0] as DecalNode;
}

/** Everything a decal author sets, as plain data, so two nodes compare in one readable assertion. */
function authored(node: DecalNode) {
    return {
        size: [...node.size],
        material: node.material ? node.material.serialize() : null,
        opacity: node.opacity,
        sortOrder: node.sortOrder,
        angleFade: node.angleFade,
        depthFade: node.depthFade,
        affects: { ...node.affects },
        receivers: node.receivers,
        pattern: node.pattern,
        radial: JSON.parse(JSON.stringify(node.radial)),
    };
}

/** Every key anywhere in a JSON tree. */
function keysDeep(value: unknown, out: string[] = []): string[] {
    if (Array.isArray(value)) for (const v of value) keysDeep(v, out);
    else if (value && typeof value === 'object')
        for (const [k, v] of Object.entries(value)) { out.push(k); keysDeep(v, out); }
    return out;
}

/** The unit cube's corners, the volume every decal shader tests against. */
const UNIT_CORNERS: vec3[] = Array.from({ length: 8 }, (_, i) =>
    vec3.fromValues(i & 1 ? 0.5 : -0.5, i & 2 ? 0.5 : -0.5, i & 4 ? 0.5 : -0.5));

/**
 * The box's world corners, from the DEFINITION -- the node's world transform applied to the corners of a
 * `size` box -- rather than from `volumeMatrix`, which is one of the things under test.
 */
function worldCorners(node: DecalNode): vec3[] {
    const [sx, sy, sz] = node.size;
    return UNIT_CORNERS.map(c =>
        vec3.transformMat4(vec3.create(), [c[0] * sx, c[1] * sy, c[2] * sz], node.worldTransform));
}

function expectClose(actual: ArrayLike<number>, expected: ArrayLike<number>, label = '', digits = 4) {
    expect(actual.length, label).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) expect(actual[i], `${label}[${i}]`).toBeCloseTo(expected[i], digits);
}

/**
 * A decal under a rotated, NON-uniformly scaled parent: the child's world matrix then carries shear, so
 * its box is a parallelepiped and nothing about it is axis-aligned or orthogonal. Everything here has to
 * hold for that case, not just for a box sitting square on the ground.
 */
function awkwardDecal(): DecalNode {
    const parent = new Node('parent');
    parent.setPosition([-4, 2, 7]);
    parent.setRotation([0, 30, 0]);
    parent.setScale([2, 1, 1]);
    const node = new DecalNode('decal', { size: [4, 1, 2.5] });
    node.setPosition([3, -1, 2]);
    node.setRotation([20, 35, -15]);
    node.setScale([1.5, 0.5, 2]);
    parent.addChild(node);
    // Outside a scene nothing walks the graph, so the world matrices have to be asked for by hand.
    parent.updateTransforms();
    return node;
}

// ---------------------------------------------------------------------------------------------------
// Authored state
// ---------------------------------------------------------------------------------------------------

describe('DecalNode defaults', () => {
    it('starts as a 1 m box projecting plain white onto every surface attribute', () => {
        const node = new DecalNode('decal');
        expect(node.nodeType).toBe('decal');
        expect(node.size).toEqual([1, 1, 1]);
        expect(node.material).toBeNull();
        expect(node.opacity).toBe(1);
        expect(node.sortOrder).toBe(0);
        expect(node.angleFade).toBe(0.3);
        expect(node.depthFade).toBe(0.2);
        expect(node.affects).toEqual({ albedo: true, normal: true, surface: true, emissive: true });
        expect(node.receivers).toBe('all');
        expect(node.pattern).toBe('material');
        // Transparent at the rim, no ring and no glow: a bare radial decal is a soft white spot.
        expect(node.radial).toEqual({
            innerColor: [1, 1, 1, 1], outerColor: [1, 1, 1, 0],
            curve: 'power', exponent: 1, falloff: 0.5, shape: 'circle',
            ringColor: [1, 1, 1, 0], ringWidthPx: 1.5, emissive: 0,
        });
    });

    it('gives every node its own live affects and radial, sharing nothing with the defaults', () => {
        // Both getters hand out the live object "to mutate freely". Had the constructor aliased the
        // module defaults, recolouring one decal would recolour every decal created after it.
        const a = new DecalNode('a');
        a.affects.albedo = false;
        a.radial.innerColor[0] = 0;
        a.radial.exponent = 4;

        for (const other of [new DecalNode('b'), new DecalNode('c')]) {
            expect(other.affects.albedo).toBe(true);
            expect(other.radial.innerColor[0]).toBe(1);
            expect(other.radial.exponent).toBe(1);
        }
    });

    it('copies what it is handed rather than keeping the caller\'s arrays', () => {
        const size: [number, number, number] = [2, 2, 2];
        const innerColor: [number, number, number, number] = [1, 0, 0, 1];
        const node = new DecalNode('decal', { size, radial: { innerColor } });
        size[0] = 9;
        innerColor[1] = 1;
        expect(node.size).toEqual([2, 2, 2]);
        expect(node.radial.innerColor).toEqual([1, 0, 0, 1]);
    });
});

describe('DecalNode setters', () => {
    // What the inspector writes through. They must hold the same ranges the reader enforces, or a value
    // typed into a field would render one way now and another after a save and reload.
    it('clamp and round exactly as the reader does', () => {
        const node = new DecalNode('decal');
        node.opacity = 1.5;
        expect(node.opacity).toBe(1);
        node.opacity = -0.2;
        expect(node.opacity).toBe(0);
        node.opacity = 0.4;
        expect(node.opacity).toBe(0.4);
        node.sortOrder = 3.5;
        expect(node.sortOrder).toBe(4);
        node.angleFade = 7;
        expect(node.angleFade).toBe(1);
        node.depthFade = -1;
        expect(node.depthFade).toBe(0);
    });

    it('coerce an unknown receivers or pattern to the default rather than storing it', () => {
        const node = new DecalNode('decal', { receivers: 'terrain', pattern: 'radial' });
        node.receivers = 'walls' as any;
        node.pattern = 'spiral' as any;
        expect(node.receivers).toBe('all');
        expect(node.pattern).toBe('material');
        node.receivers = 'terrain';
        node.pattern = 'radial';
        expect(node.receivers).toBe('terrain');
        expect(node.pattern).toBe('radial');
    });

    it('copy the affects and radial they are given, and leave nothing unset', () => {
        const node = new DecalNode('decal');
        const affects = { albedo: false, normal: true, surface: false, emissive: true };
        node.affects = affects;
        affects.albedo = true;
        expect(node.affects).toEqual({ albedo: false, normal: true, surface: false, emissive: true });

        const ringColor: [number, number, number, number] = [1, 0, 0, 1];
        node.radial = { exponent: 2, ringColor };
        ringColor[1] = 1;
        expect(node.radial.exponent).toBe(2);
        expect(node.radial.ringColor).toEqual([1, 0, 0, 1]);
        expect(node.radial.innerColor).toHaveLength(4);
        expect(node.radial.ringWidthPx).toBeTypeOf('number');
    });
});

describe('DecalNode.material', () => {
    it('keeps a PBR material, the one shading model a decal can project', () => {
        const pbr = Material.PBR({ textures: { baseColorTexture: 'tex-albedo' } });
        const node = new DecalNode('decal');
        node.material = pbr;
        expect(node.material).toBe(pbr);
    });

    it('refuses Blinn-Phong and Basic with a warning, and stores null', () => {
        const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
        const node = new DecalNode('decal', { material: Material.PBR() });

        node.material = Material.Default({});
        expect(node.material).toBeNull();
        node.material = Material.PBR();
        node.material = Material.Basic({});
        expect(node.material).toBeNull();
        expect(new DecalNode('ctor', { material: Material.Default({}) }).material).toBeNull();

        expect(warn).toHaveBeenCalledTimes(3);
        expect(String(warn.mock.calls[0][0])).toContain('PBR');
    });

    it('is cleared silently', () => {
        const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
        const node = new DecalNode('decal', { material: Material.PBR() });
        node.material = null;
        expect(node.material).toBeNull();
        expect(warn).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------------------------------

/** A decal with every authored field moved off its default, so a field that fails to parse shows. */
function fullyAuthoredDecal(): DecalNode {
    const material = Material.PBR({
        baseColor: [0.8, 0.2, 0.1], metallic: 0.7, roughness: 0.35,
        emissiveFactor: [1, 0.5, 0], emissiveIntensity: 3,
        textures: { baseColorTexture: 'tex-albedo', normalMap: 'tex-normal', roughnessMap: 'tex-rough' },
    });
    const node = new DecalNode('scorch', {
        size: [4, 2, 3], material, opacity: 0.6, sortOrder: 5, angleFade: 0.5, depthFade: 0.1,
        affects: { albedo: true, normal: false, surface: true, emissive: false },
        receivers: 'terrain', pattern: 'radial',
        radial: {
            innerColor: [1, 0.5, 0, 0.75], outerColor: [0, 0.25, 1, 0.1], exponent: 2.5,
            ringColor: [1, 1, 0, 1], ringWidthPx: 3, emissive: 4,
        },
    });
    node.setPosition([1, 2, 3]);
    node.setRotation([10, 20, 30]);
    node.setScale([2, 1, 0.5]);
    return node;
}

describe('DecalNode serialization', () => {
    it('round-trips every authored field, the embedded material included', async () => {
        const original = fullyAuthoredDecal();
        const { copy } = await roundTrip(original);

        expect(copy).toBeInstanceOf(DecalNode);
        expect(authored(copy)).toEqual(authored(original));
        expect(Array.from(copy.position)).toEqual([1, 2, 3]);
        expect(Array.from(copy.scale)).toEqual([2, 1, 0.5]);

        // Spelled out as well, because "the material survived" is the part a whole-object compare hides
        // best: an embedded material that came back as a fresh default would still be a PBR material.
        const m = copy.material!;
        expect(m).not.toBe(original.material);
        expect(m.type).toBe('pbr');
        expect(m.textures.get('baseColorTexture')).toBe('tex-albedo');
        expect(m.textures.get('normalMap')).toBe('tex-normal');
        expect(m.textures.get('roughnessMap')).toBe('tex-rough');
        expect(m.properties.get('hasNormalMap')).toBe(true);
        expect(m.properties.get('baseColor')).toEqual([0.8, 0.2, 0.1]);
        expect(m.properties.get('metallic')).toBe(0.7);
        expect(m.properties.get('roughness')).toBe(0.35);
        expect(m.properties.get('emissiveFactor')).toEqual([1, 0.5, 0]);
        expect(m.properties.get('emissiveIntensity')).toBe(3);
    });

    it('serializes a parsed decal exactly as it was read', async () => {
        // The check that catches a field written but never read back, which the first trip alone misses
        // whenever the value it was written with happens to be the default.
        const { copy, json } = await roundTrip(fullyAuthoredDecal());
        expect(await copy.serialize()).toEqual(json);
    });

    it('nests its payload under one key and never writes a key named materialId', async () => {
        const node = fullyAuthoredDecal();
        // The library link, as the editor stores it on every material-carrying node.
        node.setVariable('__materialId', 'mat-1', 'string');
        const json = JSON.parse(JSON.stringify(await node.serialize()));

        expect(json.decal).toBeTypeOf('object');
        for (const key of ['size', 'opacity', 'material', 'affects', 'radial', 'pattern', 'receivers'])
            expect(json[key], key).toBeUndefined();
        // The editor's asset graph reads any `materialId` key, at any depth, as a TERRAIN material.
        expect(keysDeep(json)).not.toContain('materialId');
    });

    it('writes an explicit null for a decal with no material', async () => {
        const { json, copy } = await roundTrip(new DecalNode('bare'));
        expect(json.decal.material).toBeNull();
        expect(copy.material).toBeNull();
    });

    it('hands out a copy, so a snapshot cannot edit the live node', async () => {
        // The undo history keeps serialized snapshots; one that aliased the node's own arrays would
        // change the moment the node did, and undo would restore the edit it was meant to revert.
        const node = fullyAuthoredDecal();
        const json = await node.serialize();
        json.decal.size[0] = 99;
        json.decal.affects.albedo = false;
        json.decal.radial.innerColor[0] = 0;
        expect(node.size[0]).toBe(4);
        expect(node.affects.albedo).toBe(true);
        expect(node.radial.innerColor[0]).toBe(1);
    });
});

describe('DecalNode tolerant parse', () => {
    const fresh = () => authored(new DecalNode('fresh'));

    it('comes back at the defaults from a node with no decal payload at all', () => {
        expect(authored(parseDecal(undefined))).toEqual(fresh());
        expect(DecalNode.optionsFromJson(null)).toEqual({});
        expect(DecalNode.optionsFromJson('decal')).toEqual({});
    });

    it('replaces every malformed field with its default', () => {
        const node = parseDecal({
            size: 'huge', material: 'pbr', opacity: 'opaque', sortOrder: null, angleFade: {}, depthFade: [0.5],
            affects: 'everything', receivers: 'walls', pattern: 'spiral', radial: 42,
        });
        expect(authored(node)).toEqual(fresh());
    });

    it('keeps the good half of a partly damaged payload', () => {
        const node = parseDecal({
            affects: { albedo: false, normal: 'no', surface: 0 },
            radial: { innerColor: [1, 0, 0], outerColor: 'blue', exponent: -2, ringWidthPx: -1, emissive: 'bright' },
        });
        expect(node.affects).toEqual({ albedo: false, normal: true, surface: true, emissive: true });
        expect(parseDecal({ affects: { emissive: false } }).affects)
            .toEqual({ albedo: true, normal: true, surface: true, emissive: false });
        expect(node.radial).toEqual({
            innerColor: [1, 0, 0, 1],       // a three-channel colour is opaque
            outerColor: [1, 1, 1, 0],       // not a colour at all: the default
            curve: 'power',
            exponent: 0,                    // clamped: a negative power would blow up at the rim
            falloff: 0.5,
            shape: 'circle',
            ringColor: [1, 1, 1, 0],
            ringWidthPx: 0,
            emissive: 0,
        });
    });

    it('clamps what it keeps into range', () => {
        expect(parseDecal({ opacity: 5 }).opacity).toBe(1);
        expect(parseDecal({ opacity: -1 }).opacity).toBe(0);
        expect(parseDecal({ angleFade: 2 }).angleFade).toBe(1);
        expect(parseDecal({ depthFade: -0.5 }).depthFade).toBe(0);
        // Draw order is an integer, so a sort can never be decided by a fractional part nobody sees.
        expect(parseDecal({ sortOrder: 2.6 }).sortOrder).toBe(3);
        expect(parseDecal({ sortOrder: -2.4 }).sortOrder).toBe(-2);
    });

    it('takes the magnitude of a negative size and never lets an extent reach zero', () => {
        const node = parseDecal({ size: [-2, 0, 3] });
        expect(node.size[0]).toBe(2);
        expect(node.size[2]).toBe(3);
        // A zero extent is a singular volume matrix. A paper-thin decal must still invert.
        expect(node.size[1]).toBeGreaterThan(0);
        expect(node.size[1]).toBeLessThan(0.01);
        node.updateTransforms();
        expect(Array.from(node.invVolumeMatrix).every(Number.isFinite)).toBe(true);
        expect(node.invVolumeMatrix[5]).toBeCloseTo(1 / node.size[1], 0);
    });

    it('falls back to the default size when any component is not a number', () => {
        // One bad component used to reach the setter as NaN: NaN bounds, a NaN volume, a decal that
        // silently vanished -- and it re-saved as `null`, which reloaded as a millimetre-thin box.
        for (const size of [[2, 'x', 2], [2, null, 2], [2, 2], [1, 2, 3, 4], { 0: 1, 1: 2, 2: 3 }]) {
            const node = parseDecal({ size });
            expect(node.size, JSON.stringify(size)).toEqual([1, 1, 1]);
            node.updateTransforms();
            expect(Number.isFinite(node.getBoundingSphere().radius)).toBe(true);
        }
    });

    it('drops an embedded material that is not PBR, keeping the rest of the decal', () => {
        for (const material of [Material.Default({}), Material.Basic({}), Material.Cel({})]) {
            const node = parseDecal({ material: material.serialize(), opacity: 0.5 });
            expect(node.material, material.type).toBeNull();
            expect(node.opacity).toBe(0.5);
        }
    });

    it('survives an embedded material that cannot be parsed at all', () => {
        const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
        vi.spyOn(Material, 'parse').mockImplementation(() => { throw new Error('corrupt material'); });

        const node = parseDecal({ material: { type: 'pbr' }, opacity: 0.5, sortOrder: 2 });
        expect(node).toBeInstanceOf(DecalNode);
        expect(node.material).toBeNull();
        expect(node.opacity).toBe(0.5);
        expect(node.sortOrder).toBe(2);
        expect(String(warn.mock.calls[0]?.[0])).toContain('corrupt material');
    });
});

// ---------------------------------------------------------------------------------------------------
// The volume
// ---------------------------------------------------------------------------------------------------

describe('DecalNode volume', () => {
    it('maps every world-space corner of the box to the unit cube', () => {
        const node = awkwardDecal();
        const inv = mat4.clone(node.invVolumeMatrix);
        worldCorners(node).forEach((corner, i) =>
            expectClose(vec3.transformMat4(vec3.create(), corner, inv), UNIT_CORNERS[i], `corner ${i}`));
    });

    it('puts the box where a hand calculation does', () => {
        // Independent of any matrix code: size [4,1,2] at scale 2 is 8 x 2 x 4, and a +90 degree yaw
        // (counter-clockwise from above) carries local +X onto world -Z and local +Z onto world +X.
        const node = new DecalNode('decal', { size: [4, 1, 2] });
        node.setPosition([10, 0, -5]);
        node.setRotation([0, 90, 0]);
        node.setScale([2, 2, 2]);
        node.updateTransforms();
        const inv = node.invVolumeMatrix;
        // Local corner (+,+,+) is (4, 1, 2) before the yaw and (2, 1, -4) after it.
        expectClose(vec3.transformMat4(vec3.create(), [12, 1, -9], inv), [0.5, 0.5, 0.5]);
        expectClose(vec3.transformMat4(vec3.create(), [10, 0, -5], inv), [0, 0, 0]);
        // A point just past the +X face (world -Z, 4 m from the centre) lies outside the unit cube.
        expect(vec3.transformMat4(vec3.create(), [10, 0, -9.1], inv)[0]).toBeGreaterThan(0.5);
    });

    it('has volumeMatrix and invVolumeMatrix as exact inverses', () => {
        const node = awkwardDecal();
        const vol = mat4.clone(node.volumeMatrix);
        const inv = mat4.clone(node.invVolumeMatrix);
        expectClose(mat4.multiply(mat4.create(), vol, inv), mat4.create(), 'vol x inv');
        expectClose(mat4.multiply(mat4.create(), inv, vol), mat4.create(), 'inv x vol');
        // And volumeMatrix is the box itself: unit corners out to the world corners.
        worldCorners(node).forEach((corner, i) =>
            expectClose(vec3.transformMat4(vec3.create(), UNIT_CORNERS[i], vol), corner, `corner ${i}`));
    });

    it('reports mirrored exactly when the world transform has a negative determinant', () => {
        const cases: { scale: [number, number, number], rotation?: [number, number, number] }[] = [
            { scale: [1, 1, 1] },
            { scale: [1, 1, 1], rotation: [120, -45, 200] },
            { scale: [-1, 1, 1] },
            { scale: [1, -1, 1] },
            { scale: [1, 1, -2] },
            { scale: [-1, -1, 1] },             // two flips are a 180 degree turn, not a mirror
            { scale: [-1, -1, -1], rotation: [30, 0, 0] },
        ];
        for (const { scale, rotation } of cases) {
            const node = new DecalNode('decal', { size: [3, 1, 2] });
            node.setScale(scale);
            if (rotation) node.setRotation(rotation);
            node.updateTransforms();
            const label = JSON.stringify({ scale, rotation });
            expect(node.mirrored, label).toBe(mat4.determinant(node.worldTransform) < 0);
            expect(node.mirrored, label).toBe(scale[0] * scale[1] * scale[2] < 0);
            // Mirrored or not, the corners still land on the unit cube: only the winding changed.
            const inv = mat4.clone(node.invVolumeMatrix);
            worldCorners(node).forEach((corner, i) =>
                expectClose(vec3.transformMat4(vec3.create(), corner, inv), UNIT_CORNERS[i], `${label} ${i}`));
        }
    });

    it('never hands the renderer a null inverse, even for a node scaled to nothing', () => {
        // The box of a zero-scale node rasterises to nothing, so what the inverse holds is irrelevant --
        // but it is uploaded as a uniform every frame, and a null there would throw.
        const node = new DecalNode('decal');
        node.setScale([0, 1, 1]);
        node.updateTransforms();
        expect(Array.from(node.invVolumeMatrix)).toEqual(Array.from(mat4.create()));
    });

    it('inherits a mirror from its parent, and never takes one from its size', () => {
        const parent = new Node('parent');
        parent.setScale([1, 1, -1]);
        const child = new DecalNode('child');
        parent.addChild(child);
        parent.updateTransforms();
        expect(child.mirrored).toBe(true);

        // The size setter takes magnitudes, so a negative size is a bigger box and not a flipped one.
        const sized = new DecalNode('sized', { size: [-2, 1, 1] });
        sized.updateTransforms();
        expect(sized.mirrored).toBe(false);
    });
});

describe('DecalNode bounds', () => {
    it('reports the tight world AABB of the oriented box', () => {
        const node = awkwardDecal();
        const corners = worldCorners(node);
        const min = corners.reduce((m, c) => vec3.min(m, m, c), vec3.fromValues(Infinity, Infinity, Infinity));
        const max = corners.reduce((m, c) => vec3.max(m, m, c), vec3.fromValues(-Infinity, -Infinity, -Infinity));
        const box = node.getBoundingBox();
        expectClose(box.min, min, 'min');
        expectClose(box.max, max, 'max');
    });

    it('reports a sphere centred on the box that holds every corner', () => {
        const node = awkwardDecal();
        const { center, radius } = node.getBoundingSphere();
        expectClose(center, node.worldPosition, 'center');
        const distances = worldCorners(node).map(c => vec3.distance(c, center));
        for (const d of distances) expect(d).toBeLessThanOrEqual(radius + 1e-4);
        // Tight, too: a sphere much larger than the box would keep an off-screen decal drawing.
        expect(radius).toBeCloseTo(Math.max(...distances), 4);
    });

    it('caches both as live references, rewritten in place rather than reallocated', () => {
        // The renderer culls every decal every frame, so the second read must not recompute the corners.
        const node = new DecalNode('decal', { size: [2, 2, 2] });
        node.updateTransforms();
        const sphere = node.getBoundingSphere();
        const box = node.getBoundingBox();
        const radius = sphere.radius;
        expect(node.getBoundingSphere()).toBe(sphere);
        expect(node.getBoundingBox()).toBe(box);

        node.size = [4, 4, 4];
        expect(node.getBoundingSphere()).toBe(sphere);
        expect(sphere.radius).toBeCloseTo(radius * 2, 5);
    });

    it('moves both bounds when the size changes, with no transform update in between', () => {
        const node = new DecalNode('decal', { size: [2, 2, 2] });
        node.setPosition([5, 0, 0]);
        node.updateTransforms();
        expect(node.getBoundingBox().max[0]).toBeCloseTo(6, 5);
        expect(node.getBoundingSphere().radius).toBeCloseTo(Math.sqrt(3), 5);

        // Both results are cached until something dirties them. Only the size setter's invalidation can
        // do that here: nothing moved, so updateTransforms never runs.
        node.size = [6, 2, 2];
        expect(node.getBoundingBox().min[0]).toBeCloseTo(2, 5);
        expect(node.getBoundingBox().max[0]).toBeCloseTo(8, 5);
        expect(node.getBoundingSphere().radius).toBeCloseTo(Math.sqrt(9 + 1 + 1), 5);
    });
});

// ---------------------------------------------------------------------------------------------------
// The reference transcriptions of the shader helpers
// ---------------------------------------------------------------------------------------------------

describe('decalLocalToUV', () => {
    it('puts the box centre in the middle of the image, whatever the depth', () => {
        for (const y of [-0.5, 0, 0.5]) expect(decalLocalToUV([0, y, 0])).toEqual([0.5, 0.5]);
    });

    it('runs +X along u and -Z along v, as seen looking down the projection', () => {
        const [u0, v0] = decalLocalToUV([0, 0, 0]);
        const [uRight, vRight] = decalLocalToUV([0.25, 0, 0]);
        const [uUp, vUp] = decalLocalToUV([0, 0, -0.25]);
        expect(uRight).toBeGreaterThan(u0);
        expect(vRight).toBe(v0);
        expect(vUp).toBeGreaterThan(v0);
        expect(uUp).toBe(u0);
    });

    it('spans the image exactly across the box', () => {
        expect(decalLocalToUV([-0.5, 0, 0.5])).toEqual([0, 0]);
        expect(decalLocalToUV([0.5, 0, -0.5])).toEqual([1, 1]);
    });
});

describe('radial falloff', () => {
    const FALLOFFS = [0, 0.05, 0.25, 0.5, 1];
    const TS = Array.from({ length: 65 }, (_, i) => i / 64);

    it('draws exactly the curve the terrain brush applies', () => {
        // The landscape cursor is a radial decal. If this drifts by one ulp the preview is still close
        // enough to fool a reviewer, so the comparison is exact, not toBeCloseTo.
        for (const f of FALLOFFS)
            for (const t of TS)
                expect(radialDecalWeight(t, brushFalloffExponent(f)), `t=${t} f=${f}`).toBe(brushFalloffWeight(t, f));
    });

    it('left sculpting and painting bit-identical when the curve was extracted', () => {
        // The formula Terrain.sculpt and Terrain.paint each carried inline before brushFalloff.ts existed.
        const inline = (t: number, falloff: number) => falloff <= 0 ? 1 : Math.pow(1 - t, falloff * 3);
        for (const f of [...FALLOFFS, -1, 0.75, 2])
            for (const t of TS)
                expect(brushFalloffWeight(t, f), `t=${t} f=${f}`).toBe(inline(t, f));
    });

    it('is 1 at the centre and 0 on the rim for any real falloff', () => {
        for (const e of [0.15, 1, 3]) {
            expect(radialDecalWeight(0, e)).toBe(1);
            expect(radialDecalWeight(1, e)).toBe(0);
        }
    });

    it('is a flat disc, rim included, at exponent 0 or below', () => {
        for (const e of [0, -1])
            for (const t of TS) expect(radialDecalWeight(t, e), `t=${t} e=${e}`).toBe(1);
    });

    it('is nothing at all outside the rim', () => {
        for (const e of [0, 1, 3])
            for (const t of [1.0001, 1.5, 10]) expect(radialDecalWeight(t, e), `t=${t} e=${e}`).toBe(0);
    });
});

// ---------------------------------------------------------------------------------------------------
// Routing: which renderer passes a decal takes part in
// ---------------------------------------------------------------------------------------------------

const NONE = { albedo: false, normal: false, surface: false, emissive: false };
const plain = () => Material.PBR();
const normalMapped = () => Material.PBR({ textures: { normalMap: 'tex-normal' } });
const glowing = (emissiveFactor = [1, 0.5, 0], emissiveIntensity = 1, textures = {}) =>
    Material.PBR({ emissiveFactor, emissiveIntensity, textures });

describe('DecalNode.writesSurface', () => {
    const cases: [string, DecalOptions, boolean][] = [
        ['the default decal, which projects plain white albedo', {}, true],
        ['albedo alone', { affects: { ...NONE, albedo: true } }, true],
        ['roughness/metallic/AO alone', { affects: { ...NONE, surface: true } }, true],
        ['normal alone, with a normal map', { affects: { ...NONE, normal: true }, material: normalMapped() }, true],
        ['normal alone, without a normal map', { affects: { ...NONE, normal: true }, material: plain() }, false],
        ['normal alone, with no material', { affects: { ...NONE, normal: true } }, false],
        ['normal alone on a radial pattern, over a normal-mapped material',
            { affects: { ...NONE, normal: true }, material: normalMapped(), pattern: 'radial' }, false],
        ['a radial pattern that affects albedo', { pattern: 'radial', affects: { ...NONE, albedo: true } }, true],
        ['emissive alone', { affects: { ...NONE, emissive: true }, material: glowing() }, false],
        ['nothing at all', { affects: NONE }, false],
    ];
    for (const [label, options, expected] of cases)
        it(`${expected ? 'writes' : 'skips'} the G-buffer: ${label}`, () =>
            expect(new DecalNode('decal', options).writesSurface).toBe(expected));
});

describe('DecalNode.emits', () => {
    const cases: [string, DecalOptions, boolean][] = [
        ['a material decal with no material', {}, false],
        ['a material with a black emissive factor', { material: plain() }, false],
        ['a material with an emissive factor', { material: glowing() }, true],
        ['an emissive factor at zero intensity', { material: glowing([1, 0.5, 0], 0) }, false],
        // pbrGBuffer multiplies the map BY the factor, so a map alone stores no emission, and a decal
        // must not claim to add light the surface shader would not.
        ['an emissive map under a black factor', { material: glowing([0, 0, 0], 1, { emissiveMap: 'tex-glow' }) }, false],
        ['a glowing material with emissive switched off', { material: glowing(), affects: { emissive: false } }, false],
        ['a radial pattern at emissive 0', { pattern: 'radial' }, false],
        ['a radial pattern with emissive above 0', { pattern: 'radial', radial: { emissive: 2 } }, true],
        ['a radial pattern over a glowing material, which it does not draw', { pattern: 'radial', material: glowing() }, false],
        ['a glowing radial pattern with emissive switched off',
            { pattern: 'radial', radial: { emissive: 2 }, affects: { emissive: false } }, false],
    ];
    for (const [label, options, expected] of cases)
        it(`${expected ? 'emits' : 'adds no light'}: ${label}`, () =>
            expect(new DecalNode('decal', options).emits).toBe(expected));
});

// ---------------------------------------------------------------------------------------------------
// The scene's decal list, which is all the renderer ever iterates
// ---------------------------------------------------------------------------------------------------

describe('Scene.decals', () => {
    it('tracks a decal from add to remove, wherever it sits in the tree', () => {
        const scene = new Scene();
        const top = new DecalNode('top');
        const group = new Node('group');
        const nested = new DecalNode('nested');
        group.addChild(nested);
        scene.addNode(top);
        scene.addNode(group);
        scene.addNode(new Node('not a decal'));

        expect(scene.decals.size).toBe(2);
        expect(scene.decals.has(top)).toBe(true);
        expect(scene.decals.has(nested)).toBe(true);

        scene.removeNode(top);
        expect(scene.decals.has(top)).toBe(false);
        expect(scene.decals.has(nested)).toBe(true);

        scene.removeNode(group);
        expect(scene.decals.size).toBe(0);
        scene.dispose();
    });

    it('drops a despawned decal and takes it back on spawn', () => {
        const scene = new Scene();
        const decal = new DecalNode('decal');
        scene.addNode(decal);
        expect(scene.decals.has(decal)).toBe(true);

        decal.despawn();
        expect(scene.decals.has(decal)).toBe(false);
        decal.spawn();
        expect(scene.decals.has(decal)).toBe(true);
        scene.dispose();
    });

    it('holds editor-only decals too, which the renderer routes to the overlay', () => {
        // The landscape brush is one. Leaving it out of the list would leave it undrawn, not overlaid.
        const scene = new Scene();
        const brush = new DecalNode('__editor__terrainBrush', { pattern: 'radial', receivers: 'terrain' });
        markEditorOnly(brush);
        scene.addNode(brush);
        expect(scene.decals.has(brush)).toBe(true);
        scene.dispose();
    });
});

describe('radial pattern curves and shapes', () => {
    const TS = Array.from({ length: 81 }, (_, i) => i / 80);

    it('is curveWeight, for every band curve and falloff', () => {
        // The brush cursor draws these; the terrain applies curveWeight. Any drift is a cursor that lies.
        for (const curve of ['smooth', 'linear', 'sphere', 'tip'] as const)
            for (const f of [0, 0.1, 0.35, 0.7, 1])
                for (const t of [...TS, 1.2])
                    expect(radialDecalWeight(t, 1, curve, f), `${curve} t=${t} f=${f}`).toBe(curveWeight(t, f, curve));
    });

    it('is the soft curve when the power exponent comes from the brush falloff', () => {
        for (const f of [0, 0.2, 0.5, 1])
            for (const t of [...TS, 1.2])
                expect(radialDecalWeight(t, brushFalloffExponent(f)), `t=${t} f=${f}`).toBe(curveWeight(t, f, 'soft'));
    });

    it('measures a square as the terrain measures a square brush', () => {
        // brushWeight's square is Chebyshev over the brush radius; the decal's half-width is that radius.
        const radius = 5;
        for (const [x, z] of [[1, 4], [-3, 2], [4.9, -4.9], [0, 0], [2.5, 0]]) {
            const local = [x / (2 * radius), 0, z / (2 * radius)];
            const t = radialDecalT(local, 'square');
            const brush = brushWeight(x, z, { x: 0, z: 0, radius, falloff: 0.5, curve: 'linear', shape: 'square' });
            expect(radialDecalWeight(t, 1, 'linear', 0.5), `(${x}, ${z})`).toBeCloseTo(brush, 12);
        }
        expect(radialDecalT([0.3, 0, 0.4], 'circle')).toBeCloseTo(1, 12);
        expect(radialDecalT([0.3, 0, 0.4], 'square')).toBeCloseTo(0.8, 12);
    });

    it('round-trips curve, falloff and shape, and reads garbage back as the defaults', async () => {
        const node = new DecalNode('ring', { pattern: 'radial', radial: { curve: 'sphere', falloff: 0.3, shape: 'square' } });
        const { copy } = await roundTrip(node);
        expect(copy.radial.curve).toBe('sphere');
        expect(copy.radial.falloff).toBeCloseTo(0.3);
        expect(copy.radial.shape).toBe('square');
        const bad = new DecalNode('bad', { radial: { curve: 'wobbly' as any, falloff: 7, shape: 'hexagon' as any } });
        expect(bad.radial.curve).toBe('power');
        expect(bad.radial.falloff).toBe(1);
        expect(bad.radial.shape).toBe('circle');
    });

    it('lists the curves in the order the shader indexes them', () => {
        // renderer.ts uploads DECAL_RADIAL_CURVES.indexOf(curve); decal.wgsl switches on 0..4 in this order.
        expect(DECAL_RADIAL_CURVES).toEqual(['power', 'smooth', 'linear', 'sphere', 'tip']);
    });
});

describe('editor picking', () => {
    const down = (x: number, z: number) => ({ origin: vec3.fromValues(x, 10, z), direction: vec3.fromValues(0, -1, 0) });

    it('picks a decal by its icon on the top face, never by the volume that encloses the ground', () => {
        // A 10 x 2 x 10 decal centred on the ground: a click on the ground inside it must not select it,
        // or nothing under a decal could ever be clicked (or dropped onto) again.
        const decal = new DecalNode('scorch', { size: [10, 2, 10] });
        decal.updateTransforms();
        expect(Raycaster.raycast(down(3, -2), [decal])).toHaveLength(0);
        const hits = Raycaster.raycast(down(0, 0), [decal]);
        expect(hits).toHaveLength(1);
        expect(hits[0].node).toBe(decal);
        expect(hits[0].point[1]).toBeCloseTo(1 + DecalNode.PICK_HALF_EXTENT, 5);   // the top face, y = 1
    });

    it('follows the transform: the icon sits on the top face of the moved, scaled box', () => {
        const decal = new DecalNode('moved', { size: [4, 2, 4] });
        decal.setPosition([5, 0, -3]);
        decal.setScale([1, 3, 1]);
        decal.updateTransforms();
        const box = decal.pickBox();
        expect((box.min[0] + box.max[0]) / 2).toBeCloseTo(5);
        expect((box.min[1] + box.max[1]) / 2).toBeCloseTo(3);   // half of 2 x 3
        expect((box.min[2] + box.max[2]) / 2).toBeCloseTo(-3);
    });
});
