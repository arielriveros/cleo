// Every node's Transform, and the scene's own Environment rows (see declare.ts). A node's transform is written
// through its setters only when a row is edited: selecting a node writes nothing, so it never marks a tab unsaved.

import type { vec3 } from 'gl-matrix';
import { Color, Vec3, Vec4 } from '../core/scripting/fieldTypes';
import { Node } from '../core/scene/nodes/node';
import { Scene } from '../core/scene/scene';
import { declareProperties } from './declare';

declareProperties(Node, 'Transform', [
    { title: '', props: [
        { key: 'position', type: Vec3, step: 0.01, set: (n, v) => { n.setPosition(v as vec3); } },
        // Degrees. Written back, a quaternion-authored orientation goes through Euler angles.
        { key: 'rotation', type: Vec3, min: -180, max: 180, step: 0.1, set: (n, v) => { n.setRotation(v as vec3); } },
        { key: 'scale', type: Vec3, step: 0.01, set: (n, v) => { n.setScale(v as vec3); }, divider: true },
        { key: 'worldPosition', label: 'World Position', type: Vec3, readonly: true },
        { key: 'quaternion', type: Vec4, readonly: true },
        { key: 'worldQuaternion', label: 'World Quaternion', type: Vec4, readonly: true },
    ] },
], { kind: 'transform' });

/** The scene's ambient fill as a colour and a strength: `ambientLight` is the two multiplied, in lux. */
const ambientLux = (s: Scene) => Math.max(s.ambientLight[0], s.ambientLight[1], s.ambientLight[2]);
const ambientColor = (s: Scene): [number, number, number] => {
    const lux = ambientLux(s);
    return lux > 0 ? [s.ambientLight[0] / lux, s.ambientLight[1] / lux, s.ambientLight[2] / lux] : [1, 1, 1];
};

// The renderer's clear colour and the scene's reflections stay the Environment card's own.
declareProperties(Scene, 'Environment', [
    { title: '', props: [
        { key: 'ambient', label: 'Ambient', type: Color, get: ambientColor,
          set: (s, v) => { const c = v as number[], lux = ambientLux(s); s.ambientLight = [c[0] * lux, c[1] * lux, c[2] * lux] as vec3; } },
        { key: 'ambientLux', label: 'Ambient (lx)', type: Number, min: 0, step: 500, get: ambientLux,
          set: (s, v) => { const c = ambientColor(s), lux = Math.max(0, Number(v)); s.ambientLight = [c[0] * lux, c[1] * lux, c[2] * lux] as vec3; } },
    ] },
], { docs: 'editor/scene-authoring', section: 'environment-scene-settings' });
