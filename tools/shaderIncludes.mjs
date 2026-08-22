// `#include "..."` resolution for shader sources, in one place.
//
// The directive syntax is deliberately identical to what `ts-shader-loader` already accepts for GLSL —
// line-anchored, quoted, optional trailing semicolon, resolved relative to the including file — so the
// two shader trees do not end up with two conventions. WGSL has no include mechanism of its own, and it
// needs one badly: a program becomes a single module holding both entry points, so the code that used
// to be shared by pairing one vertex shader with many fragment shaders (screen.vs alone serves 27
// programs) has to be shared textually instead.
//
// Unlike ts-shader-loader this tracks the include stack, so a cycle is reported rather than recursing
// until the stack blows.

const INCLUDE = /^[ \t]*#include\s+"([./\w-]+)";?[ \t]*$/gim;

/**
 * Expand every `#include` in `source`.
 *
 * `read(resolvedPath)` returns the file's text; `resolve(fromDir, relative)` returns an absolute-ish
 * key. Both are injected so this works against a filesystem (the webpack loader, the vitest plugin) or
 * against an in-memory map (tests) without knowing which.
 *
 * `onDependency` is called with every resolved path, so the loader can register watch dependencies —
 * without it, editing an included chunk would not rebuild its includers.
 */
export function resolveIncludes(source, fromDir, { read, resolve, onDependency, stack = [] } = {}) {
    return source.replace(INCLUDE, (whole, relative) => {
        const target = resolve(fromDir, relative);

        if (stack.includes(target)) {
            const cycle = [...stack, target].map(p => p.split(/[\\/]/).pop()).join(' -> ');
            throw new Error(`shader include cycle: ${cycle}`);
        }

        let text;
        try {
            text = read(target);
        } catch {
            throw new Error(`shader include not found: "${relative}" (from ${fromDir})`);
        }

        if (onDependency) onDependency(target);

        const dir = target.replace(/[\\/][^\\/]*$/, '');
        // Included text keeps its own line structure; a marker comment survives into the generated GLSL
        // and is the only breadcrumb back to the origin file once naga has mangled every identifier.
        const inner = resolveIncludes(text, dir, { read, resolve, onDependency, stack: [...stack, target] });
        return `// --- begin ${relative} ---\n${inner}\n// --- end ${relative} ---`;
    });
}

/** Whether `source` still contains an unresolved directive. Used by tests to catch a skipped pass. */
export function hasUnresolvedIncludes(source) {
    INCLUDE.lastIndex = 0;
    return INCLUDE.test(source);
}
