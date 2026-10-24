import { useMemo, useRef, useState } from 'react'
import { humanoidRigOf } from 'cleo'
import type { ModelNode } from 'cleo'
import { useAssetLibrary } from '../AssetLibraryContext'
import { useEditorSessions } from '../EditorSessionsContext'
import { DocScope, Modal, ModalHeader, ModalFooter, Button, SectionTitle, Select, cn, hintClass } from '../../components/ui'
import { modelIdOf } from '../../utils/models'
import {
  ANIMATOR_TEMPLATES, guessClipSlots, missingRequired, templateById, type TemplateId,
} from '../../utils/animatorTemplates'

// "Animate this character": from a skinned character with clips to one that idles, walks, runs and jumps
// in Play, without touching a graph. Three things on one page — the skeleton check, a template, and which
// clip fills each of its slots (guessed from the names) — then one button builds the Animator and opens
// the Character Animation workspace on it for anything the template did not cover.

/** The humanoid slots worth reporting. A template works on any skeleton; these tell the user it matched. */
const KEY_BONES = ['hips', 'spine', 'head', 'upLeg.L', 'upLeg.R', 'leg.L', 'leg.R', 'foot.L', 'foot.R', 'upperArm.L', 'upperArm.R', 'hand.L', 'hand.R']

export default function AnimateCharacterWizard({ node, onClose }: { node: ModelNode; onClose: () => void }) {
  const { models, rigs, animations } = useAssetLibrary()
  const { animateCharacter, importAnimationFiles } = useEditorSessions()
  const fileRef = useRef<HTMLInputElement>(null)

  const model = models.find(m => m.id === modelIdOf(node))
  const rig = model?.rigId ? rigs.find(r => r.id === model.rigId) : undefined
  const clipNames = useMemo(() => {
    const ids = rig?.animationIds ?? []
    return [...new Set(ids.flatMap(id => animations.find(a => a.id === id)?.clips.map(c => c.name) ?? []))]
  }, [rig, animations])

  const skin = (node.model as any)?.skin
  const humanoid = useMemo(() => {
    if (!skin) return { found: 0, total: KEY_BONES.length }
    const slots = humanoidRigOf(skin)
    return { found: KEY_BONES.filter(k => slots.has(k)).length, total: KEY_BONES.length }
  }, [skin])

  const [templateId, setTemplateId] = useState<TemplateId>('locomotion')
  const template = templateById(templateId)
  // Re-guessed when the template or the clip list changes; a user's pick survives while the clip exists.
  const [picks, setPicks] = useState<Record<string, string | undefined>>({})
  const guessed = useMemo(() => guessClipSlots(template, clipNames), [template, clipNames])
  const assigned: Record<string, string | undefined> = {}
  for (const s of template.slots) {
    const p = picks[`${templateId}:${s.key}`]
    assigned[s.key] = p === '' ? undefined : p !== undefined && clipNames.includes(p) ? p : guessed[s.key]
  }
  const missing = missingRequired(template, assigned)

  const finish = () => {
    const r = animateCharacter(node.id, templateId, assigned)
    if (r) onClose()
  }

  return (
    // Opened from a character's inspector, but documented with the animation workspace it leads into.
    <DocScope page='editor/animation' section='animate-a-character-in-a-minute'>
      <Modal onClose={onClose} className='w-[560px]'>
        <ModalHeader title={`Animate ${node.name}`} doc='editor/animation#animate-a-character-in-a-minute' />

        <div className='px-4 py-3 flex flex-col gap-4'>
          {/* 1. Skeleton */}
          <section className='flex flex-col gap-1'>
            <SectionTitle title='1. Skeleton' doc='Checks the skeleton' />
            {!rig ? (
              <p className='text-ui-sm text-warning'>This character is not a model from the library, so it has no skeleton to share clips through. Import it as a model first.</p>
            ) : humanoid.found >= 9 ? (
              <p className='text-ui-sm text-success'>✓ Humanoid skeleton “{rig.name}” — {humanoid.found} of {humanoid.total} key bones recognised.</p>
            ) : (
              <p className='text-ui-sm text-warning'>
                “{rig.name}”: only {humanoid.found} of {humanoid.total} key bones recognised by name. Templates still work, but foot
                placement and clips from other skeletons may need the bone mapping checked in the Skeleton tab.
              </p>
            )}
          </section>

          {/* 2. Template */}
          <section className='flex flex-col gap-1'>
            <SectionTitle title='2. What kind of character?' doc='Picks a template' />
            <div className='grid grid-cols-3 gap-2'>
              {ANIMATOR_TEMPLATES.map(t => (
                <button key={t.id} type='button' onClick={() => setTemplateId(t.id)}
                  className={cn('text-left rounded border p-2 flex flex-col gap-1',
                    t.id === templateId ? 'border-fg bg-selected' : 'border-control hover:bg-control')}>
                  <span className='text-ui font-medium'>{t.name}</span>
                  <span className='text-ui-xs text-dim'>{t.description}</span>
                </button>
              ))}
            </div>
          </section>

          {/* 3. Clips */}
          <section className='flex flex-col gap-1'>
            <div className='flex items-center'>
              <SectionTitle title='3. Clips' doc='Assigns the clips' className='flex-1' />
              <Button size='sm' variant='subtle' disabled={!model} onClick={() => fileRef.current?.click()}
                title='Import .fbx/.glb/.gltf animation files for this character (Mixamo works well)'>+ Import clips…</Button>
              <input ref={fileRef} type='file' multiple className='hidden' accept='.fbx,.glb,.gltf,.bin'
                onChange={e => {
                  const files = Array.from(e.target.files ?? [])
                  e.target.value = ''
                  if (files.length && model) void importAnimationFiles(files, { modelId: model.id })
                }} />
            </div>
            {clipNames.length === 0 && (
              <p className='text-ui-sm text-warning'>This character has no clips yet. Import some — an idle is the minimum; walk, run and jump make it move.</p>
            )}
            <div className='grid grid-cols-[120px_1fr] gap-x-2 gap-y-1 items-center'>
              {template.slots.map(s => (
                <div key={s.key} className='contents'>
                  <span className='text-ui-sm' title={s.hint}>{s.label}{s.required && <span className='text-warning'> *</span>}</span>
                  <div className='flex items-center gap-2 min-w-0'>
                    <Select className='flex-1 min-w-0' value={assigned[s.key] ?? ''}
                      onChange={e => setPicks(p => ({ ...p, [`${templateId}:${s.key}`]: e.target.value }))}>
                      <option value=''>{s.required ? '(choose a clip)' : '(none)'}</option>
                      {clipNames.map(c => <option key={c} value={c}>{c}</option>)}
                    </Select>
                    <span className='text-ui-xs text-dim w-[180px] truncate' title={s.hint}>{s.hint}</span>
                  </div>
                </div>
              ))}
            </div>
            {template.footPlacement && (
              <p className={cn(hintClass, 'mt-1')}>Foot placement is switched on for the skeleton if it is not already, so feet stay on slopes and stairs in Play.</p>
            )}
          </section>
        </div>

        <ModalFooter>
          {missing.length > 0 && <span className='mr-auto text-ui-sm text-warning self-center'>Choose a clip for: {missing.map(m => m.label).join(', ')}</span>}
          <Button variant='ghost' onClick={onClose}>Cancel</Button>
          <Button variant='primary' disabled={!rig || missing.length > 0} onClick={finish}>Create Animator</Button>
        </ModalFooter>
      </Modal>
    </DocScope>
  )
}
