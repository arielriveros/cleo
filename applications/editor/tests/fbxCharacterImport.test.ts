import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { runImportJob } from '../src/workers/importJobs';

// A real Mixamo character through the worker's .fbx route: examples/assets/Ch05_nonPBR.fbx, 120 MB,
// three skinned meshes, twelve embedded PNGs. Skipped when the file is not in the checkout.
//
// It pins the three things that went wrong importing it:
//  - the embedded maps were reported "missing, link them manually" (they were inside the file);
//  - the import took minutes (assimpjs copies its input into WASM a byte at a time, and 110 MB of the
//    input was those images — now stripped before assimp sees the file);
//  - the weld renumbered the vertices and left the joint arrays in the old order, so the model looked
//    right at rest and exploded as soon as a clip played.

const FILE = join(__dirname, '..', '..', '..', 'examples', 'assets', 'Ch05_nonPBR.fbx');
const present = existsSync(FILE);

describe.skipIf(!present)('importing a Mixamo FBX character', () => {
    const load = async (weldCreaseDeg: number) => {
        const file = new File([readFileSync(FILE)], 'Ch05_nonPBR.fbx');
        const { result } = await runImportJob({ kind: 'parseModelAsGltf', files: [file], animated: true, weldCreaseDeg });
        if (result.kind !== 'parseGltf') throw new Error('unexpected result');
        return result;
    };

    it('finds every embedded map and wires each material slot to one', async () => {
        const { parsed, recovered } = await load(0);
        expect(parsed.embedded?.map(e => e.name).sort()).toHaveLength(12);
        // Every glTF image resolved to bytes — none left as a "missing" file reference.
        expect(parsed.images.every(i => i.kind === 'bytes')).toBe(true);
        expect(parsed.materials.map(m => m.name)).toEqual(['Ch05_body', 'Ch05_body1', 'Ch05_body2']);
        const embeddedNames = new Set(parsed.embedded!.map(e => e.name));
        for (const slots of recovered!) {
            expect(embeddedNames.has(slots.normalMap!)).toBe(true);
            expect(embeddedNames.has(slots.baseColorTexture!)).toBe(true);
        }
    }, 300_000);

    it('keeps every welded vertex on the bones it had before the weld', async () => {
        const raw = await load(0);
        const welded = await load(45);
        expect(welded.parsed.meshes.length).toBe(raw.parsed.meshes.length);

        const influences = (j: ArrayLike<number>, w: ArrayLike<number>, v: number) => {
            const pairs: string[] = [];
            for (let k = 0; k < 4; k++) if (w[v * 4 + k] > 1e-4) pairs.push(`${j[v * 4 + k]}:${w[v * 4 + k].toFixed(3)}`);
            return pairs.sort().join(' ');
        };
        for (let m = 0; m < raw.parsed.meshes.length; m++) {
            const a = raw.parsed.meshes[m], b = welded.parsed.meshes[m];
            const vertexCount = b.geometry.positions.length / 3;
            expect(vertexCount).toBeLessThan(a.geometry.positions.length / 3);      // it did weld
            expect(b.jointIndices!.length).toBe(vertexCount * 4);
            expect(b.jointWeights!.length).toBe(vertexCount * 4);

            // Unwelded influences by exact position.
            const byPosition = new Map<string, Set<string>>();
            const P = a.geometry.positions;
            for (let v = 0; v < P.length / 3; v++) {
                const key = `${P[v * 3]},${P[v * 3 + 1]},${P[v * 3 + 2]}`;
                if (!byPosition.has(key)) byPosition.set(key, new Set());
                byPosition.get(key)!.add(influences(a.jointIndices!, a.jointWeights!, v));
            }
            const Q = b.geometry.positions;
            let wrong = 0;
            for (let v = 0; v < vertexCount; v++) {
                const key = `${Q[v * 3]},${Q[v * 3 + 1]},${Q[v * 3 + 2]}`;
                if (!byPosition.get(key)?.has(influences(b.jointIndices!, b.jointWeights!, v))) wrong++;
            }
            expect(wrong, `mesh ${m}: vertices whose bones changed in the weld`).toBe(0);
        }
    }, 600_000);
});
