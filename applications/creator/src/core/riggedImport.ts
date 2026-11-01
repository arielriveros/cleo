// A rigged model from uploaded files: the skinned meshes, their skeleton and the clips the file carries.
//
// The editor's import does the same through its worker (applications/editor/src/workers/importJobs.ts);
// this is the Creator's main-thread copy of the two routes, built from the same engine pieces:
//
//   .glb / .gltf   read directly (GLTFLoader descriptors, then Loader.assembleGltfModels)
//   .fbx           converted to glTF2 by assimp first. A binary FBX's embedded images are taken out of the
//                  copy assimp gets -- it copies its input into WASM a byte at a time, so a 120 MB Mixamo
//                  character with its textures inside takes minutes, without them seconds -- and bound back
//                  onto the converted glTF's image references by name; the material maps assimp's glTF
//                  export drops (normal, specular, ambient) are read back from the FBX's own records.
//
// Every mesh is kept: the skinned ones, and the unskinned parts (eyes, hair, armour, a held prop), which
// carry the bone they hang from so the stage can move them with it.

import { GLTFLoader, Loader, convertToGltf2FromFiles, type AnimatedModel, type Model } from 'cleo';
import type { GltfParseResult } from 'cleo/graphics/utils/gltfLoader';
import { bindEmbeddedImages, decodeDataUriImages, readFbxSource, slotsFromFbx } from 'cleo/graphics/utils/fbxEmbedded';
import type { AssimpTextureSlots } from 'cleo/graphics/utils/assimpLoader';
import type { Animation, Skin } from 'cleo/animation/animatedModel';

export interface RiggedPart {
  name: string;
  model: Model | AnimatedModel;
  /** Where the file placed an unskinned part (skinned ones are placed by the skeleton). */
  transform?: { translation: number[]; rotation: number[]; scale: number[] };
  /** The bone an unskinned part hangs from, and its offset from that bone at rest. */
  bone?: { node: number; name?: string; offset: number[] };
}

/** A parsed file and the material maps recovered for it. */
export interface RiggedParse {
  parsed: GltfParseResult;
  recovered?: AssimpTextureSlots[];
}

export interface RiggedModel {
  /** Every mesh: the skinned ones first. */
  models: RiggedPart[];
  skin: Skin;
  /** Every clip the file carries (a Mixamo character's is often a two-key bind-pose stub). */
  animations: Animation[];
}

/** The files a rigged import reads: one model file and what it references. */
export const RIGGED_ACCEPT = '.fbx,.glb,.gltf,.bin,.png,.jpg,.jpeg,.tga';

export const isModelFile = (name: string) => /\.(fbx|glb|gltf)$/i.test(name);

/**
 * The file read into glTF descriptors: meshes, skins and clips, with no GPU objects made yet. Enough to
 * list a character's clips and read its skeleton; `assembleRigged` makes the drawable models.
 */
export async function parseRiggedDescriptors(files: File[]): Promise<RiggedParse> {
  const main = files.find(f => isModelFile(f.name));
  if (!main) throw new Error('Pick a .fbx, .glb or .gltf file (with its .bin and textures, if it has them).');
  if (/\.(glb|gltf)$/i.test(main.name)) {
    const parsed = await new GLTFLoader().parseDescriptorsFromFiles(files, true);
    decodeDataUriImages(parsed);
    return { parsed };
  }
  // The editor's import worker does the same (applications/editor/src/workers/importJobs.ts).
  const fbx = await readFbxSource(files);
  const forAssimp = fbx?.stripped ? files.map(f => (f === fbx.file ? new File([fbx.stripped as BlobPart], f.name) : f)) : files;
  const converted = await convertToGltf2FromFiles(forAssimp);
  // The originals stay in the list, after the converted files, for textures referenced by name.
  const parsed = await new GLTFLoader().parseDescriptorsFromFiles([...converted, ...files], true);
  let recovered: AssimpTextureSlots[] | undefined;
  if (fbx) {
    recovered = slotsFromFbx(fbx.info, parsed);
    parsed.embedded = fbx.info.embedded;
    bindEmbeddedImages(parsed, fbx.info);
  }
  decodeDataUriImages(parsed);
  return { parsed, recovered };
}

/** The skeleton and clips of a parsed file, or an error naming the file when it has no skeleton. */
export function riggedSkeleton({ parsed }: RiggedParse, fileName: string): { skin: Skin; animations: Animation[] } {
  const skin = parsed.skins.find(Boolean);
  if (!skin) throw new Error(`${fileName} has no skeleton: the Motion Creator needs a rigged (skinned) model.`);
  return { skin, animations: [...parsed.animations] };
}

/** The drawable, skinned models of a parsed file (textures registered with the engine). */
export function assembleRigged({ parsed, recovered }: RiggedParse, files: File[], fileName = 'model'): RiggedModel {
  const assembled = Loader.assembleGltfModels(parsed, files, undefined, recovered) as RiggedPart[];
  const skinned = assembled.filter(m => (m.model as AnimatedModel).skin);
  const first = skinned[0]?.model as AnimatedModel | undefined;
  if (!first?.skin) throw new Error(`${fileName} has no skeleton: the Motion Creator needs a rigged (skinned) model.`);
  return { models: [...skinned, ...assembled.filter(m => !(m.model as AnimatedModel).skin)], skin: first.skin, animations: [...(first.animations ?? [])] };
}

/** Read and assemble in one go. */
export async function parseRigged(files: File[]): Promise<RiggedModel> {
  const name = files.find(f => isModelFile(f.name))?.name ?? 'model';
  return assembleRigged(await parseRiggedDescriptors(files), files, name);
}
