import { badgeStyles } from './assetKinds'

// Injecting the generated card badges as a <style>, once per document.
//
// A separate module from the generator so the rules are installed exactly once no matter how many times
// AssetsExplorer mounts, and so `assetKinds` — which the DOM-free tests import — stays free of document
// access. The tests can call `badgeStyles()` and read the CSS text without a DOM.

const STYLE_ID = 'cleo-asset-badges'

export function installBadgeStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = badgeStyles()
  document.head.appendChild(style)
}
