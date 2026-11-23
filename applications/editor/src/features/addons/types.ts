import type { ComponentType } from 'react'

// The editor's addon contract. An addon is an editor extension a project turns on in Project ▸ Addons (stored
// in its Project Settings, so it travels with the project, as Godot's editor plugins do). It is loaded only
// while on: its module, and everything that module imports, stays out of the editor until then.
//
// Built-in addons only for now (registry.ts): the contract is what an addon from elsewhere would implement.

/** Where an addon's components go in the editor. */
export type AddonSlotName =
  /** Beside the dock, full height: a side panel (the Claude panel). */
  | 'editorAside'
  /** The top bar's right end, beside the mode selector: a toggle for the addon's panel. */
  | 'topbarRight'
  /** The top bar's status chips. */
  | 'topbarChips'
  /** Mounted once, rendering nothing: a background service with access to the editor's contexts. */
  | 'background'

/** What an activated addon puts into the editor. */
export interface AddonContributions {
  slots?: Partial<Record<AddonSlotName, ComponentType>>
}

/** What an addon is handed when it is turned on. */
export interface AddonContext {
  /** The open project. */
  readonly projectId: string | null
  /** The addon's own settings in the project (Project Settings ▸ addons.settings[id]). */
  readonly settings: unknown
  saveSettings(next: unknown): void
}

/**
 * Why an addon is stopped:
 * - `off`: turned off in Project ▸ Addons (or an addon it requires was);
 * - `unload`: the project is closing (another one opening in this window), or the editor's own code was
 *   reloaded under it (a dev-server hot update). It is activated again when the next project has it on.
 */
export type AddonStopReason = 'off' | 'unload'

/** An addon's module: what turning it on and off does. */
export interface AddonModule {
  activate(context: AddonContext): AddonContributions | Promise<AddonContributions>
  /**
   * Stopping it: end what it started (a session, a connection). On `unload`, something that outlives the page
   * (Claude Code in the agent host) may keep running for the next project. Its slots are unmounted after
   * this returns.
   */
  deactivate?(reason: AddonStopReason): void | Promise<void>
}

/** An addon as the editor lists it, before it is loaded. */
export interface AddonManifest {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly version: string
  readonly author: string
  /** Its docs page (docs/<page>.md). */
  readonly docPage: string
  /** On in a new project unless the new-project dialog says otherwise. */
  readonly defaultOn: boolean
  /** Experimental: it works, but its behaviour may still change between versions. Only a label in Project ▸ Addons. */
  readonly experimental?: boolean
  /** Asked before turning it off while it runs, when that ends something the user would notice. */
  readonly confirmDisable?: string
  /**
   * The addons it runs on (their ids). It is off while any of them is off, and turning one of them off turns it
   * off too (dependencies.ts).
   */
  readonly requires?: readonly string[]
  load(): Promise<AddonModule>
}
