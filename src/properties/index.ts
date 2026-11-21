// The engine nodes' declared inspector properties (declare.ts), every family of them. Exported from the full
// engine (src/cleo.ts) for the editor, the agent bridge and the Sequencer; the published player never loads it.

// The engine classes that are types of their own (Material, Texture, …) are registered before any declaration.
import '../core/properties/assetKinds';
import './environment';
import './sky';
import './clouds';
import './probes';
import './weather';

export {
    declareProperties, declarationOf, declaredClasses, labelOfKey, resolveProperty, readProperty, writeProperty,
    assetIdAccess, numberChoiceAccess,
} from './declare';
export type { PropertyDeclaration, SectionDeclaration, ClassDeclaration, DeclaredProperty } from './declare';
export { sceneSunLux } from './sky';
