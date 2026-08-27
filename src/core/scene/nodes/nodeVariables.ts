import type { Node } from "./node";
import { Logger } from "../../logger";

/**
 * Node variables and the access rules that govern them across the scripting boundary.
 *
 * Reaches the node through its public surface only, which keeps `Node` a type-only import here and this
 * module a near-leaf.
 */


export type NodeVariableType = 'number' | 'string' | 'boolean' | 'vec3';
/**
 * Cross-node access level for a variable (enforced at the scripting boundary — getData/setData):
 * - 'public'    : any node may get/set it (default).
 * - 'private'   : only the owning node may get/set it.
 * - 'protected' : the owning node and any of its descendants (subtree) may get/set it.
 */
export type NodeVariableAccess = 'public' | 'private' | 'protected';
export interface NodeVariable {
    type: NodeVariableType;
    value: any;
    access?: NodeVariableAccess; // missing = 'public' (back-compat with old saves)
}

/**
 * True if `requester` is allowed to get/set the variable `name` on `target`, per the variable's
 * access level. Non-existent variables are always accessible (creating one is allowed).
 */
export function canAccessVariable(target: Node, requester: Node, name: string): boolean {
    const v = target?.variables?.get(name);
    if (!v) return true;
    const access = v.access ?? 'public';
    if (access === 'public') return true;
    if (requester === target) return true;                 // owner always
    if (access === 'protected') return requester.isDescendantOf(target);
    return false;                                          // private, non-owner
}

/**
 * Returns a plain snapshot of a node's custom variables (name -> value). Read-only: assigning to the
 * returned object does NOT change the node — use `setData(node, name, value)` to write.
 *
 * With `requester` (the node running a script), variables it may not read are omitted; without one,
 * every variable is returned.
 */
export function getData(node: Node, requester?: Node): Record<string, any> {
    const out: Record<string, any> = {};
    if (node && node.variables) {
        for (const [name, v] of node.variables) {
            if (!requester || requester === node || canAccessVariable(node, requester, name))
                out[name] = v.value;
        }
    }
    return out;
}

/**
 * Sets a custom variable on a node (including a different node than the one running the script).
 * Pass a single value, or multiple components for a vec3 (`setData(node, 'pos', x, y, z)`).
 */
export function setData(node: Node, name: string, ...params: any[]): void {
    if (!node || typeof node.setVariable !== 'function') return;
    const value = params.length <= 1 ? params[0] : params;
    node.setVariable(name, value);
}

/**
 * Build the getData/setData a user script sees, bound to the running node as the "requester" so
 * cross-node access respects each variable's public/private/protected level. Reads are filtered;
 * blocked writes warn and no-op. Access to the script's OWN node is always allowed.
 */
export function bindDataAccessors(requester: Node): {
    getData: (target: Node) => Record<string, any>;
    setData: (target: Node, name: string, ...params: any[]) => void;
} {
    return {
        getData: (target: Node) => getData(target, requester),
        setData: (target: Node, name: string, ...params: any[]) => {
            if (target && target !== requester && !canAccessVariable(target, requester, name)) {
                Logger.warn(`Script on '${requester.name}' cannot set '${name}' on '${target.name}' (${target.variables.get(name)?.access ?? 'public'})`, 'Script');
                return;
            }
            setData(target, name, ...params);
        },
    };
}
