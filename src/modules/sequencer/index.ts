// The Cinematics feature (catalog id `sequencer`): sequence nodes and the sequencer they run on. Installed by the
// full engine (src/modules/all.ts) and, in a published game built with it, loaded as a chunk of its own
// (src/modules/loaders.ts).
import type { FeatureModule } from "../../core/features/registry";
import { SequenceNode, sequenceGlobals } from "../../core/scene/nodes/sequenceNode";
import { CleoEngine } from "../../core/engine";
import { Game } from "../../core/game";
import * as api from "./api";

export * from "./api";

const sequencer: FeatureModule = {
    id: 'sequencer',
    api,
    install(reg) {
        reg.nodeType('sequence', SequenceNode.parse.bind(SequenceNode));
        // Property tracks aimed at 'renderer' or 'game' resolve here: the node module sits below both in the import graph.
        sequenceGlobals.renderer = () => { const e = CleoEngine.instance; return e && !e.headless ? e.renderer : null; };
        sequenceGlobals.game = () => Game;
    },
};

export default sequencer;
