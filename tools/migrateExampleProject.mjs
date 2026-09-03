// One-off migration of the shipped 3D example onto the control layer.
//
// The example's scripts live as STRINGS inside three generated files — `libraries/scripts.json` (the
// script asset library), `libraries/templates.json` (16 MB) and the scene blob (20 MB) — with no
// generator to regenerate them. Nothing typechecks them and nothing imports them, so the only symptom of
// a stale copy is that the sample project stops responding once the API it named is gone.
//
// Two rules this script follows, and both matter:
//
//   * RAW TEXT SUBSTITUTION, never a JSON round trip. These files are tens of megabytes of floats, and
//     re-serializing them would rewrite every one of those in whatever form this runtime prefers — a
//     diff nobody could review, over data this change has no business touching. Source strings are
//     located by parsing, then replaced by their JSON-escaped form in the original text.
//   * IDEMPOTENT. Re-running it on an already-migrated project is a no-op, so a half-finished run can
//     simply be run again.
//
// Usage:  node tools/migrateExampleProject.mjs [--check]
//         --check reports what WOULD change and writes nothing.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE = join(ROOT, 'editor', 'public', 'examples', '3d-example');

const SCRIPTS_JSON = join(EXAMPLE, 'libraries', 'scripts.json');
const TEMPLATES_JSON = join(EXAMPLE, 'libraries', 'templates.json');
const SCENES_DIR = join(EXAMPLE, 'scenes');

const check = process.argv.includes('--check');

/** The migrated sources, read from the files that ARE the source of truth. */
const PLAYABLE_SOURCE = readFileSync(join(ROOT, 'examples', 'scripts', 'ThirdPersonPlayable.ts'), 'utf-8');
const PIVOT_SOURCE = readFileSync(join(ROOT, 'examples', 'scripts', 'ThirdPersonCameraPivot.ts'), 'utf-8');

/** Recognizes which script an embedded source is, by something only that script contains. */
function identify(source) {
    if (source.includes('ThirdPersonPlayableNode')) return 'playable';
    if (source.includes('ThirdPersonCameraPivotNode')) return 'pivot';
    return null;
}

function replacementFor(kind, existing) {
    const source = kind === 'playable' ? PLAYABLE_SOURCE : PIVOT_SOURCE;
    // Match the line endings the file already uses, so the diff is the migration and nothing else.
    return existing.includes('\r\n') ? source.replace(/\n/g, '\r\n') : source;
}

/** Every embedded script source in a parsed blob, deduplicated. */
function collectSources(value, out = new Set()) {
    if (typeof value === 'string') {
        if (identify(value)) out.add(value);
    } else if (Array.isArray(value)) {
        for (const entry of value) collectSources(entry, out);
    } else if (value && typeof value === 'object') {
        for (const entry of Object.values(value)) collectSources(entry, out);
    }
    return out;
}

/**
 * Node ids whose `type` must become `character`: whatever carries the playable script.
 *
 * TWO shapes, because the two file kinds store the attachment differently. A scene node carries its
 * source inline as `node.script`; a TEMPLATE carries a `scripts` map keyed by node id alongside the
 * subtree. Missing the second one leaves the template's root a plain Node with a CharacterNode script,
 * which then refuses to attach — and the only symptom is that instantiating the template produces
 * something that does not move.
 */
function collectPlayableIds(value, out = new Set()) {
    if (Array.isArray(value)) {
        for (const entry of value) collectPlayableIds(entry, out);
    } else if (value && typeof value === 'object') {
        if (typeof value.id === 'string' && typeof value.script === 'string'
            && identify(value.script) === 'playable') out.add(value.id);
        if (value.scripts && typeof value.scripts === 'object' && !Array.isArray(value.scripts)) {
            for (const [nodeId, source] of Object.entries(value.scripts))
                if (typeof source === 'string' && identify(source) === 'playable') out.add(nodeId);
        }
        for (const entry of Object.values(value)) collectPlayableIds(entry, out);
    }
    return out;
}

const report = [];

