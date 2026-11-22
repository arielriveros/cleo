import { useMemo, useState } from 'react'
import { FEATURES, FEATURE_GROUPS, FEATURE_PRESETS, enabledFeatures, featureById, presetMatching, type FeaturePreset } from 'cleo'
import { Button, SectionTitle, Toggle, cn } from '@cleo/app-kit/ui'
import { promptDialog } from '@cleo/app-kit/feedback/dialogStore'
import type { FeatureUsage } from '../publish/featureUsage'
import ExperimentalTag from './ExperimentalTag'
import { engineEstimate, formatBytes, type FeatureSizes } from './featureSizes'

// The checklist of the engine's optional features (the engine's src/modules/catalog.ts), with the presets that
// fill it in. Shared by Project ▸ Features and the new-project dialog. Every box stays the user's to change: a
// preset only sets them, and a list that matches none reads as Custom.

export interface FeatureChoice {
  /** The features left out. Never holds 'webgl2', which is the `webgl2` flag. */
  disabled: string[];
  /** The WebGL 2 shaders ship (Options ▸ Project ▸ WebGL 2 fallback). */
  webgl2: boolean;
}

export interface FeaturePickerProps {
  value: FeatureChoice;
  onChange: (next: FeatureChoice) => void;
  /** What the project uses (Detect from Project), for the "in use" marks; absent for a new project. */
  usage?: FeatureUsage | null;
  sizes?: FeatureSizes | null;
  /** The project's physics backend, for the size estimate. */
  physicsBackend?: string;
  /** Fewer words: the new-project dialog. */
  compact?: boolean;
}

/** Presets this machine saved (Save as preset), beside the built-in ones. */
interface SavedPreset { id: string; label: string; disabled: string[]; webgl2: boolean }
const SAVED_KEY = 'cleo_feature_presets'

function loadSaved(): SavedPreset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SAVED_KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter(p => p && typeof p.id === 'string' && typeof p.label === 'string' && Array.isArray(p.disabled)) : []
  } catch { return [] }
}
function storeSaved(list: SavedPreset[]) {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(list)) } catch { /* no storage: nothing kept */ }
}

const sameList = (a: readonly string[], b: readonly string[]) => [...new Set(a)].sort().join(',') === [...new Set(b)].sort().join(',')

/** Turn a feature on (with what it needs) or off. */
export function toggleFeature(choice: FeatureChoice, id: string, on: boolean): FeatureChoice {
  if (id === 'webgl2') return { ...choice, webgl2: on }
  const disabled = new Set(choice.disabled)
  if (on) {
    const needs = (fid: string) => { disabled.delete(fid); for (const d of featureById(fid)?.dependsOn ?? []) needs(d) }
    needs(id)
  } else disabled.add(id)
  return { ...choice, disabled: [...disabled].sort() }
}

/** A preset as a choice: its WebGL 2 flag is on unless it is a saved one that turned it off. */
export function presetChoice(preset: Pick<FeaturePreset, 'disabled'> & { webgl2?: boolean }): FeatureChoice {
  return { disabled: preset.disabled.filter(id => id !== 'webgl2'), webgl2: preset.webgl2 ?? !preset.disabled.includes('webgl2') }
}

