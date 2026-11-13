import { LightProbeNode } from 'cleo';
import { useState, useEffect, useCallback } from 'react';
import Collapsable from '@cleo/app-kit/ui/Collapsable';
import { PropertyTable, PropertyRow, Select, NumberInput, Slider, Button, Toggle, SectionTitle } from '@cleo/app-kit/ui';
import { ProbeIcon } from '../sectionIcons';
import { probeBakeWarning, rebakeStale, useProbeBakeStatus } from '../../../utils/probeBake';

const BOUNDS_HINT = 'Set all three sizes above 0 and the probe only lights meshes/pixels inside its box volume, which moves and rotates with the node; the IBL feathers out over the blend distance. Any size at 0 leaves the probe unbounded: it affects the whole scene (legacy behavior).';
const BOX_PROJECTION_HINT = 'Parallax-correct the reflections against the box: a surface inside it reflects what the probe saw where the reflected ray leaves the box, so a room\'s walls land where they are on a polished floor. For rooms and corridors; leave it off for open ground, whose horizon is far away. Bounded probes only.';
const FOLLOW_SUN_HINT = 'Relight the probe each time the sun has turned this many degrees, so its reflections and fill follow a moving sun (a sequence keying it, a day cycle). A relight lights the captured scene again over a few frames; it never re-captures. 0 = only when baked.';
const AFFECTS_HINT = 'What the probe gives surfaces inside its volume. Lighting is the light it bounces onto them; Reflections is what they mirror. Turn Lighting off to keep the area lit by the sky light and ambient (or another probe) while still reflecting this probe\'s surroundings. No re-bake needed.';
import { useEventBus } from '../../EventBusContext';
import { useCleoEngine } from '../../EngineContext';
import { clamp } from '@cleo/app-kit/utils/math';
import { BOX_VOLUME_EDITED } from '../../gizmo/BoxVolumeGizmo';