function migrateFile(path) {
    let raw;
    try { raw = readFileSync(path, 'utf-8'); }
    catch { report.push(`skip   ${path} (missing)`); return; }

    const before = raw;
    const parsed = JSON.parse(raw);

    // 1. Script sources.
    for (const source of collectSources(parsed)) {
        const kind = identify(source);
        const next = replacementFor(kind, source);
        if (next === source) continue;
        const escapedOld = JSON.stringify(source).slice(1, -1);
        const escapedNew = JSON.stringify(next).slice(1, -1);
        if (!raw.includes(escapedOld)) {
            throw new Error(`${path}: the ${kind} source could not be located verbatim in the file text`);
        }
        raw = raw.split(escapedOld).join(escapedNew);
    }

    // 2. The script asset's baseType, so the editor attaches it as a Character.
    //    Only the entry whose own source is the playable one — a blind replace would catch the pivot's.
    if (Array.isArray(parsed)) {
        for (const asset of parsed) {
            if (!asset || typeof asset !== 'object') continue;
            if (identify(asset.source ?? '') !== 'playable') continue;
            if (asset.baseType === 'character') continue;
            const oldPair = `"id":${JSON.stringify(asset.id)}`;
            const idx = raw.indexOf(oldPair);
            if (idx < 0) throw new Error(`${path}: could not locate script asset ${asset.id}`);
            // Rewrite only THIS asset's baseType, found after its id.
            const baseTypeAt = raw.indexOf('"baseType":', idx);
            const end = raw.indexOf(',', baseTypeAt);
            if (baseTypeAt < 0 || end < 0) throw new Error(`${path}: malformed asset ${asset.id}`);
            raw = raw.slice(0, baseTypeAt) + '"baseType":"character"' + raw.slice(end);
        }
    }

    // 3. The script asset's declared variables. The old script had thirteen fields — nine of which are
    //    now real tuning on the Character itself and would show TWICE in the inspector, plus four that no
    //    longer exist at all. `parseScriptVariables` derives these from the source, so this is what it
    //    would produce for the migrated one.
    if (Array.isArray(parsed)) {
        for (const asset of parsed) {
            if (!asset || typeof asset !== 'object') continue;
            if (identify(asset.source ?? '') !== 'playable') continue;
            const wanted = [{ name: 'health', type: 'number', access: 'public', default: 100, hidden: false }];
            if (JSON.stringify(asset.variables) === JSON.stringify(wanted)) continue;
            const at = raw.indexOf('"variables":', raw.indexOf(`"id":${JSON.stringify(asset.id)}`));
            if (at < 0) throw new Error(`${path}: could not locate variables for ${asset.id}`);
            // The array runs to its matching bracket; nothing inside it nests one.
            const open = raw.indexOf('[', at);
            const close = raw.indexOf(']', open);
            if (open < 0 || close < 0) throw new Error(`${path}: malformed variables for ${asset.id}`);
            raw = raw.slice(0, open) + JSON.stringify(wanted) + raw.slice(close + 1);
        }
    }

    // 4. The node type, for every node carrying the playable script.
    for (const id of collectPlayableIds(parsed)) {
        const marker = `"id":${JSON.stringify(id)},"name":`;
        let from = 0;
        for (;;) {
            const at = raw.indexOf(marker, from);
            if (at < 0) break;
            from = at + marker.length;
            const typeAt = raw.indexOf('"type":', at);
            if (typeAt < 0 || typeAt > at + 400) continue;      // not this node's own type field
            const valueStart = typeAt + '"type":'.length;
            const valueEnd = raw.indexOf(',', valueStart);
            const current = raw.slice(valueStart, valueEnd);
            if (current === '"node"') {
                raw = raw.slice(0, valueStart) + '"character"' + raw.slice(valueEnd);
            }
        }
    }

    // 5. A Controller for the scene's playable, if it has none. The example is the first thing anyone
    //    opens, so it has to demonstrate the pair rather than leaving a Character nothing drives.
    if (path.includes('scenes') && parsed?.scene && !JSON.stringify(parsed.scene).includes('"controller"')) {
        const pawnId = [...collectPlayableIds(parsed)][0];
        if (pawnId) {
            const controller = {
                id: 'c0f7a1d24b3e4f5a8c9d0e1f2a3b4c5d',
                name: 'Player Controller',
                type: 'controller',
                position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
                children: [], variables: {}, spawnOnStart: true,
                possessedId: pawnId,
                aimSourceId: null,
                controlSource: 'player',
                moveAction: 'Move', lookAction: 'Look', jumpAction: 'Jump',
                sprintAction: 'Sprint', crouchAction: '',
                aimSource: 'possessed',
                driveAimTarget: true,
            };
            // Inserted at the head of the ROOT's children array, by text, so nothing else is reformatted.
            const marker = '"children":[';
            const at = raw.indexOf(marker, raw.indexOf('"scene":'));
            if (at < 0) throw new Error(`${path}: could not locate the scene root's children`);
            const insertAt = at + marker.length;
            raw = raw.slice(0, insertAt) + JSON.stringify(controller) + ',' + raw.slice(insertAt);
        }
    }

    if (raw === before) { report.push(`ok     ${path} (already migrated)`); return; }
    // Proof we did not corrupt it. Cheap next to the cost of shipping a broken 20 MB fixture.
    JSON.parse(raw);
    report.push(`${check ? 'would ' : 'wrote '} ${path} (${before.length} -> ${raw.length} bytes)`);
    if (!check) writeFileSync(path, raw, 'utf-8');
}

migrateFile(SCRIPTS_JSON);
migrateFile(TEMPLATES_JSON);
for (const name of (await import('node:fs')).readdirSync(SCENES_DIR)) {
    if (name.endsWith('.json')) migrateFile(join(SCENES_DIR, name));
}

for (const line of report) console.log(line);
