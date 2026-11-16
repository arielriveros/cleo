let counter = 0;

/** A short id, unique within a session (documents are not merged, so this is enough). */
export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;
