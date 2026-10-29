import { TextureManager, isDerivedTextureId } from 'cleo'
import { Select } from './inputs'

export interface TexturePickerProps {
  value: string | null
  onChange: (id: string | null) => void
  /** What the empty option means: "(none)" for an optional slot, "(built-in)" or "(procedural)" for a default. */
  emptyLabel?: string
}

/**
 * Picker for a field that holds a bare texture id rather than a `Material` slot — a LUT, lens dirt, a
 * UI image, a night sky. Derived (channel-packed) textures are engine-owned and never assignable, per
 * `isDerivedTextureId`, and editor-internal ones are hidden.
 */
export function TexturePicker({ value, onChange, emptyLabel = '(none)' }: TexturePickerProps) {
  const ids = Array.from(TextureManager.Instance.textures.keys())
    .filter((id) => !isDerivedTextureId(id) && !id.startsWith('__editor__'))
  return (
    <Select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value=''>{emptyLabel}</option>
      {/* A texture the scene references but the manager has dropped still has to be selectable, or the
          field silently resets itself the moment anything re-renders — and for an id held in settings
          or on a node, nothing else keeps it alive. */}
      {value && !ids.includes(value) && <option value={value}>{value} (missing)</option>}
      {ids.map((id) => <option key={id} value={id}>{id}</option>)}
    </Select>
  )
}
