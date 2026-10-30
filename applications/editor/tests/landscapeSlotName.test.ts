import { describe, it, expect } from 'vitest'
import { slotDisplayName } from '../src/utils/landscapeSlots'

// A slot linked to a Material asset is named by it, so renaming the material renames the slot in the
// Layers panel and the paint toolbar with nothing to propagate.

describe('slotDisplayName', () => {
  const materials = [{ id: 'm1', name: 'Asphalt' }]

  it('follows the linked material, whatever name the slot stored', () => {
    expect(slotDisplayName({ name: 'Road', surfaceMaterialId: 'm1' }, materials)).toBe('Asphalt')
    expect(slotDisplayName({ name: 'Road', surfaceMaterialId: 'm1' }, [{ id: 'm1', name: 'Gravel' }])).toBe('Gravel')
  })

  it('falls back to the stored name when unlinked or the material is gone', () => {
    expect(slotDisplayName({ name: 'Road', surfaceMaterialId: null }, materials)).toBe('Road')
    expect(slotDisplayName({ name: 'Road', surfaceMaterialId: 'missing' }, materials)).toBe('Road')
  })
})
