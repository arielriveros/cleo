import type {
  UIRootNode, UIImageNode, UIButtonNode, UIProgressBarNode, UISliderNode, UIToggleNode, UITextInputNode, UITextNode,
} from 'cleo'

/** Each UI node type, by the class it parses to. */
interface UINodeTypes {
  uiRoot: UIRootNode
  uiImage: UIImageNode
  uiButton: UIButtonNode
  uiProgressBar: UIProgressBarNode
  uiSlider: UISliderNode
  uiToggle: UIToggleNode
  uiTextInput: UITextInputNode
  uiText: UITextNode
}

/**
 * Whether `node` is a UI node of `type`, asked by its type rather than with `instanceof`: the published player's
 * `cleo` is the runtime barrel, which leaves the UI classes to the Game UI feature (src/modules/gameUi), so this layer
 * names them as types only.
 */
export function isUI<K extends keyof UINodeTypes>(node: unknown, type: K): node is UINodeTypes[K] {
  return (node as { nodeType?: unknown } | null | undefined)?.nodeType === type
}
