import { createContext, useContext, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { Logger } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { activeProjectId } from '../../utils/projectScope'
import { addonById } from './registry'
import { activeAddons } from './dependencies'
import type { AddonContributions, AddonModule, AddonSlotName } from './types'

// Runs the project's addons (Project ▸ Addons): loads each one it turns on, activates it, and lays its
// components out in the editor's slots (AddonSlot). One turned off in a running session is deactivated and its
// components unmounted. Waits for the project's stored settings: activating on the defaults first would start
// an addon the project has off.

type Mounted = { id: string; Component: ComponentType }
const SlotsContext = createContext<Partial<Record<AddonSlotName, Mounted[]>>>({})

export function AddonHost({ children }: { children: ReactNode }) {
  const { projectSettings, projectSettingsReady, setProjectSettings } = useCleoEngine()
  const enabled = projectSettings.addons.enabled
  const [active, setActive] = useState<Record<string, AddonContributions>>({})
  const modules = useRef(new Map<string, AddonModule>())
  const loading = useRef(new Set<string>())
  const settingsRef = useRef(projectSettings.addons.settings)
  settingsRef.current = projectSettings.addons.settings
  // What should be on at this moment: a load that finishes after its addon was turned off again stays off.
  const wanted = useRef(new Set<string>())

  useEffect(() => {
    if (!projectSettingsReady) return
    // Only the addons that can run: one whose requirement is off stays off with it (dependencies.ts).
    const want = new Set(activeAddons(enabled).map(a => a.id))
    wanted.current = want
    for (const id of want) {
      if (modules.current.has(id) || loading.current.has(id)) continue
      const manifest = addonById(id)!
      loading.current.add(id)
      manifest.load()
        .then(async mod => {
          if (!wanted.current.has(id)) return
          const contributions = await mod.activate({
            projectId: activeProjectId(),
            get settings() { return settingsRef.current[id] },
            saveSettings: next => setProjectSettings(prev => ({ ...prev, addons: { ...prev.addons, settings: { ...prev.addons.settings, [id]: next } } })),
          })
          modules.current.set(id, mod)
          setActive(prev => ({ ...prev, [id]: contributions ?? {} }))
        })
        .catch(e => Logger.error(`The ${manifest.name} addon could not start: ${e?.message ?? e}`, 'Addons'))
        .finally(() => loading.current.delete(id))
    }
    for (const [id, mod] of [...modules.current]) {
      if (want.has(id)) continue
      modules.current.delete(id)
      Promise.resolve(mod.deactivate?.()).catch(e => Logger.warn(`The ${id} addon did not stop cleanly: ${e?.message ?? e}`, 'Addons'))
      setActive(prev => { const { [id]: _gone, ...rest } = prev; return rest })
    }
  }, [enabled, projectSettingsReady, setProjectSettings])

  const slots = useMemo(() => {
    const out: Partial<Record<AddonSlotName, Mounted[]>> = {}
    for (const [id, c] of Object.entries(active))
      for (const [slot, Component] of Object.entries(c.slots ?? {}) as [AddonSlotName, ComponentType][])
        (out[slot] ??= []).push({ id, Component })
    return out
  }, [active])

  return <SlotsContext.Provider value={slots}>{children}</SlotsContext.Provider>
}

/** Where the active addons' components for `name` go. */
export function AddonSlot({ name }: { name: AddonSlotName }) {
  const mounted = useContext(SlotsContext)[name] ?? []
  return <>{mounted.map(({ id, Component }) => <Component key={id} />)}</>
}
