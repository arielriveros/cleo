import { useEffect, useState } from 'react'
import { VolumetricCloudsNode } from 'cleo'
import Collapsable from '../../../components/Collapsable'
import AxisInput from '../../../components/AxisInput'
import { ColorInput } from './LightEditor'
import { vec3ToHex } from '../../../utils/UtilFunctions'
import { useCleoEngine } from '../../EngineContext'

type Vec3 = [number, number, number]

interface CloudsState {
  coverage: number; density: number; cloudType: number;
  baseAltitude: number; thickness: number;
  baseScale: number; detailScale: number; detailStrength: number;
  curlStrength: number; anvilBias: number;
  useSceneSun: boolean; sunDirection: Vec3; sunColor: Vec3; sunIntensity: number;
  ambientColor: Vec3; ambientIntensity: number; groundColor: Vec3;
  phaseG: number; silverIntensity: number; silverSpread: number;
  powderStrength: number; absorption: number;
  windDirection: Vec3; windSpeed: number; detailWindFactor: number;
  steps: number; lightSteps: number; maxDistance: number; jitter: boolean;
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
    phaseG: node.phaseG, silverIntensity: node.silverIntensity, silverSpread: node.silverSpread,
    powderStrength: node.powderStrength, absorption: node.absorption,
    windDirection: node.windDirection, windSpeed: node.windSpeed, detailWindFactor: node.detailWindFactor,
    steps: node.steps, lightSteps: node.lightSteps, maxDistance: node.maxDistance, jitter: node.jitter,
    enabled: node.enabled, opacity: node.opacity
  }
}

const cloudTypeName = (t: number) =>
  t < 0.25 ? 'Stratus' : t < 0.5 ? 'Stratocumulus' : t < 0.8 ? 'Cumulus' : 'Cumulonimbus'

export default function VolumetricCloudsEditor(props: { node: VolumetricCloudsNode }) {
  const { eventEmitter } = useCleoEngine()
  const [state, setState] = useState<CloudsState>(() => readNode(props.node))

  // Re-seed when a different clouds node is selected.
  useEffect(() => { setState(readNode(props.node)) }, [props.node])

  // Write changed fields straight to the live node (the renderer reads it every frame) and mark dirty.
  const apply = (patch: Partial<CloudsState>) => {
    for (const k in patch) (props.node as any)[k] = (patch as any)[k]
    setState(prev => ({ ...prev, ...patch }))
    eventEmitter.emit('SCENE_CHANGED')
  }

  // Plain render helpers (invoked as functions, not JSX components) so the inputs keep their
  // identity across re-renders and don't remount mid-drag.
  const slider = (label: string, k: keyof CloudsState, min: number, max: number, step: number, fixed = 2) => (
    <div className='flex flex-col gap-1 mb-2'>
      <label className='flex justify-between text-sm'>
        <span>{label}</span>
        <span className='text-gray-400'>{(state[k] as number).toFixed(fixed)}</span>
      </label>
      <input type='range' className='w-full' min={min} max={max} step={step}
        value={state[k] as number}
        onChange={(e) => apply({ [k]: parseFloat(e.target.value) } as Partial<CloudsState>)} />
    </div>
  )

  const check = (label: string, k: keyof CloudsState) => (
    <label className='flex items-center gap-2 mb-2 text-sm cursor-pointer'>
      <input type='checkbox' checked={state[k] as boolean}
        onChange={(e) => apply({ [k]: e.target.checked } as Partial<CloudsState>)} />
      {label}
    </label>
  )

  const color = (label: string, k: 'sunColor' | 'ambientColor' | 'groundColor') => (
    <div className='flex items-center justify-between mb-2 text-sm'>
      <span>{label}</span>
      <ColorInput color={vec3ToHex(state[k])} onChange={(c) => apply({ [k]: c } as Partial<CloudsState>)} />
    </div>
  )

  const header = (label: string) => <div className='mt-2 mb-1 font-semibold text-[#9aa0ff]'>{label}</div>

  return (
    <Collapsable title='Volumetric Clouds'>
      <div className='w-full p-2'>
        {check('Enabled', 'enabled')}
        {slider('Opacity', 'opacity', 0, 1, 0.01)}

        {header('Shape')}
        {slider('Coverage', 'coverage', 0, 1, 0.01)}
        {slider('Density', 'density', 0, 4, 0.01)}
        <div className='flex flex-col gap-1 mb-2'>
          <label className='flex justify-between text-sm'>
            <span>Cloud Type</span>
            <span className='text-gray-400'>{cloudTypeName(state.cloudType)}</span>
          </label>
          <input type='range' className='w-full' min={0} max={1} step={0.01}
            value={state.cloudType}
            onChange={(e) => apply({ cloudType: parseFloat(e.target.value) })} />
        </div>
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
            <label className='text-sm'>Sun Direction</label>
            <AxisInput step={0.05} value={state.sunDirection}
              onChange={(v) => apply({ sunDirection: v })} />
          </div>
        }
        {!state.useSceneSun && color('Sun Color', 'sunColor')}
        {slider('Sun Intensity', 'sunIntensity', 0, 30, 0.1)}
        {color('Ambient (Sky) Color', 'ambientColor')}
        {slider('Ambient Intensity', 'ambientIntensity', 0, 5, 0.05)}
        {color('Ground Color', 'groundColor')}
        {slider('Forward Scatter (Phase g)', 'phaseG', 0, 0.99, 0.01)}
        {slider('Silver Lining', 'silverIntensity', 0, 2, 0.01)}
        {slider('Silver Spread', 'silverSpread', 0.01, 0.5, 0.01)}
        {slider('Powder (dark edges)', 'powderStrength', 0, 1, 0.01)}
        {slider('Absorption', 'absorption', 0, 4, 0.01)}

        {header('Animation')}
        <div className='mb-2'>
          <label className='text-sm'>Wind Direction</label>
          <AxisInput step={0.05} value={state.windDirection}
            onChange={(v) => apply({ windDirection: v })} />
        </div>
        {slider('Wind Speed', 'windSpeed', 0, 80, 0.5)}
        {slider('Detail Wind Factor', 'detailWindFactor', 0, 5, 0.05)}

        {header('Quality')}
        {slider('March Steps', 'steps', 16, 192, 1, 0)}
        {slider('Light Steps', 'lightSteps', 2, 12, 1, 0)}
        {slider('Max Distance', 'maxDistance', 1000, 120000, 500, 0)}
        {check('Jitter (reduce banding)', 'jitter')}
      </div>
    </Collapsable>
  )
}
