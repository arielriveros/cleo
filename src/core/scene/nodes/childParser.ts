import { Logger } from "../../logger";
import type { Node } from "./node";

/**
 * The slot holding the node type dispatch, so the base class can rebuild a node's children without
 * importing a single subclass.
 *
 * This lives in its own module for one specific reason, learned the hard way: it must be evaluated before
 * either of its two users, and it can only guarantee that by importing nothing but a leaf. Declared inside
 * node.ts, the binding sat in its temporal dead zone whenever the pre-existing node <-> animator cycle
 * caused `parseNodeJson.ts` to evaluate first — and assigning to a `let` in TDZ throws, taking down scene
 * parsing entirely. A leaf module cannot be caught half-initialized, so the slot is always writable.
 *
 * `Node` is imported as a type only, which is what keeps this module a leaf.
 */
export type ChildParser = (parent: Node, json: any) => void;

let childParser: ChildParser = (_parent, json) => {
    // Reached only if a scene is parsed without the dispatcher ever having been imported. Staying silent
    // would mean every child quietly deserializing as a bare Node — a model coming back as an empty
    // transform, with nothing in the log to say why.
    Logger.error(`Cannot parse child '${json?.name ?? '?'}' (${json?.type}): the node parsers were never `
        + `registered. Import parseNodeJson from core/scene/nodes/parseNodeJson.`, 'Scene');
};

/** Wire the type dispatch. Called once, on import, by the module that owns it. */
export function setChildParser(parse: ChildParser): void { childParser = parse; }

/** Rebuild one serialized child under `parent`. Used by `Node.finishParse`. */
export function parseChild(parent: Node, json: any): void { childParser(parent, json); }
