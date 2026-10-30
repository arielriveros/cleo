// ---------------------------------------------------------------------------------------------------
// What to call an imported animation clip.
//
// Clips are addressed BY NAME everywhere downstream — state machine states, Animation Field samples,
// `animator.play('Walk')` in a script. So a name that does not identify the clip is not cosmetic: it is
// the difference between a state machine finding its clip and silently playing the wrong one.
//
// Exporters routinely supply no useful name. Every Mixamo download — the character and all four of its
// animations alike — calls its single clip `mixamo.com`; assimp names a nameless FBX take `Take 001`;
// the engine's own glTF reader falls back to `Animation`. Import four of those and the de-duper turns
// them into `mixamo.com`, `mixamo.com (2)`, `(3)`, `(4)`: four clips nothing can tell apart.
//
// The file name is the only information actually present in that situation, and it is nearly always the
// right answer, because the artist named the download after the motion (`Zombie Walk.fbx`).
//
// Engine-free on purpose, so both import routes and the root test suite can use it.
// ---------------------------------------------------------------------------------------------------

/**
 * Names that carry no information about what the clip IS — an exporter's placeholder rather than
 * something an author chose. Anchored and case-insensitive; a clip genuinely called "Take Off" or
 * "Animation of a Dog" is not one of these.
 */
const GENERIC_CLIP_NAMES = [
  /^mixamo\.com$/i,          // every Mixamo export, character and animation alike
  /^animation$/i,            // GLTFLoader's own fallback for a nameless clip
  /^take ?\d+$/i,            // assimp's FBX take naming: "Take 001"
  /^default ?take$/i,        // FBX SDK's default stack name
  /^unnamed$/i,
  /^anim(ation)?[ _-]?\d*$/i, // Anim, Anim_0, animation 1 …
]

/** Whether `name` is an exporter placeholder rather than a name an author chose. */
export function isGenericClipName(name: string | null | undefined): boolean {
  const trimmed = (name ?? '').trim()
  if (!trimmed) return true
  return GENERIC_CLIP_NAMES.some(re => re.test(trimmed))
}

/** A file name with its extension removed. Accepts a bare `File.name` or a path. */
export function fileStem(fileName: string): string {
  const base = fileName.replace(/\\/g, '/').split('/').pop() ?? fileName
  return base.replace(/\.[^.]+$/, '').trim()
}

/**
 * The name to give a clip that arrived from `fileName`: its own, unless that is a placeholder, in which
 * case the file's stem. Falls back to the original when the file name yields nothing usable, so this can
 * never return an empty string for a clip that had a name.
 */
export function clipNameFromFile(clipName: string, fileName: string): string {
  if (!isGenericClipName(clipName)) return clipName
  return fileStem(fileName) || clipName
}
