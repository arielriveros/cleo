import { Logger } from "../../logger";
import type { Node } from "./node";

/**
 * The slot holding the node type dispatch, so the base class can rebuild a node's children without
 * importing a single subclass.
 *
 * Must stay a leaf — `Node` is imported as a type only. A module inside the node cycle can be caught
 * half-initialized, and assigning to the slot while it is in its temporal dead zone throws.
 */
export type ChildParser = (parent: Node, json: any) => void;

let childParser: ChildParser = (_parent, json) => {
    Logger.error(`Cannot parse child '${json?.name ?? '?'}' (${json?.type}): the node parsers were never `
        + `registered. Import parseNodeJson from core/scene/nodes/parseNodeJson.`, 'Scene');
};

/** Wire the type dispatch. Called once, on import, by the module that owns it. */
export function setChildParser(parse: ChildParser): void { childParser = parse; }

/** Rebuild one serialized child under `parent`. Used by `Node.finishParse`. */
export function parseChild(parent: Node, json: any): void { childParser(parent, json); }
