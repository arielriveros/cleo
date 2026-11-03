/**
 * "Is the user typing?" — the one answer every keyboard consumer shares: the game's input sampler and
 * the editor's letter shortcuts alike.
 *
 * A key aimed at a text field is the user writing, not playing and not commanding: it must reach the
 * field, and nothing listening on the window may act on it or cancel it. The test is by what the key
 * would DO there, not by tag alone — a focused checkbox or range slider types nothing, so a shortcut
 * pressed after clicking one should still work, while a `<select>` uses letters for its type-ahead.
 *
 * Duck-typed on purpose (`tagName`, `type`, `isContentEditable`, `closest`) so it reads any element,
 * including one from another realm, and can be tested without a DOM.
 */

/** `<input>` types that take no typed text. Every other type — text, number, search, password, date… — does. */
const NON_TEXT_INPUT_TYPES = new Set([
    'checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file', 'image', 'hidden',
]);

interface ElementLike {
    tagName?: unknown;
    type?: unknown;
    isContentEditable?: unknown;
    closest?: (selector: string) => unknown;
}

/** Whether a key pressed with focus on `target` would be typed into it. */
export function isTextEntryTarget(target: unknown): boolean {
    if (!target || typeof target !== 'object') return false;
    const el = target as ElementLike;
    if (typeof el.tagName !== 'string') return false;
    const tag = el.tagName.toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') return !NON_TEXT_INPUT_TYPES.has(String(el.type ?? 'text').toLowerCase());
    if (el.isContentEditable === true) return true;
    // Monaco takes its keys through a hidden textarea today, but through whatever element it focuses in
    // general (EditContext puts them on a plain div), so anything inside the editor counts.
    return typeof el.closest === 'function' && !!el.closest('.monaco-editor');
}

/**
 * Whether `event` is the user typing into a field. Reads the composed path's first entry, so a field
 * inside a shadow root is seen as itself rather than as its host.
 */
export function isTextEntryEvent(event: Event): boolean {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    return isTextEntryTarget(path[0] ?? event.target);
}
