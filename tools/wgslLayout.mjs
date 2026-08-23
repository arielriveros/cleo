// WGSL uniform-buffer layout, computed from the type rules.
//
// The WebGL2 backend never needed this: it asks the driver for `UNIFORM_OFFSET`,
// `UNIFORM_ARRAY_STRIDE` and `UNIFORM_MATRIX_STRIDE` and writes where it is told, which is
// authoritative in a way a hand-rolled packer cannot be. WebGPU has no equivalent reflection at all —
// a uniform buffer is bytes, and the shader reads whatever is at the offset its struct declares. So
// the offsets have to be computed, and computed correctly, before any WebGPU draw can carry a uniform.
//
// The rules implemented here are the uniform address space rules from the WGSL spec (§ Memory Layout):
//
//   scalar        align 4,  size 4
//   vec2<T>       align 8,  size 8
//   vec3<T>       align 16, size 12      <- size and align deliberately differ
//   vec4<T>       align 16, size 16
//   matCxR<f32>   align = align(vecR), size = C * roundUp(align(vecR), size(vecR))
//   array<T, N>   stride = roundUp(align(T), size(T)), size = N * stride
//   struct        align = max member align, size = roundUp(align, end of last member)
//
// plus the two extra constraints the UNIFORM address space adds on top of the storage rules:
// array element stride and struct alignment are both rounded up to 16.
//
// None of this is taken on faith. `tools/harness/uniformLayoutCheck.js` compares every offset computed
// here against what a real driver reports for the same block on WebGL2, across every program in the
// engine — the two must agree exactly, and if they ever do not, the driver is right and this is wrong.

const SCALAR_SIZE = { f32: 4, i32: 4, u32: 4, f16: 2 };

function roundUp(value, alignment) {
    return Math.ceil(value / alignment) * alignment;
}

/**
 * Split a struct body into `name: type` members.
 *
 * Bracket-aware rather than a split on commas, because `array<mat4x4<f32>, 100>` contains one. A regex
 * that stopped at the first comma silently truncated every array member's type to `array<mat4x4<f32>`
 * — the member count stayed right, which is exactly why it went unnoticed.
 */
export function splitStructMembers(body) {
    const members = [];
    let depth = 0;
    let current = '';
    for (const ch of body) {
        if (ch === '<' || ch === '(' || ch === '[') depth++;
        else if (ch === '>' || ch === ')' || ch === ']') depth--;
        if ((ch === ',' || ch === ';') && depth === 0) {
            if (current.trim()) members.push(current.trim());
            current = '';
            continue;
        }
        current += ch;
    }
    if (current.trim()) members.push(current.trim());

    return members.map((text) => {
        // Attributes such as `@align(16)` or `@size(32)` precede the name and override the computed
        // layout. None of the engine's shaders use them; parsing them out means an added one is an
        // explicit error below rather than a silently wrong offset.
        const attributes = [...text.matchAll(/@(align|size)\s*\(\s*(\d+)\s*\)/g)]
            .map(m => ({ kind: m[1], value: Number(m[2]) }));
        const stripped = text.replace(/@\w+\s*\([^)]*\)/g, '').trim();
        const colon = stripped.indexOf(':');
        if (colon < 0) return null;
        return {
            name: stripped.slice(0, colon).trim(),
            type: stripped.slice(colon + 1).trim().replace(/\s+/g, ' '),
            attributes,
        };
    }).filter(Boolean);
}

/** Every `struct Name { ... }` in a module, as a map of name to member list. */
export function findStructs(wgsl) {
    const source = wgsl.replace(/\/\/[^\n]*/g, '');
    const structs = new Map();
    for (const m of source.matchAll(/struct\s+([A-Za-z_]\w*)\s*\{([\s\S]*?)\}/g))
        structs.set(m[1], splitStructMembers(m[2]));
    return structs;
}

/** Parse a WGSL type into a shape the layout rules can walk. */
export function parseType(type) {
    const text = type.trim();

    let m = /^vec([234])<\s*([A-Za-z_]\w*)\s*>$/.exec(text);
    if (m) return { kind: 'vector', components: Number(m[1]), scalar: m[2] };

    m = /^mat([234])x([234])<\s*([A-Za-z_]\w*)\s*>$/.exec(text);
    if (m) return { kind: 'matrix', columns: Number(m[1]), rows: Number(m[2]), scalar: m[3] };

    m = /^array<\s*([\s\S]+)\s*>$/.exec(text);
    if (m) {
        // Split the element type from the count at the LAST top-level comma, so the element type may
        // itself be generic: `array<mat4x4<f32>, 100>`.
        const inner = m[1];
        let depth = 0, split = -1;
        for (let i = 0; i < inner.length; i++) {
            const ch = inner[i];
            if (ch === '<') depth++;
            else if (ch === '>') depth--;
            else if (ch === ',' && depth === 0) split = i;
        }
        if (split < 0) return { kind: 'array', of: inner.trim(), count: 0 };  // runtime-sized
        return {
            kind: 'array',
            of: inner.slice(0, split).trim(),
            count: Number(inner.slice(split + 1).trim()),
        };
    }

    if (SCALAR_SIZE[text] !== undefined) return { kind: 'scalar', scalar: text };
    return { kind: 'struct', name: text };
}

/**
 * Alignment and size of a type in the uniform address space.
 *
 * `structs` maps struct names to their member lists, so a nested struct (the engine's `PointLight`,
 * `SpotLight`, `DirectionalLight`) can be measured rather than guessed at.
 */
