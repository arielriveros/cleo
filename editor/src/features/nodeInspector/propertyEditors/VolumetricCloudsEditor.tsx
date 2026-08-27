import { useEffect, useState } from 'react'
import { VolumetricCloudsNode } from 'cleo'
import Collapsable from '../../../components/Collapsable'
import AxisInput from '../../../components/AxisInput'
import { ColorInput } from './LightEditor'
import { vec3ToHex } from '../../../utils/UtilFunctions'
import { useEventBus } from '../../EventBusContext'
import { Slider, Toggle, cn, labelClass, sectionTitleClass } from '../../../components/ui'
import { CloudsIcon } from '../sectionIcons'

type Vec3 = [number, number, number]

interface CloudsState {
  coverage: number; density: number; cloudType: number;
  baseAltitude: number; thickness: number;
  baseScale: number; detailScale: number; detailStrength: number;
  curlStrength: number; anvilBias: number;
  useSceneSun: boolean; sunDirection: Vec3; sunColor: Vec3; sunIntensity: number;
  ambientColor: Vec3; ambientIntensity: number; groundColor: Vec3; sunsetColor: Vec3;
  phaseG: number; silverIntensity: number; silverSpread: number;
  powderStrength: number; absorption: number;
  windDirection: Vec3; windSpeed: number; detailWindFactor: number;
  steps: number; lightSteps: number; maxDistance: number; jitter: boolean; resolutionScale: number;
  temporalUpscale: boolean;
  enabled: boolean; opacity: number;
}

function readNode(node: VolumetricCloudsNode): CloudsState {
  return {
    coverage: node.coverage, density: node.density, cloudType: node.cloudType,
    baseAltitude: node.baseAltitude, thickness: node.thickness,
    baseScale: node.baseScale, detailScale: node.detailScale, detailStrength: node.detailStrength,
    curlStrength: node.curlStrength, anvilBias: node.anvilBias,
    useSceneSun: node.useSceneSun, sunDirection: node.sunDirection, sunColor: node.sunColor, sunIntensity: node.sunIntensity,
    ambientColor: node.ambientColor, ambientIntensity: node.ambientIntensity, groundColor: node.groundColor,
    sunsetColor: node.sunsetColor,
    phaseG: node.phaseG, silverIntensity: node.silverIntensity, silverSpread: node.silverSpread,
    powderStrength: node.powderStrength, absorption: node.absorption,
    windDirection: node.windDirection, windSpeed: node.windSpeed, detailWindFactor: node.detailWindFactor,
    steps: node.steps, lightSteps: node.lightSteps, maxDistance: node.maxDistance, jitter: node.jitter,
    resolutionScale: node.resolutionScale,
    temporalUpscale: node.temporalUpscale,
    enabled: node.enabled, opacity: node.opacity
  }
}

const cloudTypeName = (t: number) =>
  t < 0.25 ? 'Stratus' : t < 0.5 ? 'Stratocumulus' : t < 0.8 ? 'Cumulus' : 'Cumulonimbus'

