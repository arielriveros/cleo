// Assets ▸ + Add ▸ Rigged character…: an uploaded rigged model becomes a Character in the Creator library.
//
// The file is read for its skeleton and clips only (no GPU work: the Motion Creator draws it when it opens
// the character), the originals are kept as the asset's private files, and the first revision already
// carries the files the editor imports -- every clip the file had, and an empty pose library.

import { hashChunks, newCreatorAssetId, putCreatorAsset, type CreatorFile } from '@cleo/app-kit/creatorLibrary';
import { isModelFile, parseRiggedDescriptors, riggedSkeleton } from '../core/riggedImport';
import type { ExportFile } from '../core/generator';
import { exportCharacter, newCharacter } from './character';
import { buildRig } from './motionRig';

const toFile = (f: ExportFile): CreatorFile => ({ name: f.name, mime: f.mime, blob: new Blob([f.bytes as BlobPart], { type: f.mime }) });

/** The sidecar among export files, parsed. */
export function sidecarOf(files: ExportFile[]): Record<string, unknown> | null {
  for (const f of files) {
    if (!f.name.endsWith('.json')) continue;
    try { const j = JSON.parse(new TextDecoder().decode(f.bytes)); if (j && typeof j === 'object' && 'generator' in j) return j; } catch { /* not it */ }
  }
  return null;
}

/** Read the files and store them as a new Character. Returns its library id and how many clips it had. */
export async function importCharacter(files: File[]): Promise<{ id: string; name: string; clips: number }> {
  const main = files.find(f => isModelFile(f.name));
  if (!main) throw new Error('Pick a .fbx, .glb or .gltf file (with its .bin and textures, if it has them).');
  const parsed = await parseRiggedDescriptors(files);
  const { skin, animations } = riggedSkeleton(parsed, main.name);
  const name = main.name.replace(/\.[^.]+$/, '') || 'Character';
  const doc = newCharacter(name, files.map(f => f.name), animations);
  const out = exportCharacter(doc, buildRig(skin as any), skin as any, animations);
  const privateFiles: ExportFile[] = await Promise.all(files.map(async f => ({ name: f.name, mime: f.type || 'application/octet-stream', bytes: new Uint8Array(await f.arrayBuffer()) })));
  const id = newCreatorAssetId('character');
  const docJson = new TextEncoder().encode(JSON.stringify(doc));
  await putCreatorAsset({
    id, kind: 'character', name, doc, sidecar: sidecarOf(out),
    files: out.map(toFile), privateFiles: privateFiles.map(toFile),
    contentHash: hashChunks([docJson, ...out.map(f => f.bytes), ...privateFiles.map(f => f.bytes)]),
  });
  return { id, name, clips: doc.clips.length };
}
