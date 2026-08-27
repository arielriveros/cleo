import { useEffect, useState } from 'react'
import { SkyAtmosphereNode } from 'cleo'
import Collapsable from '../../../components/Collapsable'
import AxisInput from '../../../components/AxisInput'
import { ColorInput } from './LightEditor'
import { vec3ToHex } from '../../../utils/UtilFunctions'
import { useEventBus } from '../../EventBusContext'
import { Select, Slider, Toggle, cn, labelClass, sectionTitleClass } from '../../../components/ui'
import { SkyIcon } from '../sectionIcons'

type Vec3 = [number, number, number]

interface AtmoState {
  useSceneSun: boolean; sunDirection: Vec3; sunColor: Vec3; sunIntensity: number;
  rayleighScatter: number; rayleighHeight: number; mieScatter: number; mieHeight: number; mieG: number;
  planetRadius: number; atmosphereRadius: number; sunDiskSize: number; exposure: number; groundColor: Vec3;
  resolution: number; viewSteps: number; lightSteps: number;
  fogEnabled: boolean; fogDensity: number; fogStart: number; fogHeight: number; fogHeightFalloff: number;
  fogMaxOpacity: number; fogColor: Vec3; fogColorBlend: number;
  godRaysEnabled: boolean; godRaySamples: number; godRayDensity: number; godRayExposure: number;
  godRayTint: Vec3; godRayAnisotropy: number; godRayMaxDistance: number;
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
    fogColor: node.fogColor, fogColorBlend: node.fogColorBlend,
    godRaysEnabled: node.godRaysEnabled, godRaySamples: node.godRaySamples, godRayDensity: node.godRayDensity,
    godRayExposure: node.godRayExposure, godRayTint: node.godRayTint,
    godRayAnisotropy: node.godRayAnisotropy, godRayMaxDistance: node.godRayMaxDistance
  }
}

export default function SkyAtmosphereEditor(props: { node: SkyAtmosphereNode }) {
  const eventEmitter = useEventBus()
  const [state, setState] = useState<AtmoState>(() => readNode(props.node))

  useEffect(() => { setState(readNode(props.node)) }, [props.node])

  // Write changed fields to the live node (setters flip needsBake → the renderer re-bakes next frame).
  const apply = (patch: Partial<AtmoState>) => {
    for (const k in patch) (props.node as any)[k] = (patch as any)[k]
    setState(prev => ({ ...prev, ...patch }))
    eventEmitter.emit('SCENE_CHANGED')
  }

  // Invoked as functions, not components, so the inputs keep identity across re-renders.
  const slider = (label: string, k: keyof AtmoState, min: number, max: number, step: number, fixed = 2) => (
    <Slider label={label} min={min} max={max} step={step} value={state[k] as number}
      labelClassName='w-[104px]' readout={(v) => v.toFixed(fixed)}
      onChange={(v) => apply({ [k]: v } as Partial<AtmoState>)} />
  )

  const check = (label: string, k: keyof AtmoState) => (
    <Toggle label={label} checked={state[k] as boolean} className='my-1'
      onChange={(c) => apply({ [k]: c } as Partial<AtmoState>)} />
  )

  const color = (label: string, k: 'sunColor' | 'groundColor' | 'fogColor' | 'godRayTint') => (
    <div className='flex items-center justify-between my-1'>
      <span className={labelClass}>{label}</span>
      <ColorInput color={vec3ToHex(state[k])} onChange={(c) => apply({ [k]: c } as Partial<AtmoState>)} />
    </div>
  )

  const header = (label: string) => <div className={cn(sectionTitleClass, 'mt-3 mb-1')}>{label}</div>

  return (
    <Collapsable title='Sky Atmosphere' icon={<SkyIcon />} persistKey='skyAtmosphere'>
      <div className='w-full p-2'>
        {header('Sun')}
        {check('Use Scene Directional Light', 'useSceneSun')}
        {!state.useSceneSun &&
          <div className='mb-2'>
            <label className={labelClass}>Sun Direction (toward sun)</label>
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
        <div className='flex items-center justify-between mb-2'>
          <span className={labelClass}>Resolution</span>
          <Select value={state.resolution} onChange={(e) => apply({ resolution: parseInt(e.target.value) })}>
            <option value={64}>64</option>
            <option value={128}>128</option>
            <option value={256}>256</option>
            <option value={512}>512</option>
          </Select>
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

        {header('God Rays (volumetric light shafts)')}
        {check('Enable God Rays', 'godRaysEnabled')}
        {state.godRaysEnabled && <>
          {slider('Intensity', 'godRayExposure', 0, 2, 0.01)}
          {slider('Density', 'godRayDensity', 0, 1, 0.01)}
          {slider('Anisotropy', 'godRayAnisotropy', 0, 0.95, 0.01)}
          {slider('Max Distance', 'godRayMaxDistance', 5, 500, 5, 0)}
          {slider('March Steps', 'godRaySamples', 8, 128, 1, 0)}
          {color('Tint', 'godRayTint')}
        </>}
      </div>
    </Collapsable>
  )
}
