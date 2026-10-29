import { useState } from 'react';
import { webgpuAvailableInBrowser, WEBGPU_IMPLEMENTED } from 'cleo';
import type { BackendKind } from 'cleo';
import { useCleoEngine } from '../EngineContext';
import { SegmentedControl } from '../../components/ui';
import { readBackendPreference, writeBackendPreference } from './backendPreference';
import webglLogo from '../../images/logos/WebGL-logo.svg';
import webgpuLogo from '../../images/logos/WebGPU-logo.svg';

// Graphics API selector. The choice is a request resolved when the engine constructs its device, not a
// live switch: a context cannot change API underneath the buffers, textures and programs built on it.
// The control persists a preference and says it applies on reload.

const OPTIONS: { value: BackendKind; label: string; logo: string }[] = [
  { value: 'webgl2', label: 'WebGL 2', logo: webglLogo },
  { value: 'webgpu', label: 'WebGPU', logo: webgpuLogo },
];

export default function BackendSelector() {
  const { instance } = useCleoEngine();
  const renderer: any = instance?.renderer ?? null;

  const [preference, setPreference] = useState<BackendKind>(readBackendPreference);

  const active: BackendKind = renderer?.backend ?? 'webgl2';
  const fallbackReason: string | null = renderer?.backendFallbackReason ?? null;
  const browserHasWebGPU = webgpuAvailableInBrowser();

  /** Why an option cannot be selected, or null when it can. */
  const unavailable = (value: BackendKind): string | null => {
    if (value !== 'webgpu') return null;
    if (!browserHasWebGPU) return 'This browser does not expose navigator.gpu.';
    if (!WEBGPU_IMPLEMENTED) return 'The WebGPU device works, but the renderer does not draw through it yet.';
    return null;
  };

  const choose = (value: BackendKind) => {
    if (unavailable(value) || value === preference) return;
    writeBackendPreference(value);
    setPreference(value);
  };

  // The preference is stored but the running renderer is on something else: a pending reload, or a
  // request that could not be met. Those are separate messages.
  const pendingReload = preference !== active && !fallbackReason;

  return (
    <div>
      {/* The mark is the label here, so it carries the alt text and the text below is the caption. Fixed
          height keeps the two options aligned despite different aspect ratios. */}
      <SegmentedControl<BackendKind>
        value={preference}
        onChange={choose}
        className='grid grid-cols-2 gap-2'
        itemClassName='flex-col gap-1 rounded-md px-2 py-2'
        options={OPTIONS.map(opt => {
          const reason = unavailable(opt.value);
          return {
            value: opt.value,
            disabled: !!reason,
            title: reason ?? `Use ${opt.label} to drive the renderer. Applies when the editor reloads.`,
            label: <>
              <img src={opt.logo} alt={opt.label} className='h-7 object-contain' draggable={false} />
              <span className='text-ui-xs leading-none'>{opt.label}</span>
              {active === opt.value && <span className='text-ui-2xs leading-none text-success-fg'>running</span>}
            </>,
          };
        })}
      />

      {pendingReload && (
        <div className='mt-2 text-ui-xs text-warning leading-snug'>
          Reload the editor to switch to {OPTIONS.find(o => o.value === preference)?.label}.
        </div>
      )}
      {fallbackReason && preference === 'webgpu' && (
        <div className='mt-2 text-ui-xs text-warning leading-snug'>
          Running on WebGL 2 — {fallbackReason}.
        </div>
      )}
    </div>
  );
}
