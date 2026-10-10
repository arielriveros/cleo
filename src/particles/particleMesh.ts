// The geometry mesh particles instance: a built-in shape, or a model flattened into one indexed mesh.
//
// A model is captured INTO the particle system when it is picked (as `render.meshData`), rather than
// resolved through the model library at runtime: an effect must play in a published game, which ships
// no model library, exactly as an embedded decal material or tileset does.
//
// Every mesh is recentred and scaled to fit a unit-diameter sphere, so a particle's `size` means the same
// thing — its diameter in metres — whatever the source asset's units were.

import { mat4, quat, vec3 } from 'gl-matrix';
import { Geometry } from '../core/geometry';

export type ParticleMeshKind = 'cube' | 'sphere' | 'tetrahedron' | 'cylinder' | 'model';

/** Flat, JSON-safe vertex data: xyz positions, xyz normals, uv, and triangle indices. */
export interface ParticleMeshData {
    positions: number[];
    normals: number[];
    uvs: number[];
    indices: number[];
}

/** Triangles beyond which a mesh particle is almost certainly a mistake: x capacity is the frame's cost. */
export const PARTICLE_MESH_TRIANGLE_WARNING = 5000;

function fromGeometry(g: Geometry, transform?: mat4): ParticleMeshData {
    const positions: number[] = [], normals: number[] = [], uvs: number[] = [];
    const p = vec3.create(), n = vec3.create();
    const normalMatrix = transform ? mat4.transpose(mat4.create(), mat4.invert(mat4.create(), transform) ?? mat4.create()) : null;
    const count = g.positions.length / 3;
    for (let i = 0; i < count; i++) {
        vec3.set(p, g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2]);
        if (transform) vec3.transformMat4(p, p, transform);
        positions.push(p[0], p[1], p[2]);
        if (g.normals.length >= (i + 1) * 3) {
            vec3.set(n, g.normals[i * 3], g.normals[i * 3 + 1], g.normals[i * 3 + 2]);
            if (normalMatrix) {
                const x = n[0], y = n[1], z = n[2];
                n[0] = normalMatrix[0] * x + normalMatrix[4] * y + normalMatrix[8] * z;
                n[1] = normalMatrix[1] * x + normalMatrix[5] * y + normalMatrix[9] * z;
                n[2] = normalMatrix[2] * x + normalMatrix[6] * y + normalMatrix[10] * z;
            }
            vec3.normalize(n, n);
            normals.push(n[0], n[1], n[2]);
        } else normals.push(0, 1, 0);
        if (g.uvs.length >= (i + 1) * 2) uvs.push(g.uvs[i * 2], g.uvs[i * 2 + 1]);
        else uvs.push(0, 0);
    }
    return { positions, normals, uvs, indices: Array.from(g.indices) };
}

/** Recentre on the bounding box and scale to a unit-diameter sphere, in place. */
function normalize(mesh: ParticleMeshData): ParticleMeshData {
    const n = mesh.positions.length / 3;
    if (n === 0) return mesh;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++)
        for (let a = 0; a < 3; a++) {
            const v = mesh.positions[i * 3 + a];
            if (v < min[a]) min[a] = v;
            if (v > max[a]) max[a] = v;
        }
    const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    let r = 0;
    for (let i = 0; i < n; i++)
        r = Math.max(r, Math.hypot(mesh.positions[i * 3] - c[0], mesh.positions[i * 3 + 1] - c[1], mesh.positions[i * 3 + 2] - c[2]));
    const s = r > 1e-6 ? 0.5 / r : 1;
    for (let i = 0; i < n; i++)
        for (let a = 0; a < 3; a++)
            mesh.positions[i * 3 + a] = +((mesh.positions[i * 3 + a] - c[a]) * s).toFixed(5);
    return mesh;
}

