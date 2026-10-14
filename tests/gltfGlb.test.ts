import { describe, it, expect } from 'vitest';
import { MeshoptEncoder } from 'meshoptimizer/encoder';
import { GLTFLoader } from '../src/graphics/utils/gltfLoader';

// A .glb is read by the engine's own glTF reader rather than converted through assimp, which ran large
// scenes out of WASM heap. These build a one-triangle .glb in memory and parse it back.

const pad4 = (n: number) => (n + 3) & ~3;

function makeGlb(json: object, bin: Uint8Array): File {
    const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    const jsonLen = pad4(jsonBytes.length), binLen = pad4(bin.length);
    const total = 12 + 8 + jsonLen + 8 + binLen;
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    view.setUint32(0, 0x46546C67, true); view.setUint32(4, 2, true); view.setUint32(8, total, true);
    view.setUint32(12, jsonLen, true); view.setUint32(16, 0x4E4F534A, true);
    out.fill(0x20, 20, 20 + jsonLen); out.set(jsonBytes, 20);
    const b = 20 + jsonLen;
    view.setUint32(b, binLen, true); view.setUint32(b + 4, 0x004E4942, true);
    out.set(bin, b + 8);
    return new File([out], 'scene.glb');
}

const POSITIONS = [0, 0, 0, 1, 0, 0, 0, 1, 0];
const NORMALS = [0, 0, 1, 0, 0, 1, 0, 0, 1];

function triangle(interleaved: boolean, extensionsRequired?: string[]): File {
    const floats = new Float32Array(18);
    for (let v = 0; v < 3; v++) for (let c = 0; c < 3; c++) {
        if (interleaved) { floats[v * 6 + c] = POSITIONS[v * 3 + c]; floats[v * 6 + 3 + c] = NORMALS[v * 3 + c]; }
        else { floats[v * 3 + c] = POSITIONS[v * 3 + c]; floats[9 + v * 3 + c] = NORMALS[v * 3 + c]; }
    }
    const bufferViews = interleaved
        ? [{ buffer: 0, byteOffset: 0, byteLength: 72, byteStride: 24 }]
        : [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 36 }];
    const accessors = [
        { bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: 'VEC3' },
        interleaved
            ? { bufferView: 0, byteOffset: 12, componentType: 5126, count: 3, type: 'VEC3' }
            : { bufferView: 1, byteOffset: 0, componentType: 5126, count: 3, type: 'VEC3' },
    ];
    return makeGlb({
        asset: { version: '2.0' },
        ...(extensionsRequired ? { extensionsUsed: extensionsRequired, extensionsRequired } : {}),
        buffers: [{ byteLength: 72 }],
        bufferViews, accessors,
        meshes: [{ name: 'Tri', primitives: [{ attributes: { POSITION: 0, NORMAL: 1 } }] }],
        nodes: [{ mesh: 0, name: 'TriNode' }],
        scenes: [{ nodes: [0] }],
    }, new Uint8Array(floats.buffer));
}

describe('GLTFLoader .glb', () => {
    for (const interleaved of [false, true]) {
        it(`reads the BIN chunk (${interleaved ? 'interleaved' : 'packed'} views)`, async () => {
            const parsed = await new GLTFLoader().parseDescriptorsFromFiles([triangle(interleaved)], false);
            expect(parsed.meshes).toHaveLength(1);
            expect(Array.from(parsed.meshes[0].geometry.positions)).toEqual(POSITIONS);
            expect(Array.from(parsed.meshes[0].geometry.normals!)).toEqual(NORMALS);
        });
    }

    // What gltfpack writes: quantized attributes (KHR_mesh_quantization), every view meshopt-compressed
    // into buffer 0 with an empty fallback buffer, and uvs dequantized by KHR_texture_transform.
    it('reads meshopt-compressed, quantized geometry', async () => {
        await MeshoptEncoder.ready;
        // int16 positions, padded to an 8-byte stride; normalized uint16 uvs (stride 4); uint16 indices.
        const pos = new Int16Array([0, 0, 0, 0, 100, 0, 0, 0, 0, 200, 0, 0]);
        const uv = new Uint16Array([0, 0, 65535, 0, 0, 65535]);
        const idx = new Uint16Array([0, 1, 2]);
        const parts = [
            MeshoptEncoder.encodeGltfBuffer(new Uint8Array(pos.buffer), 3, 8, 'ATTRIBUTES'),
            MeshoptEncoder.encodeGltfBuffer(new Uint8Array(uv.buffer), 3, 4, 'ATTRIBUTES'),
            MeshoptEncoder.encodeGltfBuffer(new Uint8Array(idx.buffer), 3, 2, 'TRIANGLES'),
        ];
        const offsets: number[] = [];
        let size = 0;
        for (const p of parts) { offsets.push(size); size = pad4(size + p.length); }
        const bin = new Uint8Array(size);
        parts.forEach((p, i) => bin.set(p, offsets[i]));
        const meshopt = (i: number, count: number, byteStride: number, mode: string) =>
            ({ EXT_meshopt_compression: { buffer: 0, byteOffset: offsets[i], byteLength: parts[i].length, byteStride, count, mode } });
        const ext = ['EXT_meshopt_compression', 'KHR_mesh_quantization'];
        const glb = makeGlb({
            asset: { version: '2.0' }, extensionsUsed: [...ext, 'KHR_texture_transform'], extensionsRequired: ext,
            buffers: [{ byteLength: size }, { byteLength: 64, extensions: { EXT_meshopt_compression: { fallback: true } } }],
            bufferViews: [
                { buffer: 1, byteLength: 24, byteStride: 8, extensions: meshopt(0, 3, 8, 'ATTRIBUTES') },
                { buffer: 1, byteOffset: 24, byteLength: 12, byteStride: 4, extensions: meshopt(1, 3, 4, 'ATTRIBUTES') },
                { buffer: 1, byteOffset: 36, byteLength: 6, extensions: meshopt(2, 3, 2, 'TRIANGLES') },
            ],
            accessors: [
                { bufferView: 0, componentType: 5122, count: 3, type: 'VEC3' },
                { bufferView: 1, componentType: 5123, normalized: true, count: 3, type: 'VEC2' },
                { bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR' },
            ],
            images: [{ uri: 'a.png' }], textures: [{ source: 0 }],
            materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0,
                extensions: { KHR_texture_transform: { offset: [0.25, 0.5], scale: [0.5, 0.25] } } } } }],
            meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
            nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }],
        }, bin);

        const parsed = await new GLTFLoader().parseDescriptorsFromFiles([glb], false);
        const g = parsed.meshes[0].geometry;
        expect(Array.from(g.positions)).toEqual([0, 0, 0, 100, 0, 0, 0, 200, 0]);
        expect(Array.from(g.indices)).toEqual([0, 1, 2]);
        // u = 0.25 + 0.5u, v = 0.5 + 0.25v, then V flipped.
        expect(Array.from(g.uvs)).toEqual([0.25, 0.5, 0.75, 0.5, 0.25, 0.25]);
    });

    it('refuses a file that requires a geometry compression extension', async () => {
        await expect(new GLTFLoader().parseDescriptorsFromFiles([triangle(false, ['KHR_draco_mesh_compression'])], false))
            .rejects.toThrow(/KHR_draco_mesh_compression/);
    });

    it('rejects bytes that are not a glb', async () => {
        await expect(new GLTFLoader().parseDescriptorsFromFiles([new File([new Uint8Array(32)], 'x.glb')], false))
            .rejects.toThrow(/not a binary glTF/);
    });
});
