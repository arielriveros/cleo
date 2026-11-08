import { MAX_FORCE_FIELDS, type ForceFieldNode } from '../core/scene/nodes/forceFieldNode';
import { MAX_WIND_SOURCES, WIND_SOURCE_FLOATS, packWindSources } from '../core/wind/windField';

/**
 * The frame's force fields as the particle simulation reads them (`u_fields`, four texels each): the
 * fields that move the air FIRST — exactly the wind sources the foliage and the CPU field see
 * (packWindSources: the first MAX_WIND_SOURCES enabled, visible `affectsWind` fields) — then every other
 * enabled, visible field, up to `max` in all. A wind field past the wind cap is left out here too, so no
 * system feels a source the others do not. Returns the count.
 *
 * The scene wind in chunks/particleSimCore.wgsl walks the same array and keeps only the wind records,
 * and an emitter on the scene wind skips them in `forceFieldAccel`, so none is applied twice.
 */
export function packFrameFields(fields: Iterable<ForceFieldNode>, out: Float32Array, max: number = MAX_FORCE_FIELDS): number {
    let count = packWindSources(fields, out, Math.min(max, MAX_WIND_SOURCES));
    for (const field of fields) {
        if (count >= max) break;
        if (!field.enabled || !field.visible || field.affectsWind) continue;
        field.packInto(out, count * WIND_SOURCE_FLOATS);
        count++;
    }
    return count;
}