export default function LightProbeEditor(props: { node: LightProbeNode }) {
  const [state, setState] = useState({
    resolution: props.node.resolution,
    mode: props.node.mode,
    updateFrequency: props.node.updateFrequency,
    intensity: props.node.intensity,
    sizeX: props.node.size[0],
    sizeY: props.node.size[1],
    sizeZ: props.node.size[2],
    blendDistance: props.node.blendDistance,
    affectsLighting: props.node.affectsLighting,
    affectsReflections: props.node.affectsReflections,
    boxProjection: props.node.boxProjection,
    relightDegrees: props.node.relightDegrees,
  });

  useEffect(() => {
    setState({
      resolution: props.node.resolution,
      mode: props.node.mode,
      updateFrequency: props.node.updateFrequency,
      intensity: props.node.intensity,
      sizeX: props.node.size[0],
      sizeY: props.node.size[1],
      sizeZ: props.node.size[2],
      blendDistance: props.node.blendDistance,
      affectsLighting: props.node.affectsLighting,
      affectsReflections: props.node.affectsReflections,
      boxProjection: props.node.boxProjection,
      relightDegrees: props.node.relightDegrees,
    });
  }, [props.node]);

  useEffect(() => {
    props.node.resolution = state.resolution;
    props.node.mode = state.mode;
    props.node.updateFrequency = state.updateFrequency;
    props.node.intensity = state.intensity;
    props.node.size = [state.sizeX, state.sizeY, state.sizeZ];
    props.node.blendDistance = state.blendDistance;
    props.node.affectsLighting = state.affectsLighting;
    props.node.affectsReflections = state.affectsReflections;
    props.node.boxProjection = state.boxProjection;
    props.node.relightDegrees = state.relightDegrees;
  }, [state, props.node]);

  const eventEmitter = useEventBus();
  // The viewport's face handles resize the box (and move the node) behind this panel's back: re-read the
  // size, or the next edit here would write the old one over it.
  useEffect(() => {
    const onEdited = (e: { nodeId: string }) => {
      if (e?.nodeId !== props.node.id) return;
      const [sizeX, sizeY, sizeZ] = props.node.size;
      setState(prev => ({ ...prev, sizeX, sizeY, sizeZ }));
    };
    eventEmitter.on(BOX_VOLUME_EDITED, onEdited);
    return () => { eventEmitter.off(BOX_VOLUME_EDITED, onEdited); };
  }, [eventEmitter, props.node]);
  // Emit from the user handlers, not the apply-effect above, which also runs on mount and would false-dirty
  // on selection. The 'environment' kind marks the tab unsaved without triggering a tree rebuild.
  const update = (patch: Partial<typeof state>) => {
    setState((prev) => ({ ...prev, ...patch }));
    eventEmitter.emit('SCENE_CHANGED', { kind: 'environment', node: props.node });
  };


  // --- Cubemap preview -------------------------------------------------------
  const { instance } = useCleoEngine();
  const [previewSrc, setPreviewSrc] = useState('');

  // Read-only capture of the probe's baked cube. Never emits SCENE_CHANGED, so it cannot dirty the tab.
  const refreshPreview = useCallback(() => {
    const renderer = instance?.renderer;
    if (!renderer) return;
    // The readback is async (a WebGPU one is a buffer map), so this resolves a frame or two later.
    void renderer.renderProbePreview(props.node, 256).then(setPreviewSrc);
  }, [instance, props.node]);

  // A freshly-added probe bakes on the next engine frame, so the refresh is deferred.
  useEffect(() => {
    setPreviewSrc('');
    const id = window.setTimeout(refreshPreview, 60);
    return () => window.clearTimeout(id);
  }, [props.node, refreshPreview]);

  // Realtime probes re-bake every updateFrequency seconds; poll and refresh only when a new bake landed.
  useEffect(() => {
    if (state.mode !== 'realtime') return;
    let last = props.node.lastBakeTime;
    const pollMs = clamp(state.updateFrequency * 1000, 250, 1000);
    const id = window.setInterval(() => {
      if (props.node.lastBakeTime !== last) {
        last = props.node.lastBakeTime;
        refreshPreview();
      }
    }, pollMs);
    return () => window.clearInterval(id);
  }, [state.mode, state.updateFrequency, props.node, refreshPreview]);

  // Baked probes capture on the engine's next _updateIBL, so wait for lastBakeTime to advance.
  const bakeAndPreview = () => {
    const before = props.node.lastBakeTime;
    props.node.bake();
    let tries = 0;
    const tick = () => {
      if (props.node.lastBakeTime !== before && props.node.hasBakedMaps) refreshPreview();
      else if (tries++ < 180) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  // Lights set to bake that changed since this probe captured them.
  const probeBake = useProbeBakeStatus(props.node.scene);
  const stale = probeBake.of(props.node);
  const staleLine = probeBakeWarning(stale);

  return (
    <Collapsable title='Light Probe' icon={<ProbeIcon />} persistKey='lightProbe'>
      <div className='w-full p-2'>
        {staleLine && <div className='flex items-center gap-2 mb-2'>
          <span className='text-warning text-ui flex-1'>{staleLine}</span>
          <Button size='sm' onClick={() => { if (stale) rebakeStale([stale]); eventEmitter.emit('SCENE_CHANGED'); }}>Re-bake</Button>
        </div>}
        <PropertyTable columns={['45%', '55%']}>
          <PropertyRow label='Resolution'>
            <Select value={state.resolution} onChange={(e) => update({ resolution: parseInt(e.target.value) })}>
              <option value={64}>64</option>
              <option value={128}>128</option>
              <option value={256}>256</option>
              <option value={512}>512</option>
            </Select>
          </PropertyRow>
          <PropertyRow label='Mode'>
            <Select value={state.mode} onChange={(e) => update({ mode: e.target.value as 'baked' | 'realtime' })}>
              <option value='baked'>Baked</option>
              <option value='realtime'>Real-time</option>
            </Select>
          </PropertyRow>
          {state.mode === 'realtime' && (
            <PropertyRow label='Update every (s)'>
              <NumberInput min={0} step={0.1} value={state.updateFrequency} onChange={(v) => update({ updateFrequency: v })} />
            </PropertyRow>
          )}
          <PropertyRow label='Intensity'>
            <Slider min={0} max={3} step={0.05} value={state.intensity} onChange={(v) => update({ intensity: v })} />
          </PropertyRow>
          <PropertyRow label='Follow the sun (°)' hint={FOLLOW_SUN_HINT}>
            <NumberInput min={0} max={90} step={0.5} value={state.relightDegrees} onChange={(v) => update({ relightDegrees: v })} />
          </PropertyRow>
          <PropertyRow label='Affects' labelClassName='align-top pt-1.5' hint={AFFECTS_HINT}>
            <div className='flex flex-col items-start gap-1'>
              <Toggle label='Lighting' checked={state.affectsLighting}
                      onChange={(v) => update({ affectsLighting: v })} />
              <Toggle label='Reflections' checked={state.affectsReflections}
                      onChange={(v) => update({ affectsReflections: v })} />
            </div>
          </PropertyRow>
          <PropertyRow label='Box Projection' hint={BOX_PROJECTION_HINT}>
            <Toggle checked={state.boxProjection} onChange={(v) => update({ boxProjection: v })} />
          </PropertyRow>
          <PropertyRow label='Size X' hint={BOUNDS_HINT}>
            <NumberInput min={0} step={0.5} value={state.sizeX} onChange={(v) => update({ sizeX: Math.max(0, v) })} />
          </PropertyRow>
          <PropertyRow label='Size Y' hint={BOUNDS_HINT}>
            <NumberInput min={0} step={0.5} value={state.sizeY} onChange={(v) => update({ sizeY: Math.max(0, v) })} />
          </PropertyRow>
          <PropertyRow label='Size Z' hint={BOUNDS_HINT}>
            <NumberInput min={0} step={0.5} value={state.sizeZ} onChange={(v) => update({ sizeZ: Math.max(0, v) })} />
          </PropertyRow>
          <PropertyRow label='Blend Distance' divider={false}
            hint='How far a bounded probe’s IBL feathers out at the edge of its box volume.'>
            <NumberInput min={0} step={0.1} value={state.blendDistance} onChange={(v) => update({ blendDistance: Math.max(0, v) })} />
          </PropertyRow>
        </PropertyTable>
        <div className='mt-2'>
          <SectionTitle title='Cubemap Preview' className='mb-1' />
          {previewSrc ? (
            <img src={previewSrc} className='w-full rounded border border-border' style={{ aspectRatio: '2 / 1' }} />
          ) : (
            <div className='w-full rounded border border-dashed border-border grid place-items-center text-ui text-muted' style={{ aspectRatio: '2 / 1' }}>
              Probe not baked yet
            </div>
          )}
        </div>
        <Button variant='primary' size='sm' className='mt-2 w-full' onClick={bakeAndPreview}>Bake Probe</Button>
      </div>
    </Collapsable>
  );
}
