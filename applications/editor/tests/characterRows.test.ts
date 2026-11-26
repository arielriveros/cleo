import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

// A skinned model's animation and ragdoll are its SKELETON's (clips, animators, blend spaces, the ragdoll
// profile), authored in the Skeleton part. The inspector keeps only what a character decides for itself, as
// "This character" rows under the Skeleton section, and a template instance's tree row shows the template.
// Source-text checks: the inspector and the tree pull in the engine context, which needs a browser.

const SRC = join(__dirname, '..', 'src')
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf-8').replace(/\r\n/g, '\n')

describe('an animated model inspector shows only the per-character choices', () => {
  it('has no Animation or Ragdoll section any more', () => {
    const editor = read('features', 'nodeInspector', 'propertyEditors', 'PropertyEditor.tsx')
    expect(editor).not.toContain('AnimationSlot')
    expect(editor).not.toContain('RagdollEditor')
    expect(existsSync(join(SRC, 'features', 'nodeInspector', 'propertyEditors', 'AnimationSlot.tsx'))).toBe(false)
    expect(existsSync(join(SRC, 'features', 'nodeInspector', 'physicsEditors', 'RagdollEditor.tsx'))).toBe(false)
  })

  it('puts the character rows under its Skeleton', () => {
    expect(read('features', 'nodeInspector', 'propertyEditors', 'RigSlot.tsx')).toContain('<CharacterRows modelNode={modelNode} rigId={rig?.id} />')
    const rows = read('features', 'nodeInspector', 'propertyEditors', 'CharacterRows.tsx')
    expect(rows).toContain("<SectionTitle title='This character' />")
    for (const label of ["label='Animator'", "label='Clip overrides'", "label='Ragdoll mass'", "label='Ragdoll push'",
      "label='Reactions'", "label='Reaction strength'", "label='Health'", "label='Gets up'"])
      expect(rows, label).toContain(label)
    // The animator choice keeps its behaviour: a shared one is instantiated with this character's overrides.
    expect(rows).toContain('instantiateController(asset, libs, sm?.controllerId === id ? sm.clipOverrides : undefined)')
    expect(rows).toContain('enterStateMachineEditor(modelNode.id)')
    // What the skeleton decides leaves the inspector: the source row and the generic ragdoll's joints.
    for (const gone of ["'Source'", "'Joint Type'", "'Cone Angle'", "'Bone Mass'", "'Radius Scale'", "'Self Collision'", 'Edit Animation'])
      expect(rows, gone).not.toContain(gone)
  })
})

describe('a template instance row shows the template', () => {
  it('draws the template glyph in place of its root type, named in the tooltip', () => {
    const parts = read('features', 'sceneInspector', 'sceneNodeParts.tsx')
    expect(parts).toMatch(/export function NodeTypeGlyph[\s\S]{0,600}if \(templateId\)[\s\S]{0,400}<TemplateIcon \/>/)
    expect(parts).toContain('title={`Template instance${name ? `: ${name}` : \'\'} (${nodeTypeLabel(type)} root)`}')
    expect(read('features', 'sceneInspector', 'nodeIcons.tsx')).toContain('export const TemplateIcon = () => (')
    expect(read('features', 'sceneInspector', 'SceneInspector.tsx')).toContain('<NodeTypeGlyph type={data.type} templateId={data.templateId} />')
    expect(read('features', 'sceneInspector', 'SceneGraphView.tsx')).toContain("<NodeTypeGlyph type={desc.type} templateId={desc.templateId} className='shrink-0' />")
  })
})
