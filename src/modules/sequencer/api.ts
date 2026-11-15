// What the Cinematics feature adds to the engine API (scripts' `import { ... } from 'cleo'`, and the full barrel
// src/cleo.ts): a SequenceNode plays a sequence (tracks of timed sections) against the scene.
export {
    SequenceNode, resolveNodePath, sequenceGlobals, type SequencePlayOptions, type SequenceEndReason,
} from "../../core/scene/nodes/sequenceNode";
export { SequencePlayer, type SequencePlayerHost, type SequenceEventListener, type SequencePose } from "../../sequencer/sequencePlayer";
export { parseSequence, emptySequence, parseSequenceCurve } from "../../sequencer/parse";
export { compilePropertyPath, isTransformPath, captureVisibility, type PropertyAccessor } from "../../sequencer/propertyPath";
export { keyableProperties, sameKeyValue, type KeyableProperty } from "../../sequencer/keyable";
export { SEQUENCE_VERSION, FOLIAGE_CHANNELS } from "../../sequencer/types";
export { registerSequencePresets, sequencePresetsFor, presetFields, blendPresetValue } from "../../sequencer/presetRegistry";
export type {
    SequenceData, SequenceSlot, SequenceTrack, SequenceTrackType, SequenceKey, SequenceCurve,
    SectionBase, PathSection, PathTrack, PathLook, CameraCutSection, CameraCutTrack, PropertySection,
    PropertyTrack, PropertyValueType, EventKey, EventTrack, SequenceMarker,
    PresetSection, PresetTrack, FoliageSection, FoliageTrack, FoliageChannel,
    ScriptSection, ScriptTrack, SequenceScriptContext, AnimationSection, AnimationTrack, AudioSection, AudioTrack,
    SpawnSection, SpawnTrack, PossessSection, PossessTrack,
} from "../../sequencer/types";
