/**
 * The one place node names are validated, so the Properties panel and the tree's inline rename refuse
 * exactly the same names.
 *
 * `__editor__` / `__debug__` are not cosmetic: buildGameData strips every node whose name contains them,
 * so a name that slips through deletes content from shipped builds. `root` is reserved because
 * Scene.parse re-finds the root by that literal name.
 *
 * @returns a warning to show the user, or null when the name is acceptable.
 */
export function validateNodeName(name: string): string | null {
  if (name === '') return 'Node name cannot be empty'
  if (name === 'root') return '"root" name is reserved for the root node'
  if (name.includes('__debug__')) return 'Node name cannot contain "__debug__"'
  if (name.includes('__editor__')) return 'Node name cannot contain "__editor__"'
  return null
}
