import { CustomMaterial, customSeedTemplate, customSeedUniforms } from 'cleo'
import type { CustomBaseType, CustomRenderMode } from 'cleo'

type MaterialConfig = Parameters<typeof CustomMaterial.Create>[2]

/**
 * (Re)seed a custom material's shader source, uniform declarations and their live values from an "extend
 * base" choice and a render mode. Clears previous user uniforms/textures, so switching base or mode gives
 * a clean, compiling scaffold. Callers must refresh the inspector afterwards.
 */
export function seedCustomMaterial(mat: CustomMaterial, base: CustomBaseType, mode: CustomRenderMode): void {
  mat.baseType = base
  mat.renderMode = mode
  mat.fragmentSource = customSeedTemplate(base, mode)
  mat.uniforms = customSeedUniforms(base, mode)
  mat.properties.clear()
  mat.textures.clear()
  for (const u of mat.uniforms)
    if (u.type !== 'sampler2D' && u.type !== 'samplerCube') mat.properties.set(u.name, u.value)
  mat.refreshType()
}

/** Create a fully-seeded custom material — used when switching a material to the 'custom' shader type. */
export function newCustomMaterial(base: CustomBaseType, mode: CustomRenderMode, config?: MaterialConfig): CustomMaterial {
  const mat = CustomMaterial.Create(base, mode, config)
  seedCustomMaterial(mat, base, mode)
  return mat
}
