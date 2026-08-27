// The runtime template table: baked node-subtree JSON a script materializes with `scene.instantiate`.
// Each entry is self-contained, in the shape Scene.parse feeds to a node's `parse`. Global, not
// per-Scene: one table is registered at boot and shared by every scene, so loading a scene must not clear it.

import { Logger } from '../logger';

/** A template as the runtime sees it: an id, a name to look it up by, and its baked subtree JSON. */
export interface NodeTemplate {
    id: string;
    name: string;
    node: any;
}

const byId = new Map<string, NodeTemplate>();
const byName = new Map<string, NodeTemplate>();

/** Replace the template table. Called once at boot by the player / the editor's play bootstrap. */
export function registerTemplates(templates: NodeTemplate[] | undefined | null): void {
    clearTemplates();
    for (const template of templates ?? []) {
        if (!template?.node) continue;
        byId.set(template.id, template);
        // Names are not unique across the library; the first one registered wins.
        if (byName.has(template.name))
            Logger.warn(`Two templates are named '${template.name}'; scene.instantiate('${template.name}') will always use the first.`, 'Scene');
        else
            byName.set(template.name, template);
    }
}

export function clearTemplates(): void {
    byId.clear();
    byName.clear();
}

/** Look a template up by name or by id (name first — that is what a script writes). */
export function getTemplate(nameOrId: string): NodeTemplate | undefined {
    return byName.get(nameOrId) ?? byId.get(nameOrId);
}

/** Every registered template's name, in registration order. For diagnostics and editor tooling. */
export function templateNames(): string[] {
    return [...byName.keys()];
}
