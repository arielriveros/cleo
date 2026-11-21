import { LightProbeNode } from 'cleo';
import { useState, useEffect, useCallback } from 'react';
import Collapsable from '@cleo/app-kit/ui/Collapsable';
import { Button, SectionTitle } from '@cleo/app-kit/ui';
import { ProbeIcon } from '../sectionIcons';
import { probeBakeWarning, rebakeStale, useProbeBakeStatus } from '../../../utils/probeBake';
import { useEventBus } from '../../EventBusContext';
import { useCleoEngine } from '../../EngineContext';
import { clamp } from '@cleo/app-kit/utils/math';
import DeclaredSections, { useNodeTick } from '../../properties/DeclaredSections';

// The Light Probe inspector: its declared properties (src/properties/probes.ts), the cubemap it last captured,
// and the bake controls.

export default function LightProbeEditor(props: { node: LightProbeNode }) {
  const eventEmitter = useEventBus();
  useNodeTick(props.node);
  const mode = props.node.mode;
  const updateFrequency = props.node.updateFrequency;

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
    if (mode !== 'realtime') return;
    let last = props.node.lastBakeTime;
    const pollMs = clamp(updateFrequency * 1000, 250, 1000);
    const id = window.setInterval(() => {
      if (props.node.lastBakeTime !== last) {
        last = props.node.lastBakeTime;
        refreshPreview();
      }
    }, pollMs);
    return () => window.clearInterval(id);
  }, [mode, updateFrequency, props.node, refreshPreview]);

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
        <DeclaredSections node={props.node} />
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
