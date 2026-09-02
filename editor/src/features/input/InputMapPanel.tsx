import { useMemo, useState } from 'react'
import {
  ACTION_KINDS, DEFAULT_INPUT_MAP, DEFAULT_PRESS_POINT, cloneInputMap, sourceKey,
} from 'cleo'
import type { ActionKind, InputMap, ProcessorKind } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import {
  Button, ButtonWithConfirm, Panel, Section, Select, Slider, TextInput, Toggle, hintClass, labelClass,
  sectionTitleClass,
} from '../../components/ui'
import BindingRow from './BindingRow'
import ProcessorList from './ProcessorList'
import InputMonitor from './InputMonitor'
import VirtualControlsEditor from './VirtualControlsEditor'
import { useRebindCapture } from './useRebindCapture'
import * as edits from './inputMapEdits'

/**
 * The Input panel: author the project's action maps.
 *
 * Everything here edits ONE piece of state — `inputMap` on the engine context — through the pure
 * reducers in `inputMapEdits`. That state is persisted to IndexedDB, pushed into the running
 * `InputSystem` on every change (so Play reflects a rebind with no rebuild), and written into a
 * published build's `config.input`. There is no separate "apply" step, and deliberately so: the whole
 * value of the live monitor below is that it shows the effect of the edit you just made.
 *
 * The editor's own viewport camera map is NOT shown. It is a host overlay, lives outside the project's
 * map entirely, and is not the user's to rebind here.
 */
