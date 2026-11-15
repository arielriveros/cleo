// The Game UI feature (catalog id `gameUi`): UI nodes (menus, HUDs and their widgets) and their layout; the player's
// UI layer that draws them is a part of its own (src/player/uiHost.tsx). Installed by the full engine
// (src/modules/all.ts); a published game built with it loads it as a chunk of its own (src/modules/loaders.ts).
import type { FeatureModule } from "../../core/features/registry";
import { K } from "../../core/scene/sceneKinds";
import { UIRootNode } from "../../core/scene/nodes/ui/uiRoot";
import { UIPanelNode, UIStackNode, UISpacerNode } from "../../core/scene/nodes/ui/uiContainers";
import { UITextNode, UIImageNode } from "../../core/scene/nodes/ui/uiContent";
import { UIButtonNode, UIProgressBarNode, UISliderNode, UIToggleNode, UITextInputNode } from "../../core/scene/nodes/ui/uiWidgets";
import { UINode } from "../../core/scene/nodes/ui/uiNode";
import * as api from "./api";

export * from "./api";

const feature: FeatureModule = {
    id: 'gameUi',
    api,
    install(reg) {
        reg.nodeType('uiRoot', (parent, json) => UIRootNode.parse(parent, json));
        reg.nodeType('uiPanel', (parent, json) => UIPanelNode.parse(parent, json));
        reg.nodeType('uiText', (parent, json) => UITextNode.parse(parent, json));
        reg.nodeType('uiImage', (parent, json) => UIImageNode.parse(parent, json));
        reg.nodeType('uiButton', (parent, json) => UIButtonNode.parse(parent, json));
        reg.nodeType('uiStack', (parent, json) => UIStackNode.parse(parent, json));
        reg.nodeType('uiSpacer', (parent, json) => UISpacerNode.parse(parent, json));
        reg.nodeType('uiProgressBar', (parent, json) => UIProgressBarNode.parse(parent, json));
        reg.nodeType('uiSlider', (parent, json) => UISliderNode.parse(parent, json));
        reg.nodeType('uiToggle', (parent, json) => UIToggleNode.parse(parent, json));
        reg.nodeType('uiTextInput', (parent, json) => UITextInputNode.parse(parent, json));
        reg.nodeKind(UINode, K.UI_NODE);
        reg.nodeKind(UIRootNode, K.UI_ROOT);
    },
};

export default feature;
