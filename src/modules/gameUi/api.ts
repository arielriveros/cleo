// What the Game UI feature adds to the engine API (scripts' `import { ... } from 'cleo'`, and the full barrel
// src/cleo.ts). The runtime barrel src/cleoCore.ts leaves these out: a published game loads the feature as a chunk.
// UI nodes. Every class must be exported individually: a script's base type is resolved by CLASS NAME,
// and the editor's script library matches the same names.
export { UINode } from "../../core/scene/nodes/ui/uiNode";
export { UIRootNode } from "../../core/scene/nodes/ui/uiRoot";
export { UIPanelNode, UIStackNode, UISpacerNode } from "../../core/scene/nodes/ui/uiContainers";
export { UITextNode, UIImageNode } from "../../core/scene/nodes/ui/uiContent";
export { UIButtonNode, UIProgressBarNode, UISliderNode, UIToggleNode, UITextInputNode } from "../../core/scene/nodes/ui/uiWidgets";
export type { UIImageFit, UIFillDirection, UITextAlign, UITextVAlign, UISizing, UIColor } from "../../core/scene/nodes/ui/uiNode";
export {
    setRect as uiSetRect, solveRect as uiSolveRect, rootScale as uiRootScale,
    projectToScreen as uiProjectToScreen, worldUIScale, intersectRect as uiIntersectRect,
    rectOffscreen as uiRectOffscreen, stackLayout as uiStackLayout,
} from "../../core/uiLayout";
export type { UIRect, UIScaleMode, UISpace, StackJustify, StackItem, ScreenProjection } from "../../core/uiLayout";
