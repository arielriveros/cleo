// The 2D cameras' and rooms' declared properties (see declare.ts). Documented with the rest of 2D
// (docs/editor/tilemap-2d.md).

import { Vec2 } from '../core/scripting/fieldTypes';
import { Camera2DNode } from '../core/scene/nodes/camera2DNode';
import { CameraNode } from '../core/scene/nodes/cameraNode';
import { Room2DNode } from '../core/scene/nodes/room2DNode';
import { ParallaxLayerNode } from '../core/scene/nodes/parallaxLayerNode';
import { declareProperties } from './declare';

const DOCS = 'editor/tilemap-2d';

declareProperties(Camera2DNode, 'Camera 2D', [
    { title: '', props: [
        { key: 'active', type: Boolean },
        { key: 'pixelsPerUnit', label: 'Pixels per unit', type: Number, min: 1, step: 1 },
        { key: 'referenceResolution', label: 'Reference resolution', type: Vec2, min: 1, step: 1 },
        { key: 'zoom', type: Number, min: 0.05, step: 0.25 },
        { key: 'pixelPerfect', label: 'Pixel perfect', type: Boolean },
        { key: 'followTarget', label: 'Follow', type: String },
        { key: 'followOffset', label: 'Follow offset', type: Vec2, step: 0.1 },
        { key: 'deadzone', label: 'Dead zone', type: Vec2, min: 0, step: 0.1 },
        { key: 'damping', type: Number, min: 0, step: 0.02 },
        { key: 'lookAhead', label: 'Look ahead', type: Number, min: 0, step: 0.25 },
        { key: 'confineToRooms', label: 'Confine to rooms', type: Boolean },
        { key: 'roomTransitionSeconds', label: 'Room transition', type: Number, min: 0, step: 0.05 },
    ] },
], { docs: DOCS, replaces: [CameraNode] });

declareProperties(Room2DNode, 'Room', [
    { title: '', props: [
        { key: 'size', type: Vec2, min: 0, step: 1 },
        { key: 'zone', type: String },
    ] },
], { docs: DOCS });

declareProperties(ParallaxLayerNode, 'Parallax Layer', [
    { title: '', props: [
        { key: 'parallax', type: Vec2, step: 0.05 },
        { key: 'repeatX', label: 'Repeat X', type: Boolean },
        { key: 'repeatY', label: 'Repeat Y', type: Boolean },
        { key: 'scroll', type: Vec2, step: 0.1 },
    ] },
], { docs: DOCS });
