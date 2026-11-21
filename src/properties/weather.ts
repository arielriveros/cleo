// The weather volume's declared properties (see declare.ts). Its falling sprite sheet and its snow material are
// the card's own (the editor's tileset and material libraries).

import { Vec3 } from '../core/scripting/fieldTypes';
import { Choice } from '../core/properties/types';
import { WeatherNode, MIN_WEATHER_VOLUME_SIZE } from '../core/scene/nodes/weatherNode';
import type { PrecipitationKind } from '../core/scene/nodes/weatherNode';
import { declareProperties } from './declare';

const falling = (n: WeatherNode) => n.precipitation !== 'none';
const rainy = (n: WeatherNode) => n.precipitation === 'rain' || n.precipitation === 'mixed';

declareProperties(WeatherNode, 'Weather', [
    { title: '', props: [
        { key: 'enabled', type: Boolean, divider: true },
        { key: 'size', type: Vec3, min: MIN_WEATHER_VOLUME_SIZE, step: 0.5, when: n => n.bounded },
        { key: 'blendDistance', type: Number, min: 0, step: 0.5, when: n => n.bounded },
        { key: 'priority', type: Number, step: 1, divider: true },
        { key: 'wetness', type: Number, min: 0, max: 1, step: 0.01 },
        { key: 'puddles', type: Number, min: 0, max: 1, step: 0.01 },
    ] },
    { title: 'Falling', props: [
        { key: 'precipitation', label: 'Falling', type: Choice(['none', 'rain', 'snow', 'mixed'], ['Nothing', 'Rain', 'Snow', 'Rain and snow']),
          // A kind picked on a volume with nothing falling gets a steady rate, so the pick shows at once.
          set: (n, v) => {
              n.precipitation = v as PrecipitationKind;
              if (v !== 'none' && !(n.precipitationRate > 0)) n.precipitationRate = 0.6;
          } },
        { key: 'precipitationRate', label: 'Rate', type: Number, min: 0, max: 1, step: 0.01, when: falling },
        { key: 'precipitationSnowShare', label: 'Snow Share', type: Number, min: 0, max: 1, step: 0.01, when: n => n.precipitation === 'mixed' },
        { key: 'precipitationSize', type: Number, min: 0.25, max: 3, step: 0.05, when: falling,
          label: n => (n.precipitation === 'rain' ? 'Drop Size' : n.precipitation === 'snow' ? 'Flake Size' : 'Drop & Flake Size') },
        { key: 'precipitationSpeed', label: 'Fall Speed', type: Number, min: 0.25, max: 3, step: 0.05, when: falling },
        { key: 'precipitationTrailMin', label: 'Trail Min', type: Number, min: 0.1, max: 4, step: 0.05, when: n => falling(n) && rainy(n) },
        { key: 'precipitationTrailMax', label: 'Trail Max', type: Number, min: 0.1, max: 4, step: 0.05, when: n => falling(n) && rainy(n) },
        { key: 'precipitationWind', label: 'Wind', type: Number, min: 0, max: 1, step: 0.01, when: falling },
    ] },
    { title: 'Snow', props: [
        { key: 'snow', type: Number, min: 0, max: 1, step: 0.01 },
        { key: 'snowTiling', type: Number, min: 0.05, step: 0.5 },
        { key: 'snowSlope', type: Number, min: 0, max: 90, step: 1 },
        { key: 'snowBreakup', type: Number, min: 0, max: 1, step: 0.01 },
        { key: 'shelter', type: Boolean },
    ] },
], 'environment');
