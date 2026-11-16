// Name paths: how a save finds a node again when its id has changed (an editor template resync re-mints the
// ids of a placed copy; a game patch may too). The rules are the editor's template overrides'
// (applications/editor/src/utils/templateOverrides.ts): child names joined by '/', '' for the root, and a
// `#k` suffix on the k-th later sibling of the same name, so two "Torch" children stay apart.

import type { Node } from '../scene/nodes/node';

function segment(name: string, k: number): string {
    return k === 0 ? name : `${name}#${k}`;
}

/** Split one path segment back into its name and namesake index. */
function parseSegment(part: string): { name: string; index: number } {
    const hash = part.lastIndexOf('#');
    if (hash > 0 && /^\d+$/.test(part.slice(hash + 1))) return { name: part.slice(0, hash), index: Number(part.slice(hash + 1)) };
    return { name: part, index: 0 };
}

/** A serialized scene tree, indexed by id and by name path, with each node's parent. */
export interface SceneJsonIndex {
    byId: Map<string, any>;
    byPath: Map<string, any>;
    pathOf: Map<any, string>;
    parentOf: Map<any, any>;
}

/** Index a serialized subtree (a scene's root node JSON, or a template's), every node, with its path. */
export function indexNodeJson(root: any): SceneJsonIndex {
    const index: SceneJsonIndex = { byId: new Map(), byPath: new Map(), pathOf: new Map(), parentOf: new Map() };
    const visit = (json: any, path: string) => {
        if (typeof json?.id === 'string') index.byId.set(json.id, json);
        index.byPath.set(path, json);
        index.pathOf.set(json, path);
        const children = Array.isArray(json?.children) ? json.children : [];
        const seen = new Map<string, number>();
        for (const child of children) {
            if (!child || typeof child !== 'object') continue;
            const name = String(child.name ?? '');
            const k = seen.get(name) ?? 0;
            seen.set(name, k + 1);
            index.parentOf.set(child, json);
            visit(child, path === '' ? segment(name, k) : `${path}/${segment(name, k)}`);
        }
    };
    if (root && typeof root === 'object') visit(root, '');
    return index;
}

/** `node`'s name path below `root` ('' for the root itself), or null when it is not inside it. */
export function livePathOf(root: Node, node: Node): string | null {
    const parts: string[] = [];
    let n: Node | null = node;
    while (n && n !== root) {
        const parent: Node | null = n.parent;
        if (!parent) return null;
        let k = 0;
        for (const sibling of parent.children) {
            if (sibling === n) break;
            if (sibling.name === n.name) k++;
        }
        parts.unshift(segment(n.name, k));
        n = parent;
    }
    return n === root ? parts.join('/') : null;
}

/** The live node at `path` below `root`, or null. */
export function liveNodeAtPath(root: Node, path: string): Node | null {
    if (path === '') return root;
    let n: Node | null = root;
    for (const part of path.split('/')) {
        if (!n) return null;
        const { name, index } = parseSegment(part);
        let k = 0;
        let found: Node | null = null;
        for (const child of n.children) {
            if (child.name !== name) continue;
            if (k === index) { found = child; break; }
            k++;
        }
        n = found;
    }
    return n;
}