export default function FeaturePicker({ value, onChange, usage, sizes, physicsBackend = 'jolt', compact }: FeaturePickerProps) {
  const [saved, setSaved] = useState<SavedPreset[]>(loadSaved)
  const enabled = useMemo(() => enabledFeatures(value.disabled), [value.disabled])
  const matched = presetMatching(value.disabled)
  const savedMatch = saved.find(p => sameList(p.disabled, value.disabled) && p.webgl2 === value.webgl2)
  const active = savedMatch?.id ?? (matched && value.webgl2 ? matched.id : null)

  const savePreset = async () => {
    const label = await promptDialog({
      title: 'Save as preset',
      message: 'A name for this set of features. Presets you save are kept on this computer.',
      placeholder: 'Preset name',
      validate: v => (v.trim() ? null : 'Give it a name'),
    })
    if (!label) return
    const next = [...saved.filter(p => p.label !== label.trim()), { id: `saved:${Date.now()}`, label: label.trim(), disabled: value.disabled, webgl2: value.webgl2 }]
    setSaved(next)
    storeSaved(next)
  }
  const forget = (id: string) => {
    const next = saved.filter(p => p.id !== id)
    setSaved(next)
    storeSaved(next)
  }

  const estimate = sizes ? engineEstimate(sizes, enabled, value.webgl2, physicsBackend) : null

  return (
    <div className='flex flex-col gap-3 min-w-0'>
      <div className='flex flex-col gap-1.5'>
        <SectionTitle title='Presets' doc='editor/project-features#presets' />
        <div className={cn('grid gap-1.5', compact ? 'grid-cols-3' : 'grid-cols-6')}>
          {FEATURE_PRESETS.map(p => (
            <button key={p.id} type='button' title={p.description}
              onClick={() => onChange(presetChoice(p))}
              className={cn('text-left rounded border px-2 py-1.5 min-w-0',
                active === p.id ? 'border-primary bg-selected text-fg' : 'border-control bg-surface hover:bg-surface-sunken text-fg')}>
              <div className='text-ui font-semibold truncate'>{p.label}</div>
              {!compact && <div className='text-ui-xs text-muted line-clamp-2'>{p.description}</div>}
            </button>
          ))}
        </div>
        {(saved.length > 0 || !compact) && (
          <div className='flex flex-wrap items-center gap-1.5'>
            {saved.map(p => (
              <span key={p.id} className={cn('inline-flex items-center rounded border text-ui-sm',
                active === p.id ? 'border-primary bg-selected' : 'border-control bg-surface')}>
                <button type='button' className='px-2 py-0.5' onClick={() => onChange({ disabled: [...p.disabled], webgl2: p.webgl2 })}>{p.label}</button>
                <button type='button' className='px-1.5 py-0.5 text-muted hover:text-fg border-l border-control' title={`Forget the preset "${p.label}"`} aria-label={`Forget ${p.label}`}
                  onClick={() => forget(p.id)}>
                  <svg width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.5' strokeLinecap='round'><path d='M6 6l12 12M18 6L6 18' /></svg>
                </button>
              </span>
            ))}
            <span className='text-ui-sm text-muted'>{active ? '' : 'Custom'}</span>
            <Button size='sm' variant='ghost' onClick={() => void savePreset()} title='Keep this set of features as a preset on this computer'>
              Save as preset
            </Button>
          </div>
        )}
      </div>

      <div className={cn('grid gap-x-6 gap-y-3', compact ? 'grid-cols-1' : 'grid-cols-2')}>
        {FEATURE_GROUPS.map(group => {
          const features = FEATURES.filter(f => f.group === group.id)
          if (!features.length) return null
          return (
            <div key={group.id} className='flex flex-col gap-1 min-w-0'>
              <SectionTitle title={group.label} doc={false} />
              {features.map(f => {
                const on = f.id === 'webgl2' ? value.webgl2 : enabled.has(f.id)
                const blockedBy = f.dependsOn?.find(d => !enabled.has(d))
                const uses = usage?.get(f.id) ?? []
                const saves = sizes?.byFeature[f.id]
                const bytes = saves ? (value.webgl2 || f.id === 'webgl2' ? saves.all : saves.webgpuOnly) : 0
                return (
                  <div key={f.id} className='flex items-start gap-2 min-w-0'>
                    <Toggle checked={on} onChange={next => onChange(toggleFeature(value, f.id, next))}
                      doc={`editor/project-features::${f.label}`}
                      title={blockedBy ? `Needs ${featureById(blockedBy)?.label}` : f.description} />
                    <div className='flex-1 min-w-0'>
                      <div className='flex items-baseline gap-2 min-w-0'>
                        <span className={cn('text-ui truncate', on ? 'text-fg' : 'text-muted')}>{f.label}</span>
                        {f.experimental && <ExperimentalTag feature={f} variant={compact ? 'icon' : 'pill'} />}
                        {uses.length > 0 && (
                          <span className={cn('text-ui-xs rounded px-1 shrink-0', on ? 'bg-surface-sunken text-muted' : 'bg-warning/20 text-warning')}
                            title={uses.slice(0, 12).map(u => `${u.where}: ${u.what}`).join('\n') + (uses.length > 12 ? `\n… and ${uses.length - 12} more` : '')}>
                            {on ? `in use (${uses.length})` : `in use (${uses.length}), not shipped`}
                          </span>
                        )}
                        {bytes > 0 && <span className='ml-auto text-ui-xs text-dim shrink-0' title='What leaving it out saves'>{formatBytes(bytes)}</span>}
                      </div>
                      {!compact && <div className='text-ui-xs text-muted'>{blockedBy ? `Off: it needs ${featureById(blockedBy)?.label}.` : f.description}</div>}
                    </div>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>

      {estimate !== null && (
        <div className='text-ui-sm text-muted'>
          Engine download about <span className='text-fg font-semibold'>{formatBytes(estimate)}</span>, before the
          game's own scenes, meshes and textures.
        </div>
      )}
    </div>
  )
}
