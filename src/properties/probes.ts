// The light probe's and the GI volume's declared properties (see declare.ts).

import { Vec3 } from '../core/scripting/fieldTypes';
import { Choice } from '../core/properties/types';
import { LightProbeNode } from '../core/scene/nodes/lightProbeNode';
import { GIVolumeNode, MAX_GI_PROBES_PER_AXIS, MIN_GI_PROBES_PER_AXIS } from '../core/scene/nodes/giVolumeNode';
import { declareProperties, numberChoiceAccess } from './declare';

declareProperties(LightProbeNode, 'Light Probe', [
    { title: '', props: [
        { key: 'resolution', type: Choice(['64', '128', '256', '512']), ...numberChoiceAccess<LightProbeNode>('resolution') },
        { key: 'mode', type: Choice(['baked', 'realtime'], ['Baked', 'Real-time']) },
        { key: 'updateFrequency', label: 'Update every (s)', type: Number, min: 0, step: 0.1, when: n => n.mode === 'realtime' },
        { key: 'intensity', type: Number, min: 0, max: 3, step: 0.05 },
        { key: 'relightDegrees', label: 'Follow the sun (°)', type: Number, min: 0, max: 90, step: 0.5 },
        { key: 'affectsLighting', label: 'Affects Lighting', type: Boolean },
        { key: 'affectsReflections', label: 'Affects Reflections', type: Boolean },
        { key: 'boxProjection', label: 'Box Projection', type: Boolean },
        { key: 'size', type: Vec3, min: 0, step: 0.5 },
        { key: 'blendDistance', type: Number, min: 0, step: 0.1 },
    ] },
], 'environment');

declareProperties(GIVolumeNode, 'GI Volume', [
    { title: '', props: [
        { key: 'enabled', type: Boolean, divider: true },
        { key: 'size', type: Vec3, min: 0.01, step: 0.5, divider: true },
        { key: 'probeCounts', label: 'Probes', type: Vec3, min: MIN_GI_PROBES_PER_AXIS, max: MAX_GI_PROBES_PER_AXIS, step: 1, divider: true },
        { key: 'probeInset', label: 'Probe inset', type: Number, min: 0, max: 0.5, step: 0.05, divider: true },
        { key: 'rays', type: Choice(['64', '256'], ['64 (8 x 8)', '256 (16 x 16)']), divider: true, ...numberChoiceAccess<GIVolumeNode>('rays') },
        { key: 'maxRayDistance', label: 'Ray reach', type: Number, min: 1, max: 2000, step: 1, divider: true },
        { key: 'captureResolution', label: 'Capture resolution', type: Choice(['16', '32'], ['16 px', '32 px']), divider: true,
          ...numberChoiceAccess<GIVolumeNode>('captureResolution') },
        { key: 'blendDistance', label: 'Blend distance', type: Number, min: 0, step: 0.1, divider: true },
        { key: 'intensity', type: Number, min: 0, step: 0.05, divider: true },
        { key: 'normalBias', label: 'Normal bias', type: Number, min: 0, max: 2, step: 0.05, divider: true },
        { key: 'viewBias', label: 'View bias', type: Number, min: 0, max: 2, step: 0.05, divider: true },
        { key: 'multiBounce', label: 'Multi-bounce', type: Boolean, divider: true },
        { key: 'additive', type: Boolean, divider: true },
        { key: 'includeGrass', label: 'Include grass', type: Boolean },
    ] },
], 'environment');
