// The 2D world feature (catalog id `world2d`): tilemaps (their meshes, cells and collision), 2D cameras, rooms and
// parallax layers. Installed by the full engine (src/modules/all.ts); a published game built with it loads it as a
// chunk of its own (src/modules/loaders.ts).
import type { FeatureModule } from "../../core/features/registry";
import { TilemapNode } from "../../core/scene/nodes/tilemapNode";
import { Camera2DNode } from "../../core/scene/nodes/camera2DNode";
import { Room2DNode } from "../../core/scene/nodes/room2DNode";
import { ParallaxLayerNode } from "../../core/scene/nodes/parallaxLayerNode";
import { K } from "../../core/scene/sceneKinds";
import * as api from "./api";

export * from "./api";

const feature: FeatureModule = {
    id: 'world2d',
    api,
    install(reg) {
        reg.nodeType('tilemap', (parent, json) => TilemapNode.parse(parent, json));
        reg.nodeType('camera2D', (parent, json) => Camera2DNode.parse(parent, json));
        reg.nodeType('room2D', (parent, json) => Room2DNode.parse(parent, json));
        reg.nodeType('parallaxLayer', (parent, json) => ParallaxLayerNode.parse(parent, json));
        reg.nodeKind(TilemapNode, K.TILEMAP);
    },
};

export default feature;
