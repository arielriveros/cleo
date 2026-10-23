import { useEffect, useState } from 'react'
import { VolumetricCloudsNode, VOLUMETRIC_CLOUDS_PRESETS, type VolumetricCloudsPreset } from 'cleo'
import Collapsable from '../../../components/Collapsable'
import AxisInput from '../../../components/AxisInput'
import { ColorInput } from './LightEditor'
import { vec3ToHex } from '../../../utils/UtilFunctions'
import { useEventBus } from '../../EventBusContext'
import { Button, Hint, PresetMenu, Select, Slider, Toggle, cn, labelClass, sectionTitleClass } from '../../../components/ui'
import { cloudBakeWarning, formatBakeAge, useCloudBakeStatus } from '../../../utils/cloudBake'
import { CloudsIcon } from '../sectionIcons'

type Vec3 = [number, number, number]

interface CloudsState {
  coverage: number; density: number; cloudType: number;
  baseAltitude: number; thickness: number;
  baseScale: number; detailScale: number; detailStrength: number;
  curlStrength: number; anvilBias: number;
  useSceneSun: boolean; sunDirection: Vec3; sunColor: Vec3; sunIntensity: number;
  useSkyAmbient: boolean; ambientColor: Vec3; ambientIntensity: number; groundColor: Vec3; sunsetColor: Vec3;
  phaseG: number; silverIntensity: number; silverSpread: number;
  powderStrength: number; absorption: number; albedo: number;
  phaseBackG: number; phaseBackWeight: number;
  msOctaves: number; msScatter: number; msExtinction: number; msEccentricity: number;
  hazeDistance: number;
  useSceneWind: boolean; windDirection: Vec3; windSpeed: number; detailWindFactor: number;
  steps: number; lightSteps: number; maxDistance: number; jitter: boolean; resolutionScale: number;
  temporalUpscale: boolean;
  enabled: boolean; opacity: number;
  bakeIntoSky: boolean; previewBake: boolean; bakeResolution: number; autoRebake: boolean;
}