export default function VolumetricCloudsEditor(props: { node: VolumetricCloudsNode }) {
  const eventEmitter = useEventBus()
  const [state, setState] = useState<CloudsState>(() => readNode(props.node))

  useEffect(() => { setState(readNode(props.node)) }, [props.node])

  // The renderer reads the node every frame, so changed fields are written straight to it.
  const apply = (patch: Partial<CloudsState>) => {
    for (const k in patch) (props.node as any)[k] = (patch as any)[k]
    setState(prev => ({ ...prev, ...patch }))
    eventEmitter.emit('SCENE_CHANGED')
  }

  // Invoked as functions, not JSX components, so the inputs keep identity and do not remount mid-drag.
  const slider = (label: string, k: keyof CloudsState, min: number, max: number, step: number, fixed = 2) => (
    <Slider label={label} min={min} max={max} step={step} value={state[k] as number}
      labelClassName='w-[104px]' readout={(v) => v.toFixed(fixed)}
      onChange={(v) => apply({ [k]: v } as Partial<CloudsState>)} />
  )

  const check = (label: string, k: keyof CloudsState) => (
    <Toggle label={label} checked={state[k] as boolean} className='my-1'
      onChange={(c) => apply({ [k]: c } as Partial<CloudsState>)} />
  )

  const color = (label: string, k: 'sunColor' | 'ambientColor' | 'groundColor' | 'sunsetColor') => (
    <div className='flex items-center justify-between my-1'>
      <span className={labelClass}>{label}</span>
      <ColorInput color={vec3ToHex(state[k])} onChange={(c) => apply({ [k]: c } as Partial<CloudsState>)} />
    </div>
  )

  const header = (label: string) => <div className={cn(sectionTitleClass, 'mt-3 mb-1')}>{label}</div>

  return (
    <Collapsable title='Volumetric Clouds' icon={<CloudsIcon />} persistKey='volumetricClouds'>
      <div className='w-full p-2'>
        {check('Enabled', 'enabled')}
        {slider('Opacity', 'opacity', 0, 1, 0.01)}

        {header('Shape')}
        {slider('Coverage', 'coverage', 0, 1, 0.01)}
        {slider('Density', 'density', 0, 4, 0.01)}
        <Slider label='Cloud Type' min={0} max={1} step={0.01} value={state.cloudType}
          labelClassName='w-[104px]' readout={() => cloudTypeName(state.cloudType)}
          onChange={(v) => apply({ cloudType: v })} />
        {slider('Base Altitude', 'baseAltitude', 0, 5000, 10, 0)}
        {slider('Thickness', 'thickness', 50, 3000, 10, 0)}
        {slider('Base Noise Scale', 'baseScale', 0.00005, 0.002, 0.00005, 5)}
        {slider('Detail Noise Scale', 'detailScale', 0.0005, 0.01, 0.0005, 4)}
        {slider('Detail Strength', 'detailStrength', 0, 1, 0.01)}
        {slider('Curl / Turbulence', 'curlStrength', 0, 3, 0.01)}
        {slider('Anvil Bias', 'anvilBias', 0, 1, 0.01)}

        {header('Lighting')}
        {check('Use Scene Directional Light', 'useSceneSun')}
        {!state.useSceneSun &&
          <div className='mb-2'>
            <label className={labelClass}>Sun Direction</label>
            <AxisInput step={0.05} value={state.sunDirection}
              onChange={(v) => apply({ sunDirection: v })} />
          </div>
        }
        {!state.useSceneSun && color('Sun Color', 'sunColor')}
        {slider('Sun Intensity', 'sunIntensity', 0, 30, 0.1)}
        {color('Ambient (Sky) Color', 'ambientColor')}
        {slider('Ambient Intensity', 'ambientIntensity', 0, 5, 0.05)}
        {color('Ground Color', 'groundColor')}
        {color('Sunset/Sunrise Color', 'sunsetColor')}
        {slider('Forward Scatter (Phase g)', 'phaseG', 0, 0.99, 0.01)}
        {slider('Silver Lining', 'silverIntensity', 0, 2, 0.01)}
        {slider('Silver Spread', 'silverSpread', 0.01, 0.5, 0.01)}
        {slider('Powder (dark edges)', 'powderStrength', 0, 1, 0.01)}
        {slider('Absorption', 'absorption', 0, 4, 0.01)}

        {header('Animation')}
        <div className='mb-2'>
          <label className={labelClass}>Wind Direction</label>
          <AxisInput step={0.05} value={state.windDirection}
            onChange={(v) => apply({ windDirection: v })} />
        </div>
        {slider('Wind Speed', 'windSpeed', 0, 80, 0.5)}
        {slider('Detail Wind Factor', 'detailWindFactor', 0, 5, 0.05)}

        {header('Quality')}
        <Slider label='Resolution Scale' min={0.25} max={1} step={0.05} value={state.resolutionScale}
          labelClassName='w-[104px]' readout={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => apply({ resolutionScale: v })} />
        {slider('March Steps', 'steps', 16, 192, 1, 0)}
        {slider('Light Steps', 'lightSteps', 2, 12, 1, 0)}
        {slider('Max Distance', 'maxDistance', 1000, 120000, 500, 0)}
        {check('Jitter (reduce banding)', 'jitter')}
        {check('Temporal Upscale (1/16 rays per frame)', 'temporalUpscale')}
      </div>
    </Collapsable>
  )
}