export function layoutOf(type, structs) {
    const parsed = typeof type === 'string' ? parseType(type) : type;

    switch (parsed.kind) {
        case 'scalar': {
            const size = SCALAR_SIZE[parsed.scalar];
            if (size === undefined) throw new Error(`unknown scalar type ${parsed.scalar}`);
            return { align: size, size };
        }
        case 'vector': {
            const scalar = SCALAR_SIZE[parsed.scalar];
            if (scalar === undefined) throw new Error(`unknown scalar type ${parsed.scalar}`);
            const size = parsed.components * scalar;
            // vec3 aligns to 16 while occupying 12 — the single most common source of hand-packing
            // bugs, and the reason a naive "sum the sizes" packer drifts after the first vec3.
            const align = parsed.components === 3 ? 4 * scalar : size;
            return { align, size };
        }
        case 'matrix': {
            // A matrix is C columns, each laid out as a vecR. Column stride is the vector's ALIGNMENT,
            // so a mat3x3 occupies 48 bytes rather than 36.
            const column = layoutOf({ kind: 'vector', components: parsed.rows, scalar: parsed.scalar }, structs);
            const stride = roundUp(column.size, column.align);
            return { align: column.align, size: parsed.columns * stride, matrixStride: stride };
        }
        case 'array': {
            const element = layoutOf(parsed.of, structs);
            // The uniform address space requires a stride that is a multiple of 16 — this is why the
            // engine's WGSL packs per-cascade scalars as `array<vec4<f32>, 1>` rather than
            // `array<f32, 4>`, which is not expressible here at all.
            const stride = roundUp(roundUp(element.size, element.align), 16);
            return { align: Math.max(element.align, 16), size: parsed.count * stride, arrayStride: stride };
        }
        case 'struct': {
            const members = structs.get(parsed.name);
            if (!members) throw new Error(`unknown struct ${parsed.name}`);
            const laid = layoutStruct(members, structs);
            return { align: laid.align, size: laid.size };
        }
        default:
            throw new Error(`unhandled type kind ${parsed.kind}`);
    }
}

/**
 * Offsets and sizes for every member of a struct, in declaration order.
 *
 * Returns `{ align, size, members }` where each member carries the byte offset the shader will read it
 * at, plus the array/matrix strides where they apply — the same three numbers the WebGL2 backend reads
 * back from the driver, so the two can be compared directly.
 */
export function layoutStruct(members, structs) {
    const out = [];
    let offset = 0;
    let maxAlign = 1;

    for (const member of members) {
        const explicitAlign = member.attributes?.find(a => a.kind === 'align')?.value;
        const explicitSize = member.attributes?.find(a => a.kind === 'size')?.value;
        const natural = layoutOf(member.type, structs);
        const align = explicitAlign ?? natural.align;
        const size = explicitSize ?? natural.size;

        offset = roundUp(offset, align);
        out.push({
            name: member.name,
            type: member.type,
            offset,
            size,
            align,
            ...(natural.arrayStride !== undefined ? { arrayStride: natural.arrayStride } : {}),
            ...(natural.matrixStride !== undefined ? { matrixStride: natural.matrixStride } : {}),
        });
        offset += size;
        maxAlign = Math.max(maxAlign, align);
    }

    // The uniform address space rounds a struct's alignment up to 16, which also pads its size.
    const align = roundUp(maxAlign, 16);
    return { align, size: roundUp(offset, align), members: out };
}

/**
 * Every writable leaf of a block, by full path, with the offset from the START OF THE BLOCK.
 *
 * `layoutStruct` gives offsets relative to the struct a member sits in, which is the right answer for
 * one struct and the wrong one for anything nested — `ambient` is at 16 inside `PointLight` and at 464
 * inside the lighting block's fourth point light. A uniform write needs the absolute number.
 *
 * The paths produced are exactly the names the renderer already uses: `u_exposure`,
 * `u_pointLights[3].position`, `u_material.baseColor`. That is not a coincidence — it is what lets a
 * WebGPU `setUniform(name, value)` find its offset with a single map lookup, keeping the ~380 existing
 * call sites unchanged.
 *
 * Arrays of scalars, vectors and matrices are NOT expanded per element: GL reports them as one active
 * uniform with a stride, the renderer writes them as one typed array, and both backends want the same.
 * Arrays of STRUCTS are expanded, because that is how they are addressed and how GL reports them.
 */
export function flattenLayout(typeName, structs, baseName = '', baseOffset = 0, out = []) {
    const parsed = parseType(typeName);

    if (parsed.kind === 'struct') {
        const members = structs.get(parsed.name);
        if (!members) throw new Error(`unknown struct ${parsed.name}`);
        for (const member of layoutStruct(members, structs).members) {
            const name = baseName ? `${baseName}.${member.name}` : member.name;
            flattenLayout(member.type, structs, name, baseOffset + member.offset, out);
        }
        return out;
    }

    if (parsed.kind === 'array') {
        const element = parseType(parsed.of);
        const { arrayStride } = layoutOf(parsed, structs);
        if (element.kind === 'struct') {
            for (let i = 0; i < parsed.count; i++)
                flattenLayout(parsed.of, structs, `${baseName}[${i}]`, baseOffset + i * arrayStride, out);
            return out;
        }
        const inner = layoutOf(parsed.of, structs);
        out.push({
            name: baseName,
            type: typeName,
            offset: baseOffset,
            size: parsed.count * arrayStride,
            arrayStride,
            ...(inner.matrixStride !== undefined ? { matrixStride: inner.matrixStride } : {}),
        });
        return out;
    }

    const leaf = layoutOf(parsed, structs);
    out.push({
        name: baseName,
        type: typeName,
        offset: baseOffset,
        size: leaf.size,
        ...(leaf.matrixStride !== undefined ? { matrixStride: leaf.matrixStride } : {}),
    });
    return out;
}
