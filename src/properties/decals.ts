// The decal's declared properties (see declare.ts). Its nested groups (what it affects, its flipbook, its radial
// pattern) are whole objects on the node, so each row writes a copy with its one change.

import { ColorAlpha, Vec3 } from '../core/scripting/fieldTypes';
import { Choice, Integer } from '../core/properties/types';
import { DecalNode, type DecalAffects, type DecalFlipbook, type DecalRadialPattern } from '../core/scene/nodes/decalNode';
import { declareProperties, type PropertyDeclaration } from './declare';

const FLIPBOOK_DEFAULT: DecalFlipbook = { columns: 4, rows: 4, frames: 16, fps: 12, loop: false, blend: true };

const affect = (key: keyof DecalAffects, label: string): PropertyDeclaration<DecalNode> => ({
    key: `affects.${key}`, label, type: Boolean,
    get: n => n.affects[key],
    set: (n, v) => { n.affects = { ...n.affects, [key]: !!v }; },
});

const flip = (key: keyof DecalFlipbook, decl: Omit<PropertyDeclaration<DecalNode>, 'key' | 'get' | 'set' | 'when'>,
              fit: (v: any) => unknown = v => v): PropertyDeclaration<DecalNode> => ({
    key: `flipbook.${key}`, ...decl, when: n => !!n.flipbook,
    get: n => n.flipbook?.[key],
    set: (n, v) => { n.flipbook = { ...(n.flipbook ?? FLIPBOOK_DEFAULT), [key]: fit(v) }; },
});

const radial = (key: keyof DecalRadialPattern, decl: Omit<PropertyDeclaration<DecalNode>, 'key' | 'get' | 'set'>): PropertyDeclaration<DecalNode> => ({
    key: `radial.${key}`, ...decl,
    get: n => n.radial[key],
    set: (n, v) => { n.radial = { ...n.radial, [key]: v }; },
});

const whole = (min: number) => (v: unknown) => Math.max(min, Math.round(Number(v)));

declareProperties(DecalNode, 'Decal', [
    { title: '', props: [
        { key: 'size', type: Vec3, min: 0.01, step: 0.1 },
        { key: 'opacity', type: Number, min: 0, max: 1, step: 0.01 },
        { key: 'albedoOpacity', label: 'Albedo opacity', type: Number, min: 0, max: 1, step: 0.01 },
        { key: 'sortOrder', label: 'Sort order', type: Integer, step: 1 },
        { key: 'angleFade', label: 'Angle fade', type: Number, min: 0, max: 1, step: 0.01 },
        { key: 'depthFade', label: 'Depth fade', type: Number, min: 0, max: 1, step: 0.01 },
        affect('albedo', 'Affects Albedo'),
        affect('normal', 'Affects Normal'),
        affect('surface', 'Affects Roughness / Metal / AO'),
        affect('emissive', 'Affects Emissive'),
        { key: 'receivers', type: Choice(['all', 'terrain'], ['All surfaces', 'Terrain only']) },
        { key: 'pattern', type: Choice(['material', 'radial'], ['Material', 'Radial']) },
    ] },
    { title: 'Flipbook', when: n => n.pattern === 'material', props: [
        { key: 'flipbook', label: 'Animated', type: Boolean,
          get: n => !!n.flipbook, set: (n, on) => { n.flipbook = on ? { ...FLIPBOOK_DEFAULT } : null; } },
        flip('columns', { type: Integer, min: 1, step: 1 }, whole(1)),
        flip('rows', { type: Integer, min: 1, step: 1 }, whole(1)),
        flip('frames', { type: Integer, min: 1, step: 1 }, whole(1)),
        flip('fps', { label: 'Frame rate', type: Number, min: 0, step: 1 }, v => Math.max(0, Number(v))),
        flip('loop', { type: Boolean }),
        flip('blend', { label: 'Blend frames', type: Boolean }),
    ] },
    { title: 'Radial pattern', when: n => n.pattern === 'radial', props: [
        radial('innerColor', { label: 'Inner colour', type: ColorAlpha }),
        radial('outerColor', { label: 'Outer colour', type: ColorAlpha }),
        radial('shape', { type: Choice(['circle', 'square'], ['Circle', 'Square']) }),
        radial('curve', { type: Choice(['power', 'smooth', 'linear', 'sphere', 'tip'], ['Power', 'Smooth', 'Linear', 'Sphere', 'Tip']) }),
        radial('exponent', { type: Number, min: 0, step: 0.1, when: n => n.radial.curve === 'power' }),
        radial('falloff', { type: Number, min: 0, max: 1, step: 0.01, when: n => n.radial.curve !== 'power' }),
        radial('ringColor', { label: 'Ring colour', type: ColorAlpha }),
        radial('ringWidthPx', { label: 'Ring width (px)', type: Number, min: 0, step: 0.5 }),
        radial('emissive', { type: Number, min: 0, step: 0.1 }),
    ] },
], 'environment');