export default function InputMapPanel() {
  const { inputMap, setInputMap } = useCleoEngine()
  const capture = useRebindCapture()

  const [selectedMap, setSelectedMap] = useState<string>(() => inputMap.maps[0]?.name ?? '')
  const [selectedAction, setSelectedAction] = useState<string>('')
  const [selectedControl, setSelectedControl] = useState<string | null>(null)

  const map = inputMap.maps.find(m => m.name === selectedMap) ?? inputMap.maps[0] ?? null
  const action = map?.actions.find(a => a.name === selectedAction) ?? map?.actions[0] ?? null
  const mapName = map?.name ?? ''
  const actionName = action?.name ?? ''

  /** `Map/Action` names each of this action's sources is ALSO bound in. Reported, never blocked. */
  const conflicts = useMemo(() => {
    const out = new Map<string, string[]>()
    if (!action) return out
    for (const binding of action.bindings) {
      const key = sourceKey(binding.source)
      out.set(binding.id, edits.bindingsUsing(inputMap, key, sourceKey)
        .filter(where => where !== `${mapName}/${actionName}`))
    }
    return out
  }, [inputMap, action, mapName, actionName])

  const apply = (next: InputMap) => setInputMap(next)

  if (!map) {
    return (
      <Panel className='p-2'>
        <p className={hintClass}>This project has no input maps.</p>
        <Button size='sm' className='mt-2' onClick={() => apply(edits.addMap(inputMap))}>Add a map</Button>
      </Panel>
    )
  }

  return (
    <Panel className='p-2 flex flex-col gap-3 overflow-auto'>
      {/* ----- maps ----- */}
      <Section title='Action maps' hint='A map is a context. Turn one off and everything held in it is released.'>
        <div className='flex flex-col gap-1'>
          {inputMap.maps.map(m => (
            <div key={m.name}
              className={`flex items-center gap-1 rounded px-1 py-0.5 cursor-pointer
                ${m.name === mapName ? 'bg-selected/25' : 'hover:bg-control-hover'}`}
              onClick={() => { setSelectedMap(m.name); setSelectedAction('') }}
            >
              <Toggle
                checked={m.enabled}
                onChange={enabled => apply(edits.setMapEnabled(inputMap, m.name, enabled))}
                title='Whether this map starts enabled. A script can turn it on and off at runtime.'
              />
              <TextInput
                className='flex-1 min-w-0'
                value={m.name}
                onChange={name => {
                  apply(edits.renameMap(inputMap, m.name, name))
                  if (m.name === mapName) setSelectedMap(name.trim() || m.name)
                }}
              />
              <span className={hintClass}>{m.actions.length}</span>
              <ButtonWithConfirm onClick={() => apply(edits.removeMap(inputMap, m.name))}>✕</ButtonWithConfirm>
            </div>
          ))}
          <Button size='sm' variant='ghost' onClick={() => apply(edits.addMap(inputMap))}>+ Map</Button>
        </div>
      </Section>

      {/* ----- actions ----- */}
      <Section title={`Actions in ${mapName}`}>
        <div className='flex flex-col gap-1'>
          {map.actions.map(a => (
            <div key={a.name}
              className={`flex items-center gap-1 rounded px-1 py-0.5 cursor-pointer
                ${a.name === actionName ? 'bg-selected/25' : 'hover:bg-control-hover'}`}
              onClick={() => setSelectedAction(a.name)}
            >
              <TextInput
                className='flex-1 min-w-0'
                value={a.name}
                onChange={name => {
                  apply(edits.renameAction(inputMap, mapName, a.name, name))
                  if (a.name === actionName) setSelectedAction(name.trim() || a.name)
                }}
              />
              <Select
                className='w-[84px]'
                value={a.kind}
                onChange={e => apply(edits.setActionKind(inputMap, mapName, a.name, e.target.value as ActionKind))}
                title='button = pressed/released · axis = -1..1 · vector = [x, y]'
              >
                {ACTION_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
              </Select>
              <ButtonWithConfirm onClick={() => apply(edits.removeAction(inputMap, mapName, a.name))}>
                ✕
              </ButtonWithConfirm>
            </div>
          ))}
          <Button size='sm' variant='ghost' onClick={() => apply(edits.addAction(inputMap, mapName))}>
            + Action
          </Button>
        </div>
      </Section>

      {/* ----- bindings ----- */}
      {action && (
        <Section title={`Bindings for ${action.name}`}>
          <div className='flex flex-col gap-1'>
            {action.bindings.map(binding => (
              <BindingRow
                key={binding.id}
                binding={binding}
                actionKind={action.kind}
                virtualControls={inputMap.virtualControls}
                conflicts={conflicts.get(binding.id) ?? []}
                capture={capture}
                onSource={source => apply(edits.setBindingSource(inputMap, mapName, action.name, binding.id, source))}
                onPart={part => apply(edits.setBindingPart(inputMap, mapName, action.name, binding.id, part))}
                onModifiers={mods => apply(edits.setBindingModifiers(inputMap, mapName, action.name, binding.id, mods))}
                onAddProcessor={kind => apply(edits.addProcessor(inputMap, mapName, action.name, binding.id, kind))}
                onRemoveProcessor={i => apply(edits.removeProcessor(inputMap, mapName, action.name, binding.id, i))}
                onUpdateProcessor={(i, p) => apply(edits.updateProcessor(inputMap, mapName, action.name, binding.id, i, p))}
                onMoveProcessor={(i, d) => apply(edits.moveProcessor(inputMap, mapName, action.name, binding.id, i, d))}
                onRemove={() => apply(edits.removeBinding(inputMap, mapName, action.name, binding.id))}
              />
            ))}
            <Button size='sm' variant='ghost'
              onClick={() => apply(edits.addBinding(inputMap, mapName, action.name))}>
              + Binding
            </Button>
          </div>

          {action.kind === 'button' && (
            <div className='mt-2 flex flex-col gap-1'>
              <Slider
                label='Press point'
                min={0.01} max={1} step={0.01}
                value={action.pressPoint ?? DEFAULT_PRESS_POINT}
                onChange={v => apply(edits.setPressPoint(inputMap, mapName, action.name, v))}
              />
              <p className={hintClass}>
                How far an analog trigger must be pulled to count as pressed. A key is always 1.
              </p>
              <Slider
                label='Hold time'
                min={0} max={3} step={0.05}
                value={action.holdSeconds ?? 0}
                onChange={v => apply(edits.setHoldSeconds(inputMap, mapName, action.name, v))}
              />
              <p className={hintClass}>
                Seconds held before the phase becomes <code>performed</code>. 0 means immediately.
              </p>
            </div>
          )}

          <div className='mt-2'>
            <p className={labelClass}>Action processors</p>
            <p className={hintClass}>Applied after the winning binding, to the composed value.</p>
            <ProcessorList
              chain={action.processors ?? []}
              onAdd={(kind: ProcessorKind) => apply(edits.addProcessor(inputMap, mapName, action.name, null, kind))}
              onRemove={i => apply(edits.removeProcessor(inputMap, mapName, action.name, null, i))}
              onUpdate={(i, p) => apply(edits.updateProcessor(inputMap, mapName, action.name, null, i, p))}
              onMove={(i, d) => apply(edits.moveProcessor(inputMap, mapName, action.name, null, i, d))}
            />
          </div>
        </Section>
      )}

      {/* ----- live values ----- */}
      <Section title='Live values' hint='Press keys, move a stick or drag on a touch screen — this updates as you do.'>
        <InputMonitor mapName={mapName} />
      </Section>

      {/* ----- on-screen controls ----- */}
      <Section title='On-screen controls'
        hint='Drawn over the game on a touch device, and bindable like any other source.'>
        <VirtualControlsEditor
          controls={inputMap.virtualControls}
          selectedId={selectedControl}
          onSelect={setSelectedControl}
          onChange={control => apply(edits.upsertVirtualControl(inputMap, control))}
          onAdd={kind => {
            const id = uniqueControlId(inputMap, kind)
            apply(edits.upsertVirtualControl(inputMap, kind === 'stick'
              ? { id, kind, x: 0.15, y: 0.76, radius: 0.11, deadzone: 0.12 }
              : { id, kind, x: 0.85, y: 0.78, radius: 0.07, label: id }))
            setSelectedControl(id)
          }}
          onRemove={id => { apply(edits.removeVirtualControl(inputMap, id)); setSelectedControl(null) }}
        />
      </Section>

      <div className='pt-1 border-t border-border'>
        <p className={sectionTitleClass}>Reset</p>
        <ButtonWithConfirm onClick={() => { setInputMap(cloneInputMap(DEFAULT_INPUT_MAP)); setSelectedAction('') }}>
          Restore default bindings
        </ButtonWithConfirm>
        <p className={hintClass}>Replaces every map with the ones this build ships.</p>
      </div>
    </Panel>
  )
}

/** A control id nothing is using yet. Ids are what bindings name, so they must not collide. */
function uniqueControlId(map: InputMap, kind: 'stick' | 'button'): string {
  const taken = new Set(map.virtualControls.map(c => c.id))
  for (let i = taken.size; ; i++) {
    const id = i === 0 ? kind : `${kind}${i + 1}`
    if (!taken.has(id)) return id
  }
}
