// The runtime template table: serialized node subtrees a script can materialize with `scene.instantiate`.
//
// Templates are an EDITOR asset — a subtree plus its scripts, colliders and material links, all held in
// separate editor-side maps. What lands here is the baked form: one self-contained JSON blob per template
// with everything already inlined, exactly the shape Scene.parse feeds to a node's `parse`. Baking happens
// once, at play/publish time (editor/src/features/publish/buildGameData.ts), so this module never has to
// know anything about the editor's asset model.
//
// Deliberately global rather than per-Scene: a published game packs ONE template table shared by all its
// scenes (geometry interning dedupes across them), and it is registered once at boot, before any scene is
// parsed. Loading a new scene must not lose it.

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
        // Names are not guaranteed unique across the library; first one registered wins, and the collision is
        // reported rather than silently deciding which "Bullet" a script meant.
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
