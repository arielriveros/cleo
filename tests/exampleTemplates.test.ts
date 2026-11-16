import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { instanceProblems, templatizeScene } from '../tools/exampleKit/templatize';
import { materializeVariant } from '../applications/editor/src/utils/templateVariants';

// The shipped examples place nothing more than once as loose nodes: a group the scene repeats is a template,
// and each copy an instance of it (tools/exampleKit/templatizeExamples.ts, and Duskwell's generator). Each
// instance must be exactly what the editor would rebuild from its template, or opening the scene changes it.

const EXAMPLES = join(__dirname, '..', 'applications', 'editor', 'public', 'examples');
const examples = existsSync(EXAMPLES)
    ? readdirSync(EXAMPLES).filter(n => existsSync(join(EXAMPLES, n, 'manifest.json')) && existsSync(join(EXAMPLES, n, 'scenes')))
    : [];
/**
 * Instances placed before this rule, known to differ from their template, by example and template name. The
 * Firing Line's placed fighters (FPS Bot, its variants, FPS Player) carry their own weapon meshes, ragdoll and controller actions that its template
 * predates; opening it in the editor does not rebuild it (its hashes are current), so it keeps them.
 */
const KNOWN_DIVERGENT: Record<string, string[]> = { 'firing-line': ['FPS Bot', 'FPS Vanguard', 'FPS Raider', 'FPS Swat', 'FPS Player'] };

const json = (...parts: string[]) => JSON.parse(readFileSync(join(EXAMPLES, ...parts), 'utf8'));
const allNodes = (root: any): any[] => { const out: any[] = []; const walk = (n: any) => { out.push(n); (n.children ?? []).forEach(walk); }; walk(root); return out; };

describe.each(examples)('the %s example', (name) => {
    const templates: any[] = existsSync(join(EXAMPLES, name, 'libraries', 'templates.json')) ? json(name, 'libraries', 'templates.json') : [];
    const byId = new Map(templates.map(t => [t.id, t]));
    const scenes = readdirSync(join(EXAMPLES, name, 'scenes')).map(f => json(name, 'scenes', f));

    it('repeats no group of nodes outside a template', () => {
        for (const scene of scenes) {
            const { templates: made, log } = templatizeScene(structuredClone(scene.scene), { takenNames: new Set(), idFor: k => k });
            expect(log, `${name}: groups placed more than once without a template`).toEqual([]);
            expect(made).toHaveLength(0);
        }
    });

    it('places every instance exactly as its template builds it', () => {
        for (const scene of scenes)
            for (const n of allNodes(scene.scene)) {
                const id = n.variables?.__templateId?.value;
                if (!id) continue;
                const template = byId.get(id);
                expect(template, `${n.name} names a missing template`).toBeDefined();
                if (KNOWN_DIVERGENT[name]?.includes(template.name)) continue;
                expect(instanceProblems(template, n), `${n.name}`).toEqual([]);
            }
    });

    it('stores every variant as its base plus its diff', () => {
        for (const v of templates.filter(t => t.variant)) {
            const base = byId.get(v.variant.baseTemplateId);
            expect(base, `${v.name}'s base`).toBeDefined();
            expect(JSON.stringify(materializeVariant(base, v.id, v.variant.diff).nodeJson), v.name).toBe(JSON.stringify(v.nodeJson));
        }
    });

    it('never shares a node id between two templates', () => {
        const owner = new Map<string, string>();
        for (const t of templates) for (const n of allNodes(t.nodeJson)) {
            expect(owner.get(n.id), `${n.name} in ${t.name} reuses an id of ${owner.get(n.id)}`).toBeUndefined();
            owner.set(n.id, t.name);
        }
    });
});
