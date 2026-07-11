// Detects texture image files a model references but that were NOT included in the upload. The engine
// loaders silently drop a missing texture reference (the name never reaches the returned Material), so
// we re-derive references directly from the source files: GLTF `images[].uri` and MTL `map_*` lines.
// GLB/FBX embed their textures, so nothing to detect there.

// Last path segment, splitting on both separators (MTL paths are often Windows-style, e.g. `tex\a.png`).
function baseName(path: string): string { const parts = path.split(/[\\/]/); return parts[parts.length - 1] }
function extOf(name: string): string { const b = baseName(name).toLowerCase(); const i = b.lastIndexOf('.'); return i >= 0 ? b.slice(i) : '' }

// MTL texture-map directives; the filename is the LAST whitespace token (options like `-bm 0.5` precede it).
const MTL_MAP_RE = /^\s*(map_\w+|bump|disp|decal|norm|refl)\b\s+(.+?)\s*$/i

// The gltf material texture slots the engine's GLTFLoader.createMaterial actually loads. Detection must
// mirror this exactly so the modal lists precisely the images that will be applied (not every image in
// the file, which over-reports unused / shared-source images and leaves uploads that never get used).
function gltfMaterialImageIndices(mat: any): (number | undefined)[] {
  const pbr = mat?.pbrMetallicRoughness
  return [
    pbr?.baseColorTexture?.index,
    pbr?.metallicRoughnessTexture?.index,
    mat?.normalTexture?.index,
    mat?.occlusionTexture?.index,
    mat?.emissiveTexture?.index,
  ]
}

/** Texture image basenames referenced by the model files in the set (external refs only, not embedded). */
export async function referencedTextureNames(files: File[]): Promise<string[]> {
  const names = new Set<string>()
  for (const f of files) {
    const ext = extOf(f.name)
    try {
      if (ext === '.gltf') {
        const json = JSON.parse(await f.text())
        const images = json.images || []
        const textures = json.textures || []
        const uriOfTexture = (texIndex: number | undefined): string | undefined => {
          if (texIndex === undefined) return undefined
          const tex = textures[texIndex]
          if (!tex || tex.source === undefined) return undefined
          return images[tex.source]?.uri
        }
        // Walk material → texture-slot → texture → image, mirroring GLTFLoader.createMaterial.
        for (const mat of (json.materials || [])) {
          for (const texIndex of gltfMaterialImageIndices(mat)) {
            const uri = uriOfTexture(texIndex)
            if (typeof uri === 'string' && uri && !uri.startsWith('data:')) names.add(baseName(uri))
          }
        }
      } else if (ext === '.mtl') {
        const text = await f.text()
        for (const line of text.split(/\r?\n/)) {
          const m = MTL_MAP_RE.exec(line)
          if (!m) continue
          const tokens = m[2].trim().split(/\s+/)
          const file = tokens[tokens.length - 1]
          if (file) names.add(baseName(file))
        }
      }
    } catch { /* unreadable / malformed source — ignore, treat as no refs */ }
  }
  return [...names]
}

/** Referenced texture basenames that are NOT present among the uploaded files (case-insensitive). */
export async function detectMissingTextures(files: File[]): Promise<string[]> {
  const referenced = await referencedTextureNames(files)
  const present = new Set(files.map(f => baseName(f.name).toLowerCase()))
  return referenced.filter(n => !present.has(n.toLowerCase()))
}
