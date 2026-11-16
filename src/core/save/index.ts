// Saving and loading game state. Scripts use `SaveGame`; hosts (the player, the editor's play mode) build
// runtime scenes through `parseRuntimeScene` and install a store with `setSaveStore`.

export { SaveGame, setSaveStore, getSaveStore } from './saveGame';
export type { SaveOptions, LoadOptions, SaveStoreOptions } from './saveGame';
export { parseRuntimeScene, resetSaveSession, beginSaveSessionFrom, captureOutgoing, sessionPlayTime } from './session';
export { captureScene } from './capture';
export {
    createMemorySaveStore, createIndexedDbSaveStore, createBridgeSaveStore, createTextSaveStore, SAVES_CHANNEL,
} from './stores';
export type { SaveStore, SaveTextBackend, SaveFilesBridge, IndexedDbSaveStoreOptions, SavesChangedMessage } from './stores';
export {
    SAVE_FORMAT, SAVE_FORMAT_VERSION, isValidSlot, validateSaveDocument, migrateSaveDocument, slotInfoOf, emptySceneMemory,
} from './doc';
export type { SaveDocument, SaveSlotInfo, SceneMemory, SavedNodeState, SavedSpawn, SavedRef, SaveMigrator } from './doc';
