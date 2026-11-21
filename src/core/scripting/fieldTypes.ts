import type { Node } from "../scene/nodes/node";
import type { vec2, vec3, vec4 } from "gl-matrix";
import { propertyToken, type PropertyToken } from "../properties/types";

// The native attribute types: a script field's TYPE decides its editor, and what it holds while the game runs
// (docs/scripting/attribute-types.md). Each name below is both a type, for a script's field, and a runtime
// token of the same name, for an engine node's property declarations (src/core/properties/declare.ts):
//
//   @attribute tint: Color = [1, 0.8, 0.6]          // a colour picker; a vec3 at runtime
//   @attribute offset: Vec3 = [0, 1, 0]             // X, Y, Z
//   @attribute skin: Material = null                // a material picker; the Material itself at runtime
//   @attribute icon: Texture = null                 // a texture picker; the Texture
//   @attribute door: LightNode = null               // a node in the scene, filled in before onStart
//   @attribute clip: ClipName = 'Attack'            // a name list: the clips of this node's character
//
// The engine classes that are types of their own (Material, Texture, Sound, Tileset, every Node class) need
// nothing here: the reflection knows them by name, and they register as tokens where they live.

/* -------------------------------------------------------------------------- */
/* Vectors and colours                                                         */
/* -------------------------------------------------------------------------- */

/** Two numbers, edited as X and Y: any gl-matrix `vec2` or `[x, y]`. */
export type Vec2 = vec2;
/** Three numbers, edited as X, Y and Z: any gl-matrix `vec3` or `[x, y, z]`. */
export type Vec3 = vec3;
/** Four numbers, edited as X, Y, Z and W: any gl-matrix `vec4` or `[x, y, z, w]`. */
export type Vec4 = vec4;
/**
 * A linear RGB colour, `[r, g, b]` with components 0..1 (more for a glow): a vec3, picked with a colour
 * picker. Engine colours (a light's, a fog's albedo) are the same three numbers.
 */
export type Color = vec3 & { readonly __type?: "color" };
/** A linear RGBA colour, `[r, g, b, a]`: a vec4, picked with a colour picker and an alpha slider. */
export type ColorAlpha = vec4 & { readonly __type?: "colorAlpha" };

/** Two numbers (the declaration token for {@link Vec2}). */
export const Vec2: PropertyToken = propertyToken({ kind: 'vector', size: 2 });
/** Three numbers (the declaration token for {@link Vec3}). */
export const Vec3: PropertyToken = propertyToken({ kind: 'vector', size: 3 });
/** Four numbers (the declaration token for {@link Vec4}). */
export const Vec4: PropertyToken = propertyToken({ kind: 'vector', size: 4 });
/** A linear RGB colour (the declaration token for {@link Color}). */
export const Color: PropertyToken = propertyToken({ kind: 'color' });
/** A linear RGBA colour (the declaration token for {@link ColorAlpha}). */
export const ColorAlpha: PropertyToken = propertyToken({ kind: 'color', alpha: true });

/* -------------------------------------------------------------------------- */
/* Names                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Typed NAME fields. Each is a plain string at runtime -- a clip, cue, socket, template or node name stored
 * exactly as a `string` field would be, so serialization, template overrides, variants and publishing never
 * see a difference. The type tells the editor what the string NAMES, and the inspector then offers the valid
 * names for that node instead of a text box:
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
 * reflector and for hover docs.
 */
export type ClipName = string & { readonly __pick?: "clip" };
/** A SoundNode's name in the `Sounds` group of this node or its nearest owner (see {@link SOUNDS_GROUP}). */
export type SoundName = string & { readonly __pick?: "sound" };
/** A skeleton socket name on the character this node belongs to (e.g. 'RightHand'). */
export type SocketName = string & { readonly __pick?: "socket" };
/** The name of a template in the project, as `scene.instantiate(name)` takes it. */
export type TemplateName = string & { readonly __pick?: "template" };
/** A clip (or state) of the sprite animation set of the sprite this node is or belongs to (AnimatedSpriteNode.play). */
export type SpriteClipName = string & { readonly __pick?: "spriteClip" };
/** The name of a node inside or beside this one (a child, or a sibling such as the next move in a combo). */
export type NodeName = string & { readonly __pick?: "node" };
/** The name of a scene in the project, as `Game.loadScene(name)` takes it. */
export type SceneName = string & { readonly __pick?: "scene" };
/** A collision layer's name, as the project's Collision Layers list them ('Character', 'Stair Ramp', …). */
export type LayerName = string & { readonly __pick?: "layer" };
/** A parameter of the animator of the character this node belongs to, as `animParam` and `SetParam` take it. */
export type ParamName = string & { readonly __pick?: "param" };
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
 * The input actions a project's input map declares, one key each: bare (`Jump`) and qualified by their map
 * (`Gameplay/Jump`). Empty here, so an action is any string; the editor augments it for a project's scripts
 * (the generated `.cleo/types/project.d.ts`), which turns {@link ActionName} into exactly those names.
 */
export interface ProjectActions {}

/** An input action's name, as `@onAction` and `Input` take it. In a project's scripts, one its input map declares. */
export type ActionName = [keyof ProjectActions] extends [never] ? string : Extract<keyof ProjectActions, string>;

/** A clip name (the declaration token for {@link ClipName}). */
export const ClipName: PropertyToken = propertyToken({ kind: 'name', name: 'clip' });
/** A cue name in the owner's `Sounds` group (the declaration token for {@link SoundName}). */
export const SoundName: PropertyToken = propertyToken({ kind: 'name', name: 'sound' });
/** A skeleton socket name (the declaration token for {@link SocketName}). */
export const SocketName: PropertyToken = propertyToken({ kind: 'name', name: 'socket' });
/** A template name (the declaration token for {@link TemplateName}). */
export const TemplateName: PropertyToken = propertyToken({ kind: 'name', name: 'template' });
/** A sprite clip name (the declaration token for {@link SpriteClipName}). */
export const SpriteClipName: PropertyToken = propertyToken({ kind: 'name', name: 'spriteClip' });
/** A node inside or beside this one (the declaration token for {@link NodeName}). */
export const NodeName: PropertyToken = propertyToken({ kind: 'name', name: 'node' });
/** A scene name (the declaration token for {@link SceneName}). */
export const SceneName: PropertyToken = propertyToken({ kind: 'name', name: 'scene' });
/** A collision layer name (the declaration token for {@link LayerName}). */
export const LayerName: PropertyToken = propertyToken({ kind: 'name', name: 'layer' });
/** An animator parameter name (the declaration token for {@link ParamName}). */
export const ParamName: PropertyToken = propertyToken({ kind: 'name', name: 'param' });
/** An animator trigger name (the declaration token for {@link TriggerName}). */
export const TriggerName: PropertyToken = propertyToken({ kind: 'name', name: 'trigger' });
/** An input action name (the declaration token for {@link ActionName}). */
export const ActionName: PropertyToken = propertyToken({ kind: 'name', name: 'action' });

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
