import type { Node } from "../scene/nodes/node";

/**
 * Typed NAME fields for scripts. Each is a plain string at runtime -- a clip, cue, socket, template or
 * child-node name stored exactly as a `string` field would be, so serialization, template overrides,
 * variants and publishing never see a difference. The type only tells the editor's reflection what the
 * string NAMES, and the inspector then offers the valid names for that node instead of a text box:
 *
 *   public clip: ClipName = 'Souls_Sword_L1'      // the clips of the character this node belongs to
 *   public sound: SoundName = 'Enemy Swing'       // the cues in the owner's `Sounds` group
 *   public castSocket: SocketName = 'LeftHand'    // the sockets on the owner's skeleton
 *   public projectile: TemplateName = 'Magic Bolt'
 *   public next: NodeName = ''                    // a node inside or beside this one
 *   public roll: TriggerName = 'Roll'             // a trigger on the character's animator
 *   public moves: ClipName[] = []                 // a list of any of the above works too
 *
 * The optional brand keeps a string literal assignable while still being a distinct name for the
 * reflector and for hover docs. A field can also stay `string` and carry a `@pick clip` doc tag.
 */
export type ClipName = string & { readonly __pick?: "clip" };
/** A SoundNode's name in the `Sounds` group of this node or its nearest owner (see {@link SOUNDS_GROUP}). */
export type SoundName = string & { readonly __pick?: "sound" };
/** A skeleton socket name on the character this node belongs to (e.g. 'RightHand'). */
export type SocketName = string & { readonly __pick?: "socket" };
/** The name of a template in the project, as `scene.instantiate(name)` takes it. */
export type TemplateName = string & { readonly __pick?: "template" };
/** The name of a node inside or beside this one (a child, or a sibling such as the next move in a combo). */
export type NodeName = string & { readonly __pick?: "node" };
/**
 * The trigger names a project's animators declare, one key each. Empty here, so a trigger is any string;
 * the editor augments it for a project's scripts (a generated `.cleo/types/project.d.ts`), which turns
 * {@link TriggerName} into exactly those names: a misspelt trigger is a type error, and the names complete.
 */
export interface ProjectTriggers {}

/**
 * A `trigger` parameter of the animator of the character this node belongs to — what a script passes to
 * `animator.setTrigger` to enter a state, such as an Actions-layer roll. In a project's scripts, one of the
 * triggers its animators declare (see {@link ProjectTriggers}), or `''` for none.
 */
export type TriggerName = [keyof ProjectTriggers] extends [never]
    ? string & { readonly __pick?: "trigger" }
    // A plain union of the names (no brand): the editors complete string literals of a union, not of an
    // intersection with one.
    : Extract<keyof ProjectTriggers, string> | '';

/**
 * Name of the group, directly under an owner (a character, a prop, a weapon), that holds its SoundNodes.
 * A {@link SoundName} field picks from the nearest such group at or above the node.
 */
export const SOUNDS_GROUP = "Sounds";

/** The `Sounds` group of `from` or of its nearest ancestor that has one, or null. */
export function ownedSoundsGroup(from: Node | null | undefined): Node | null {
    for (let n = from ?? null; n; n = n.parent) {
        const group = n.getChildByName(SOUNDS_GROUP)[0];
        if (group) return group;
    }
    return null;
}
