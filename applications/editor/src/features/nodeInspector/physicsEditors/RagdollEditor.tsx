import { useEffect, useMemo, useRef, useState } from 'react';
import { ModelNode, AnimatedModel, Node, RAGDOLL_DEFAULTS, effectiveRagdollProfile } from 'cleo'
import type { RagdollOptions } from 'cleo'
import { useCleoEngine } from '../../EngineContext';
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import AxisInput from '@cleo/app-kit/ui/AxisInput'
import { Field, Slider, Toggle, Select, NumberInput, Button, DocScope, valueClass } from '@cleo/app-kit/ui'
import { PhysicsIcon } from '../sectionIcons'
import { useAssetLibrary } from '../../AssetLibraryContext'
import { modelIdOf } from '../../../utils/models'

const LABEL = 'w-[130px]';

/** The names the docs' Ragdoll › Source table gives the three ragdolls a character can fall with. */
const RAGDOLL_SOURCE_LABEL = { rig: 'Rig profile', auto: 'Automatic humanoid', generic: 'Generic' } as const;

/** Whether `node` is a skinned model a ragdoll applies to: a ModelNode with a skinned AnimatedModel and an animator. */
export function isRagdollModel(node: Node): node is ModelNode {
  const m = node as ModelNode;
  return node.nodeType === 'model' && m.model instanceof AnimatedModel && m.model.hasSkin && !!m.animator;
}

/**
 * How a skinned character falls when it goes limp (ModelNode.ragdollConfig): which ragdoll it falls with,
 * and the generic one's joints. The config lives on the node, so it serializes with the scene, and an edit
 * is an ordinary scene change (dirty + undo).
 */
export default function RagdollEditor({ node }: { node: ModelNode }) {
  const { eventEmitter, enterRigEditor } = useCleoEngine();
  const [ragdoll, setRagdoll] = useState<RagdollOptions>(() => ({ ...RAGDOLL_DEFAULTS, ...(node.ragdollConfig || {}) }));
  const [sceneChanged, setSceneChanged] = useState(0);

  useEffect(() => {
    const onChange = () => setSceneChanged(v => v + 1);
    eventEmitter.on('SCENE_CHANGED', onChange);
    return () => { eventEmitter.off('SCENE_CHANGED', onChange); };
  }, [eventEmitter]);

  // Adopting the node's config on selection is not an edit; changing it is. (Mounted per node: keyed by id.)
  const loadRef = useRef(true);
  useEffect(() => {
    node.ragdollConfig = ragdoll;
    if (loadRef.current) loadRef.current = false;
    else eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node });
  }, [ragdoll]);

  // What this character falls with: the rig's authored profile, the automatic humanoid one, or the generic
  // per-bone ragdoll. Only the last is tuned by the joint fields below.
  const { models: modelLibrary } = useAssetLibrary();
  const ragdollSource = useMemo(() => {
    const skin = node.model instanceof AnimatedModel ? node.model.skin : null;
    return skin ? effectiveRagdollProfile(skin).source : 'generic';
  }, [node, sceneChanged]);
  const ragdollRigId = modelLibrary.find(m => m.id === modelIdOf(node))?.rigId;

  return (
    <DocScope page='editor/physics'>
      <Collapsable title='Ragdoll' icon={<PhysicsIcon />} persistKey='ragdoll'>
        <div className='w-full p-2'>
          {/* Which of the three ragdolls this character falls with: the fields below change with it. */}
          <Field label='Source' labelClassName={LABEL}>
            <span className={valueClass}>{RAGDOLL_SOURCE_LABEL[ragdollSource]}</span>
          </Field>
          {ragdollRigId && <Button variant='subtle' size='sm' className='w-full mb-2' onClick={() => enterRigEditor(ragdollRigId)}>Edit ragdoll in rig</Button>}
          { ragdollSource === 'generic' ? <>
            <Field label='Joint Type' labelClassName={LABEL}>
              <Select value={ragdoll.jointType} onChange={(e) => setRagdoll({ ...ragdoll, jointType: e.target.value as 'ball' | 'coneTwist' })}>
                <option value='ball'>Ball (free, stable)</option>
                <option value='coneTwist'>Cone-Twist (limited)</option>
              </Select>
            </Field>
            { ragdoll.jointType === 'coneTwist' && <>
              <Slider label='Cone Angle' labelClassName={LABEL} min={0} max={180} step={1} value={ragdoll.coneAngle ?? 0} readout={(v) => `${v.toFixed(0)}°`} onChange={(v) => setRagdoll({ ...ragdoll, coneAngle: v })} />
              <Slider label='Twist Angle' labelClassName={LABEL} min={0} max={180} step={1} value={ragdoll.twistAngle ?? 0} readout={(v) => `${v.toFixed(0)}°`} onChange={(v) => setRagdoll({ ...ragdoll, twistAngle: v })} />
              <Field label='Stiffness' labelClassName={LABEL}><NumberInput value={ragdoll.stiffness ?? 0} onChange={(v) => setRagdoll({ ...ragdoll, stiffness: v })} /></Field>
            </> }
            <Slider label='Angular Damping' labelClassName={LABEL} min={0} max={1} step={0.01} value={ragdoll.angularDamping ?? 0} onChange={(v) => setRagdoll({ ...ragdoll, angularDamping: v })} />
            <Slider label='Linear Damping' labelClassName={LABEL} min={0} max={1} step={0.01} value={ragdoll.linearDamping ?? 0} onChange={(v) => setRagdoll({ ...ragdoll, linearDamping: v })} />
            <Field label='Bone Mass' labelClassName={LABEL}><NumberInput step={0.1} value={ragdoll.boneMass ?? 0} onChange={(v) => setRagdoll({ ...ragdoll, boneMass: v })} /></Field>
            <Field label='Radius Scale' labelClassName={LABEL}><NumberInput step={0.05} value={ragdoll.radiusScale ?? 0} onChange={(v) => setRagdoll({ ...ragdoll, radiusScale: v })} /></Field>
            <Field label='Self Collision' labelClassName={LABEL}><Toggle checked={!!ragdoll.selfCollision} onChange={(c) => setRagdoll({ ...ragdoll, selfCollision: c })} /></Field>
            <Field label='Knockback Impulse' labelClassName={LABEL}>
              <AxisInput step={0.1} value={[ragdoll.impulse?.[0] ?? 0, ragdoll.impulse?.[1] ?? 0, ragdoll.impulse?.[2] ?? 0]} onChange={(v) => setRagdoll({ ...ragdoll, impulse: [v[0], v[1], v[2]] })} />
            </Field>
          </> : <>
            <Field label='Mass Scale' labelClassName={LABEL}>
              <NumberInput step={0.05} min={0.1} value={ragdoll.massScale ?? 1} onChange={(v) => setRagdoll({ ...ragdoll, massScale: Math.max(0.1, v) })} />
            </Field>
            <Field label='Push (m/s)' labelClassName={LABEL}>
              <AxisInput step={0.1} value={[ragdoll.impulse?.[0] ?? 0, ragdoll.impulse?.[1] ?? 0, ragdoll.impulse?.[2] ?? 0]} onChange={(v) => setRagdoll({ ...ragdoll, impulse: [v[0], v[1], v[2]] })} />
            </Field>
          </> }
        </div>
      </Collapsable>
    </DocScope>
  );
}
