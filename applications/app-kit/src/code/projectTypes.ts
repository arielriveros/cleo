// A project's OWN generated declarations — what its assets declare that scripts are checked against (the
// editor writes its animators' trigger names here). Kept apart from cleoTypes.ts, which carries the whole
// engine declaration tree: the editor sets these from its main bundle, and must not pull that tree in.

/**
 * Where they live — in the script workspace, and in Monaco at the same path. The workspace tsconfig already
 * includes `.cleo/types/*.d.ts`.
 */
export const PROJECT_TYPES_REL = '.cleo/types/project.d.ts';

let projectTypes = '';
const listeners = new Set<() => void>();

/** Replace the project's generated declarations (a module file; '' for none). */
export function setProjectTypes(content: string): void {
  if (content === projectTypes) return;
  projectTypes = content;
  for (const listener of listeners) listener();
}

export function getProjectTypes(): string { return projectTypes; }

/** Called after every change. Returns the unsubscribe. */
export function subscribeProjectTypes(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
