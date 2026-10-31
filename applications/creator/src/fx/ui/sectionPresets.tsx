import { PresetMenu } from '@cleo/app-kit/ui';
import type { FxParams } from '../fxParams';
import { EFFECT_SECTION_PRESETS, type SectionPreset } from '../fxPresets';

/** A section's Presets ▾, where the section has presets. */
export function sectionPresets(title: string, params: FxParams, setParams: (p: FxParams) => void) {
  const presets = EFFECT_SECTION_PRESETS[title];
  return presets
    ? <PresetMenu presets={presets} onApply={(p: SectionPreset<Partial<FxParams>>) => setParams({ ...params, ...p.values })} />
    : undefined;
}
