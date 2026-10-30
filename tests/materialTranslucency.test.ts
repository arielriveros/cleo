import { describe, expect, it } from 'vitest';
import { Material, applyWind, windConfigOf } from '../src/graphics/material';
import { GLTFLoader } from '../src/graphics/utils/gltfLoader';

/**
 * PBR `translucency`: thin-surface diffuse transmission for leaves and grass. It rides in the G-buffer
 * as a negative metallic (chunks/pbrGBuffer.wgsl), so what these pin down is the asset side: absent
 * means 0, it round-trips, it is clamped, and glTF's KHR_materials_diffuse_transmission feeds it.
 */

describe('PBR translucency', () => {
    it('defaults to 0 and is omitted from JSON at 0, so old assets keep their bytes', () => {
        const m = Material.PBR({});
        expect(m.properties.get('translucency')).toBe(0);
        expect('translucency' in (m.serialize() as any)).toBe(false);
    });

    it('round-trips through serialize/parse', () => {
        const m = Material.PBR({ translucency: 0.45 });
        const back = Material.parse(m.serialize());
        expect(back.properties.get('translucency')).toBeCloseTo(0.45);
    });

    it('loads a material saved before it existed at 0', () => {
        const back = Material.parse({ type: 'pbr', baseColor: [1, 1, 1], metallic: 0, roughness: 1 });
        expect(back.properties.get('translucency')).toBe(0);
    });

    it('is clamped to 0..1', () => {
        expect(Material.PBR({ translucency: 3 }).properties.get('translucency')).toBe(1);
        expect(Material.PBR({ translucency: -1 }).properties.get('translucency')).toBe(0);
    });
});

// --- glTF ----------------------------------------------------------------------------------------

const pad4 = (n: number) => (n + 3) & ~3;

function glb(material: object): File {
    const floats = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const json = {
        asset: { version: '2.0' },
        extensionsUsed: ['KHR_materials_diffuse_transmission'],
        buffers: [{ byteLength: 72 }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 36 }],
        accessors: [
            { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
            { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
        ],
        materials: [material],
        meshes: [{ name: 'Leaf', primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, material: 0 }] }],
        nodes: [{ mesh: 0 }],
        scenes: [{ nodes: [0] }],
    };
    const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    const jsonLen = pad4(jsonBytes.length), binLen = pad4(floats.byteLength);
    const total = 12 + 8 + jsonLen + 8 + binLen;
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    view.setUint32(0, 0x46546C67, true); view.setUint32(4, 2, true); view.setUint32(8, total, true);
    view.setUint32(12, jsonLen, true); view.setUint32(16, 0x4E4F534A, true);
    out.fill(0x20, 20, 20 + jsonLen); out.set(jsonBytes, 20);
    const b = 20 + jsonLen;
    view.setUint32(b, binLen, true); view.setUint32(b + 4, 0x004E4942, true);
    out.set(new Uint8Array(floats.buffer), b + 8);
    return new File([out], 'leaf.glb');
}

describe('glTF KHR_materials_diffuse_transmission', () => {
    it('reads the factor and the Cleo wind extras into the descriptor', async () => {
        const parsed = await new GLTFLoader().parseDescriptorsFromFiles([glb({
            alphaMode: 'MASK', doubleSided: true,
            extensions: { KHR_materials_diffuse_transmission: { diffuseTransmissionFactor: 0.4 } },
            extras: { cleo: { wind: { windStrength: 0.2, windRole: 'leaves' } } },
        })], false);
        const d = parsed.materials[0];
        expect(d.translucency).toBeCloseTo(0.4);
        expect(d.wind).toEqual({ windStrength: 0.2, windRole: 'leaves' });
        expect(d.alphaCutoff).toBe(0.5);
        expect(d.doubleSided).toBe(true);
    });

    it('reads 0 when the extension is absent', async () => {
        const parsed = await new GLTFLoader().parseDescriptorsFromFiles([glb({})], false);
        expect(parsed.materials[0].translucency).toBe(0);
        expect(parsed.materials[0].wind).toBeUndefined();
    });

    it('wind extras apply through applyWind', () => {
        // The same call loader.ts makes with the descriptor's wind block.
        const m = Material.PBR({});
        applyWind(m, { windStrength: 0.3 });
        expect(windConfigOf(m).windStrength).toBeCloseTo(0.3);
    });
});