function readNode(node: VolumetricCloudsNode): CloudsState {
  return {
    coverage: node.coverage, density: node.density, cloudType: node.cloudType,
    baseAltitude: node.baseAltitude, thickness: node.thickness,
    baseScale: node.baseScale, detailScale: node.detailScale, detailStrength: node.detailStrength,
    curlStrength: node.curlStrength, anvilBias: node.anvilBias,
    useSceneSun: node.useSceneSun, sunDirection: node.sunDirection, sunColor: node.sunColor, sunIntensity: node.sunIntensity,
    useSkyAmbient: node.useSkyAmbient,
    ambientColor: node.ambientColor, ambientIntensity: node.ambientIntensity, groundColor: node.groundColor,
    sunsetColor: node.sunsetColor,
    phaseG: node.phaseG, silverIntensity: node.silverIntensity, silverSpread: node.silverSpread,
    powderStrength: node.powderStrength, absorption: node.absorption, albedo: node.albedo,
    phaseBackG: node.phaseBackG, phaseBackWeight: node.phaseBackWeight,
    msOctaves: node.msOctaves, msScatter: node.msScatter, msExtinction: node.msExtinction,
    msEccentricity: node.msEccentricity,
    hazeDistance: node.hazeDistance,
    useSceneWind: node.useSceneWind,
    windDirection: node.windDirection, windSpeed: node.windSpeed, detailWindFactor: node.detailWindFactor,
    steps: node.steps, lightSteps: node.lightSteps, maxDistance: node.maxDistance, jitter: node.jitter,
    resolutionScale: node.resolutionScale,
    temporalUpscale: node.temporalUpscale,
    enabled: node.enabled, opacity: node.opacity,
    bakeIntoSky: node.bakeIntoSky, previewBake: node.previewBake, bakeResolution: node.bakeResolution,
    autoRebake: node.autoRebake
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
    eventEmitter.emit('SCENE_CHANGED', { kind: 'environment', node: props.node })
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

  const bake = useCloudBakeStatus(props.node.scene)
  const bakeWarning = state.bakeIntoSky ? cloudBakeWarning(bake.staleness) : null
  const regenerate = () => { props.node.requestBake(); eventEmitter.emit('SCENE_CHANGED') }

  const applyPreset = (p: VolumetricCloudsPreset) => {
    props.node.applyPreset(p)
    setState(readNode(props.node))
    eventEmitter.emit('SCENE_CHANGED', { kind: 'environment', node: props.node })
  }

  const presets = <PresetMenu presets={VOLUMETRIC_CLOUDS_PRESETS} onApply={applyPreset} title='Cloud presets' />

  // Read at render: the clouds editor re-renders on every edit, and adding a Wind node selects it anyway.
  const sceneWind = props.node.scene?.wind ?? null
  const followingWind = state.useSceneWind && !!sceneWind

  return (
    <Collapsable title='Volumetric Clouds' icon={<CloudsIcon />} persistKey='volumetricClouds' right={presets}>
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
        {slider('Haze Distance', 'hazeDistance', 0, 100000, 500, 0)}

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
        {check('Ambient from Sky Light', 'useSkyAmbient')}
        {color('Ambient (Sky) Color', 'ambientColor')}
        {slider('Ambient Intensity', 'ambientIntensity', 0, 5, 0.05)}
        {color('Ground Albedo', 'groundColor')}
        {color('Sunset/Sunrise Color', 'sunsetColor')}
        {slider('Extinction', 'absorption', 0, 4, 0.01)}
        {slider('Albedo', 'albedo', 0.5, 1, 0.005, 3)}
        {slider('Forward Scatter (Phase g)', 'phaseG', 0, 0.99, 0.01)}
        {slider('Back Scatter g', 'phaseBackG', -0.99, 0, 0.01)}
        {slider('Back Scatter Weight', 'phaseBackWeight', 0, 1, 0.01)}
        {slider('Silver Lining', 'silverIntensity', 0, 2, 0.01)}
        {slider('Silver Spread', 'silverSpread', 0.01, 0.5, 0.01)}
        {slider('Powder (dark edges)', 'powderStrength', 0, 1, 0.01)}

        {header('Multiple Scattering')}
        {slider('Octaves', 'msOctaves', 1, 4, 1, 0)}
        {slider('Scatter (a)', 'msScatter', 0, 1, 0.01)}
        {slider('Extinction (b)', 'msExtinction', 0, 1, 0.01)}
        {slider('Eccentricity (c)', 'msEccentricity', 0, 1, 0.01)}

        {header('Animation')}
        {check('Follow Scene Wind', 'useSceneWind')}
        {followingWind
          ? <Hint>Blowing the way Wind ‘{sceneWind!.name}’ does. Wind Speed is the altitude wind at its
              Strength 1 — the Wind node’s Strength scales it, and 0 stills the sky.</Hint>
          : <>
              {state.useSceneWind && <Hint>No Wind node in the scene — the clouds use the direction below.</Hint>}
              <div className='mb-2'>
                <label className={labelClass}>Wind Direction</label>
                <AxisInput step={0.05} value={state.windDirection}
                  onChange={(v) => apply({ windDirection: v })} />
              </div>
            </>}
        {slider('Wind Speed', 'windSpeed', 0, 80, 0.5)}
        {slider('Detail Wind Factor', 'detailWindFactor', 0, 5, 0.05)}

        {header('Sky Bake')}
        {check('Bake into Sky in Play', 'bakeIntoSky')}
        {state.bakeIntoSky && <>
          {!bake.hasAtmosphere && <Hint>The bake paints the clouds over the Sky Atmosphere — add one, or the clouds stay live.</Hint>}
          {check('Preview Baked in Editor', 'previewBake')}
          {check('Re-bake When the Sun Moves', 'autoRebake')}
          <div className='flex items-center justify-between my-1'>
            <span className={labelClass}>Bake Resolution</span>
            <Select value={state.bakeResolution} onChange={(e) => apply({ bakeResolution: parseInt(e.target.value) })}>
              <option value={256}>256</option>
              <option value={512}>512</option>
              <option value={1024}>1024</option>
            </Select>
          </div>
          <div className='flex items-center gap-2 my-1'>
            <Button size='sm' onClick={regenerate} disabled={!bake.hasAtmosphere}>Regenerate</Button>
            <span className='text-ui text-muted'>
              {bake.age === null ? 'Not baked yet' : `Baked ${formatBakeAge(bake.age)}`}
            </span>
          </div>
          {bakeWarning && <div className='text-warning text-ui my-1'
            title='Play mode re-bakes at load anyway; this is about the preview, and about a sun animated during play when re-baking is off.'>
            {bakeWarning}</div>}
          <Hint>
            Play mode and published games bake the clouds into the sky cubemap at load and draw it as a static
            texture instead of raymarching every frame. Wind and cloud shadows freeze at the bake.
          </Hint>
        </>}

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