/** A built-in shape, unit diameter. */
export function builtinParticleMesh(kind: Exclude<ParticleMeshKind, 'model'>): ParticleMeshData {
    switch (kind) {
        case 'sphere': return normalize(fromGeometry(Geometry.Sphere(12, 0.5)));
        case 'tetrahedron': return normalize(fromGeometry(Geometry.Pyramid(1, 1)));
        case 'cylinder': return normalize(fromGeometry(Geometry.Cylinder(12, 0.5, 1)));
        case 'cube':
        default: return normalize(fromGeometry(Geometry.Cube(1, 1, 1)));
    }
}

/**
 * Flatten a serialized model subtree (a `ModelAsset.nodeJson`, or any node JSON) into one mesh, with
 * every node's transform baked in. Null when the subtree holds no geometry.
 */
export function particleMeshFromNodeJson(json: any): ParticleMeshData | null {
    const parts: ParticleMeshData[] = [];
    const visit = (node: any, parent: mat4) => {
        if (!node || typeof node !== 'object') return;
        const local = mat4.create();
        const position = Array.isArray(node.position) ? node.position : [0, 0, 0];
        const rotation = Array.isArray(node.rotation) ? node.rotation : [0, 0, 0];
        const scale = Array.isArray(node.scale) ? node.scale : [1, 1, 1];
        // Node rotations are degrees, composed Rz·Ry·Rx — gl-matrix's `fromEuler` order.
        const q = quat.fromEuler(quat.create(), rotation[0] || 0, rotation[1] || 0, rotation[2] || 0);
        mat4.fromRotationTranslationScale(local, q, position as vec3, scale as vec3);
        const world = mat4.multiply(mat4.create(), parent, local);
        const g = node.model?.geometry;
        if (g && g.positions) {
            const geometry = new Geometry(g.positions, g.normals, g.texCoords, g.tangents, g.bitangents, g.indices);
            if (geometry.positions.length > 0) parts.push(fromGeometry(geometry, world));
        }
        if (Array.isArray(node.children)) for (const child of node.children) visit(child, world);
    };
    visit(json, mat4.create());
    if (parts.length === 0) return null;

    const out: ParticleMeshData = { positions: [], normals: [], uvs: [], indices: [] };
    for (const part of parts) {
        const base = out.positions.length / 3;
        out.positions.push(...part.positions);
        out.normals.push(...part.normals);
        out.uvs.push(...part.uvs);
        for (const i of part.indices) out.indices.push(i + base);
    }
    return normalize(out);
}

/** Tolerant read of stored mesh data; null when it is not usable. */
export function parseParticleMesh(raw: any): ParticleMeshData | null {
    if (!raw || !Array.isArray(raw.positions) || !Array.isArray(raw.indices)) return null;
    const n = Math.floor(raw.positions.length / 3);
    if (n === 0 || raw.indices.length < 3) return null;
    const nums = (a: unknown, len: number, fill: number) => {
        const src = Array.isArray(a) ? a : [];
        return Array.from({ length: len }, (_, i) => (typeof src[i] === 'number' && Number.isFinite(src[i]) ? src[i] : fill));
    };
    const indices = (raw.indices as unknown[]).map(i => Math.max(0, Math.min(n - 1, Math.floor(Number(i) || 0))));
    return {
        positions: nums(raw.positions, n * 3, 0),
        normals: nums(raw.normals, n * 3, 0),
        uvs: nums(raw.uvs, n * 2, 0),
        indices: indices.slice(0, indices.length - (indices.length % 3)),
    };
}

/** Interleave for upload: position, normal, uv — 8 floats per vertex. */
export function interleaveParticleMesh(mesh: ParticleMeshData): { vertices: Float32Array; indices: Uint32Array } {
    const n = mesh.positions.length / 3;
    const vertices = new Float32Array(n * 8);
    for (let i = 0; i < n; i++) {
        vertices.set([mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2],
                      mesh.normals[i * 3] ?? 0, mesh.normals[i * 3 + 1] ?? 1, mesh.normals[i * 3 + 2] ?? 0,
                      mesh.uvs[i * 2] ?? 0, mesh.uvs[i * 2 + 1] ?? 0], i * 8);
    }
    return { vertices, indices: Uint32Array.from(mesh.indices) };
}
