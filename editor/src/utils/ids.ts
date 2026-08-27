// Id generation for editor-side records (assets, scenes, projects, node subtrees).

/** Random 128-bit hex id, without pulling in a uuid dependency. */
export function cryptoRandomId(): string {
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  return 'ui_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
