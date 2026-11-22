// The water volume's declared properties (see declare.ts): its waves, its buoyancy, and what it reacts to (the
// layers whose bodies ripple and splash it and whose colliders shape its flow) with its splashes. Its body
// (the river's points, the carve), its surface and its flow bake stay the card's own. Documented in
// docs/editor/water.md.

import { CollisionMask, TemplateName } from '../core/scripting/fieldTypes';
import { ModelNode } from '../core/scene/nodes/modelNode';
import { WaterVolumeNode } from '../core/scene/nodes/waterVolumeNode';
import { declareProperties, nodeIdAccess } from './declare';

const river = (n: WaterVolumeNode) => n.waterType === 'river';

declareProperties(WaterVolumeNode, 'Water Volume', [
    { title: '', props: [{ key: 'enabled', type: Boolean }] },
    { title: 'Waves', props: [
        { key: 'windSpeed', label: 'Wind speed', type: Number, min: 0, step: 0.5, divider: true, when: n => !river(n) },
        { key: 'fetch', type: Number, min: 0, step: 500, divider: true, when: n => !river(n) },
        { key: 'waveDirection', label: 'Direction', type: Number, step: 5, divider: true, when: n => !river(n) },
        { key: 'waveScale', label: 'Height', type: Number, min: 0, max: 3, step: 0.05, divider: true },
        { key: 'choppiness', type: Number, min: 0, max: 1, step: 0.05, divider: true, when: n => !river(n) },
        { key: 'waveSpeed', label: 'Wave speed', type: Number, min: 0, max: 2, step: 0.05, divider: true },
        { key: 'followWind', label: 'Follow wind', type: Boolean, divider: true, when: n => !river(n) },
        { key: 'shoreFade', label: 'Shore fade', type: Number, min: 0, step: 0.5, divider: true },
        { key: 'waveAmplitude', label: 'Swell', type: Number, min: 0, step: 0.01, divider: true },
        { key: 'waveFrequency', label: 'Swell rate', type: Number, min: 0, step: 0.05 },
    ] },
    { title: 'Buoyancy', props: [
        { key: 'density', type: Number, min: 1, step: 25, divider: true },
        { key: 'linearDrag', label: 'Drag', type: Number, min: 0, step: 0.1, divider: true },
        { key: 'angularDrag', label: 'Spin drag', type: Number, min: 0, step: 0.1, divider: true },
        { key: 'currents', type: Boolean, divider: true },
        { key: 'affectCharacters', label: 'Buoy characters', type: Boolean },
    ] },
    { title: 'Ripples and splashes', props: [
        { key: 'reactsTo', label: 'Reacts to', type: CollisionMask, divider: true },
        { key: 'spray', label: 'Spray', type: Number, min: 0, max: 2, step: 0.05, divider: true },
        { key: 'splashTemplate', label: 'Splash', type: TemplateName, divider: true },
        { key: 'wadeSplashTemplate', label: 'Wading splash', type: TemplateName, divider: true },
        { key: 'surfaceNodeId', label: 'Surface model', type: ModelNode, ...nodeIdAccess<WaterVolumeNode>('surfaceNodeId') },
    ] },
], { docs: 'editor/water' });
