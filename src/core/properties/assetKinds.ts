// The engine classes that are property types of their own, and how a field's stored id finds each one.
// Imported once by cleoCore.ts, for what it registers.

import { Material } from '../../graphics/material';
import { Texture } from '../../graphics/texture';
import { TextureManager } from '../../graphics/systems/textureManager';
import { Tileset } from '../../graphics/tilemap/tileset';
import { Sound } from '../../audio/sound';
import { AudioManager } from '../../audio/audioManager';
import { Node } from '../scene/nodes/node';
import { registerClassType, setNodeClassTest } from './types';
import { registerAssetParser, registerAssetResolver } from './fieldRefs';

registerClassType(Material, { kind: 'asset', asset: 'material' });
registerClassType(Texture, { kind: 'asset', asset: 'texture' });
registerClassType(Sound, { kind: 'asset', asset: 'sound' });
registerClassType(Tileset, { kind: 'asset', asset: 'tileset' });
setNodeClassTest(ctor => ctor === Node || ctor.prototype instanceof Node);

// Textures and sounds are already the engine's by id, in a published game too (both are packed by id).
registerAssetResolver('texture', id => TextureManager.Instance.getTexture(id));
registerAssetResolver('sound', id => AudioManager.Instance.getSound(id));
// Materials and tilesets live in nodes, not in a registry: the game's asset table carries the ones fields name.
registerAssetParser('material', json => Material.parse(json));
registerAssetParser('tileset', json => Tileset.parse(json));
