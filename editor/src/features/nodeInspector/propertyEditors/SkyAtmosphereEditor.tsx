import { useEffect, useState } from 'react'
import { SkyAtmosphereNode } from 'cleo'
import Collapsable from '../../../components/Collapsable'
import AxisInput from '../../../components/AxisInput'
import { ColorInput } from './LightEditor'
import { vec3ToHex } from '../../../utils/UtilFunctions'
import { useCleoEngine } from '../../EngineContext'

type Vec3 = [number, number, number]

interface AtmoState {
  useSceneSun: boolean; sunDirection: Vec3; sunColor: Vec3; sunIntensity: number;
  rayleighScatter: number; rayleighHeight: number; mieScatter: number; mieHeight: number; mieG: number;
  planetRadius: number; atmosphereRadius: number; sunDiskSize: number; exposure: number; groundColor: Vec3;
  resolution: number; viewSteps: number; lightSteps: number;
  fogEnabled: boolean; fogDensity: number; fogStart: number; fogHeight: number; fogHeightFalloff: number;
  fogMaxOpacity: number; fogColor: Vec3; fogColorBlend: number;
}

function readNode(node: SkyAtmosphereNode): AtmoState {
  return {
    useSceneSun: node.useSceneSun, sunDirection: node.sunDirection, sunColor: node.sunColor, sunIntensity: node.sunIntensity,
    rayleighScatter: node.rayleighScatter, rayleighHeight: node.rayleighHeight,
    mieScatter: node.mieScatter, mieHeight: node.mieHeight, mieG: node.mieG,
    planetRadius: node.planetRadius, atmosphereRadius: node.atmosphereRadius,
    sunDiskSize: node.sunDiskSize, exposure: node.exposure, groundColor: node.groundColor,
    resolution: node.resolution, viewSteps: node.viewSteps, lightSteps: node.lightSteps,
    fogEnabled: node.fogEnabled, fogDensity: node.fogDensity, fogStart: node.fogStart,
    fogHeight: node.fogHeight, fogHeightFalloff: node.fogHeightFalloff, fogMaxOpacity: node.fogMaxOpacity,
    fogColor: node.fogColor, fogColorBlend: node.fogColorBlend
  }
}

export default function SkyAtmosphereEditor(props: { node: SkyAtmosphereNode }) {
  const { eventEmitter } = useCleoEngine()
  const [state, setState] = useState<AtmoState>(() => readNode(props.node))

  useEffect(() => { setState(readNode(props.node)) }, [props.node])

  // Write changed fields to the live node (setters flip needsBake → the renderer re-bakes next frame).
  const apply = (patch: Partial<AtmoState>) => {
    for (const k in patch) (props.node as any)[k] = (patch as any)[k]
    setState(prev => ({ ...prev, ...patch }))
    eventEmitter.emit('SCENE_CHANGED')
  }

  // Plain render helpers (invoked as functions so inputs keep identity across re-renders).
  const slider = (label: string, k: keyof AtmoState, min: number, max: number, step: number, fixed = 2) => (
    <div className='flex flex-col gap-1 mb-2'>
      <label className='flex justify-between text-sm'>
        <span>{label}</span>
        <span className='text-gray-400'>{(state[k] as number).toFixed(fixed)}</span>
      </label>
      <input type='range' className='w-full' min={min} max={max} step={step}
        value={state[k] as number}
        onChange={(e) => apply({ [k]: parseFloat(e.target.value) } as Partial<AtmoState>)} />
    </div>
  )

  const check = (label: string, k: keyof AtmoState) => (
    <label className='flex items-center gap-2 mb-2 text-sm cursor-pointer'>
      <input type='checkbox' checked={state[k] as boolean}
        onChange={(e) => apply({ [k]: e.target.checked } as Partial<AtmoState>)} />
      {label}
    </label>
  )

  const color = (label: string, k: 'sunColor' | 'groundColor' | 'fogColor') => (
    <div className='flex items-center justify-between mb-2 text-sm'>
      <span>{label}</span>
      <ColorInput color={vec3ToHex(state[k])} onChange={(c) => apply({ [k]: c } as Partial<AtmoState>)} />
    </div>
  )

  const header = (label: string) => <div className='mt-2 mb-1 font-semibold text-[#9aa0ff]'>{label}</div>

  return (
    <Collapsable title='Sky Atmosphere'>
      <div className='w-full p-2'>
        {header('Sun')}
        {check('Use Scene Directional Light', 'useSceneSun')}
        {!state.useSceneSun &&
          <div className='mb-2'>
            <label className='text-sm'>Sun Direction (toward sun)</label>
            <AxisInput step={0.05} value={state.sunDirection}
              onChange={(v) => apply({ sunDirection: v })} />
          </div>
        }
        {color('Sun Color', 'sunColor')}
        {slider('Sun Intensity', 'sunIntensity', 0, 40, 0.1)}
        {slider('Sun Disk Size (deg)', 'sunDiskSize', 0, 10, 0.1)}

        {header('Atmosphere')}
        {slider('Rayleigh Scatter', 'rayleighScatter', 0, 4, 0.01)}
        {slider('Rayleigh Height', 'rayleighHeight', 1000, 16000, 100, 0)}
        {slider('Mie Scatter', 'mieScatter', 0, 4, 0.01)}
        {slider('Mie Height', 'mieHeight', 100, 4000, 50, 0)}
        {slider('Mie Anisotropy (g)', 'mieG', 0, 0.99, 0.01)}
        {slider('Exposure', 'exposure', 0, 4, 0.05)}
        {color('Ground Color', 'groundColor')}
        {slider('Planet Radius', 'planetRadius', 1000000, 10000000, 100000, 0)}
        {slider('Atmosphere Radius', 'atmosphereRadius', 1000000, 11000000, 100000, 0)}

        {header('Quality')}
        <div className='flex items-center justify-between mb-2 text-sm'>
          <span>Resolution</span>
          <select className='bg-[#3b3b3b] text-white border border-[#2d2d77] rounded px-2 py-1'
            value={state.resolution}
            onChange={(e) => apply({ resolution: parseInt(e.target.value) })}>
            <option value={64}>64</option>
            <option value={128}>128</option>
            <option value={256}>256</option>
            <option value={512}>512</option>
          </select>
        </div>
        {slider('View Steps', 'viewSteps', 4, 64, 1, 0)}
        {slider('Light Steps', 'lightSteps', 2, 32, 1, 0)}

        {header('Fog (aerial perspective)')}
        {check('Enable Fog', 'fogEnabled')}
        {state.fogEnabled && <>
          {slider('Density', 'fogDensity', 0, 0.02, 0.0001, 4)}
          {slider('Start Distance', 'fogStart', 0, 2000, 5, 0)}
          {slider('Max Opacity', 'fogMaxOpacity', 0, 1, 0.01)}
          {slider('Height', 'fogHeight', -500, 2000, 10, 0)}
          {slider('Height Falloff', 'fogHeightFalloff', 0, 0.02, 0.0001, 4)}
          {color('Custom Color', 'fogColor')}
          {slider('Custom Color Blend', 'fogColorBlend', 0, 1, 0.01)}
        </>}
      </div>
    </Collapsable>
  )
}
